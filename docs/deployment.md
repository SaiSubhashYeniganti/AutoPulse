# Deploy guide — start to finish (~30 min)

If you already have a Supabase project + Vercel account + OpenAI API key, this should take 30 minutes flat.

---

## 0. Prereqs

```bash
brew install supabase/tap/supabase   # Supabase CLI
node -v                               # 18+ required
```

You'll need:
- An OpenAI API key with at least $15 in credit (current model mix is roughly $10–15/mo at expected volume)
- A Supabase project (free tier is enough)
- A Vercel account (free tier is enough)

---

## 1. Create the database

In Supabase dashboard → **SQL Editor** → New query, run these in order:

1. Paste **`supabase/schema.sql`** → Run.
   - Creates 7 tables, enables pgvector, sets up RLS.
   - Should finish in <5 seconds.

2. Paste **`supabase/seed.sql`** → Run.
   - Inserts 10 RSS sources and initialises pipeline state rows.

Don't run `cron.sql` yet — schedules need the deployed functions.

---

## 2. Set up Edge Function secrets

Supabase dashboard → **Project Settings → Edge Functions → Secrets** → add:

```
OPENAI_API_KEY=sk-...
BACKEND_API_KEY=sb_secret_...
```

(`SUPABASE_URL` is auto-injected. `BACKEND_API_KEY` holds your Supabase **secret** API key — Supabase blocks env names starting with `SUPABASE_`, so we use `BACKEND_API_KEY` instead. Get the value from Project Settings → API Keys.)

Optional tuning vars (defaults are fine):

```
MAX_ARTICLES_PER_SOURCE=25
FIRST_RUN_LOOKBACK_HOURS=720
ROUTER_CANDIDATE_K=5
```

---

## 3. Deploy Edge Functions

From the repo root:

```bash
# Get your project ref from Supabase dashboard URL
supabase link --project-ref <your-project-ref>

# Deploy all 7 functions.
# New Supabase sb_publishable_/sb_secret_ keys require --no-verify-jwt.
# The functions implement their own apikey-header check.
supabase functions deploy rss-ingest --no-verify-jwt
supabase functions deploy classify-articles --no-verify-jwt
supabase functions deploy route-articles --no-verify-jwt
supabase functions deploy synthesize-stories --no-verify-jwt
supabase functions deploy generate-daily-brief --no-verify-jwt
supabase functions deploy generate-competitor-summary --no-verify-jwt
supabase functions deploy run-pipeline --no-verify-jwt
```

Or in one shot:

```bash
for fn in rss-ingest classify-articles route-articles synthesize-stories \
          generate-daily-brief generate-competitor-summary run-pipeline; do
  supabase functions deploy $fn --no-verify-jwt
done
```

---

## 4. Smoke-test the pipeline manually

```bash
# Set these to make the curl commands shorter
export PROJECT_URL=https://<your-project-ref>.supabase.co
export BACKEND_API_KEY=<your-sb_secret-key>

# 4a. Ingest RSS (force=true bypasses the 2h throttle for first run)
curl -sX POST "$PROJECT_URL/functions/v1/rss-ingest" \
  -H "apikey: $BACKEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"force": true}' | jq

# Expect: {ok: true, sources_processed: 10, articles_inserted: 50-200}
```

```bash
# 4b. Classify what got ingested
curl -sX POST "$PROJECT_URL/functions/v1/classify-articles" \
  -H "apikey: $BACKEND_API_KEY" \
  -d '{"limit": 50}' | jq

# Expect: {ok: true, processed: N, counts: {HIGH: 1-3, MED: 5-10, LOW: 10-20, DROP: 20-50}}
```

```bash
# 4c. Embed + route into clusters
curl -sX POST "$PROJECT_URL/functions/v1/route-articles" \
  -H "apikey: $BACKEND_API_KEY" \
  -d '{"limit": 50}' | jq

# Expect: {ok: true, processed: N, decision_counts: {route_to_existing: A, create_new: B}}
```

```bash
# 4d. Synthesize stories
curl -sX POST "$PROJECT_URL/functions/v1/synthesize-stories" \
  -H "apikey: $BACKEND_API_KEY" \
  -d '{"limit": 30}' | jq

# Expect: {ok: true, processed: M (clusters with HIGH/MED articles)}
```

```bash
# 4e. Generate today's brief
curl -sX POST "$PROJECT_URL/functions/v1/generate-daily-brief" \
  -H "apikey: $BACKEND_API_KEY" \
  -d '{}' | jq

# Expect: {ok: true, hero_count: 3-5, competitor_pulse_count: 6}
```

```bash
# 4f. Generate first competitor summaries
curl -sX POST "$PROJECT_URL/functions/v1/generate-competitor-summary" \
  -H "apikey: $BACKEND_API_KEY" \
  -d '{}' | jq
```

Or just run the orchestrator and skip the manual chaining:

```bash
curl -sX POST "$PROJECT_URL/functions/v1/run-pipeline" \
  -H "apikey: $BACKEND_API_KEY" \
  -d '{"stages": ["ingest","classify","route","synthesize","brief","competitor"]}' | jq
```

---

## 5. Schedule pg_cron

Two prerequisites:

a. **Add Vault secrets** (Supabase dashboard → Project Settings → Vault → New secret):

   ```
   Name: project_url
   Secret: https://<your-project-ref>.supabase.co
   ```
   ```
   Name: backend_api_key
   Secret: <your-sb_secret-key>
   ```

b. **Run `supabase/cron.sql`** in the SQL Editor.

Verify schedules are live:

```sql
select jobname, schedule, command from cron.job;
-- Expect 4 rows: cars24-rss-ingest, cars24-archive-clusters, cars24-daily-brief, cars24-competitor-summary
```

---

## 6. Deploy the web app

```bash
cd web
cp .env.example .env.local
# Edit .env.local with your NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
# (publishable key is in Supabase dashboard → Project Settings → API Keys)

npm install
npm run dev
# → http://localhost:3000 — should show today's brief
```

Push to Vercel:

```bash
npm i -g vercel
vercel --prod
# Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY when prompted
```

---

## 7. (Optional) Custom domain

In Vercel project → **Settings → Domains** → Add your subdomain (e.g. `brief.example.com`).

Vercel gives you a CNAME target — add it to your DNS provider:

```
Record:  brief.example.com
Type:    CNAME
Value:   cname.vercel-dns.com
```

Cert provisioning takes <1 minute.

---

## Watching it run

```sql
-- Pipeline state per stage (one row per stage)
select id, last_run_at, last_run_status, last_run_meta from pipeline_state;

-- Cron job history (last 20 runs)
select jobid, status, return_message, start_time
from cron.job_run_details order by start_time desc limit 20;

-- Source health (any sources erroring out?)
select name, last_fetched_at, last_status from sources order by last_fetched_at desc nulls last;

-- Today's pipeline output stats
select pipeline_state, count(*) from articles where fetched_at > now() - interval '24 hours' group by 1;

-- Importance distribution today
select importance, count(*) from articles where classified_at > now() - interval '24 hours' group by 1;

-- Latest daily brief
select brief_date, window_hours, is_quiet_day, jsonb_array_length(hero_stories) as hero_count, ai_cost_usd
from daily_briefs order by brief_date desc limit 5;
```

---

## Troubleshooting

**`rss-ingest` returns errors for some sources** — Some Indian outlets 403 generic UAs or have intermittent
500s. The function records the error in `sources.last_status` and keeps going for the others. If a source
errors for >24h, swap the URL in the seed file.

**`classify-articles` returns 0 processed** — All articles already classified (re-run is idempotent), or
none in `pipeline_state='ingested'`. Check: `select pipeline_state, count(*) from articles group by 1;`

**`route-articles` errors with "vector dimension mismatch"** — `text-embedding-3-small` returns 1536-dim
vectors; the schema expects 1536. If you change the embed model, update `vector(1536)` in `schema.sql`.

**Empty hero on the website** — Either the brief hasn't been generated (run `generate-daily-brief` manually),
or there are no MED/HIGH-with-implication stories in the 24h window. The window is strict; we don't widen.
Check the `daily_briefs` row and the underlying `stories` table for the day.
