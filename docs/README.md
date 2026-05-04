# Documentation

A daily intelligence brief on the Indian used-car market for Cars24's leadership team — competitor moves, market signals, and external coverage of Cars24, synthesized into a 2-minute read.

---

## Start here

Read in order if you're new to the project. Each layer assumes the one above.

| File | Read time | What it covers |
|---|---|---|
| [`product.md`](./product.md) | 8 min | What we built, who it's for, what's deliberately out of scope. |
| [`architecture.md`](./architecture.md) | 5 min | System overview and the data flow in one picture. |
| [`pipeline.md`](./pipeline.md) | 15 min | Per-function deep dive across all 8 Edge Functions. |
| [`data-model.md`](./data-model.md) | 10 min | Schema, RLS, indexes, helper SQL functions. |
| [`prompts.md`](./prompts.md) | 12 min | Every LLM prompt in the pipeline and why it's shaped that way. |
| [`operations.md`](./operations.md) | 8 min | Cron, costs, observability, runbooks. |
| [`decisions.md`](./decisions.md) | 8 min | Key product and architecture decisions, with trade-offs. |
| [`user-flows.md`](./user-flows.md) | 5 min | How a reader and an operator interact with the system end-to-end. |
| [`deployment.md`](./deployment.md) | 30 min hands-on | Step-by-step deploy from scratch (~30 min if you have accounts). |

Total: **≈30 minutes** to ramp up enough to operate the system; **≈1 hour** to extend it.

---

## At a glance

- **Stack** — Next.js 14 on Vercel · Supabase Postgres + pgvector + Edge Functions (Deno) · OpenAI GPT-4o · `pg_cron`.
- **Volume** — ≈50 articles/day after dedup, ≈12 clusters/day, 4–6 hero stories surfaced per brief.
- **Cost** — ≈$11/month at current volume, tracked per-day in `daily_briefs.ai_cost_usd`.
- **Refresh cadence** — Pipeline every 2 hours; the 05:30 IST ingest feeds the 06:05 IST daily brief and 06:15 IST competitor summaries.

---

## Related top-level files

- [`../README.md`](../README.md) — engineering quickstart.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — how to set up locally and contribute.
