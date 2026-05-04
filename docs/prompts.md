# Prompts

Every LLM prompt in the pipeline, with the design rationale.

The prompts are the editorial brain of the product. They're worth more
attention than they usually get — they're what separates "fetch RSS
and show it" from "a brief the leadership team would actually read."

> Source files:
> - Classifier: `supabase/functions/classify-articles/index.ts`
> - Router: `supabase/functions/route-articles/index.ts`
> - Synthesizer: `supabase/functions/synthesize-stories/index.ts`
> - Competitor summarizer: `supabase/functions/generate-competitor-summary/index.ts`

---

## Prompt design principles

1. **Open in scope, strict in quality.** The classifier accepts a wide
   range of "useful" stories (4 buckets), but is explicit that most
   articles will be LOW or DROP. The opposite — narrow scope, lenient
   quality — would either miss signal or pad the brief.

2. **Worked examples > rules.** Every prompt includes a few `✓` and `✗`
   examples. LLMs follow concrete examples more reliably than abstract
   rules.

3. **Permission to say nothing.** The classifier and synthesizer can
   return `null` / `""` for `cars24_implication` when no genuine
   insight exists. Forcing an implication on every story produces
   garbage like "Cars24 should monitor this development." Honest
   absence beats fake presence.

4. **Explicit anti-noise rules.** Things like "motorsport / two-wheelers
   / luxury enthusiast comparisons → DROP" save a lot of brief
   pollution.

5. **One LLM call per atomic unit.** Per article (classifier), per
   article (router), per cluster (synthesizer). No batched calls — we
   want isolated reasoning and easy debug.

6. **Strict JSON output, validated server-side.** Every prompt asks for
   "ONLY a JSON object, no markdown, no preamble." We then re-validate
   against an enum + shape, normalize edge cases (literal "None" →
   `null`), and surface clear errors on schema drift.

---

## 1. `classify-articles` — the editorial brain

**Model:** `gpt-4o`
**Concurrency:** 5 parallel calls
**Per-article cost:** ~$0.005-0.015

### System prompt (excerpt)

> You are the editor of "Auto Market Pulse for Cars24" — a daily
> intelligence brief for the Cars24 leadership team.
>
> Your job is to read one auto-industry news article and decide:
> Would this help Cars24's leadership understand the market, competitors,
> or external narrative better today?
>
> Cars24's business is the used-car ecosystem in India: buying from
> consumers, refurbishing, financing, listing, and reselling. But the
> team also needs to stay on top of the broader Indian auto market
> because new-car volume, fuel mix, OEM strategy, financing, taxes,
> scrappage rules, and consumer preference shifts all become used-car
> supply, demand, pricing, and product strategy signals.
>
> Direct competitors: Spinny, CarDekho (and Gaadi), Droom, OLX Autos.
> Adjacent players: Maruti True Value, Hyundai H Promise, Mahindra
> First Choice, OEM CPO programs, classifieds, large dealer chains,
> financing/insurance partners.

### The 4 buckets

| Bucket | Definition |
|---|---|
| **COMPETITOR** | Material moves by Spinny, CarDekho, Droom, OLX Autos, or adjacent used-car/CPO players. Funding, leadership, products, expansions, partnerships, lawsuits, layoffs. |
| **MARKET** | Indian auto-market pulse that can affect Cars24 directly or indirectly. OEM volumes, market share, mix shifts (SUV/hatchback/sedan, EV/CNG), discounts, fuel prices, financing, GST/tax, scrappage rules, depreciation, rural/urban demand. *Does NOT need to mention Cars24 or used cars.* |
| **CARS24_PRESS** | Third-party coverage ABOUT Cars24 that reflects external narrative. Funding/IPO chatter, leadership, regulatory issues, customer complaints, leaks, viral negative coverage. |
| **CARS24_PR** | Cars24's own outbound marketing, thought leadership, branded content. Press releases, advertorials, exec quotes, generic advice articles. *Usually LOW or DROP* — the CEO knows his own marketing. |

### The importance bar

| Level | Bar |
|---|---|
| **HIGH** | Founder-critical today. Competitor funding/M&A/IPO, top-competitor leadership change, major regulatory action, scrappage rule change, viral negative Cars24 coverage. |
| **MED** | Meaningful for strategy or ops. For MARKET: quantitative shifts (sales %, mix %, price moves), structural shifts (rules, tax, financing), early indicators (EV/CNG adoption, rural demand). |
| **LOW** | Adjacent or weak signal. Single-model launches, minor discounts, generic trend pieces without numbers. Doesn't enter the brief. |
| **DROP** | Noise. Motorsport, two-wheelers only, luxury enthusiast pieces, photo galleries, generic reviews/buying guides, coupons, non-India items, non-English/transliterated titles. |

### Language gate

The classifier drops non-English or transliterated/Hinglish titles before
clustering. This product is an English CEO brief, and non-English duplicate
coverage is more likely to create noisy false splits than to add unique signal.

### Two critical rules

> **Critical MARKET rule:** Industry stories without a named
> competitor are NOT automatically LOW. Ask: does this affect Cars24's
> SUPPLY, DEMAND, PRICING, INVENTORY MIX, REFURBISHMENT priorities,
> FINANCING, or PRODUCT/FEATURE strategy? If yes and the article has
> numbers, policy detail, or a clear directional signal, classify as
> MED at minimum.

> **Critical CARS24 rule:** Do not fill the founder brief with Cars24's
> own PR. If Cars24 is simply promoting itself or publishing advice,
> use CARS24_PR and usually LOW/DROP. If independent media is covering
> Cars24 in a way that affects reputation, investor perception,
> hiring, customer trust, or competitive positioning, use
> CARS24_PRESS and classify by impact.

### Output shape

```json
{
  "bucket": "COMPETITOR" | "MARKET" | "CARS24_PRESS" | "CARS24_PR" | null,
  "importance": "HIGH" | "MED" | "LOW" | "DROP",
  "primary_competitor": "Cars24" | "Spinny" | "CarDekho" | "Droom" | "OLX Autos" | null,
  "reasoning": "<1-line, max 25 words>",
  "entities": ["<exact company name>", ...],
  "cars24_implication": "<1-line specific implication, or null>"
}
```

### `primary_competitor` rules

A forced single-choice. Drives clustering (same-competitor only) and
the per-competitor view query.

- If the article is fundamentally about ONE of the 5 tracked players
  → pick that one.
- If MULTIPLE tracked players are involved → pick the **primary actor**
  (the one doing the thing).
- If general market / regulatory / OEM / non-tracked-competitor news
  → return `null` and add the brand to `entities[]` (e.g. Maruti True
  Value).
- When in doubt → `null`. Wrong primary_competitor pollutes a
  cluster; null is always safe.

### Alias map (in the prompt + server-side scrub)

The model is instructed to normalize variants to canonical names:

| Canonical | Aliases / variants |
|---|---|
| **CarDekho** | Cardekho, Car Dekho, CARDEKHO, Gaadi (subsidiary), gaadi.com |
| **Cars24** | Cars 24, CARS24, cars24.com |
| **OLX Autos** | OLX, OLX India, OLX Auto |
| **Spinny** | spinny.com |
| **Droom** | droom.in |

Server-side `normalizePrimaryCompetitor()` re-applies the same
mapping as a belt-and-braces scrub in case the model returns a known
variant verbatim.

### Implication examples (from the prompt)

```
✓ "GST cut on used cars to 12% — direct margin tailwind for Cars24."
✓ "SUV share rising at Maruti signals future sourcing/refurb capacity should skew more toward compact SUVs."
✗ "Could affect the industry."   ← use null instead
✗ "Cars24 should monitor this."  ← use null instead
```

### Server-side validation

- `importance` must be in `{HIGH, MED, LOW, DROP}`.
- `bucket` must be in `{COMPETITOR, MARKET, CARS24_PRESS, CARS24_PR}`
  (or null for DROP).
- `entities` must be string array.
- `normalizeImplication()` converts literal `"none"`, `"null"`,
  `"n/a"`, `"na"`, `"no implication"` to actual `null`.
- For HIGH/MED with no implication → log a warning, don't fail
  (model occasionally misses it but the importance + bucket are
  enough signal).

---

## 2. `route-articles` — cluster routing judge

**Model:** `gpt-4o`, temperature 0.1, max_tokens 250

### System prompt (excerpt)

> You decide whether a new auto-industry news article belongs to an
> existing story cluster (a group of articles about the same
> real-world event) or starts a new cluster.
>
> A "real-world event" is a single happening — one funding round, one
> product launch, one regulatory action, one acquisition, one executive
> exit. Multiple outlets writing about the same event = same cluster.

### Decision rules

> **ROUTE TO EXISTING when:**
> - The new article and a candidate cluster cover the same specific
>   event (same company + same action + same approximate timeframe).
> - Different angles on the same event (e.g. one focuses on the
>   dollar amount, another on the strategic angle) STILL belong
>   together — synthesis pulls those facets into one editorial story
>   later.
> - Follow-up coverage (analysts react, stock moves, official
>   statement follows the news break) belongs with the original
>   break.
> - For competitor IPO/funding/M&A coverage, planning, bankers hired,
>   timeline, valuation, filing, and investor-angle articles within 14
>   days are the same event narrative unless they clearly refer to
>   separate transactions. Reported timeline differences are source
>   variance, not a new event by themselves.
>
> **CREATE NEW when:**
> - Same companies but different events. (Spinny launching in UAE ≠
>   Spinny raising a Series F. Cars24 founder X stepping down ≠ Cars24
>   founder Y stepping down weeks later.)
> - Same theme but different specifics. (Two different used-car GST
>   policy proposals are two events, not one.)
> - You can't find any candidate that's a clear match.
>
> **Default when uncertain:**
> - Same `primary_competitor` + same strategic event family
>   (IPO/listing/funding/M&A/leadership/launch/partnership/layoffs) +
>   timestamps within 14 days → route to existing. False splits inside a
>   competitor narrative show up as duplicate stories in the brief.
> - Same `primary_competitor` but different action verbs → create new.
> - MARKET articles with no `primary_competitor` → when unsure, create new.

### Output shape

```json
{
  "decision": "route_to_existing" | "create_new",
  "cluster_id": "<uuid of chosen candidate, or null>",
  "reasoning": "<1-line, max 20 words>"
}
```

### Why the default differs by lane

For general MARKET stories, false merges are more dangerous because
"auto sales rise" / "EV demand grows" vocabulary recurs across unrelated
events. So MARKET keeps the conservative default: when unsure, create new.

For competitor stories, false splits are more visible and more damaging:
two Spinny IPO rows in the weekly brief make the dedup layer look broken.
So the router prefers merging when the same competitor, same action verb,
and close timestamp point to the same event.

---

## 3. `synthesize-stories` — editorial writer

**Model:** `gpt-4o`, temperature 0.2, max_tokens 800

### System prompt (excerpt)

> You are an editorial writer for the Cars24 leadership team's daily
> intelligence brief.
>
> Multiple news articles cover the same real-world event from
> different angles. You consolidate them into one tight,
> professionally-edited story.

### Voice rules

> - Voice: Bloomberg / Reuters terse. Lead with the news, not the
>   framing.
> - Tense: past for what happened, present for ongoing.
> - **No meta-commentary** ("This development highlights...", "It will
>   be interesting to see...", "Industry observers note..."). Just
>   facts.
> - **No filler conclusions.** End on the last fact, not a summary
>   sentence.
> - Numbers: keep specifics from the articles ($, ₹, %, dates, city
>   counts). Do not round or estimate.
> - Names: full company names on first mention.
> - Indian English. ₹ for INR amounts. Cr / Lakh OK in context.

### Field-by-field rules

| Field | Rule |
|---|---|
| `title` | 60 chars max. **State the news, not the topic.** ✓ "Spinny raises $283M Series F led by Tiger Global" ✗ "Spinny in the news: a major funding update" |
| `summary` | 3-4 sentences, ~70 words. Pull unique facts from each source. NEVER end mid-sentence. |
| `cars24_implication` | 1 line, ≤25 words. Specific and actionable. **Empty string `""` if no genuine implication** — don't fabricate. ✓ "Pressure on Cars24 to defend Tier 1 share — Spinny's UAE expansion validates the cross-border thesis." ✗ "Could affect the industry in interesting ways." ✗ "Cars24 should monitor this development." |
| `importance` | HIGH/MED/LOW. Use the maximum across member articles. Don't downgrade for a quiet day or upgrade for a loud one. |

### Output shape

```json
{
  "title": "<...>",
  "summary": "<...>",
  "cars24_implication": "<...>",
  "importance": "HIGH" | "MED" | "LOW"
}
```

### Server-side post-processing

- `normalizeImplication()` again — converts literal "none"/"null"/etc.
  to `null` so the UI can hide the line cleanly.
- Final `importance` = `max(LLM-suggested, max-of-members)`. The model
  can never *lower* the importance below the max of its inputs.

---

## 4. `generate-competitor-summary` — themed rollup

**Model:** `gpt-4o`

Generates the weekly + quarterly themed bullets shown in the
expandable competitor row.

### Shape of the prompt

> For competitor `<name>` and these `<N>` stories from the last
> `<week | quarter>`, group them into 2-4 themes (e.g. *Funding &
> investor activity*, *Product moves*, *Leadership*). For each theme,
> write 2-4 short bullets that synthesize the underlying stories.
> Every bullet must reference its source story IDs so the UI can link
> to the originals.
>
> Also write a `context_line` for the sparkline strip (≤80 chars):
> what changed this week vs the previous week. e.g. "Funding driving
> 250% mention spike", "Quiet week — usual product chatter".

### Output shape

```json
{
  "context_line": "Funding driving 250% mention spike",
  "themed_summary": {
    "themes": [
      {
        "title": "Funding & investor activity",
        "bullets": [
          {"text": "Spinny raised $283M Series F at $1.8B valuation",
           "story_ids": ["uuid", "uuid"]}
        ]
      }
    ],
    "total_stories": 12
  }
}
```

### Day-one quarterly fallback

If <4 weekly summaries exist for a competitor, the function falls
back to raw 90-day stories (including backfill). This is documented
in the prompt input so the model knows it's working with a deeper
horizon than usual.

---

## Prompt iteration history

What we tried, what didn't work, what we kept.

1. **Initial classifier was 2-bucket** ("useful for Cars24" / "not
   useful"). Lost the *why* — the reader couldn't tell at a glance whether
   a story was a competitor move vs a market signal vs Cars24's own PR.
   → Replaced with 4-bucket.

2. **Initial prompt forced an implication on every story.** Got
   garbage like "Cars24 should monitor this development." → Allowed
   `null`, added explicit "✗ use null instead" examples.

3. **Initial classifier downweighted MARKET stories** (no Cars24
   mention → automatic LOW). Missed real signal like GST changes,
   scrappage rules. → Added the explicit "Critical MARKET rule" that
   asks the question "does this affect supply / demand / pricing /
   inventory / financing / strategy?"

4. **Initial classifier didn't separate Cars24's own PR.** Brief was
   getting polluted with "Cars24 launches new feature" from press
   releases. → Added CARS24_PR bucket with explicit "usually LOW or
   DROP" guidance.

5. **Tested GPT-4o-mini for classification.** Bled CARS24_PR into
   CARS24_PRESS. The judgment isn't one-shot — it requires reading
   between the lines of a press release vs an independent piece. →
   Stayed on GPT-4o.

6. **Initial synthesizer wrote conclusion sentences** ("This will be
   important for the industry going forward.") → Added explicit "No
   filler conclusions. End on the last fact" rule.

7. **Initial router didn't have a "when unsure" tiebreaker.** False
   merges showed up in the UI as "why are these unrelated?" → Added
   "WHEN UNSURE → create_new" as the default.
