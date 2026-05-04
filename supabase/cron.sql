-- ============================================================================
-- Cars24 Brief — pg_cron Schedules
-- ============================================================================
-- Run AFTER deploying Edge Functions and AFTER setting these values in your
-- Supabase project's Vault (Settings → Vault → New Secret):
--
--   project_url           = https://<your-project-ref>.supabase.co
--   backend_api_key       = <your sb_secret_... key>
--
-- Then update the placeholders below before running.
-- ============================================================================

-- Helper: read a value from the Vault
-- (Supabase exposes vault.decrypted_secrets as a view of decrypted Vault secrets.)

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
-- 2. Daily brief generation — 06:00 IST = 00:30 UTC
-- ---------------------------------------------------------------------------

select cron.schedule(
  'cars24-daily-brief',
  '30 0 * * *',                                   -- 00:30 UTC = 06:00 IST
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
-- 4. Per-competitor weekly + quarterly summaries — daily at 05:00 IST = 23:30 UTC prev day
-- ---------------------------------------------------------------------------

select cron.schedule(
  'cars24-competitor-summary',
  '30 23 * * *',                                  -- 23:30 UTC = 05:00 IST next day
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
