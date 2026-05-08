# Architecture

System overview for Cars24 Brief.

> Audience: an engineer (or AI) who needs to reason about, extend, or
> debug the system. For per-function detail see
> [`pipeline.md`](./pipeline.md). For schema see
> [`data-model.md`](./data-model.md).

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 App Router on Vercel | SSR, Tailwind, fast deploy, free tier covers demo traffic |
| API | Next.js Route Handlers | Direct read from Supabase via the public `sb_publishable_...` key |
| Backend compute | Supabase Edge Functions (Deno + TypeScript) | Stateless, per-function deploys; each stage is independently re-runnable |
| Database | Supabase Postgres | Single store for sources, articles, clusters, stories |
| Vector store | `pgvector` extension on the same Postgres | One DB to manage; embeddings live next to articles |
| Scheduler | `pg_cron` (Supabase-hosted) | No external scheduler. Cron rows live in the same DB. |
| LLMs | OpenAI: GPT-4o (judgment), `text-embedding-3-small` (vectors) | GPT-4o-mini was tested and rejected — see [`decisions.md`](./decisions.md) §12 |

Total LOC of Edge Functions: **~2,408** across 7 functions.

---

## High-level diagram

```
                    ┌────────────────────────────────────────────────┐
                    │  10 SOURCES                                    │
                    │  - 3 trade-press direct RSS                    │
                    │  - 7 Google News RSS queries (competitors,     │
                    │    used-cars topic, India auto industry)       │
                    └────────────────────┬───────────────────────────┘
                                         │ (every 2h via pg_cron)
                                         ▼
                    ┌────────────────────────────────────────────────┐
                    │  rss-ingest (Edge Function)                    │
                    │  - parses RSS/Atom XML                         │
                    │  - dedupes by URL                              │
                    │  - inserts into `articles` (state='ingested')  │
                    └────────────────────┬───────────────────────────┘
                                         ▼
                    ┌────────────────────────────────────────────────┐
                    │  classify-articles (Edge Function)             │
                    │  - LLM call per article (GPT-4o)               │
                    │  - assigns: bucket, importance, entities,      │
                    │    cars24_implication, reasoning               │
                    │  - state → 'classified' or 'dropped'           │
                    └────────────────────┬───────────────────────────┘
                                         ▼
                    ┌────────────────────────────────────────────────┐
                    │  route-articles (Edge Function)                │
                    │  - embed via text-embedding-3-small (1536d)    │
                    │  - find_candidate_clusters() top-K via         │
                    │    pgvector + same-competitor/time guards      │
                    │  - LLM judges: route_to_existing | create_new  │
                    │  - state → 'routed', cluster_id set            │
                    └────────────────────┬───────────────────────────┘
                                         ▼
                    ┌────────────────────────────────────────────────┐
                    │  synthesize-stories (Edge Function)            │
                    │  - one LLM call per cluster (GPT-4o)           │
                    │  - merges all member articles into 1 story     │
                    │  - upserts into `stories` (one row / cluster)  │
                    │  - state → 'synthesized'                       │
                    └────────────────────┬───────────────────────────┘
                                         ▼
                    ┌────────────────────────────────────────────────┐
                    │  generate-daily-brief         (every day 00:35 │
                    │  generate-competitor-summary   UTC / 00:45 UTC) │
                    │  - daily brief: 24h window anchored to         │
                    │    brief_date (prev 06:05 IST → 06:05 IST),    │
                    │    not "last 24h from now"; empty = empty      │
                    │    (no widening to 48h/72h)                    │
                    │  - quarterly event ledger: 3-pass extract +    │
                    │    pattern + TL;DR (raw stories, daily refresh)│
                    │  - weekly themed digest: gated to Mondays only │
                    │    for previous Mon→Sun window                 │
                    │  - cache to daily_briefs / competitor_summaries│
                    └────────────────────┬───────────────────────────┘
                                         ▼
                    ┌────────────────────────────────────────────────┐
                    │  Next.js (Vercel)                              │
                    │  - SSR page reads daily_briefs +               │
                    │    competitor_summaries via                    │
                    │    sb_publishable_... key                      │
                    │  - public read RLS only on these 3 tables      │
                    └────────────────────────────────────────────────┘
```

---

## Data flow in one sentence

> RSS → classify per article → embed → cluster (vector top-K + LLM
> judge) → synthesize cluster → cache daily brief + per-competitor
> quarterly event ledger (daily) and weekly digest (Mondays only) →
> SSR-render page.

---

## Key design properties

### 1. Stateless Edge Functions, watermark-driven
Every stage reads its watermark (`pipeline_state.<stage>.last_processed_at`)
and writes a new one. No in-memory state between invocations. Each
stage is independently triggerable for debug or rerun.

### 2. Hybrid clustering
Embeddings are a **shortlist filter**, not a clusterer. We use them to
narrow the candidate set to same-competitor, event-time-close clusters,
then the LLM is the final judge. This trades a small amount of cost for
materially fewer false merges and fewer duplicate competitor stories.

### 3. Single orchestrator, individual functions
`run-pipeline` is one HTTP entry point that chains stages. But each
stage is its own Edge Function deployment. Operator can curl any
stage in isolation; cron just calls `run-pipeline`.

### 4. RLS on by default
- Public reads enabled on `stories`, `daily_briefs`,
  `competitor_summaries` (everything the website renders).
- All writes blocked from the public. Edge Functions hold a
  `BACKEND_API_KEY` (Supabase secret key) that bypasses RLS.

### 5. Honest empty states baked in
Both daily brief and competitor summaries have explicit logic for
"not enough data" → render an honest banner instead of fake content.
This is the product, not a degraded mode.

---

## Auth model

There are **three** principals:

| Principal | What it can do | How it auths |
|---|---|---|
| Public web visitor | SELECT on `stories`, `daily_briefs`, `competitor_summaries` | `sb_publishable_...` key, embedded in the Next.js bundle |
| Edge Functions | Full DB access, bypass RLS | `BACKEND_API_KEY` (= `sb_secret_...`), in env, never sent to client |
| `pg_cron` rows | Call Edge Functions via `net.http_post` | Pulls `backend_api_key` from Supabase Vault |

The legacy Supabase JWT model (`anon` / `service_role`) is not used.
Migration was forced by Supabase deprecating those keys mid-build —
see [`operations.md`](./operations.md).

---

## Why Supabase + Vercel (not AWS / GCP / a custom stack)

- **Supabase** gives us Postgres + cron + functions + vector + auth
  in one console. For a 7-hour build, "1 console, 1 bill" beats
  "stitch together Aurora + Lambda + EventBridge + Pinecone."
- **Vercel** gives us free SSR + a `vercel.app` URL out of the box.
  No DNS, no SSL, no CDN setup.
- Both are hostable elsewhere if Cars24 wanted to bring it in-house;
  the Edge Functions are Deno + TypeScript and would port to any
  serverless runtime with minimal change.

---

## What's deliberately not in the architecture

- No queue (SQS, Redis). `pg_cron` + watermarks is enough at our
  volume (~50 articles / day).
- No separate vector DB (Pinecone, Weaviate). `pgvector` works at
  <10K embeddings.
- No CDN for API responses. SSR + Next.js cache headers are enough.
- No background worker pool. Each Edge Function is its own pool.
- No admin panel. Direct SQL via Supabase Studio is the admin UX.
