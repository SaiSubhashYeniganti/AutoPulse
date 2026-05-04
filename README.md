# Cars24 Brief

A daily AI-powered intelligence brief on the Indian used-car market for Cars24's leadership team. Aggregates news from 10+ sources, deduplicates overlapping coverage, classifies for relevance, and ships a single 1-page brief that's readable in 2 minutes.

```
RSS / Google News
   │
   ▼
articles            (raw, deduped by URL)
   │
   │  classify-articles
   ▼  (gpt-4o → importance + bucket + entities + cars24_implication)
   │
articles            (importance ∈ {HIGH, MED, LOW, DROP}, bucket, …)
   │
   │  route-articles
   ▼  (embed → pgvector top-K → gpt-4o picks: route_to_existing | create_new)
   │
clusters            (1..N articles per real-world event)
   │
   │  synthesize-stories
   ▼  (gpt-4o per cluster → one editorial story + Cars24 implication)
   │
stories
   │
   ├──► generate-daily-brief         → daily_briefs            (cached, served to UI)
   └──► generate-competitor-summary  → competitor_summaries    (per competitor × week/quarter)
```

---

## What it does

1. **Ingests** Indian auto news every 2 hours from 4 trade-press RSS feeds + 6+ Google News entity/topic queries (Cars24, Spinny, CarDekho, Droom, OLX Autos, "used cars India", "car depreciation India").
2. **Classifies** every article through an LLM that asks: *"Would the Cars24 leadership team want to know about this in the next 24 hours?"* Outputs `importance`, `bucket`, `entities`, `primary_competitor`, and a 1-line `cars24_implication`.
3. **Clusters** articles about the same real-world event using OpenAI embeddings as a candidate filter and GPT-4o for the final routing decision (so 5 articles about "Spinny raised X" become *one* story, not 5).
4. **Synthesizes** each cluster into a single editorial story with a "What this means for Cars24" callout.
5. **Serves** a single web page: today's hero, weekly recap, per-competitor pulse, and yesterday's brief in an accordion. No tabs to navigate, no login. One scroll. Built for an executive with a coffee.

---

## Quickstart

```bash
# 1. Clone + install web deps
cd web && npm install

# 2. Configure environment
cp .env.example .env.local                   # at repo root, also web/.env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
#              OPENAI_API_KEY, BACKEND_API_KEY

# 3. Run the database setup (paste each into Supabase SQL Editor)
#    supabase/schema.sql
#    supabase/seed.sql
#    supabase/cron.sql        (only after Edge Functions are deployed)

# 4. Deploy Edge Functions
supabase link --project-ref <your-project-ref>
for fn in rss-ingest classify-articles route-articles \
          synthesize-stories generate-daily-brief generate-competitor-summary \
          run-pipeline; do
  supabase functions deploy $fn --no-verify-jwt
done

# 5. Trigger the first pipeline run
curl -X POST "https://<project-ref>.supabase.co/functions/v1/run-pipeline" \
  -H "apikey: $BACKEND_API_KEY"

# 6. Run the web app
cd web && npm run dev          # http://localhost:3000
```

Full instructions: [`docs/deployment.md`](./docs/deployment.md).

---

## Repository layout

```
.
├── README.md                            ← this file
├── CONTRIBUTING.md                      ← setup + workflow
├── LICENSE
├── .env.example
│
├── docs/
│   ├── README.md                        ← documentation index
│   ├── product.md                       ← what we built and why
│   ├── architecture.md                  ← system overview
│   ├── pipeline.md                      ← per-function deep dive
│   ├── data-model.md                    ← schema, RLS, helpers
│   ├── prompts.md                       ← every LLM prompt + rationale
│   ├── operations.md                    ← cron, costs, observability
│   ├── deployment.md                    ← end-to-end deploy guide
│   ├── decisions.md                     ← key design decisions
│   └── user-flows.md                    ← reader / operator walkthroughs
│
├── supabase/
│   ├── schema.sql                       ← all tables, indexes, pgvector
│   ├── seed.sql                         ← 10+ sources + initial pipeline state
│   ├── cron.sql                         ← pg_cron schedules
│   └── functions/
│       ├── _shared/                     ← supabase, openai, rss, vector helpers
│       ├── rss-ingest/
│       ├── classify-articles/
│       ├── route-articles/
│       ├── synthesize-stories/
│       ├── generate-daily-brief/
│       ├── generate-competitor-summary/
│       └── run-pipeline/                ← orchestrator
│
├── web/                                 ← Next.js 14 (App Router)
│   ├── app/
│   ├── components/
│   ├── lib/
│   └── package.json
│
└── design/                              ← visual guidelines + image prompts
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 App Router, React Server Components, Tailwind, TypeScript |
| Backend  | Supabase Edge Functions (Deno + TypeScript) |
| Database | Supabase Postgres with `pgvector` for embeddings |
| AI       | OpenAI GPT-4o (classification / routing / synthesis), `text-embedding-3-small` (embeddings), `gpt-4o-mini` (lightweight context lines) |
| Scheduling | `pg_cron` inside Supabase |
| Hosting  | Vercel (frontend), Supabase (backend) |

Total Edge Function code: **~2,400 LOC across 7 functions.**

---

## Cost

| Component | Approx. monthly cost |
|---|---:|
| Supabase free tier | $0 |
| Vercel free tier   | $0 |
| OpenAI (≈50 articles/day, 12 clusters/day) | ≈$11 |
| **Total**          | **≈$11/month** |

Tracked per-day in `daily_briefs.ai_cost_usd` and surfaced in the UI footer.

---

## Documentation

Start with [`docs/README.md`](./docs/README.md) for the documentation index. Recommended reading order:

1. [`docs/product.md`](./docs/product.md) — what the product is and who it's for
2. [`docs/architecture.md`](./docs/architecture.md) — system overview
3. [`docs/pipeline.md`](./docs/pipeline.md) — how each Edge Function works
4. [`docs/decisions.md`](./docs/decisions.md) — key design decisions and trade-offs
5. [`docs/deployment.md`](./docs/deployment.md) — how to ship it

---

## License

[MIT](./LICENSE).
