# Operations

How the live system runs day-to-day, how to deploy, and the current
state.

> Engineering quickstart: [`../README.md`](../README.md)
> Full deploy guide: [`./deployment.md`](./deployment.md)

---

## Deployment topology

| Component | Where |
|---|---|
| Database + Edge Functions | Supabase project (URL configured via `NEXT_PUBLIC_SUPABASE_URL`) |
| Frontend (Next.js) | Vercel |
| Cron schedules | `pg_cron` in the same Supabase project (3 jobs — see below) |
| OpenAI account | Configured via `OPENAI_API_KEY` |

---

## Environment variables

### Edge Functions (Supabase Dashboard → Edge Functions → Secrets)

| Var | Purpose |
|---|---|
| `BACKEND_API_KEY` | The `sb_secret_...` key. Bypasses RLS. Used by Edge Functions to write to the DB and by `run-pipeline` to call sub-functions. |
| `OPENAI_API_KEY` | OpenAI API key. Used by classifier, router (embeddings), synthesizer. |
| `SUPABASE_URL` | Auto-injected by Supabase. |
| `CLASSIFY_BATCH_SIZE` | Optional. Default 30. |
| `CLASSIFY_CONCURRENCY` | Optional. Default 5. |
| `BACKFILL_HOURS` | First-run RSS backfill window. Default 720 (30d). |

### Vercel (Project → Settings → Environment Variables)

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public — embedded in client bundle |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The `sb_publishable_...` key. Public read on whitelisted tables only. |

### Supabase Vault (Settings → Vault → New Secret)

For `pg_cron` to call Edge Functions, it needs these:

| Secret name | Value |
|---|---|
| `project_url` | The project's `https://<project-ref>.supabase.co` URL |
| `backend_api_key` | The same `sb_secret_...` key |

---

## Cron schedule

All times in UTC. IST = UTC+5:30.

| Job name | Schedule | What it does |
|---|---|---|
| `cars24-rss-ingest` | `0 */2 * * *` (every 2h on the hour) | Calls `run-pipeline` with `["ingest","classify","route","synthesize"]` |
| `cars24-daily-brief` | `30 0 * * *` (00:30 UTC = 06:00 IST) | Calls `generate-daily-brief` |
| `cars24-competitor-summary` | `30 23 * * *` (23:30 UTC = 05:00 IST next day) | Calls `generate-competitor-summary` for all competitors + scopes |

Inspect:

```sql
select * from cron.job;
select * from cron.job_run_details order by start_time desc limit 20;
```

Unschedule:

```sql
select cron.unschedule('cars24-rss-ingest');
```

---

## Deployment

Full instructions in [`./deployment.md`](./deployment.md). TL;DR:

```bash
# 1. Schema (one-time, or after schema changes)
supabase db push   # or paste schema.sql into Studio

# 2. Seed sources (idempotent)
psql ... -f supabase/seed.sql

# 3. Edge Functions (each deployed separately)
for fn in rss-ingest classify-articles route-articles \
          synthesize-stories generate-daily-brief \
          generate-competitor-summary run-pipeline backfill-history; do
  supabase functions deploy $fn --no-verify-jwt
done

# 4. Cron (after Vault secrets are set)
psql ... -f supabase/cron.sql

# 5. Frontend
cd web && vercel --prod
```

The `--no-verify-jwt` flag is required because we use `apikey` header
auth (the new Supabase model), not JWT bearer auth.

---

## Manual triggers

For demoing, debugging, or after deploys.

```bash
# Full pipeline
curl -X POST "$SUPABASE_URL/functions/v1/run-pipeline" \
  -H "apikey: $BACKEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"stages":["ingest","classify","route","synthesize"]}'

# Single stage
curl -X POST "$SUPABASE_URL/functions/v1/classify-articles" \
  -H "apikey: $BACKEND_API_KEY"

# Daily brief (force regenerate)
curl -X POST "$SUPABASE_URL/functions/v1/generate-daily-brief" \
  -H "apikey: $BACKEND_API_KEY"

# Backfill (one-shot, one query at a time)
curl -X POST "$SUPABASE_URL/functions/v1/backfill-history" \
  -H "apikey: $BACKEND_API_KEY" \
  -d '{"query":"Spinny","weeks_back":12,"slice_days":14,"max_per_period":8}'
```

---

## Cost model

Per-call OpenAI pricing (from `_shared/openai.ts`):

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|---|---:|---:|
| `gpt-4o` | $2.50 | $10.00 |
| `gpt-4o-mini` (not used) | $0.15 | $0.60 |
| `text-embedding-3-small` | $0.02 | — |

**Daily cost estimate** (at ~50 articles/day, ~12 clusters/day):

| Component | Calls | Tokens (in/out) | Cost |
|---|---:|---|---:|
| Classify (50 articles) | 50 | ~400 / ~150 | ~$0.13 |
| Embed (50 articles) | 50 | ~300 in (free output) | ~$0.0003 |
| Route (50 articles, ~80% need LLM) | 40 | ~600 / ~80 | ~$0.09 |
| Synthesize (12 clusters) | 12 | ~1500 / ~250 | ~$0.075 |
| Daily brief (1) | 1 | small | ~$0.005 |
| Competitor summaries (5 × 2 = 10) | 10 | ~1500 / ~400 | ~$0.07 |
| **Total** | ~113 | | **~$0.37 / day** |

Monthly: **~$11**. Trivially scalable to 5x volume.

`ai_cost_usd` is tracked per daily brief in the `daily_briefs` table
for transparency in the UI footer.

---

## Current data snapshot (as of last cron tick)

> Run `select count(*), max(published_at) from articles;` in Supabase
> Studio for live numbers. Approximate as of build:

| Table | Row count | Notes |
|---|---:|---|
| `sources` | 11 | 3 trade-press + 8 Google News |
| `articles` (total) | varies | After 90-day Google News backfill + live RSS; competitor queries are event-oriented, so review noise is lower |
| `articles` (last 24h) | ~40-50 | Typical day |
| `articles` (DROP) | ~40% | Healthy noise filter rate |
| `clusters` | ~150-200 | Some are single-article (cluster-of-one) |
| `stories` | ~150-200 | One per cluster |
| `daily_briefs` | 1+ | One row per `brief_date` |
| `competitor_summaries` | 10 | 5 competitors × 2 scopes |

---

## Observability

### Per-stage state

```sql
select id, last_processed_at, last_run_at, last_run_status, last_run_meta
from pipeline_state
order by id;
```

`last_run_meta` typically contains `{processed_count, error_count,
cost_usd, ...}` from the most recent invocation.

### Per-source health

```sql
select name, last_fetched_at, last_status
from sources
where is_active = true
order by last_fetched_at desc;
```

`last_status` is a freeform error/success string.

### Cron run history

```sql
select * from cron.job_run_details
order by start_time desc
limit 20;
```

### Cost tracking

```sql
select brief_date, total_stories_in_window, ai_cost_usd
from daily_briefs
order by brief_date desc;
```

---

## Known operational issues

These are open and would be addressed if this became a real product.

1. **No source-health dashboard.** A dead RSS feed surfaces only via
   `sources.last_status` SQL. Should render in an admin page.

2. **No paging on classify.** If we ever fall behind by >30 articles,
   each cron tick only catches up 30. Ratchet: if backlog > N,
   trigger `classify-articles` 2-3x in a row.

3. **No structured logging / alerting.** Errors land in Supabase
   function logs but no PagerDuty/Slack hook. For a real product:
   wire `pipeline_state.last_run_status LIKE 'error:%'` to an alert.

4. **Centroid is "most recent member" not "average".** Cheaper but
   slightly drifty in big clusters. At our cluster sizes (<20)
   irrelevant; at 100+ would matter.

5. **No cluster archival.** `clusters.is_archived` exists but we don't
   set it. After ~90 days the candidate-cluster ANN search is doing
   useless work on stale clusters. Add a daily archive job.

6. **Backfill is one-shot.** Future quarterly depth fills in
   organically; if we wanted continuous quarterly refresh, we'd need
   a weekly backfill job (with rate-limit care).

---

## Disaster recovery

| Scenario | Recovery |
|---|---|
| Bad deploy of one function | `supabase functions deploy <fn> --no-verify-jwt` from previous git SHA |
| DB corruption / accidental DROP | Supabase point-in-time recovery (PITR), 7 days retention on free tier |
| Vercel down | Frontend goes dark; pipeline keeps running; recovers when Vercel does |
| OpenAI down | Pipeline stalls in current stage; auto-resumes when OpenAI is back (next cron tick) |
| Schema change with existing rows | Always additive; we never DROP. If you must, write a one-shot migration. |

---

## Pre-demo checklist

Before showing the live site to a stakeholder:

- [ ] Trigger a fresh `run-pipeline` manually so the brief is current.
- [ ] Trigger `generate-daily-brief` so today's hero is freshly built.
- [ ] Open the web URL on a clean browser; verify hero stories load
      and competitor pulse expands cleanly.
- [ ] Verify the `[COMPETITOR]` / `[MARKET]` / `[CARS24]` tags render.
- [ ] Verify the "Yesterday's brief" accordion expands.
- [ ] Verify at least one competitor row's quarterly view shows real
      content (or the honest "filling in" message — both are fine).
- [ ] Check `pipeline_state` for any stages stuck in `error:` status.
- [ ] Have a `cron.job_run_details` query ready for "show me the last
      cron run" questions.
