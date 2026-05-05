# Data Model

Schema reference for Cars24 Brief.

Source of truth: [`../../supabase/schema.sql`](../../supabase/schema.sql).
This doc explains the *why* behind each table and how they relate.

---

## Tables at a glance

```
sources           ── 10 RSS / Google News feeds
   │
   ▼
articles          ── raw + classified + embedded + routed
   │  (cluster_id)
   ▼
clusters          ── group of articles about the same event
   │  (1:1)
   ▼
stories           ── synthesized editorial story (the unit shown in UI)
   │
   ├──► daily_briefs           ── cached daily brief (one row / day)
   └──► competitor_summaries   ── cached weekly + quarterly per-competitor

pipeline_state    ── watermarks per stage (orchestration scratch)
```

---

## 1. `sources`

The 10 ingestion endpoints.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | e.g. "ET Auto", "Google News: Spinny" |
| `url` | text UNIQUE | RSS/Atom URL or Google News query URL |
| `source_type` | text | `'rss'` or `'google_news'` |
| `is_active` | bool | Soft-disable a source without deleting |
| `fetch_interval_minutes` | int | Hint, not enforced (cron is global) |
| `last_fetched_at` / `last_status` | tz / text | Updated by `rss-ingest` |

**Why a unique constraint on `url`:** lets `seed.sql` use `ON CONFLICT
(url) DO UPDATE` so re-running the seed is idempotent.

---

## 2. `articles`

The raw + enriched per-article record. Most write activity happens
here.

### Identity & ingestion

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `source_id` | uuid → sources(id) | nullable for imported rows |
| `source_name` | text NOT NULL | Denormalized for display |
| `title`, `summary`, `url` (UNIQUE), `image_url`, `published_at`, `fetched_at` | | Standard ingestion fields |

### Classifier output (set by `classify-articles`)

| Column | Type | Notes |
|---|---|---|
| `importance` | text CHECK in (HIGH/MED/LOW/DROP) | |
| `bucket` | text CHECK in (COMPETITOR/MARKET/CARS24_PRESS/CARS24_PR) | nullable for DROP rows |
| `reasoning` | text | 1-line LLM rationale (not shown in UI; useful for debug) |
| `entities` | text[] | e.g. `{Spinny, Tiger Global}`. GIN-indexed for `@>` queries (soft tag) |
| `primary_competitor` | text CHECK in (Cars24/Spinny/CarDekho/Droom/OLX Autos) | **Hard cluster-routing constraint.** Forced single-choice by the classifier. null = MARKET / general / non-tracked-competitor. |
| `cars24_implication` | text | nullable — model returns null when no genuine insight |
| `classified_at` | tz | |

### Embedding (set by `route-articles`)

| Column | Type | Notes |
|---|---|---|
| `embedding` | vector(1536) | from `text-embedding-3-small` |
| `embedded_at` | tz | |

### Cluster routing (set by `route-articles`)

| Column | Type | Notes |
|---|---|---|
| `cluster_id` | uuid → clusters(id) ON DELETE SET NULL | FK added after `clusters` table exists |
| `routed_at` | tz | |

### State machine

| Column | Type | Notes |
|---|---|---|
| `pipeline_state` | text NOT NULL DEFAULT 'ingested' | `ingested` → `classified` → `embedded` → `routed` → `synthesized` (or `dropped`) |

### Indexes

```sql
idx_articles_pipeline_state    -- batch picker for each stage
idx_articles_published_at      -- desc, time-window queries
idx_articles_importance        -- ranking
idx_articles_bucket            -- bucket filters
idx_articles_entities (gin)    -- entities @> ARRAY['Spinny']
idx_articles_embedding (ivfflat, vector_cosine_ops, lists=100)
                                -- pgvector ANN for router
```

`lists=100` is appropriate at <10k embeddings. Raise for higher
volume.

---

## 3. `clusters`

A group of articles covering the same real-world event.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `centroid` | vector(1536) | Currently = most-recent member's embedding (see schema comment) |
| `theme` | text | Short label, set by router or synthesizer |
| `primary_competitor` | text CHECK | **Set ONCE at cluster creation, never mutated.** All members of a cluster share this. The router enforces same-competitor routing via `find_candidate_clusters`. null clusters group MARKET/general stories. |
| `earliest_article_at` / `latest_article_at` | tz | Maintained by `refresh_cluster_aggregates` |
| `article_count` | int | Same |
| `needs_synthesis` | bool | True when new articles attached; cleared by synthesizer |
| `is_archived` | bool | Set by `archive_stale_clusters(14)` daily cron — anything with no activity in 14d is closed. The router skips archived clusters; the synthesizer does too. |
| `created_at`, `updated_at` | tz | |

### Indexes

```sql
idx_clusters_needs_synthesis (partial: where needs_synthesis = true)
idx_clusters_latest_article_at desc
idx_clusters_centroid (ivfflat, vector_cosine_ops, lists=50)
```

### Centroid trade-off

Today: `centroid` = most-recent member's embedding (drift-friendly,
cheap to maintain). Documented as a trade-off in schema comments.

Alternative: average all member embeddings. We chose simplicity
because cluster sizes stay small (<20 members) at our volume.

---

## 4. `stories`

The unit served to the UI. One story per cluster.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `cluster_id` | uuid UNIQUE → clusters(id) ON DELETE CASCADE | 1:1 |
| `title` | text NOT NULL | LLM, ≤60 chars |
| `short_summary` | text | LLM, one sentence, ≤140 chars; compact feed row |
| `summary` | text NOT NULL | LLM, 3-4 sentences |
| `cars24_implication` | text | nullable; suppressed if no genuine insight |
| `importance` | text NOT NULL CHECK in (HIGH/MED/LOW) | DROP excluded |
| `bucket` | text NOT NULL CHECK in (COMPETITOR/MARKET/CARS24_PRESS/CARS24_PR) | From cluster's primary article |
| `primary_competitor` | text CHECK | Inherited from cluster. Drives competitor-view filtering (`stories.primary_competitor = 'Spinny'` is faster + cleaner than the legacy `entities @> ['Spinny']`). |
| `entities` | text[] | Deduped union across members |
| `source_count` | int NOT NULL | Length of source_articles |
| `source_articles` | jsonb NOT NULL | `[{name, url, published_at, title}, ...]` |
| `primary_source_name` / `primary_source_url` / `image_url` | text | Picked from earliest member |
| `published_at` | tz NOT NULL | = latest source article / latest coverage activity |
| `created_at` / `updated_at` | tz | |

### Indexes

```sql
idx_stories_published_at desc
idx_stories_importance
idx_stories_bucket
idx_stories_primary_competitor -- primary_competitor = 'Spinny' for competitor views
idx_stories_entities (gin)     -- fallback entity search / debugging
```

### Why `source_articles` is jsonb (not a separate table)

The source list is read-only metadata, always fetched together with
the story. A jsonb column avoids a join and keeps the API surface
flat. We pay slightly more storage; we save query complexity.

---

## 5. `daily_briefs`

Cached output of `generate-daily-brief`. One row per `brief_date`.

| Column | Type | Notes |
|---|---|---|
| `brief_date` | date UNIQUE | Used as the read key |
| `hero_stories` | jsonb NOT NULL | Stories that have NEVER appeared in any prior brief. Strict no-repeat. |
| `still_developing` | jsonb NOT NULL DEFAULT `[]` | Compact one-liners for previously-shown stories whose cluster has had new article activity since the last brief that featured them. Shape: `[{story_id, cluster_id, title, primary_competitor, bucket, source_count, latest_update_at, days_running, first_seen_in_brief}]` |
| `window_hours` | int NOT NULL | 24, 48, or 72 (auto-widens when fresh-eligible count is low) |
| `is_quiet_day` / `quiet_day_note` | bool / text | UI banner copy |
| `competitor_pulse` | jsonb | Per-competitor sparkline data |
| `total_stories_in_window` | int | Footer transparency |
| `ai_cost_usd` | numeric(8,4) | Per-day pipeline cost |
| `generated_at` | tz | |

The website reads the latest row by `brief_date`.

---

## 6. `competitor_summaries`

Cached output of `generate-competitor-summary`. One row per
(competitor, scope, period_end).

| Column | Type | Notes |
|---|---|---|
| `competitor` | text NOT NULL | 'Spinny', 'CarDekho', 'Cars24', etc. |
| `scope` | text CHECK in ('week','quarter') | |
| `period_start` / `period_end` | date | |
| `context_line` | text | "Funding driving 250% mention spike" — for sparkline strip |
| `themed_summary` | jsonb NOT NULL | `{themes: [{title, bullets, story_ids}], total_stories: N}` |
| `story_count` | int NOT NULL | Underlying story count (not weekly count) |
| `generated_at` | tz | |
| **UNIQUE** `(competitor, scope, period_end)` | | Idempotent upserts |

Index: `idx_competitor_summaries_lookup (competitor, scope, period_end desc)`.

---

## 7. `pipeline_state`

Watermark + observability scratch. One row per stage.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `'rss_ingest'`, `'classifier'`, `'router'`, `'synthesizer'`, `'daily_brief'` |
| `last_processed_at` | tz | Watermark — what we've consumed up to |
| `last_run_at` | tz | When the function last ran |
| `last_run_status` | text | `'success'` / `'partial'` / `'error: <msg>'` |
| `last_run_meta` | jsonb | Free-form stats (counts, errors, costs) |

Seeded by `seed.sql` to `now() - 30 days` so first run picks up
recent history.

---

## RLS (Row-Level Security)

All tables have RLS enabled.

**Public read policies** (only):
- `stories_public_read` — `select` allowed for all
- `daily_briefs_public_read` — `select` allowed for all
- `competitor_summaries_public_read` — `select` allowed for all

**No public policies on** `sources`, `articles`, `clusters`,
`pipeline_state` → no public access at all. Edge Functions hold the
`BACKEND_API_KEY` (Supabase secret key) which bypasses RLS.

---

## Helper functions

### `find_candidate_clusters(query_embedding text, candidate_count int default 12, lookback_days int default 14, competitor text default null, article_published_at timestamptz default now(), max_event_gap_days int default 14)`

Returns top-K closest non-archived clusters ordered by cosine distance,
**restricted to clusters whose `primary_competitor` matches** (both null
is also a match — so MARKET/general articles only see other
MARKET/general clusters).

Recency is anchored to `article_published_at`, not wall-clock `now()`.
That matters during a 90-day historical reset: old articles from the
same week must be able to see each other even though they are older than
14 days from today. The additional `max_event_gap_days` guard prevents
same-theme/different-event merges (for example, a March 12 Cars24 CEO
exit article merging into a May 1 founder-exit cluster).

Note: `query_embedding` is `text` (not `vector`) — accepting text
avoids a PostgREST encoding edge case where pgvector params get
mangled. Inside the function we cast to `vector` via `query_embedding::vector`.
The `_shared/vector.ts` `toVectorLiteral()` helper formats the array
into the `[0.1,0.2,...]` text shape.

### `refresh_cluster_aggregates(target_cluster_id uuid)`

Called by `route-articles` after attaching an article to a cluster.
Recomputes `article_count`, `earliest_article_at`,
`latest_article_at`, updates `centroid` to the most-recent member's
embedding, and sets `needs_synthesis=true`.

### `archive_stale_clusters(max_age_days int default 14)`

Closes any non-archived cluster whose `latest_article_at` is older
than `max_age_days`. Returns the row count archived. Called by a
daily `pg_cron` job at 22:30 UTC (04:00 IST). Once a cluster is
archived, the router can never route into it — a fresh article on
the same theme starts a new cluster, which is the correct outcome
for a story that's been quiet for 2+ weeks.

---

## Migration history (informal)

The schema is `CREATE ... IF NOT EXISTS` everywhere, so it's
re-runnable. Major shape changes during the build:

1. **Initial schema** — articles + clusters + stories + daily_briefs
   + competitor_summaries.
2. **Added `bucket` column** — to articles + stories with the 4-bucket
   classification + indexes.
3. **Switched `find_candidate_clusters` signature** — embedding param
   went from `vector` to `text` to dodge PostgREST encoding.
4. **Added `pipeline_state` row for `daily_brief`** — for completeness.
5. **No destructive migrations.** Everything additive.

If you do a destructive change later, write a one-shot SQL migration
file under `supabase/migrations/` (currently unused; we ran SQL via
the Studio editor for this build).
