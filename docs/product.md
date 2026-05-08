# Product

**Cars24 Brief — auto market pulse for the Cars24 leadership team.**

> Written for a non-engineering reader. For the under-the-hood view, jump to
> [`architecture.md`](./architecture.md), [`pipeline.md`](./pipeline.md), and
> [`prompts.md`](./prompts.md).

---

## TL;DR

A single web page, fresh every morning. The Feed tab shows the 4–6 stories from the Indian auto market that matter today — competitor moves and market signals — each with a 1-line "what this means for Cars24" callout, plus Yesterday and Last 7 Days views. A separate Cars24 sub-tab inside Feed surfaces external press about Cars24 (Today + Last 14 Days). The Competitors tab gives per-competitor weekly + quarterly rollups. Read in 2 minutes; close the tab.

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

### 3.1 Feed — Today's Brief (the "Hero")

A single ranked list of the 4–6 most important stories from the last 24 hours. No section headers, no bucket pills on the row — bucket is an internal routing concept, not a reader concept.

For each story:
- **A one-line title.**
- **2–3 sentences of context** (synthesized from every outlet that covered the story).
- **A "So what for Cars24?" line** — only when the model has a genuine, specific take. Otherwise we suppress the line; better to say nothing than pad with *"Cars24 should monitor this development."*
- **Source attribution** — primary outlet name + an explicit *"Read at [source] →"* link. If multiple outlets covered it we say so (*"ET Auto + 3 others"*).

The Feed tab has three time segments: **Today**, **Yesterday**, and **Last 7 Days**.

**Quiet-day handling.** The window is a strict 24h. If nothing fresh and eligible came in overnight, the Today segment shows an honest empty state ("Nothing new in this window. Check back later.") and the reader falls back to the **Yesterday** or **Last 7 Days** segments inside the same Feed tab. We deliberately do *not* widen to 48h/72h — re-surfacing day-old stories under a "today" header is misleading, and yesterday's hero is one click away in the Yesterday segment.

### 3.1a Feed — Cars24 sub-tab

External press about Cars24 lives in its own sub-tab inside Feed. Different read from competitor moves — same shape, but two segments: **Recent Cars24 mentions** and **Earlier in the last 14 days**. The full 90-day Cars24 archive lives at `/feed/week?tab=cars24`.

### 3.2 Competitor Pulse

One row per major competitor in the left rail: Spinny, CarDekho, Droom, OLX Autos. **Cars24 is pinned at the bottom** — it's "us, not them," and the rail is for scanning competitors first.

The right pane is a quarter-in-review brief, designed to read like an analyst handed it to the CEO. Top-to-bottom:

1. **TL;DR** — 1–2 sentences. What materially changed about this competitor in 90 days.
2. **What they did** — an exhaustive event ledger. Every material event the competitor logged in the last 90 days, with date and 1-line description, grouped by event type (funding, product, expansion, people, partnerships, regulatory, pricing, restructuring, other). Each row links back to the source story. The ledger is *not* abstracted into themes — three product launches show up as three rows, never as "active product cadence."
3. **Patterns worth flagging** — only when ≥2 events form a coherent strategic thread (e.g. *"Aggressive financing push: acquisition + 2 lending partnerships in 60 days"*). When no pattern exists, this section is empty. We don't pad.
4. **So what for Cars24** — 0–4 quarter-level implications, concrete and actionable. Empty if there isn't one worth saying.

Below the brief, **This week** lists the last 7 days of stories, and **Archive** holds the older 90-day stories one click away.

### 3.3 Yesterday + Last 7 Days

Yesterday and Last 7 Days are segments inside the Feed tab, not separate pages. Yesterday is the same hero shape, just from yesterday — useful before a Monday standup (*"did anything ship over the weekend?"*). Last 7 Days is the weekly recap (HIGH-importance items, topped up with MEDIUMs that have a concrete Cars24 implication if HIGH alone is thin). Day-before-yesterday is intentionally not kept on the home page. The full 7-day and 90-day archives live at `/feed/week`.

---

## 4. What the AI pipeline actually does (in plain English)

The product is not "fetch RSS and show it." It's an opinionated edit. Here's what runs in the background, in human terms:

### Step 1 — **Ingest**
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
Once a day at 06:05 IST, after the latest source data is ready, we pick stories by importance + recency from a 24h window anchored to the brief_date — `(brief_date − 1) 06:05 IST → brief_date 06:05 IST`. The window is deterministic, so re-runs of the function produce the same answer rather than sliding forward. Every page load reads from the cached row.

### Step 6 — **Generate competitor summaries**
At 06:15 IST, using the same fresh morning dataset, for each competitor we generate:
- A **quarterly event ledger** (raw 90-day stories → exhaustive event ledger + patterns + Cars24 implications). Three LLM passes, recomputed daily so the 90-day window stays current. *Reads from raw stories every time — never from compressed weekly rollups.*
- A **weekly themed digest** (last completed Mon→Sun) — but only on Mondays. On other days the weekly job is a no-op. The weekly is a leaf-node artifact: nothing else reads it.

### Why no "rollup of rollups"
We deliberately do *not* build the quarterly from weekly summaries. A weekly digest compresses ~5 stories into ~3 themed bullets — losing dates, named products, deal sizes, named cities. Once that compression has happened, the quarterly LLM can never recover the detail no matter how good its prompt is. So the quarterly always reads ground truth (raw stories), and the weekly is output-only.

### A note on quarterly depth
Quarterly depth is built up organically from the live RSS feeds. Until ~30+ days of history exist, the event ledger may be thin — that's surfaced honestly rather than padded with weak narrative.

---

## 5. What the user sees vs what the user doesn't

| User sees | User doesn't see (but it's there) |
|---|---|
| 4–6 hero stories | The 30–50 articles ingested today, of which most were dropped |
| 1 line "what this means for Cars24" | The 4-bucket classifier, the importance score, the LLM reasoning |
| *"ET Auto + 3 others"* attribution | The full cluster of 4 articles, all dedupe-traced |
| *"Read at [source] →"* link | The original URL + full source name |
| *"Nothing new in this window."* on a quiet morning | The strict 24h gate — we never quietly resurface day-old stories under a "today" header |
| Honest empty event ledger when a competitor was quiet | The exhaustive-extraction prompt that refuses to invent themes |
| A single ranked Feed (no section headers) | Every story has been routed through 4-bucket classification under the hood; the bucket decides which tab/lane it lands in |

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

- **Email digest** after the 06:05 IST brief refresh for leadership members who don't open the URL.
- **Slack integration** (`/cars24-brief` slash command).
- **Personalized lenses** (COO sees ops-tilted, CFO sees finance/funding-tilted).
- **Source expansion** to 25–30 sources, including international used-car coverage (Carvana, Cazoo, AutoTrader UK) for benchmark signal.
- **Alerts** for HIGH-importance stories that break after the morning brief.
- **Source-health dashboard** so it's obvious when a feed dies.
- **Scoring & feedback loop** — thumbs up/down so the model learns the editorial bar over time.
