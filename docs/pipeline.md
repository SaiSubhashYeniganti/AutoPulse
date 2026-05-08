# Pipeline — Per-Function Deep Dive

Detailed reference for each of the 8 Edge Functions in
`supabase/functions/`.

For the full prompts see [`prompts.md`](./prompts.md). For the schema
see [`data-model.md`](./data-model.md).

---

## Function inventory

| # | Function | LOC | Trigger | Purpose |
|---|---|---:|---|---|
| 1 | `rss-ingest` | 246 | cron 2h | Pull from 10 sources, dedup by URL, insert articles |
| 2 | `classify-articles` | 392 | cron 2h | Per-article LLM classify (bucket + importance + entities + implication) |
| 3 | `route-articles` | 398 | cron 2h | Embed + cluster (pgvector top-K + LLM judge) |
| 4 | `synthesize-stories` | 437 | cron 2h | Per-cluster LLM synthesis → row in `stories` |
| 5 | `generate-daily-brief` | 328 | cron daily 00:35 UTC | Rank, window-anchor, cache `daily_briefs` row |
| 6 | `generate-competitor-summary` | 440 | cron daily 00:45 UTC | Per-competitor week + quarter themed rollups |
| 7 | `run-pipeline` | 167 | cron 2h | Orchestrator that chains stages 1-4 |

Total: **~2,408 LOC across 7 functions.**

---

## 1. `rss-ingest`

**Triggered by:** `run-pipeline` (which is triggered by `pg_cron`
every 2 hours).

**Reads:**
- `sources` table (every active row).
- `pipeline_state.rss_ingest.last_processed_at` (watermark).

**Writes:**
- `articles` table (new rows with `pipeline_state='ingested'`).
- Updates `sources.last_fetched_at`, `sources.last_status`.
- Updates `pipeline_state.rss_ingest`.

**How it works:**
1. Loads all active sources.
2. For each source, fetches the RSS/Atom XML with retry/backoff
   (`FETCH_RETRIES=2`, exponential backoff).
3. Concurrency limited to **3 parallel fetches** (was higher; reduced
   after Google News 503s during heavy fetch bursts).
4. Custom regex-based XML parser (`_shared/rss.ts`) — no external XML
   library needed.
5. For each parsed item, checks if URL already exists → skip if yes.
6. Inserts new article with `published_at` from feed (best effort
   parse), `fetched_at = now()`.
7. RSS ingest is live/current only. The first ~30 days of history accumulate
   organically from the live RSS feeds. On day one a competitor's event
   ledger may be sparse or empty; that's surfaced honestly (an empty ledger
   says "no material events logged in the last 90 days") rather than padded.

**Failure modes:**
- 503 from a source → retried, then logged in `sources.last_status`,
  pipeline continues.
- Malformed XML → individual item skipped, source's other items still
  ingested.

**Files:**
- `supabase/functions/rss-ingest/index.ts`
- `supabase/functions/_shared/rss.ts`

---

## 2. `classify-articles`

**Triggered by:** `run-pipeline`.

**Reads:**
- `articles` where `pipeline_state='ingested'`, ordered by
  `published_at`, capped at `BATCH_SIZE=30`.

**Writes:**
- For each row, sets: `bucket`, `importance`, `reasoning`, `entities`,
  `cars24_implication`, `classified_at`, `pipeline_state='classified'`
  (or `'dropped'` if `importance='DROP'`).

**LLM call:**
- Model: `gpt-4o`.
- Concurrency: `CONCURRENCY=5` parallel calls.
- One LLM call per article (no batching) — gives isolated reasoning
  per article and easier debug.
- Prompt: "4-bucket Cars24 editor" — see [`prompts.md`](./prompts.md#1-classify-articles).
- Response: JSON object with `bucket`, `importance`, `reasoning`,
  `entities`, `cars24_implication`.
- Validation: enforces enums, normalizes literal "None" / "null" /
  "n/a" implications to actual `null`.
- Pre-LLM language gate: non-English Indic-script titles and obvious
  transliterated/Hinglish titles are dropped with zero LLM cost. This prevents
  noisy duplicate coverage from creating false-split clusters in an English CEO
  brief.

**Cost:** ~$0.005-0.015 per article. At 30-50 articles/day → <$1/day.

**Files:**
- `supabase/functions/classify-articles/index.ts`
- `supabase/functions/_shared/openai.ts`

---

## 3. `route-articles`

**Triggered by:** `run-pipeline`.

**Reads:**
- `articles` where `pipeline_state='classified'`, batched.
- For each, calls `find_candidate_clusters(embedding, 12, 14, primary_competitor, article.published_at, 14)`
  — a SQL function in `schema.sql` that returns top-12 closest clusters
  via `pgvector` cosine distance, **restricted to clusters with the same
  `primary_competitor`** (or both null for MARKET/general) and whose
  latest article is close to the new article's `published_at`. A Spinny
  article literally cannot be routed into a CarDekho cluster, and a March
  12 Cars24-exit article cannot merge into a May 1 Cars24-exit cluster.

**Writes:**
- Generates embedding via `text-embedding-3-small` (1536d).
- Stores embedding on the article row + `embedded_at`.
- Calls GPT-4o to decide route-to-existing vs create-new.
- If route → updates article's `cluster_id`, calls
  `refresh_cluster_aggregates(cluster_id)`.
- If new → inserts a new `clusters` row with the article's embedding
  as initial centroid, then attaches.
- Sets `pipeline_state='routed'`.

**Helper SQL (`find_candidate_clusters`):**
```sql
select c.id, c.theme, c.article_count,
       (c.centroid <=> query_embedding::vector) as cosine_distance,
       c.latest_article_at, c.primary_competitor
from clusters c
where c.is_archived = false
  and c.centroid is not null
  and c.latest_article_at > article_published_at - (lookback_days || ' days')::interval
  and c.primary_competitor is not distinct from competitor
  and abs(extract(epoch from (article_published_at - c.latest_article_at)))
      < max_event_gap_days * 86400
order by c.centroid <=> query_embedding::vector
limit candidate_count;
```

The `is not distinct from` operator handles null-vs-null correctly
(SQL `=` returns NULL when both sides are null, which would silently
filter out null=null matches). This is the structural guarantee that
clusters never mix competitors.

**Helper SQL (`refresh_cluster_aggregates`):**
- Recomputes `article_count`, `earliest_article_at`,
  `latest_article_at`.
- Updates `centroid` (currently using most-recent member's embedding;
  see schema comment for the trade-off vs full average).
- Sets `needs_synthesis=true` so the synthesizer picks it up.

**Why hybrid (embedding + LLM)?** See [`decisions.md`](./decisions.md) §8.

**Files:**
- `supabase/functions/route-articles/index.ts`
- `supabase/functions/_shared/vector.ts` — converts `number[]` to
  pgvector literal string `[0.1,0.2,...]` (avoids PostgREST encoding
  edge cases).

---

## 4. `synthesize-stories`

**Triggered by:** `run-pipeline`.

**Reads:**
- `clusters` where `needs_synthesis=true` AND has ≥1 article in
  `pipeline_state='routed'`.
- For each cluster, loads all member articles.

**Writes:**
- One LLM call per cluster (GPT-4o, temperature 0.2, max_tokens 800).
- Upserts a row in `stories` keyed by `cluster_id`:
  - `title`, `short_summary`, `summary`, `cars24_implication`, `importance`,
    `bucket`, `entities` (deduped union across members), `source_count`,
    `source_articles` (jsonb array), `primary_source_name/url`,
    `image_url`, `published_at` (= latest member / latest coverage activity).
- `bucket` is taken from the cluster's primary article (earliest).
- `importance` is `max(LLM-suggested, max-of-members)` — never lower
  than the highest member.
- Sets cluster `needs_synthesis=false`, theme = first 200 chars of
  story title.
- Marks all member articles `pipeline_state='synthesized'`.

**Image picking:** First non-null `image_url` across members.

**Files:**
- `supabase/functions/synthesize-stories/index.ts`

---

## 5. `generate-daily-brief`

**Triggered by:** `pg_cron` daily at 00:35 UTC (06:05 IST), after the 05:30
IST ingest run has a short buffer to finish.

**Window anchoring (the important bit).** Each `brief_date` row covers a fixed
24h window:
- **Lower bound** = `(brief_date − 1) 06:05 IST` (= 00:35 UTC the day before)
- **Upper bound** = `brief_date 06:05 IST` (= 00:35 UTC, "the seal")

Both bounds are **deterministic for that brief_date** — they do not depend
on wall-clock now. So the May 8 brief always covers `May 7 06:05 IST → May 8
06:05 IST`, regardless of when the function actually runs.

When the function fires, it figures out which `brief_date` it's targeting:
- Wall ≤ today's seal (00:35 UTC) → sealing today's brief.
- Wall > today's seal → would target tomorrow's brief. With the regular
  schedule this branch is only hit by manual re-runs / backfills — the cron
  always fires before its own seal — so the production behavior is "morning
  cron seals today's brief and we're done for the day."

Re-running for an already-sealed brief_date is a safe no-op (the upper
bound is already at the cap). The lower bound is always fixed, so reruns
can only ADD stories, never drop one that previously qualified.

**Reads:**
- Market/competitor stories in the anchored 24h window.
- Cars24 stories from the last 14d (trailing from upper bound).
- All prior `daily_briefs.hero_stories` and `hero_cars24` (to know what was previously shown).
- All clusters of previously-shown stories (to detect new activity).

**Logic — Hero (strict no-repeat, anchored 24h):**
1. Load all hero story IDs that have appeared in any prior brief.
2. Load stories in the anchored window, ordered by `(importance DESC, published_at DESC)`.
3. **Filter out any story whose ID appeared in a prior brief.**
4. Select all HIGH stories and MED stories with a concrete Cars24 implication.
   There is no upper cap; weak MED stories without an implication stay in the
   archive instead of padding the CEO brief.
5. If the result is empty, the lane stays empty and the UI shows an honest
   *"Nothing new in this window. Check back later."* The reader falls back to
   the **Yesterday** or **Last 7 Days** segments inside the same Feed tab.

**Why no 48h/72h widening?** Earlier versions widened the window to 48h and
72h on quiet mornings. In practice the only stories the wider window could
surface were stories from yesterday that didn't make yesterday's brief — a
narrow recovery for borderline mis-classifications, which the reader would
correctly read as *"this is yesterday's news."* Yesterday's actual hero is
one click away in the Yesterday segment, so the widening was paying a UX
cost for a marginal recall win. Removed.

**Why anchored windows (not "last 24h from now")?** Using `now − 24h` meant
that re-running the function at, say, 19:00 IST shifted the window forward
by 13h vs. the morning cron — silently dropping stories the morning brief
had included, and replacing them with stories that should belong to
tomorrow's brief. With anchored windows each brief_date is an immutable,
explainable slice of time; multiple runs converge on the same answer.

**Logic — Weekly:**
1. Market/competitor lane reads the last 7d.
2. Cars24 lane reads the last 14d and labels the section "Earlier in the last
   14 days" (the full 90d Cars24 archive is a separate page).
3. Dedup against today's hero cluster IDs.
4. Include all HIGH stories. If fewer than `WEEKLY_RECAP_MIN=5` HIGH stories
   exist, top up with MED stories that have a concrete Cars24 implication.

**Logic — Still Developing (compact strip):**
1. Take the previously-shown story IDs.
2. Pull their cluster's `latest_article_at` and `is_archived`.
3. Pull each story's `last_shown_at` (= `generated_at` of the most
   recent brief that featured it).
4. Keep stories where:
   - Cluster is not archived, AND
   - `cluster.latest_article_at > last_shown_at` (new activity since
     we last surfaced it).
5. Sort by `latest_update_at DESC`, take top `STILL_DEVELOPING_MAX=8`.
6. Render as compact one-liners: bucket pill + title + source count
   + days running + relative time of last update.

**Logic — Competitor pulse:**
1. Build per-competitor 7-day story counts for the sparkline strip
   (Cars24, Spinny, CarDekho, Droom, OLX Autos, Maruti True Value).
2. Generate a 1-line context per competitor via GPT-4o-mini.

**Persist:** Upsert into `daily_briefs` keyed on `brief_date` — both
`hero_stories` and `still_developing` jsonb arrays in one row.

**Output (jsonb):**
```json
{
  "brief_date": "2026-05-04",
  "hero_stories": [{"story_id": "...", "rank": 1}, ...],
  "window_hours": 24,
  "is_quiet_day": false,
  "quiet_day_note": null,
  "competitor_pulse": [...],
  "total_stories_in_window": 17,
  "ai_cost_usd": 0.43
}
```

**Files:**
- `supabase/functions/generate-daily-brief/index.ts`

---

## 6. `generate-competitor-summary`

**Triggered by:** `pg_cron` daily at 00:45 UTC (06:15 IST), using the same fresh morning dataset as the daily brief. Daily cadence is the *cron* cadence; the function then decides scope-by-scope whether to actually run (see Weekly cadence guard below).

**Two scopes, two very different shapes:**

### Quarterly (`scope='quarter'`) — exhaustive event ledger
Re-derived from raw stories every day. Output shape:
```json
{
  "tldr": "<1-2 sentences>",
  "events":  [{date, type, headline, story_id}, ...],
  "patterns": [{title, description, story_ids}, ...],
  "cars24_implications": ["<line>", ...]
}
```

**Reads:** stories from the last 90 days, queried *both* by `primary_competitor = X` AND by `entities @> ['X']` (the two result sets are unioned and deduped by id). The wider entity-based recall matters at the 90-day horizon because mis-classifications of `primary_competitor` add up — the LLM can drop noise in extraction far more easily than it can recover stories we never showed it.

**Three LLM passes** (anti-pattern: don't ask one LLM call to be both exhaustive and writerly — split the responsibilities):

1. **Extract** (gpt-4o-mini, T=0.1) — Given the story list, output a structured ledger. Every material event becomes one row: `{date, type, headline, story_id}`. Type is from a fixed enum (`funding | acquisition | product | expansion | hire | departure | partnership | regulatory | layoff | pricing | other`). The prompt is explicit that this is an extraction task, not a synthesis task — be exhaustive, no abstracting, drop only duplicates.
2. **Pattern-detect** (gpt-4o-mini, T=0.2) — Given the ledger, identify 0–4 narrative arcs that 2+ events trace. The prompt explicitly allows zero patterns. Skipped when there are <2 events.
3. **TL;DR + implications** (gpt-4o, T=0.3) — Given the ledger and patterns, write the 1–2 line headline and 0–4 Cars24-specific "so what" lines.

**Server-side validators** drop hallucinated story_ids (LLM occasionally invents UUIDs), enforce ≥2 supporting events for any pattern, and clamp implications to ≤4 entries.

**Cost:** ~$0.02–0.05 per competitor per quarterly run (most of it pass 1).

### Weekly (`scope='week'`) — themed digest, Monday-only
Covers a fixed Monday→Sunday window — the *previous* completed week. Output shape unchanged from before: `{context_line, themes: [{title, bullets, story_ids}]}`.

**Cadence guard:** the function runs the weekly only when `now()` is a Monday (UTC). On other days the weekly is a no-op (returns `status: "skipped"`). The cron still pokes the function every day because (a) the quarterly always runs and (b) on Mondays the weekly fires automatically. Override with `{"force": true}` for backfills.

**Why Monday-only?** A daily-regenerated weekly produced a *sliding* 7-day window that overlapped yesterday's window by 6 days, re-LLM'ing essentially the same stories every morning and producing fresh wording — noise dressed up as freshness. A fixed Mon→Sun window with one canonical run gives stable, auditable history.

**Reads:** stories with `primary_competitor = X` published in the previous Mon→Sun window. Stricter than the quarterly's entities-based query because the weekly is a clean digest, not a recall problem.

### What we deliberately do NOT do

- **No "rollup of rollups."** The quarterly never reads weekly summaries. Once a story is compressed into a weekly bullet, dates / names / amounts are lost; the quarterly LLM can't recover them. Weeklies are a leaf node — output only.
- **No `themed_summary` shape on quarterly rows.** New quarterly rows write the `EventLedgerSummary` JSON shape into the same `themed_summary` column. The UI runtime-checks `Array.isArray(s.events)` and renders accordingly. Older themed-summary rows still render via a backwards-compat path.

**Files:**
- `supabase/functions/generate-competitor-summary/index.ts`

---

## 7. `run-pipeline`

**Triggered by:** `pg_cron` every 2h, OR manually via curl.

**Reads:** Just the request body for the `stages` list.

**Logic:**
1. Parses stages list (default: `["ingest","classify","route","synthesize"]`).
2. Maps each stage name to a function name via `STAGE_TO_FUNCTION`.
3. Dedupes consecutive duplicate function calls (handles
   `["embed","route"]` → both map to `route-articles`, so run once).
4. Sequentially calls each function via `fetch()` to its
   `/functions/v1/<name>` URL with `apikey: $BACKEND_API_KEY`.
5. Collects per-stage results: `{stage, http_status, body,
   elapsed_ms}`.
6. Returns aggregate response.

**Why sequential?** Stages depend on each other (classify needs
ingested rows, route needs classified rows, etc). No parallelism
between stages.

**Stop-on-error:** Optional `{"stop_on_error": true}` halts the chain
on first failure. Default false (continue and report errors).

**Files:**
- `supabase/functions/run-pipeline/index.ts`

---

## Cross-cutting helpers (`_shared/`)

| File | Purpose |
|---|---|
| `supabase.ts` | `getSupabaseClient()`, `getBackendApiKey()`, `isAuthorizedRequest()`, response helpers |
| `openai.ts` | `chatJson()`, `embed()`, `costFor()` (per-model pricing for cost tracking) |
| `rss.ts` | Custom regex-based RSS/Atom parser, `stripHtml()` |
| `vector.ts` | `toVectorLiteral()` — converts `number[]` to pgvector text literal |
| `types.ts` | Shared TypeScript types: `Article`, `Story`, `Cluster`, `Bucket`, `ClassificationResult` |

---

## Pipeline state machine

Every article flows through:

```
   ingested  ──[classify]──►  classified  ──[route]──►  routed  ──[synthesize]──►  synthesized
                  │
                  └──(if importance='DROP')──►  dropped
```

Watermarks per stage (in `pipeline_state` table):
- `rss_ingest.last_processed_at` — last article's `published_at` we
  considered.
- `classifier.last_processed_at` — last article's `classified_at`.
- `router.last_processed_at` — last article's `routed_at`.
- `synthesizer.last_processed_at` — last cluster's `updated_at`.

This gives idempotent re-runs: if a cron tick fails mid-stage, the
next tick picks up where we left off.
