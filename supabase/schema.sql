-- ============================================================================
-- Cars24 Brief — Database Schema
-- ============================================================================
-- Run this in Supabase SQL Editor (or via supabase db push).
-- Idempotent: safe to re-run; uses CREATE ... IF NOT EXISTS where possible.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "vector";       -- pgvector for embeddings
create extension if not exists "pg_cron";      -- scheduled jobs (Supabase enables this)
create extension if not exists "pg_net";       -- HTTP from cron (Supabase enables this)

-- ---------------------------------------------------------------------------
-- 1. sources — the 10 RSS / Google News feeds we ingest from
-- ---------------------------------------------------------------------------

create table if not exists sources (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  url             text not null,
  source_type     text not null check (source_type in ('rss', 'google_news')),
  is_active       boolean not null default true,
  fetch_interval_minutes int not null default 120,
  last_fetched_at timestamptz,
  last_status     text,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. articles — raw ingested articles, then enriched by classifier + router
-- ---------------------------------------------------------------------------

create table if not exists articles (
  id                  uuid primary key default gen_random_uuid(),
  source_id           uuid references sources(id) on delete set null,
  source_name         text not null,
  title               text not null,
  summary             text,
  url                 text not null unique,
  image_url           text,
  published_at        timestamptz not null,
  fetched_at          timestamptz not null default now(),

  -- Classifier output (one LLM call sets all of these)
  importance          text check (importance in ('HIGH','MED','LOW','DROP')),
  bucket              text check (bucket in ('COMPETITOR','MARKET','CARS24_PRESS','CARS24_PR')),
  reasoning           text,
  entities            text[] not null default '{}',
  -- primary_competitor: forced single-choice that drives clustering + competitor view.
  -- One of the 5 tracked players, or null for MARKET / general / non-tracked-competitor stories.
  primary_competitor  text check (primary_competitor in ('Cars24','Spinny','CarDekho','Droom','OLX Autos')),
  cars24_implication  text,
  classified_at       timestamptz,

  -- Embedding (1536 dims for text-embedding-3-small)
  embedding           vector(1536),
  embedded_at         timestamptz,

  -- Router output
  cluster_id          uuid,           -- FK added below after clusters table
  routed_at           timestamptz,

  -- Pipeline state machine
  pipeline_state      text not null default 'ingested'
    check (pipeline_state in ('ingested','classified','embedded','routed','synthesized','dropped'))
);

-- Idempotent column add: needed because CREATE TABLE IF NOT EXISTS will not
-- add new columns to an existing table. Run separately so re-runs of this
-- file pick up schema changes on tables that already exist.
alter table articles add column if not exists primary_competitor text;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'articles_primary_competitor_check'
  ) then
    alter table articles add constraint articles_primary_competitor_check
      check (primary_competitor in ('Cars24','Spinny','CarDekho','Droom','OLX Autos'));
  end if;
end $$;

create index if not exists idx_articles_pipeline_state on articles (pipeline_state);
create index if not exists idx_articles_published_at on articles (published_at desc);
create index if not exists idx_articles_importance on articles (importance);
create index if not exists idx_articles_bucket on articles (bucket);
create index if not exists idx_articles_primary_competitor on articles (primary_competitor);
create index if not exists idx_articles_entities on articles using gin (entities);

-- pgvector index for fast cosine-similarity search (used by router)
-- Lists=100 is appropriate for our scale (<10k embeddings); raise for production.
create index if not exists idx_articles_embedding on articles
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ---------------------------------------------------------------------------
-- 3. clusters — groups of articles about the same real-world event
-- ---------------------------------------------------------------------------

create table if not exists clusters (
  id                    uuid primary key default gen_random_uuid(),
  centroid              vector(1536),         -- mean of member-article embeddings
  theme                 text,                  -- short cluster label (set by router or synthesizer)
  -- Hard attribute: a cluster is locked to one primary_competitor (or null = MARKET/general).
  -- Set when the cluster is first created; the router enforces same-competitor routing.
  primary_competitor    text check (primary_competitor in ('Cars24','Spinny','CarDekho','Droom','OLX Autos')),
  earliest_article_at   timestamptz,
  latest_article_at     timestamptz,
  article_count         int not null default 0,
  needs_synthesis       boolean not null default true,
  is_archived           boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table clusters add column if not exists primary_competitor text;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clusters_primary_competitor_check'
  ) then
    alter table clusters add constraint clusters_primary_competitor_check
      check (primary_competitor in ('Cars24','Spinny','CarDekho','Droom','OLX Autos'));
  end if;
end $$;

create index if not exists idx_clusters_needs_synthesis on clusters (needs_synthesis) where needs_synthesis = true;
create index if not exists idx_clusters_latest_article_at on clusters (latest_article_at desc);
create index if not exists idx_clusters_primary_competitor on clusters (primary_competitor);
create index if not exists idx_clusters_centroid on clusters
  using ivfflat (centroid vector_cosine_ops) with (lists = 50);

-- Now add the FK from articles → clusters
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'articles_cluster_id_fkey'
  ) then
    alter table articles
      add constraint articles_cluster_id_fkey
      foreign key (cluster_id) references clusters(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. stories — synthesized editorial stories (the unit shown in the brief)
-- ---------------------------------------------------------------------------
-- One story per cluster. This is what the daily brief and competitor views read from.

create table if not exists stories (
  id                    uuid primary key default gen_random_uuid(),
  cluster_id            uuid not null unique references clusters(id) on delete cascade,

  -- Editorial output from synthesizer
  title                 text not null,
  -- short_summary: ≤140 chars, single sentence; what shows in the compact feed row.
  -- summary: 2-3 sentences; what shows when the row expands.
  short_summary         text,
  summary               text not null,
  cars24_implication    text,                            -- the "what this means for Cars24" callout
  importance            text not null check (importance in ('HIGH','MED','LOW')),
  bucket                text not null check (bucket in ('COMPETITOR','MARKET','CARS24_PRESS','CARS24_PR')),
  -- Inherited from the underlying cluster. Drives competitor-view filtering.
  primary_competitor    text check (primary_competitor in ('Cars24','Spinny','CarDekho','Droom','OLX Autos')),
  entities              text[] not null default '{}',

  -- Source attribution
  source_count          int not null,
  source_articles       jsonb not null,                  -- [{name, url, published_at, title}, ...]
  primary_source_name   text,
  primary_source_url    text,
  image_url             text,

  -- Timing
  published_at          timestamptz not null,            -- = earliest source article
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_stories_published_at on stories (published_at desc);
create index if not exists idx_stories_importance on stories (importance);
alter table stories add column if not exists primary_competitor text;
alter table stories add column if not exists short_summary text;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stories_primary_competitor_check'
  ) then
    alter table stories add constraint stories_primary_competitor_check
      check (primary_competitor in ('Cars24','Spinny','CarDekho','Droom','OLX Autos'));
  end if;
end $$;

create index if not exists idx_stories_bucket on stories (bucket);
create index if not exists idx_stories_primary_competitor on stories (primary_competitor);
create index if not exists idx_stories_entities on stories using gin (entities);

-- ---------------------------------------------------------------------------
-- 5. daily_briefs — cached daily brief output, one row per day
-- ---------------------------------------------------------------------------

create table if not exists daily_briefs (
  id                  uuid primary key default gen_random_uuid(),
  brief_date          date not null unique,

  -- ── Today (last 24h, can widen to 48/72h on quiet days) ────────────────────
  -- hero_stories: MARKET + COMPETITOR buckets only. Self-coverage of Cars24
  --   is suppressed here so the operator's feed isn't polluted by own PR.
  -- hero_cars24:  CARS24_PRESS + CARS24_PR — anything that mentions Cars24.
  --   Lives behind the "Cars24" sub-tab on the feed page.
  hero_stories        jsonb not null,
  hero_cars24         jsonb not null default '[]'::jsonb,

  -- ── This week (last 7d, dedup against today's cluster_ids) ─────────────────
  -- weekly_recap:  MARKET + COMPETITOR HIGH stories. Cap is max(count, all-HIGH)
  --   so a heavy news week shows everything that mattered.
  -- weekly_cars24: CARS24_* HIGH stories.
  weekly_recap        jsonb not null default '[]'::jsonb,
  weekly_cars24       jsonb not null default '[]'::jsonb,

  -- "Still developing": stories that were previously a hero and have had new
  -- activity since their last appearance. Compact one-liners, not full cards.
  -- Shape: [{story_id, title, source_count, latest_update_at, days_running}]
  still_developing    jsonb not null default '[]'::jsonb,

  -- The window we ended up using (24, 48, or 72)
  window_hours        int not null,
  is_quiet_day        boolean not null default false,
  quiet_day_note      text,                              -- e.g. "Quiet last 24h — showing since Friday"

  -- Competitor pulse: per-competitor sparkline data
  -- Shape: [{competitor, story_count_7d, story_count_prev_7d, sparkline_daily, context_line}, ...]
  competitor_pulse    jsonb not null default '[]'::jsonb,

  -- Footer transparency
  total_stories_in_window int not null,
  ai_cost_usd         numeric(8, 4),

  generated_at        timestamptz not null default now()
);

alter table daily_briefs add column if not exists still_developing jsonb not null default '[]'::jsonb;
alter table daily_briefs add column if not exists hero_cars24 jsonb not null default '[]'::jsonb;
alter table daily_briefs add column if not exists weekly_recap jsonb not null default '[]'::jsonb;
alter table daily_briefs add column if not exists weekly_cars24 jsonb not null default '[]'::jsonb;

create index if not exists idx_daily_briefs_brief_date on daily_briefs (brief_date desc);

-- ---------------------------------------------------------------------------
-- 6. competitor_summaries — weekly + quarterly per-competitor synthesized views
-- ---------------------------------------------------------------------------

create table if not exists competitor_summaries (
  id              uuid primary key default gen_random_uuid(),
  competitor      text not null,                         -- 'Spinny', 'CarDekho', 'Cars24', etc.
  scope           text not null check (scope in ('week', 'quarter')),
  period_start    date not null,
  period_end      date not null,

  -- For sparkline strip (1-line context, e.g. "Funding driving 250% mention spike")
  context_line    text,

  -- Themed synthesis: {themes: [{title, bullets: [...], story_ids: [...]}], total_stories: N}
  themed_summary  jsonb not null,

  story_count     int not null,
  generated_at    timestamptz not null default now(),

  unique (competitor, scope, period_end)
);

create index if not exists idx_competitor_summaries_lookup on competitor_summaries (competitor, scope, period_end desc);

-- ---------------------------------------------------------------------------
-- 7. pipeline_state — watermark tracking per stage (orchestrator uses this)
-- ---------------------------------------------------------------------------

create table if not exists pipeline_state (
  id                text primary key,                    -- 'rss_ingest', 'classifier', 'router', 'synthesizer'
  last_processed_at timestamptz,
  last_run_at       timestamptz,
  last_run_status   text,                                -- 'success' | 'partial' | 'error: ...'
  last_run_meta     jsonb                                -- arbitrary stats from the last run
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Public reads on the read-only stuff served to the website.
-- All writes restricted to service_role (Edge Functions only).

alter table sources                enable row level security;
alter table articles               enable row level security;
alter table clusters               enable row level security;
alter table stories                enable row level security;
alter table daily_briefs           enable row level security;
alter table competitor_summaries   enable row level security;
alter table pipeline_state         enable row level security;

-- Public can READ stories, daily_briefs, competitor_summaries (the data the website displays)
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'stories_public_read') then
    create policy stories_public_read on stories for select using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'daily_briefs_public_read') then
    create policy daily_briefs_public_read on daily_briefs for select using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'competitor_summaries_public_read') then
    create policy competitor_summaries_public_read on competitor_summaries for select using (true);
  end if;
end $$;

-- All other tables: writes only via service role (which bypasses RLS).
-- No public policies = no public access.

-- ---------------------------------------------------------------------------
-- Helper: find similar clusters (used by router)
-- ---------------------------------------------------------------------------
-- Returns top-K cluster candidates by cosine similarity, restricted to:
--   1. Same primary_competitor (or both null) — prevents cross-competitor merges.
--   2. Recent activity relative to the new article's published_at. This matters
--      for 90-day historical backfills: old articles from the same week should
--      still see each other as candidate clusters even though they are older
--      than 14 days from "now".
--   3. Not archived.
--   4. NEW: temporal proximity to the new article (max_event_gap_days).
--      The new article's published_at must be within ±max_event_gap_days of the
--      cluster's latest_article_at. This stops semantically-similar but
--      time-distant events from merging (e.g. a March 12 founder-exit story
--      being routed into a May 1 founder-exit cluster — same theme, different
--      events). Without this guard, the router has no way to distinguish
--      "same event" from "same recurring theme".

drop function if exists find_candidate_clusters(vector(1536), int, int);
drop function if exists find_candidate_clusters(text, int, int);
drop function if exists find_candidate_clusters(text, int, int, text);
drop function if exists find_candidate_clusters(text, int, int, text, timestamptz, int);

create or replace function find_candidate_clusters(
  -- Passed from Edge Functions as a pgvector literal string ("[0.1,0.2,...]").
  -- Accepting text here avoids PostgREST/vector parameter encoding edge cases.
  query_embedding text,
  candidate_count int default 12,
  lookback_days int default 14,
  competitor text default null,
  article_published_at timestamptz default now(),
  max_event_gap_days int default 14
)
returns table (
  cluster_id uuid,
  theme text,
  article_count int,
  cosine_distance float,
  latest_article_at timestamptz,
  primary_competitor text
)
language sql stable as $$
  select
    c.id,
    c.theme,
    c.article_count,
    (c.centroid <=> query_embedding::vector) as cosine_distance,
    c.latest_article_at,
    c.primary_competitor
  from clusters c
  where c.is_archived = false
    and c.centroid is not null
    and c.latest_article_at > article_published_at - (lookback_days || ' days')::interval
    and (
      -- Hard filter: cluster's primary_competitor must match the article's.
      -- Both null (MARKET / general) is also a match.
      c.primary_competitor is not distinct from competitor
    )
    and abs(extract(epoch from (article_published_at - c.latest_article_at)))
        < max_event_gap_days * 86400
  order by c.centroid <=> query_embedding::vector
  limit candidate_count;
$$;

-- ---------------------------------------------------------------------------
-- Helper: archive stale clusters
-- ---------------------------------------------------------------------------
-- Closes clusters whose latest article is older than the lookback ceiling.
-- Once archived, a cluster is invisible to the router — a fresh article on
-- the same theme will start a new cluster instead.

create or replace function archive_stale_clusters(max_age_days int default 14)
returns int
language plpgsql as $$
declare
  archived_count int;
begin
  update clusters
  set is_archived = true,
      updated_at = now()
  where is_archived = false
    and latest_article_at < now() - (max_age_days || ' days')::interval;
  get diagnostics archived_count = row_count;
  return archived_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helper: refresh a cluster's centroid + counts after articles change
-- ---------------------------------------------------------------------------

create or replace function refresh_cluster_aggregates(target_cluster_id uuid)
returns void
language plpgsql as $$
declare
  new_centroid vector(1536);
  new_count int;
  new_earliest timestamptz;
  new_latest timestamptz;
begin
  -- Average all member-article embeddings for the new centroid
  -- Note: pgvector doesn't have AVG built-in for vectors as of writing; approximate by selecting the most recent.
  -- For our scale (<20 articles per cluster) this is fine. For larger clusters, do the average client-side.
  select embedding into new_centroid
  from articles
  where cluster_id = target_cluster_id
    and embedding is not null
  order by published_at desc
  limit 1;

  select
    count(*),
    min(published_at),
    max(published_at)
  into new_count, new_earliest, new_latest
  from articles
  where cluster_id = target_cluster_id;

  update clusters
  set centroid = coalesce(new_centroid, centroid),
      article_count = new_count,
      earliest_article_at = new_earliest,
      latest_article_at = new_latest,
      updated_at = now(),
      needs_synthesis = true
  where id = target_cluster_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Done
-- ---------------------------------------------------------------------------

comment on table sources is 'RSS feeds and Google News queries we ingest from.';
comment on table articles is 'Raw ingested articles, enriched by classifier + embedded + clustered.';
comment on table clusters is 'Groups of articles covering the same real-world event.';
comment on table stories is 'Synthesized editorial stories (one per cluster). The unit served to the UI.';
comment on table daily_briefs is 'Cached daily brief output, served by the website.';
comment on table competitor_summaries is 'Per-competitor weekly + quarterly themed summaries.';
