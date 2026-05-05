# Auto Pulse — Loom Script

**Audience:** Vikram (Cars24 CEO).
**Length target:** 8–10 min (Vikram asked for 5–10).
**Brief:** Build a daily auto-aggregator. Pull used-car news + competitor moves
from 10 sources, dedup, summarize, output a 1-page brief readable in 2 min.
Actual build: 7 hours. Walk through source list + dedup logic, run on yesterday's
news, name one place scope was cut.

---

## Beat 1 — Open with the problem (30 sec)

> "Hi Vikram — Sai here. This is Auto Pulse, my answer to the 48-hour brief.
>
> The problem you're trying to solve: tracking the Indian auto market means
> opening 8 to 10 sites a day, deduping the same story syndicated five times,
> filtering out your own PR, and translating generic auto news into *'does
> this affect us?'*. 30 to 45 minutes of mental work, every morning.
>
> Auto Pulse compresses it to a 2-minute read. One URL, refreshed every 2
> hours. Let me show you."

---

## Beat 2 — Live demo: Feed today (1.5 min)

**Land on the home page.**

> "Date, last-updated timestamp in IST, two tabs: **Feed** and **Competitors**.
>
> The Feed is a single ranked list of the 4 to 6 stories from the Indian auto
> market that matter today. Around 30–50 articles get ingested in a typical
> day; most get dropped, and these are what's left."

**Click a story open.**

> "Each row gives you the headline, a one-line summary, and source. Click in
> and you get the full 3-sentence summary — synthesized from every outlet
> that covered the event — and the **'So what for Cars24?'** line.
>
> That's the editorial payoff. The model only writes that line when it has a
> specific, non-generic take. If there's nothing real to say, we leave it
> blank — better silence than padding with *'Cars24 should monitor this
> development.'*"

**Point at attribution.**

> "Attribution: primary outlet, plus *'+ 3 others'* if multiple covered it.
> Click and it opens the original article. Every claim is traceable."

**[Click a source link, let it open, close the tab.]**

---

## Beat 3 — "Run the brief on yesterday's news" (45 sec)

*(This is the explicit ask in the brief — make it a deliberate moment.)*

**Click the Yesterday segment.**

> "You asked to see the brief run on yesterday's news. Here it is —
> yesterday's edition. Same shape, same editorial bar, just the previous
> day's window. *[Walk through 1-2 stories briefly: title, the implication
> line, the source count.]*
>
> The system runs every 2 hours, so this isn't a backfill — this is what
> someone opening the page yesterday morning would have seen. Useful before
> a Monday standup."

**Click Last 7 Days.**

> "And the weekly recap — only the highest-importance items from the last
> seven days, deduped against today's hero so you never see the same story
> twice."

---

## Beat 4 — Source list walkthrough (1 min)

*(Vikram explicitly asked for this. Be specific.)*

> "You asked about the source list. There are 10 sources, deliberately mixed:
>
> **Four direct trade-press feeds** — ET Auto, Autocar India, Live Mint Auto,
> and a Google News query for *'Indian auto industry'*. These give general
> market coverage.
>
> **Five competitor watches** — one Google News feed each for Cars24, Spinny,
> CarDekho, Droom, and OLX Autos. All five use the same event-oriented query
> template: the company name in quotes, AND'd with a list of strategic-move
> verbs — *funding, raises, acquires, layoffs, launches, IPO, appoints,
> resigns, profit, loss, revenue*. Without the verb list, *'CarDekho'* would
> return mostly their own car-review SEO content, not news *about* them. The
> verb list is what turns Google News into a real competitor watch.
>
> **Two topic watches** — *'used cars India'* and *'car depreciation / used
> car prices India'* — for market signal that doesn't show up under any
> single competitor's name.
>
> Adding a new source — say Maruti True Value, or international benchmarks
> like Carvana or Cazoo — is a one-line config change."

---

## Beat 5 — Dedup + clustering logic (1.5 min)

*(Also explicitly asked for. This is the technical centerpiece.)*

> "You asked about dedup. There are two layers.
>
> **Layer 1 — URL dedup at ingest.** When we pull from 10 feeds, we skip any
> URL we've already seen. Cheap and exact.
>
> **Layer 2 — semantic clustering.** When 12 different outlets cover the
> same event with 12 different headlines, those are 12 different URLs but
> one story. To collapse them:
>
> First, every article gets converted into a 1536-dimension vector — a math
> fingerprint of meaning, using OpenAI's embedding model. Two articles about
> the same event have fingerprints that point in nearly the same direction.
>
> Second, for each new article, we use the vector to find the 5 nearest
> existing clusters in the database — but only clusters of *the same
> competitor*, in *a tight time window*. A Spinny article literally cannot
> get routed into a CarDekho cluster, and a March layoff cannot merge into a
> May layoff. That constraint is enforced in SQL, not prompt-engineered.
>
> Third, GPT-4o looks at those 5 candidates plus the new article and decides:
> attach to one, or start a new cluster.
>
> Why hybrid instead of just embeddings or just LLM? Embeddings alone
> over-cluster — every article about *'used cars India'* looks similar.
> LLM alone is too expensive at scale. The hybrid is fast and accurate.
>
> Once a cluster has its members, GPT-4o reads them all and writes the one
> editorial story you saw on the front page."

---

## Beat 6 — Competitors tab (1 min)

**Click Competitors.**

> "Same data, sliced by competitor. Left rail is the company list — Cars24,
> Spinny, CarDekho, Droom, OLX Autos — ranked by activity. Click any one and
> you get **This week** and **This quarter** for that competitor.
>
> Week and quarter, deliberately. Day is too noisy. Month is an awkward
> middle. Week catches news cycles, quarter catches strategic moves."

**Click a competitor with content. Show themed groupings.**

> "The week and quarter views are themed — *Funding*, *Product moves*,
> *Leadership* — each theme has bullets, each bullet links to its source
> articles."

**If a quarter is sparse, point at the 'filling in' message.**

> "When a quarterly view is shallow, we say so plainly — *'filling in...'*
> — rather than padding with weak data. Quarterly depth builds organically
> as the live feeds accumulate; about 30 days in, it's fully formed."

---

## Beat 7 — Cars24 tab (20 sec)

**Switch to the Cars24 sub-tab inside Feed.**

> "And press *about Cars24* sits in its own tab inside Feed — different lens,
> same shape. Today, plus the last 14 days."

---

## Beat 8 — How it works page (15 sec)

**Footer → How Auto Pulse works. Quick scroll.**

> "There's a public methodology page covering the problem, the 5-step
> pipeline, and the stack. Anyone landing on the site can understand exactly
> what they're looking at."

---

## Beat 9 — Backend, fast (1.5 min)

**Vercel dashboard.**

> "Frontend is a Next.js app on Vercel. Auto-deploys from GitHub. Repo is
> shared with you."

**Supabase → Edge Functions.**

> "Backend is seven Supabase Edge Functions, ~2,400 lines of TypeScript total:
> `rss-ingest`, `classify-articles`, `route-articles`, `synthesize-stories`,
> `generate-daily-brief`, `generate-competitor-summary`, and a `run-pipeline`
> orchestrator that chains them."

**Database → Tables.**

> "Seven tables — sources, articles, clusters, stories, daily_briefs,
> competitor_summaries, pipeline_state."

**Cron jobs.**

> "Four pg_cron schedules: pipeline every 2 hours, archive stale clusters
> nightly at 4 AM IST, daily brief regenerates at 6:05 AM IST, competitor
> rollups at 6:15. By the time you open the page with morning coffee,
> everything is fresh.
>
> Total OpenAI cost: under $2 a month. Vercel and Supabase on free tiers."

---

## Beat 10 — Where I cut scope (1 min)

*(Vikram explicitly asked for ONE. Lead with the headline cut, then list the
others briefly so it's clear every cut was deliberate, not accidental.)*

> "You asked where I cut scope to ship in 7 hours instead of 60. The
> headline cut: **performance polish on the Competitors tab.**
>
> You probably noticed the Competitors page takes a beat to load when you
> click between competitors. Each click hits the database for that
> competitor's stories and summaries fresh. With caching, prefetching, and
> a static-generation pass at brief-build time, that goes from ~1 second to
> instant. I knew exactly how to do it. I chose not to, because the time
> went into editorial quality instead — better prompts, the dedup
> guardrails, the implication-suppression logic. A snappy product that
> says nothing useful is worse than a slow product that does. Easy to fix
> in a follow-up day.
>
> **Other cuts I made deliberately:**
>
> 1. **No login.** My previous app, BlockPulse, was a mobile app with
>    auth. Here, a single public URL is the right shape — friction kills a
>    2-minute morning habit. If this becomes an internal tool for 100
>    people, you'd want SSO; for a leadership read, you don't.
> 2. **No email digest.** Pull beats push for someone who already gets
>    200 emails a day. Easy to add — same data, different render.
> 3. **Fixed time windows.** I considered letting users pick custom
>    windows — last 2 days, last month, etc. I left them fixed because
>    *picking the windows is part of the editorial stance*. Today, Yesterday,
>    Last 7 Days, This Week, This Quarter — these are the windows that
>    matter for an exec read. Configurability would have added a settings
>    surface and diluted the opinion.
> 4. **Prompt tightening.** The current prompts work well for ~90% of
>    articles. Tightening the long tail needs more diverse source data than
>    the live feeds have produced in 48 hours. I pushed it to a follow-up
>    once there's a real corpus to test against."

---

## Beat 11 — Close (30 sec)

> "To recap: 10 sources, two-layer dedup with vector + LLM clustering, GPT-4o
> for synthesis, refreshes every 2 hours, fresh brief at 6:05 AM IST, runs at
> under $2 a month. Whole thing is one URL — read in 2 minutes, close the tab.
>
> Repo and Loom links are in the email reply. Built with Cursor, GPT-4o, and
> Claude for code review. Happy to walk through any of this live in Gurugram —
> would love to do that."

---

## Email reply checklist

Before you send, confirm you have answers for all five:

- [ ] **Repo:** GitHub link (public or shared with Vikram)
- [ ] **Loom:** shareable link
- [ ] **Hours on build:** 7 hours
- [ ] **AI tools used:** Cursor, GPT-4o (classification + synthesis),
      text-embedding-3-small (clustering), Claude (code review / docs)
- [ ] **One thing you'd defend if pushed back:** *(suggested)* "Suppressing
      the 'so what for Cars24?' line when there isn't a genuine take — most
      tools pad it with safe filler; I'd rather show silence than slop."

---

## Quick reference (for live Q&A in Gurugram)

| Likely question | Answer |
|---|---|
| "How many articles a day?" | 30–50 ingested, most dropped, 4–6 surface. |
| "How accurate is dedup?" | Two-pass: URL exact match, then vector + LLM judge scoped to same competitor + tight time window. Structurally cannot mix companies. |
| "Why GPT-4o, not cheaper?" | Editorial quality matters more than cost at this volume. Total spend is <$2/mo. Easy to swap models per stage. |
| "Add a new competitor?" | Config change, not code. Backfills as articles come in. |
| "Hindi / vernacular?" | English-only today. Indic-script + obvious transliteration dropped pre-LLM. Vernacular is a roadmap item. |
| "Email digest?" | Roadmap. Easy — same data, different render. |
| "What if a source dies?" | Per-source `last_status` is logged. Source-health dashboard is roadmap. |
| "How long until quarterly is full?" | ~30 days from go-live. Shows *'filling in'* until then. |
| "Why not weights of stories shown to me to learn over time?" | No editorial feedback loop today. Genuinely valuable once you're reading it daily; cut for the 7-hour build. |
| "Why is Competitors slow?" | Caching/prefetch was the cut. Fix is straightforward — static-generate at brief-build time. |

---

## Things NOT to say

- Don't call it an "aggregator." It's a brief — the editing is the product.
- Don't say "AI does it." Say "the model classifies / synthesizes." Specific is more credible than magical.
- Don't apologize for the quiet-day widening. It's a feature; explain it as one.
- Don't read out cron syntax. Just say "every 2 hours."
- Don't hedge on the scope cut. Pick one, own it.
