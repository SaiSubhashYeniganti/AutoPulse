# User Flows

Text-only walkthrough of how each user (the reader, the system, the
operator) moves through the product end-to-end.

> No screenshots intentionally — the UI is being iterated on. These
> flows describe behavior, not pixels.

---

## Flow 1 — A leadership reader checks the brief in the morning

1. The reader opens the site on phone or laptop.
2. The page loads server-side; first paint shows the brief immediately
   (no skeleton flash, no loading spinner).
3. They see the **Today's Brief** section at the top:
   - A date stamp (e.g. *Monday, 4 May 2026 — last refreshed 06:08 IST*).
   - A window banner if applicable (e.g. *"Quiet last 24h — showing
     since Friday"*).
   - 4-6 stories, ranked. Each story shows:
     - A **bucket pill**: `[COMPETITOR]`, `[MARKET]`, or `[CARS24]`.
     - The headline.
     - A 2-3 sentence editorial summary.
     - One **"So what for Cars24?"** line below — *only if the model had
       genuine signal*. Otherwise omitted.
     - Source attribution: primary outlet name + multi-source count
       (e.g. *"ET Auto + 2 others"*).
     - An explicit **"Read at ET Auto →"** link.
4. They scroll to the **Competitor Pulse** strip:
   - One row per competitor (Cars24, Spinny, CarDekho, Droom,
     OLX Autos), each with a 7-day sparkline and a 1-line context.
5. They click Spinny's row to expand:
   - **Last week** — 2-3 themed bullet groups (e.g. *Funding & investor
     activity*, *Product moves*). Each bullet is a clickable link to
     the underlying source articles.
   - **Last quarter** — same shape, longer horizon. If sparse, an
     honest banner: *"This quarter (filling in...) — only 4 sourced
     stories so far."*
6. They scroll past the competitor strip to **Yesterday's Brief**:
   - Collapsed accordion. Click to expand. Shows the same hero shape
     from yesterday — useful before a Monday standup.
7. Tab closes. Total time: ~2 minutes.

**No further interaction needed.** No login. No "save for later." No
notification settings.

---

## Flow 2 — The system runs the pipeline (background)

Triggered automatically by `pg_cron` every 2 hours.

1. **00:00 / 02:00 / ... 22:00 UTC** — `pg_cron` fires. It calls
   `/functions/v1/run-pipeline` with `{stages: ["ingest","classify","route","synthesize"]}`.
2. **`rss-ingest`** runs:
   - Reads the watermark `pipeline_state.rss_ingest.last_processed_at`.
   - For each of the 10 sources, fetches the RSS, parses items.
   - Inserts new articles (dedup by URL) with `pipeline_state='ingested'`.
   - Updates the watermark.
3. **`classify-articles`** runs:
   - Picks up everything in `pipeline_state='ingested'` (up to a batch).
   - For each article, calls GPT-4o with the bucket-classifier prompt.
   - Updates the row with `bucket`, `importance`, `entities`,
     `cars24_implication`, `pipeline_state='classified'`.
   - Articles classified as `DROP` get `pipeline_state='dropped'`.
4. **`route-articles`** runs:
   - Picks up everything in `pipeline_state='classified'` (excluding `DROP`).
   - For each article, generates a 1536-d embedding via
     `text-embedding-3-small`.
  - Calls `find_candidate_clusters()` (a SQL function over `pgvector`)
    to get the closest existing clusters with the same `primary_competitor`
    and a close event-time window.
   - Calls GPT-4o with the routing prompt: "Same event as any of
     these, or new?"
   - Either attaches the article to an existing cluster or creates a
     new one (with the article's embedding as initial centroid).
   - Sets `pipeline_state='routed'`. Cluster's `needs_synthesis=true`.
5. **`synthesize-stories`** runs:
   - Picks up clusters where `needs_synthesis=true` and that have ≥1
     `routed` article.
   - For each cluster, calls GPT-4o with the synthesizer prompt against
     all member articles.
   - Upserts a row in `stories` (one row per cluster) with title,
     summary, implication, importance, source attribution.
   - Marks all member articles `pipeline_state='synthesized'` and the
     cluster `needs_synthesis=false`.
6. **End of cron run.** Each stage updates `pipeline_state` watermark
   + `last_run_meta` for observability.

### Once-a-day jobs

- **00:30 UTC (06:00 IST)** — `pg_cron` calls `generate-daily-brief`,
  which builds the cached daily brief row that the website reads.
- **23:30 UTC (05:00 IST next day)** — `pg_cron` calls
  `generate-competitor-summary` for each competitor + scope (week /
  quarter), caching the rows the expandable rows read from.

---

## Flow 3 — Operator runs the pipeline manually

For debugging or after schema changes.

1. SSH / local terminal with `BACKEND_API_KEY` env var set.
2. `curl https://<project>.supabase.co/functions/v1/run-pipeline`
   `-H "apikey: $BACKEND_API_KEY" -H "Content-Type: application/json"`
   `-d '{"stages":["ingest","classify","route","synthesize"]}'`.
3. Response is a JSON array — one entry per stage with status,
   elapsed_ms, and a body containing per-batch stats.
4. To run a single stage: `'{"stages":["classify"]}'`.
5. To stop on first error: `{"stages":[...], "stop_on_error": true}'`.

The operator can also bypass `run-pipeline` and call any stage
directly: `/functions/v1/classify-articles`, etc. Useful for "I just
deployed a new prompt — re-run classify."

---

## Flow 4 — Operator backfills 90 days of history (one-shot)

Used once at first launch to seed the quarterly competitor view with
real depth.

1. From local: a Python orchestration script iterates over a list of
   queries (one per competitor + a few topic queries).
2. For each query, it calls `/functions/v1/backfill-history` with
   `{"query": "...", "weeks_back": 12, "slice_days": 14, "max_per_period": 8}`.
3. The Edge Function issues date-range Google News RSS calls for each
   2-week slice and inserts deduped articles with
   `source_name = "Google News Backfill: <query>"`.
4. Articles flow through the normal pipeline (classify → route →
   synthesize) on the next cron tick.
5. The frontend filters out `Google News Backfill: %` sources from
   daily/weekly views (so backfill only shows in the quarterly), so
   stale-dated articles can't leak into "today."

---

## Flow 5 — A new source needs to be added

Worst case in the lifecycle, but cleanly defined.

1. Edit `supabase/seed.sql` and add an `INSERT` for the new source
   (URL, source_type, fetch interval).
2. Run the seed insert against prod.
3. Wait for the next `rss-ingest` cron tick (or trigger manually) —
   articles flow in.
4. They go through the normal classify → route → synthesize pipeline
   automatically; no code change.
5. If the source needs special parsing (e.g. JSON feed instead of
   RSS), extend `_shared/rss.ts`.

---

## Flow 6 — A failure happens (degraded mode)

What the user sees vs what the operator sees.

| Failure | What the reader sees | What the operator sees |
|---|---|---|
| One source RSS dies | Smaller article volume; brief still ships | Source row in `pipeline_runs.last_run_meta` shows error |
| OpenAI API rate-limited | Brief is older (last cached); no new stories until catch-up | Stage logs show 429s; pipeline retries with backoff |
| `synthesize-stories` errors on a cluster | That cluster's story doesn't update; old version stays | Cluster's `needs_synthesis=true` persists; next cron retries |
| Daily brief job fails | Yesterday's brief still shows; no "today" hero | `daily_briefs` table missing today's row |
| Competitor summary job fails | "Filling in..." messaging covers it | `competitor_summaries` table missing today's row |
| Whole DB down | Web page shows error / empty state | Vercel logs + Supabase status page |

The product is designed so that any single-stage failure degrades the
brief, never breaks it.
