-- ============================================================================
-- Cars24 Brief — pg_cron Schedules
-- ============================================================================
-- Run AFTER deploying Edge Functions and AFTER setting these values in your
-- Supabase project's Vault (Settings -> Vault -> New Secret):
--
--   project_url           = https://<your-project-ref>.supabase.co
--   backend_api_key       = <your sb_secret_... key>
--
-- Then update the placeholders below before running.
-- ============================================================================

-- Helper: read a value from the Vault
-- (Supabase exposes vault.decrypted_secrets as a view of decrypted Vault secrets.)
--
-- Re-running this file is safe: existing schedules with the same names are
-- removed before being recreated.

select cron.unschedule('cars24-rss-ingest')
where exists (select 1 from cron.job where jobname = 'cars24-rss-ingest');

select cron.unschedule('cars24-daily-brief')
where exists (select 1 from cron.job where jobname = 'cars24-daily-brief');

-- (Defensive: tear down the short-lived noon/evening jobs if they were ever
-- scheduled. The product runs a single 06:05 IST brief.)
select cron.unschedule('cars24-daily-brief-noon')
where exists (select 1 from cron.job where jobname = 'cars24-daily-brief-noon');

select cron.unschedule('cars24-daily-brief-evening')
where exists (select 1 from cron.job where jobname = 'cars24-daily-brief-evening');

select cron.unschedule('cars24-archive-clusters')
where exists (select 1 from cron.job where jobname = 'cars24-archive-clusters');

select cron.unschedule('cars24-competitor-summary')
where exists (select 1 from cron.job where jobname = 'cars24-competitor-summary');

-- ---------------------------------------------------------------------------
-- 1. RSS ingest — every 2 hours
-- ---------------------------------------------------------------------------

select cron.schedule(
  'cars24-rss-ingest',
  '0 */2 * * *',                                  -- minute 0, every 2 hours
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/run-pipeline',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'backend_api_key')
      ),
      body := '{"stages": ["ingest", "classify", "route", "synthesize"]}'::jsonb
    );
  $$
);

-- ---------------------------------------------------------------------------
-- 2. Daily brief generation — once a day at 06:05 IST = 00:35 UTC
-- ---------------------------------------------------------------------------
-- The brief window for a given brief_date is anchored to that date's 06:05
-- IST mark — `(brief_date − 1) 06:05 IST → brief_date 06:05 IST`. The window
-- is fully determined by the date, not by wall-clock now, so manual re-runs
-- (e.g. for a backfill) converge on the same answer rather than sliding the
-- window forward.
--
-- A story published at 16:05 IST on May 7 lands in the May 8 brief (window
-- May 7 06:05 → May 8 06:05). A story published at 14:00 IST on May 8 lands
-- in the May 9 brief, surfacing the next morning.

select cron.schedule(
  'cars24-daily-brief',
  '35 0 * * *',                                   -- 00:35 UTC = 06:05 IST
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/generate-daily-brief',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'backend_api_key')
      ),
      body := '{}'::jsonb
    );
  $$
);

-- ---------------------------------------------------------------------------
-- 3. Cluster archival — daily at 04:00 IST = 22:30 UTC prev day
-- ---------------------------------------------------------------------------
-- Closes any cluster whose latest article is older than 14 days. Runs BEFORE
-- the daily brief and competitor summary so they only consider live clusters.

select cron.schedule(
  'cars24-archive-clusters',
  '30 22 * * *',                                  -- 22:30 UTC = 04:00 IST next day
  $$
    select archive_stale_clusters(14);
  $$
);

-- ---------------------------------------------------------------------------
-- 4. Per-competitor summaries — daily at 06:15 IST = 00:45 UTC
-- ---------------------------------------------------------------------------
-- Cadence rules (enforced inside the Edge Function):
--   - quarter scope:  re-derived from raw stories every day. The 90-day
--                     window slides forward, so daily refresh is correct.
--   - week scope:     covers a fixed Monday-Sunday window. The function
--                     auto-skips weekly generation on non-Mondays so we
--                     don't (a) re-LLM the same window and (b) produce a
--                     sliding 7-day window that overlaps yesterday by 6.
-- The cron still pokes the function daily because (a) quarterly always
-- runs, and (b) on Mondays the weekly will fire automatically.

select cron.schedule(
  'cars24-competitor-summary',
  '45 0 * * *',                                   -- 00:45 UTC = 06:15 IST
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/generate-competitor-summary',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'backend_api_key')
      ),
      body := '{"competitors": ["Cars24", "Spinny", "CarDekho", "Droom", "OLX Autos"], "scopes": ["week", "quarter"]}'::jsonb
    );
  $$
);

-- ---------------------------------------------------------------------------
-- Inspecting / managing schedules
-- ---------------------------------------------------------------------------
-- View all schedules:           select * from cron.job;
-- View recent runs:              select * from cron.job_run_details order by start_time desc limit 20;
-- Unschedule a job:              select cron.unschedule('cars24-rss-ingest');
-- ---------------------------------------------------------------------------
