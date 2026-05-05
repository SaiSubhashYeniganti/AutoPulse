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
| 5 | `generate-daily-brief` | 328 | cron daily 00:35 UTC | Rank, window-decide, cache `daily_briefs` row |
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
   organically from the live RSS feeds; the brief calls out a "filling in"
   state on quarterly views until enough depth exists.

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

**Triggered by:** `pg_cron` daily at 00:35 UTC (06:05 IST), after the 05:30 IST ingest run has a short buffer to finish.

**Reads:**
- Market/competitor stories from the last 24/48/72h.
- Cars24 stories from the last 14d.
- All prior `daily_briefs.hero_stories` (to know what was previously shown).
- All clusters of previously-shown stories (to detect new activity).

**Logic — Hero (strict no-repeat):**
1. Load all hero story IDs that have appeared in any prior brief.
2. Load stories from last 24h, ordered by `(importance DESC, published_at DESC)`.
3. **Filter out any story whose ID appeared in a prior brief.**
4. If there are zero *fresh-eligible* stories → widen to 48h, then
   72h. If there is one eligible story in the normal 24h window, the
   brief shows that one story and stops. The widening is based on eligible
   hero stories, not raw story count.
5. Select all HIGH stories and MED stories with a concrete Cars24 implication.
   There is no upper cap; weak MED stories without an implication stay in the
   archive instead of padding the CEO brief.

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
  "window_hours": 48,
  "is_quiet_day": true,
  "quiet_day_note": "Quiet last 24h — showing since Friday",
  "competitor_pulse": [...],
  "total_stories_in_window": 17,
  "ai_cost_usd": 0.43
}
```

**Files:**
- `supabase/functions/generate-daily-brief/index.ts`

---

## 6. `generate-competitor-summary`

**Triggered by:** `pg_cron` daily at 00:45 UTC (06:15 IST), using the same fresh morning dataset as the daily brief.

**Reads:**
- `stories` filtered by `primary_competitor = <competitor>` (e.g.
  `'Spinny'`). This is stricter than the legacy `entities` lookup and
  guarantees competitor analysis does not mix companies.

**Logic per (competitor, scope) pair:**

### Weekly (`scope='week'`)
1. Load stories from last 7 days.
2. Group themes via LLM (e.g. *Funding & investor activity*, *Product
   moves*, *Leadership*) — per-cluster bullets, each linkable to
   source articles.
3. Compute `context_line` ("Funding driving 250% mention spike").
4. Upsert into `competitor_summaries` keyed on `(competitor, scope,
   period_end)`.

### Quarterly (`scope='quarter'`) — Day-One Depth strategy
1. Try to load last 12 weekly summaries (a "rollup of rollups").
2. **If fewer than 4 weekly summaries exist** → fall back to raw
   90-day stories so the quarterly view shows whatever depth exists.
3. LLM-synthesize themes from whichever input set we ended up with.
4. `story_count` reflects underlying story count (not weekly count).
5. Upsert into `competitor_summaries`.

**Why two paths?** On day one, we don't have 12 weeks of weekly
rollups. The fallback to raw 90-day stories is the honest day-one
strategy; as real weeks accumulate, the rollup path takes over.

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
