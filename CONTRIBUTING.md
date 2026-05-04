# Contributing

Thanks for taking a look. This guide covers local setup, the development loop, and the conventions used in this repo.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥18.17 | Next.js 14 requirement |
| npm | ≥9 | Package manager (yarn/pnpm should also work) |
| Supabase CLI | latest | Edge Function deploy + local dev |
| Deno | ≥1.40 (optional) | Edge Functions run in Deno; only needed for local function dev |
| OpenAI API key | — | Pipeline calls GPT-4o + `text-embedding-3-small` |

---

## Local setup

```bash
# 1. Clone
git clone <repo-url> cars24-brief
cd cars24-brief

# 2. Web app deps
cd web && npm install && cd ..

# 3. Environment
cp .env.example .env.local           # repo root
cp .env.example web/.env.local       # web app
# Fill in OPENAI_API_KEY, NEXT_PUBLIC_SUPABASE_URL,
#         NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, BACKEND_API_KEY

# 4. Database (paste each into your Supabase project's SQL Editor)
#    supabase/schema.sql      # tables, indexes, pgvector, helpers
#    supabase/seed.sql        # 10+ sources + initial pipeline state
#    supabase/cron.sql        # only after Edge Functions are deployed

# 5. Edge Functions
supabase link --project-ref <your-project-ref>
for fn in rss-ingest backfill-history classify-articles route-articles \
          synthesize-stories generate-daily-brief generate-competitor-summary \
          run-pipeline; do
  supabase functions deploy $fn --no-verify-jwt
done

# 6. Trigger the first pipeline run
curl -X POST "https://<project-ref>.supabase.co/functions/v1/run-pipeline" \
  -H "apikey: $BACKEND_API_KEY"

# 7. Run the dev server
cd web && npm run dev          # http://localhost:3000
```

Detailed step-by-step, including Vercel deployment and DNS: [`docs/deployment.md`](./docs/deployment.md).

---

## Development loop

### Web app

```bash
cd web
npm run dev          # local Next.js dev server (http://localhost:3000)
npm run build        # production build
npm run lint         # eslint
```

### Edge Functions

```bash
# Deploy a single function after a change
supabase functions deploy classify-articles --no-verify-jwt

# Trigger a single stage (auth via the BACKEND_API_KEY)
curl -X POST "https://<project-ref>.supabase.co/functions/v1/classify-articles" \
  -H "apikey: $BACKEND_API_KEY"

# Or run the whole pipeline
curl -X POST "https://<project-ref>.supabase.co/functions/v1/run-pipeline" \
  -H "apikey: $BACKEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"stages":["ingest","classify","route","synthesize"]}'
```

### Database

Schema lives in `supabase/schema.sql`. Migrations (additive only) live in `supabase/migrations/`. Run them via the Supabase SQL editor or `supabase db push`.

---

## Conventions

- **Stateless functions.** Each Edge Function in `supabase/functions/` does one thing and is independently triggerable. State lives in `pipeline_state`.
- **Watermark-driven.** Each stage advances `pipeline_state.<stage>.last_processed_at` after a successful batch. Re-runs are safe.
- **Schema is additive.** Never `DROP COLUMN`. New columns get a migration in `supabase/migrations/` named `YYYY_MM_DD_<change>.sql`.
- **All LLM prompts live next to their function.** Update [`docs/prompts.md`](./docs/prompts.md) whenever you change one.
- **All design decisions get logged.** If you change something architectural, add (or amend) an entry in [`docs/decisions.md`](./docs/decisions.md).
- **No secrets in code or commits.** Secrets go in `.env.local` and `supabase/.env`, both gitignored.

---

## Project structure

See [`README.md`](./README.md#repository-layout) for the full layout. Quick reference:

- `web/` — Next.js 14 frontend.
- `supabase/functions/` — 8 Edge Functions (Deno + TypeScript).
- `supabase/schema.sql` / `supabase/seed.sql` / `supabase/cron.sql` — DB setup.
- `docs/` — product, architecture, pipeline, data-model, prompts, operations, decisions.
- `scripts/` — one-off Node scripts for admin tasks.

---

## Submitting changes

1. Branch from `main`.
2. Make the change. Update relevant docs in `docs/` if you've changed behavior.
3. Run `npm run lint` and `npm run build` in `web/`.
4. Open a PR with a short description of the *why*, not just the *what*.

---

## Reporting issues

- Pipeline / data issues → include the relevant `pipeline_state` row and a snippet from `cron.job_run_details`.
- Frontend issues → include browser, screenshot, and the URL.
