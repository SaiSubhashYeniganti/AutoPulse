# Key Decisions

A log of the decisions made during the build, with the reasoning. If you want to change one of these later, this is where you find out what you'd be trading off.

Format: **Decision → Why → What we gave up.**

---

## Product / scope

### 1. Web app (not mobile, not Slack, not email)
- **Why:** A leadership reader needs to land on a URL. Pull > push for an exec. Web is the right form factor for a 1-pager and is easier to share with the rest of the team.
- **Trade-off:** No push notifications, no offline read.

### 2. Single page (not tabs, not a dashboard)
- **Why:** The brief *is* the product. Tabs imply *"more to explore"* which fights the 2-minute promise.
- **Trade-off:** Can't scale infinitely. If we ever need segment-by-segment views (EV, financing, tier-2), we'd need either tabs or collapsible sections.

### 3. No auth, no accounts
- **Why:** Friction. The product is one URL.
- **Trade-off:** No personalization. Everyone sees the same brief. Acceptable for a leadership-team use case.

### 4. Source list focused on Indian auto outlets + Google News queries
- **Why:** Most direct competitor blogs (Spinny blog, CarDekho blog) don't have reliable RSS, or what they do publish is mostly SEO content rather than news. Google News with `site:` and topic queries gives us competitor-tagged feeds for free, and works around blocked direct RSS.
- **Trade-off:** Dependent on Google News indexing. If that breaks, we'd need a Bing News fallback or scraping. Today it's the lowest-friction path to 10+ effective sources.

### 5. The 4-bucket classification (`COMPETITOR` / `MARKET` / `CARS24_PRESS` / `CARS24_PR`)
- **Why:** *"Useful vs not useful"* alone wasn't enough. The reader needs to know *why* a story matters. We explicitly need to suppress Cars24's own outbound PR — the leadership team already knows what marketing shipped.
- **Trade-off:** More prompt complexity. More room for misclassification (mitigated with explicit rules + worked examples in the system prompt).

### 6. Honest empty states (no fake data)
- **Why:** On day one, Spinny might have 1 weekly story. Padding it with filler would lie to the user. Saying *"filling in"* is more credible than pretending.
- **Trade-off:** First impression looks lighter. Worth it for trust.

---

## Architecture

### 7. Stateless Edge Functions chained by `run-pipeline`
- **Why:** Each function does one thing and is independently triggerable. Easier to debug, easier to retry stages.
- **Trade-off:** More HTTP overhead than a single monolith. Negligible at our volume.

### 8. Hybrid embedding + LLM clustering (not pure embeddings)
- **Why:** Pure cosine-similarity clustering overfits in narrow domains (*"used cars India"* looks similar to almost everything). Pure LLM clustering is too expensive at scale. Hybrid uses pgvector to shortlist top-K candidates, then GPT-4o decides route-vs-create.
- **Trade-off:** Two-pass cost. Mitigated by tight K and concurrency.

### 8a. `primary_competitor` is a hard cluster-routing constraint (not a soft tag)
- **Why:** The `entities[]` array is great for *"show me everything that mentions Spinny"* queries, but it's a soft tag — the router could (and did) route a Spinny article into a CarDekho cluster if the embeddings happened to be close. That's wrong by definition. Now `primary_competitor` is a single forced choice set by the classifier, locked at cluster creation, and enforced by `find_candidate_clusters` so clusters cannot be cross-competitor.
- **Trade-off:** A misclassification at the article level produces a wrong cluster. We mitigate with an explicit alias map in the classifier prompt (Gaadi → CarDekho, OLX → OLX Autos, etc.) and a belt-and-braces `normalizePrimaryCompetitor()` server-side scrub.

### 8b. Cluster lookback: active for 14 days, archived after 14 days
- **Why:** A cluster older than 14 days is closed (`is_archived=true`) by a daily cron — even if it had recent activity. After 14 days, any new article on the same theme is a new editorial story, not a continuation. The router only considers clusters with activity in the last 14 days as candidates.
- **Trade-off:** Articles 15+ days apart on the same actual event will end up in two clusters. Acceptable — surfacing as two stories with the second one being "follow-up coverage" is honest.

### 9. `pgvector` in Supabase (not a separate vector DB like Pinecone)
- **Why:** One database to manage. Embeddings live next to articles. Cron + Edge Functions + vector search all on Supabase = one bill, one dashboard, one auth model.
- **Trade-off:** Pinecone is faster at 10M+ vectors. We're at <10K.

### 10. Next.js 14 App Router, SSR (not ISR)
- **Why:** Initially shipped with `revalidate = 300` ISR but the build-time prerender served an empty homepage. SSR (`force-dynamic`) fixed it and is fast enough — the page makes 3 cheap Supabase reads.
- **Trade-off:** Each page load hits the DB. At our traffic this is irrelevant.

### 11. Quarterly fills in organically
- **Why:** Google News date-range queries are heavy and prone to 503s, so competitor quarterly depth builds from the live source stream. On day one the event ledger is shallow — that's surfaced honestly (an empty ledger says "no material events logged in the last 90 days") rather than padded with weak narrative.
- **Trade-off:** Day-one quarterly view looks light until live ingest catches up. Acceptable, and consistent with the product's honest-empty-states principle.

---

## AI / pipeline

### 12. GPT-4o for classification, synthesis, judgment; GPT-4o-mini was rejected
- **Why:** We tested mini for the bucket classifier and it bled `CARS24_PR` into `CARS24_PRESS`. Production-grade judgment justifies the cost at our volume (<100 articles/day after dedup).
- **Trade-off:** ~3x cost vs. mini. Daily cost still <$1.

### 13. `text-embedding-3-small` (not `-large`)
- **Why:** Sufficient for our domain density. `-large` adds cost without meaningful clustering improvement at this scale.
- **Trade-off:** Slightly noisier neighbors. The LLM dedup pass cleans this up.

### 14. Allow `cars24_implication = null` in classification
- **Why:** Forcing the model to write an implication for every story produced low-quality boilerplate (*"This is relevant to Cars24's positioning"*). Letting it return null when honest gives the remaining implications signal.
- **Trade-off:** Some stories show without an implication line. We surface them with the bucket tag instead so the user still gets context.

### 15. Hero is strictly never-shown-before; *Still Developing* carries the rest
- **Why:** Even with perfect clustering, an important story can rank #1 day after day if the model just keeps scoring it highest. That feels broken — the reader opens the brief and sees yesterday's headline. The fix: hero is built from the pool of stories that have NEVER appeared in any prior brief. Stories that *were* in a prior brief AND have new article activity since their last appearance go into a *Still Developing* strip below the hero — one compact line per story showing source count, days running, and time of last update.
- **Trade-off:** Strict no-escape-hatch. Even if a HUGE new fact drops on a story shown 2 days ago (e.g. SEBI launches a probe), it cannot re-promote to hero — it just gets a *Still Developing* line with the new update. Cleaner UX, no scoring judgment calls. If we later want a "promote-back" override, we can add a manual flag.

### 16. Quarterly competitor view is an event ledger, not a themed narrative
- **Why:** The first design summarized the quarter into 3–5 "narrative arcs" with the LLM told to "abstract to the pattern." That works as commentary but fails as intelligence: a one-off Spinny acquisition that didn't fit a pattern was either folded into a generic theme or quietly dropped. The reader could see acquisition stories in the source list but no acquisition row in the summary. Honest, but wrong shape. The new quarterly is a **complete event ledger first, narrative second**: extract every material event into a structured row (date, type, headline, story_id), then layer patterns on top *only when ≥2 events form a coherent thread*, then write a TL;DR + Cars24 implications. Three LLM passes — extraction (gpt-4o-mini), pattern-detect (gpt-4o-mini), TL;DR (gpt-4o) — because asking one model to be both exhaustive and writerly produces neither.
- **Trade-off:** Longer outputs (the ledger is exhaustive by construction) and more LLM calls (~3× cost vs. the old single-pass version, still under $0.05 per competitor per day). The reader has to scroll. Acceptable: the ledger is the *point* of the view.

### 17. Quarterly reads raw stories every time; weeklies are output-only
- **Why:** The previous design built the quarterly from the last 12 weekly summaries (a "rollup of rollups") once ≥4 weeklies existed. That compression discarded dates, named amounts, named cities, named products — the quarterly LLM saw "City expansion: 2 cities" instead of "Apr 5 — Spinny opened in Pune; Mar 28 — Spinny opened in Coimbatore." Worse, the day a competitor crossed the 4-weekly threshold the quarterly visibly shrank, which read as a regression. Fix: the quarterly always reads raw stories from the last 90 days. Weeklies are a leaf node — UI artifact only, nothing else reads them.
- **Trade-off:** ~9K tokens of input per quarterly run (vs. ~1.5K from compressed weeklies). Still well within gpt-4o-mini's context, and still ~2¢ for the extraction pass. The savings from "rollup of rollups" weren't worth the lossiness.

### 18. Weekly competitor digest runs once a week on Monday, not every day
- **Why:** The original schedule re-ran the weekly daily, which produced a *sliding* 7-day window that overlapped yesterday's by 6 days. We were paying the LLM to re-summarize essentially the same stories every morning, with `temperature: 0.2` re-rolling the wording each time — a reader saw "Spinny had a quiet week" today and "Spinny saw routine product chatter" tomorrow about the same set. Noise dressed up as freshness. Fix: weekly covers a *fixed* Monday→Sunday window, generated once on Monday morning. Cron still pokes the function daily (the quarterly always runs); the function cadence-guards the weekly with `now().getUTCDay() === 1`. `force: true` overrides for backfills.
- **Trade-off:** The "this week" digest in the UI lags by up to 6 days at the end of the week. We mitigate by also showing the live raw stories under "This week" in the competitor view — readers get fresh stories *and* a stable digest. Cost goes from 7 weekly runs/competitor/week to 1.

### 19. Today's hero is a strict 24h window — no auto-widen to 48h/72h
- **Why:** The original brief widened the window when the 24h pool produced zero fresh-eligible stories — first to 48h, then to 72h. The intent was to never show an empty hero. In practice the only stories the wider window could surface were stories *from yesterday that didn't make yesterday's brief* (rare borderline mis-classifications), and the surface UX (*"Showing recent unshown stories from the last 3 days"*) read as "you're showing me old news under a TODAY header." Worse, it conflicted with the **Yesterday** and **Last 7 Days** segments already inside the same Feed tab — those *are* the fallback, exposed to the reader. The widening was paying a credibility cost for marginal recall. Removed in favor of an honest empty state.
- **Trade-off:** On a genuinely quiet morning the Today segment shows *"Nothing new in this window. Check back later."* and the reader has to click into Yesterday or Last 7 Days. Acceptable: it's the same number of clicks they'd take if today had one weak resurfaced story, and it preserves the meaning of "Today."

### 20. Cars24 is pinned at the bottom of the Competitors rail
- **Why:** The Competitors tab is for tracking *competitors*. Sorting Cars24 alongside them by 90-day volume meant Cars24 sometimes became the default selection (when its press volume was highest), which is the wrong landing page for a tab whose job is "what are they doing." Pinning Cars24 last keeps the rail's primary scan order about competitors and treats Cars24 as a self-press lane.
- **Trade-off:** Cars24 is now always one click away from the top, even on weeks when Cars24 press is the most active story. Acceptable: there's a dedicated Cars24 sub-tab inside Feed for the Cars24-press lane, which is a better surface for that.

### 21. Daily-brief windows are anchored to brief_date, not to wall-clock now
- **Why:** The original code computed the hero window as `now − 24h → now`, evaluated at function-run time. That worked for the regular morning cron, but manual re-runs broke it. Re-triggering the function at, say, 19:00 IST shifted the window forward by 13h vs. the morning cron — silently dropping stories the morning brief had included, and substituting in stories that should belong to *tomorrow's* brief. The Tata/JSW story (May 7 16:05 IST) was a real example: it qualified for May 8's brief at the morning cron, but a 19:00 IST May 8 re-run swapped it out. Fix: each `brief_date` covers a deterministic, immutable window — `(brief_date − 1) 06:05 IST → brief_date 06:05 IST`. Both bounds are computed from `brief_date`, not from `now()`. Re-runs converge on the same answer; the answer is explainable as "the 24h leading up to the morning seal."
- **Trade-off:** The handler logic is slightly more involved (figure out which brief_date this run is targeting based on whether wall-clock has crossed today's seal). Worth it: the brief is now reproducible, and re-running the function is a safe operation for ops. Backfills with `as_of` still work for historical days. Cadence stays at one run/day at 06:05 IST — stories that break during the day surface in *tomorrow's* brief (and they're already visible to the reader on the Feed page through the live cluster/story tables).

---

## Where to change something

If you're modifying any of these decisions, also update:
- The corresponding code (mostly in `supabase/functions/<stage>/index.ts`).
- [`prompts.md`](./prompts.md) if the change affects an LLM prompt.
- [`data-model.md`](./data-model.md) if the change touches the schema.
- [`pipeline.md`](./pipeline.md) for any pipeline-flow changes.
