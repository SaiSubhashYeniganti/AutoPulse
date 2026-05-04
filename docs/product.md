# Product

**Cars24 Brief — auto market pulse for the Cars24 leadership team.**

> Written for a non-engineering reader. For the under-the-hood view, jump to
> [`architecture.md`](./architecture.md), [`pipeline.md`](./pipeline.md), and
> [`prompts.md`](./prompts.md).

---

## TL;DR

A single web page, refreshed every 2 hours, that surfaces 4–6 stories from the Indian auto market — competitor moves, market signals, external Cars24 coverage — each with a 1-line "what this means for Cars24" callout. Plus a per-competitor pulse strip with weekly + quarterly rollups, and a "yesterday's brief" accordion. Read in 2 minutes; close the tab.

---

## 1. Problem statement

Indian auto news is loud and repetitive. A leader who actually wants to track *"what's happening in my market"* has to:

1. Open 8–10 sites a day.
2. Mentally dedupe the same story re-syndicated 5 times.
3. Filter out their own outbound marketing (which they already know about).
4. Translate generic auto news into "does this affect us?".

That's 30–45 minutes of mental work per day. We compress it to 2 minutes.

---

## 2. Users

| Who | Why they use it |
|---|---|
| **Cars24 CEO** — primary | Pre-meeting market scan over coffee. |
| **Cars24 leadership** — secondary | Same use case, different lens (COO cares about ops signals, CFO cares about funding/regulation, etc.). |
| Anyone with the URL | Read-only; no auth, no personalization. |

Explicitly **not** for: auto journalists, end consumers, or marketing/PR (each needs a different shape — raw feeds, vehicle search, sentiment dashboards).

---

## 3. The product, in 3 sections

### 3.1 Today's Brief (the "Hero")

The 4–6 most important stories from the last 24 hours.

For each story:
- **A bucket tag** — `[COMPETITOR]`, `[MARKET]`, or `[CARS24]` — so the reader knows in one word why a story is in the brief.
- **A one-line title.**
- **2–3 sentences of context** (synthesized from every outlet that covered the story).
- **A "So what for Cars24?" line** — only when the model has a genuine, specific take. Otherwise we suppress the line; better to say nothing than pad with *"Cars24 should monitor this development."*
- **Source attribution** — primary outlet name + an explicit *"Read at [source] →"* link. If multiple outlets covered it we say so (*"ET Auto + 3 others"*).

**Quiet-day handling.** If the 24h window has fewer than the minimum number of strong stories, the window auto-widens to 48h, then 72h, with an honest banner: *"Quiet last 24 hours — showing the last 48."* No filler.

### 3.2 Competitor Pulse

One row per major competitor: Cars24, Spinny, CarDekho, Droom, OLX Autos.

- A 7-day sparkline (story volume) and a 1-line context (*"Funding driving 250% mention spike"*, or *"Quiet week — usual product chatter"*).
- Click a row to expand. Inside, two views:
  - **Last week** — themed bullets (e.g. *Funding & investor activity* → 3 bullets → each bullet links to its source articles).
  - **Last quarter** — same shape, longer horizon. When sparse, the UI says so plainly: *"This quarter (filling in...) — only 4 sourced stories so far."*

### 3.3 Yesterday's Brief

An accordion at the bottom. Same hero shape, just from yesterday. Useful before a Monday standup (*"did anything ship over the weekend?"*). Day-before-yesterday is intentionally not kept — keeps the page lean and the product opinionated. The full archive lives at `/feed/week`.

---

## 4. What the AI pipeline actually does (in plain English)

The product is not "fetch RSS and show it." It's an opinionated edit. Here's what runs in the background, in human terms:

### Step 1 — **Ingest** (every 2h)
We pull the latest items from 10+ feeds (4 trade-press RSS + 6 Google News queries that act as competitor- and topic-tagged feeds). Deduplicated by URL.

### Step 2 — **Classify** (LLM)
For each new article, GPT-4o reads the headline + body and decides:
- **Bucket** — Is this competitor news? Market news? External press about Cars24? Or Cars24's own outbound PR?
- **Importance** — HIGH, MED, LOW, or DROP (drop = noise like motorsport).
- **Entities** — Which companies are named?
- **Primary competitor** — Forced single choice from `{Cars24, Spinny, CarDekho, Droom, OLX Autos, null}`. This is what the router uses to keep clusters competitor-pure.
- **Cars24 implication** — Is there a specific, non-generic insight? If not, leave it blank (better to say nothing than pad).

This is the editorial brain — the difference between an aggregator and a brief.

### Step 3 — **Embed + cluster** (vector + LLM)
Different outlets cover the same event with different headlines. To treat them as one story:
1. Each article is converted into a 1536-dimension embedding (a math fingerprint of meaning).
2. We use that fingerprint to find the most similar existing clusters with the same primary competitor and a close event-time window.
3. We ask GPT-4o: *"Is this article the same event as any of these? If yes, attach. If no, start a new cluster."*

Why two passes (embedding + LLM)? Embeddings alone over-cluster in narrow domains (*"used cars India"* looks similar to almost everything). LLM alone is too expensive at scale. Hybrid is fast and accurate.

### Step 4 — **Synthesize** (LLM)
For each cluster (= group of articles about one event), GPT-4o reads all the member articles and writes one editorial story:
- A title, ≤60 chars, that states the news.
- A one-sentence `short_summary` (≤140 chars) for the compact feed row.
- A 3–4 sentence `summary` that pulls unique facts from each source.
- A `cars24_implication` (or blank if there isn't one worth saying).

Source articles are kept, attributed, and linked.

### Step 5 — **Generate the daily brief**
Once a day at 06:00 IST, we pick stories by importance + recency, decide the time window (24/48/72h based on volume), and cache the result. Every page load reads from this cached row.

### Step 6 — **Generate competitor summaries**
At 05:00 IST, for each competitor we generate:
- A weekly themed summary (the underlying stories are linked).
- A quarterly themed summary (or a "filling in" message if shallow).

### Plus: one-shot historical backfill
A one-shot job pulls 90 days of history from Google News (date-range queries per competitor) so the quarterly view has real depth on day one. This runs once; future quarters fill in organically as the live ingest collects.

---

## 5. What the user sees vs what the user doesn't

| User sees | User doesn't see (but it's there) |
|---|---|
| 4–6 hero stories | The 30–50 articles ingested today, of which most were dropped |
| 1 line "what this means for Cars24" | The 4-bucket classifier, the importance score, the LLM reasoning |
| *"ET Auto + 3 others"* attribution | The full cluster of 4 articles, all dedupe-traced |
| *"Read at [source] →"* link | The original URL + full source name |
| *"Quiet last 24h — showing since Friday"* | The dynamic 24h → 48h → 72h fallback |
| *"Filling in..."* on quarterly | The honest empty-state guard |
| The bucket tag pill `[COMPETITOR]` | Every story has been routed through 4-bucket classification |

The product is mostly the iceberg under the waterline. The 1-page brief is what surfaces.

---

## 6. Out of scope (deliberately)

| Not included | Why |
|---|---|
| Auth, accounts, personalization | Friction on a tool meant to be a single URL visit. |
| Email digest, Slack bot, push notifications | Pull beats push for an executive who already gets 200+ emails/day. |
| Raw article browser | The point of the brief is the editing — exposing the raw stream defeats it. |
| Archive beyond yesterday in the hero | Keeps the page lean. Full 7d / 90d archive is at `/feed/week`. |
| Share-of-voice / sentiment charts | Tempting visualization layer; signal is too low at this volume to be honest. |
| Source-health admin dashboard | Source health lands in `sources.last_status`; a UI for it is on the roadmap. |
| Mobile-first polish | Responsive, but designed desktop-first. |

---

## 7. Future work

- **Email digest** at 06:00 IST for leadership members who don't open the URL.
- **Slack integration** (`/cars24-brief` slash command).
- **Personalized lenses** (COO sees ops-tilted, CFO sees finance/funding-tilted).
- **Source expansion** to 25–30 sources, including international used-car coverage (Carvana, Cazoo, AutoTrader UK) for benchmark signal.
- **Alerts** for HIGH-importance stories breaking outside the 2h cron window.
- **Source-health dashboard** so it's obvious when a feed dies.
- **Scoring & feedback loop** — thumbs up/down so the model learns the editorial bar over time.
