-- ============================================================================
-- 2026-05-04 — primary_competitor migration
-- ============================================================================
-- Adds primary_competitor as a hard cluster-routing attribute and a daily
-- cluster archival policy.
--
-- Run order:
--   1. Apply schema.sql (idempotent, adds columns + helpers).
--   2. Run the BACKFILL block below to derive primary_competitor on existing
--      articles + clusters + stories from the entities[] array.
--   3. Optionally archive old clusters one time (the daily cron picks it up
--      from then on).
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── 1. Backfill articles.primary_competitor from entities[] ───────────────────
-- Pick the first entity that matches our 5 tracked competitors. If none, leave null.
-- Order in the CASE matters: we prefer Cars24 > Spinny > CarDekho > Droom > OLX
-- so that a story mentioning multiple gets attributed to its primary actor.
-- (For day-one backfill this is "good enough"; the classifier will set the
-- field correctly from now on.)

update articles
set primary_competitor = case
  when 'Cars24'    = any(entities) then 'Cars24'
  when 'Spinny'    = any(entities) then 'Spinny'
  when 'CarDekho'  = any(entities) then 'CarDekho'
  when 'Droom'     = any(entities) then 'Droom'
  when 'OLX Autos' = any(entities) or 'OLX' = any(entities) then 'OLX Autos'
  else null
end
where primary_competitor is null;

-- ── 2. Backfill clusters.primary_competitor from member articles ─────────────
-- A cluster's primary_competitor = the most common non-null primary_competitor
-- among its members. If members are mixed, pick the most frequent. If all null,
-- leave the cluster null (MARKET).
--
-- Note: this can leave us with "polluted" clusters whose old members don't all
-- match. That's acceptable for backfill — the router going forward will keep
-- new clusters clean. We don't try to split existing clusters retroactively.

with cluster_competitors as (
  select
    cluster_id,
    primary_competitor,
    count(*) as cnt,
    row_number() over (
      partition by cluster_id
      order by count(*) desc, primary_competitor
    ) as rnk
  from articles
  where cluster_id is not null
    and primary_competitor is not null
  group by cluster_id, primary_competitor
)
update clusters c
set primary_competitor = cc.primary_competitor
from cluster_competitors cc
where c.id = cc.cluster_id
  and cc.rnk = 1
  and c.primary_competitor is null;

-- ── 3. Backfill stories.primary_competitor from cluster ──────────────────────

update stories s
set primary_competitor = c.primary_competitor
from clusters c
where s.cluster_id = c.id
  and s.primary_competitor is null
  and c.primary_competitor is not null;

-- ── 4. Archive stale clusters (one-time cleanup) ─────────────────────────────
-- Anything whose latest article is older than 14 days gets closed.

select archive_stale_clusters(14);

-- ── 5. Sanity check (run manually) ───────────────────────────────────────────
-- Should show distribution across 5 competitors + null:
--   select primary_competitor, count(*) from articles group by 1 order by 2 desc;
--   select primary_competitor, count(*) from clusters where is_archived = false group by 1 order by 2 desc;
--   select primary_competitor, count(*) from stories group by 1 order by 2 desc;
