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
-- 2. Daily brief generation — 06:05 IST = 00:35 UTC
-- ---------------------------------------------------------------------------

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
-- 4. Per-competitor weekly + quarterly summaries — daily at 06:15 IST = 00:45 UTC
-- ---------------------------------------------------------------------------

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
