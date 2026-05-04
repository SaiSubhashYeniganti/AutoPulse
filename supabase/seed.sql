-- ============================================================================
-- Cars24 Brief — Source Seed
-- ============================================================================
-- 10 sources covering Indian auto news, competitor watching, and used-car-relevant topics.
-- Mix: 4 trade-press direct RSS + 6 Google News entity/topic queries.
--
-- Run AFTER schema.sql. Idempotent (uses upsert on URL).

-- Ensure unique constraint on sources.url (needed for ON CONFLICT below)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sources_url_unique'
  ) then
    alter table sources add constraint sources_url_unique unique (url);
  end if;
end $$;

insert into sources (name, url, source_type, fetch_interval_minutes) values

-- ─── Trade press direct RSS (3) + high-signal market watch (1) ───────────────

(
  'ET Auto',
  'https://auto.economictimes.indiatimes.com/rss/topstories',
  'rss',
  120
),
(
  'Autocar India',
  'https://www.autocarindia.com/rss/all',
  'rss',
  180
),
(
  'Live Mint Auto',
  'https://www.livemint.com/rss/auto',
  'rss',
  180
),
(
  'Google News: Indian auto industry',
  'https://news.google.com/rss/search?q=Indian+auto+industry&hl=en-IN&gl=IN&ceid=IN:en',
  'google_news',
  120
),

-- ─── Google News competitor watches (5, one per competitor) ─────────────────
-- All five queries use the SAME event-oriented template:
--   "<Competitor>" (funding OR raises OR acquires OR acquisition OR layoffs
--                  OR launches OR partnership OR IPO OR appoints OR exits
--                  OR hires OR resigns OR "steps down" OR profit OR loss
--                  OR revenue)
-- Quotes around entity names force exact-phrase matching. The verb list
-- restricts results to *strategic moves* — without it, queries like "CarDekho"
-- return mostly the company's own car-review content, not news *about* them.

(
  'Google News: Cars24',
  'https://news.google.com/rss/search?q=%22Cars24%22+%28funding+OR+raises+OR+acquires+OR+acquisition+OR+layoffs+OR+launches+OR+partnership+OR+IPO+OR+appoints+OR+exits+OR+hires+OR+resigns+OR+%22steps+down%22+OR+profit+OR+loss+OR+revenue%29&hl=en-IN&gl=IN&ceid=IN:en',
  'google_news',
  120
),
(
  'Google News: Spinny',
  'https://news.google.com/rss/search?q=%22Spinny%22+%28funding+OR+raises+OR+acquires+OR+acquisition+OR+layoffs+OR+launches+OR+partnership+OR+IPO+OR+appoints+OR+exits+OR+hires+OR+resigns+OR+%22steps+down%22+OR+profit+OR+loss+OR+revenue%29&hl=en-IN&gl=IN&ceid=IN:en',
  'google_news',
  120
),
(
  'Google News: CarDekho',
  'https://news.google.com/rss/search?q=%22CarDekho%22+%28funding+OR+raises+OR+acquires+OR+acquisition+OR+layoffs+OR+launches+OR+partnership+OR+IPO+OR+appoints+OR+exits+OR+hires+OR+resigns+OR+%22steps+down%22+OR+profit+OR+loss+OR+revenue%29&hl=en-IN&gl=IN&ceid=IN:en',
  'google_news',
  120
),
(
  'Google News: Droom',
  'https://news.google.com/rss/search?q=%22Droom%22+%28funding+OR+raises+OR+acquires+OR+acquisition+OR+layoffs+OR+launches+OR+partnership+OR+IPO+OR+appoints+OR+exits+OR+hires+OR+resigns+OR+%22steps+down%22+OR+profit+OR+loss+OR+revenue%29&hl=en-IN&gl=IN&ceid=IN:en',
  'google_news',
  120
),
(
  'Google News: OLX Autos',
  'https://news.google.com/rss/search?q=%22OLX+Autos%22+%28funding+OR+raises+OR+acquires+OR+acquisition+OR+layoffs+OR+launches+OR+partnership+OR+IPO+OR+appoints+OR+exits+OR+hires+OR+resigns+OR+%22steps+down%22+OR+profit+OR+loss+OR+revenue%29&hl=en-IN&gl=IN&ceid=IN:en',
  'google_news',
  120
),

-- ─── Google News topic watches (2) ───────────────────────────────────────────

(
  'Google News: Used cars India',
  'https://news.google.com/rss/search?q=%22used+cars%22+India&hl=en-IN&gl=IN&ceid=IN:en',
  'google_news',
  240
),
(
  'Google News: Car depreciation / used car prices',
  'https://news.google.com/rss/search?q=%28%22car+depreciation%22+OR+%22used+car+prices%22%29+India&hl=en-IN&gl=IN&ceid=IN:en',
  'google_news',
  240
)

on conflict (url) do update set
  name = excluded.name,
  source_type = excluded.source_type,
  fetch_interval_minutes = excluded.fetch_interval_minutes,
  is_active = true;

-- Initialize pipeline_state rows (so the orchestrator has watermarks to read on first run)
insert into pipeline_state (id, last_processed_at, last_run_at, last_run_status) values
  ('rss_ingest',  now() - interval '30 days', null, null),
  ('classifier',  now() - interval '30 days', null, null),
  ('router',      now() - interval '30 days', null, null),
  ('synthesizer', now() - interval '30 days', null, null),
  ('daily_brief', now() - interval '30 days', null, null)
on conflict (id) do nothing;
