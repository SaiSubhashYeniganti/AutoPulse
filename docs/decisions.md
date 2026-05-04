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

### 11. No historical backfill — quarterly fills in organically
- **Why:** Google News date-range queries are heavy and prone to 503s, so we don't keep a backfill function in the live system. The competitor quarterly view shows an honest "filling in" state until ~30+ days of live RSS history accumulate.
- **Trade-off:** Day-one quarterly view looks shallow until live ingest catches up. Acceptable, and consistent with the product's honest-empty-states principle.

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

---

## Where to change something

If you're modifying any of these decisions, also update:
- The corresponding code (mostly in `supabase/functions/<stage>/index.ts`).
- [`prompts.md`](./prompts.md) if the change affects an LLM prompt.
- [`data-model.md`](./data-model.md) if the change touches the schema.
- [`pipeline.md`](./pipeline.md) for any pipeline-flow changes.
