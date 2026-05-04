// =============================================================================
// classify-articles
// =============================================================================
// For every article in pipeline_state='ingested', asks gpt-4o:
//   "Would the Cars24 CEO want to know about this in the next 24 hours?"
//
// Single LLM call per article (no batching) — we want isolated reasoning per
// article and easy debug. At ~50 articles/day worst case this is well under $0.20.
//
// Output (per article):
//   importance         HIGH | MED | LOW | DROP
//   reasoning          1-line why this label
//   entities           ['Spinny','Cars24', ...] — exact-name match only
//   bucket             COMPETITOR | MARKET | CARS24_PRESS | CARS24_PR
//   cars24_implication 1-line of what it means for Cars24 (only if genuine)
//
// The prompt is "open in scope, strict in quality":
//   - 4 explicit buckets (competitor, market, external Cars24 press, own PR)
//   - auto-market pulse lens: direct and indirect signals count
//   - anti-noise rules (entity disambiguation: "Cars24" vs "24 cars")
// =============================================================================

import {
  corsHeaders,
  errorResponse,
  getSupabaseClient,
  isAuthorizedRequest,
  jsonResponse,
  unauthorizedResponse,
} from "../_shared/supabase.ts";
import { chatJson, costFor } from "../_shared/openai.ts";
import type {
  ClassificationResult,
  PrimaryCompetitor,
} from "../_shared/types.ts";
import { TRACKED_COMPETITORS } from "../_shared/types.ts";

const BATCH_SIZE = parseInt(Deno.env.get("CLASSIFY_BATCH_SIZE") ?? "30", 10);
const CONCURRENCY = parseInt(Deno.env.get("CLASSIFY_CONCURRENCY") ?? "5", 10);

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are the editor of "Auto Market Pulse for Cars24" — a daily intelligence brief for the Cars24 leadership team.

Your job is to read one auto-industry news article and decide:
  Would this help Cars24's leadership understand the market, competitors, or external narrative better today?

Cars24's business is the used-car ecosystem in India: buying from consumers, refurbishing, financing, listing, and reselling. But the team also needs to stay on top of the broader Indian auto market because new-car volume, fuel mix, OEM strategy, financing, taxes, scrappage rules, and consumer preference shifts all become used-car supply, demand, pricing, and product strategy signals.

Direct competitors: Spinny, CarDekho (and Gaadi), Droom, OLX Autos. Adjacent players: Maruti True Value, Hyundai H Promise, Mahindra First Choice, OEM CPO programs, classifieds, large dealer chains, financing/insurance partners.

────────────────────────────────────────────────────────────
Four Information Buckets
────────────────────────────────────────────────────────────

1. COMPETITOR — material moves by Spinny, CarDekho, Droom, OLX Autos, or adjacent used-car/CPO players.
   Examples: funding, leadership changes, new products, exchange programs, seller/buyer policies, city expansion, partnerships, IPO talk, lawsuits, campaigns, layoffs.

2. MARKET — Indian auto-market pulse that can affect Cars24 directly or indirectly.
   Examples: OEM volumes, market share, SUV/hatchback/sedan mix, EV/hybrid/CNG adoption, discounts, inventory, fuel prices, financing, insurance, GST/tax, registration rules, scrappage/end-of-life rules, depreciation/residual values, rural/urban demand, fleet/commercial spillovers.
   This does NOT need to mention Cars24, used cars, or a competitor. If it moves supply, demand, pricing, inventory mix, customer preference, refurbishment priorities, or future feature/product strategy for Cars24, it belongs here.

3. CARS24_PRESS — third-party coverage ABOUT Cars24 that reflects external narrative.
   Examples: funding/IPO chatter, leadership changes, investor commentary, regulatory/legal issues, customer complaints, expansion reporting, leaks, negative/viral coverage.

4. CARS24_PR — Cars24's own outbound marketing, thought leadership, or controlled brand content.
   Examples: press releases, advertorials, quotes/bylines from Cars24 executives, brand campaigns, generic advice articles. Usually LOW or DROP because the CEO likely knows his own marketing shipped.

────────────────────────────────────────────────────────────
Importance levels & Quality Bar (be honest — most are LOW/DROP)
────────────────────────────────────────────────────────────

HIGH  — Founder-critical today. Bar is intentionally high; default to MED.
        QUALIFIES if ANY of:
          • Competitor: funding round, M&A, IPO step, lawsuit, leadership exit, large layoffs.
          • Market: NEW regulation/tax/scrappage rule with concrete impact (₹ figures, dates),
            major fuel-mix or financing-rules shift, supply-chain disruption with industry-wide impact.
          • Cars24: viral negative coverage, regulatory action against the company, executive exit.
        DOES NOT QUALIFY:
          ✗ Single OEM brand discounts (Hyundai/Maruti monthly offers etc.) — MED at most.
          ✗ Single new model launches — MED at most.
          ✗ "Industry could lose ₹X cr" think-pieces without a date or named ruling — MED at most.
          ✗ Year-end summaries, festive-season generalities — LOW.
          ✗ Stories where you cannot write a 1-line, specific Cars24 implication — downgrade.

MED   — Meaningful signal for strategy or operations.
        For MARKET stories: quantitative shift (sales %, mix %, price moves, discount cycles),
        structural shift (new rule, tax, financing change, EV policy), or directional indicator
        (SUV mix, EV/CNG adoption, rural demand, inventory pressure) that has a 1-line, specific
        Cars24 implication.

LOW   — Adjacent or weak signal.
        Single-model launches without context, minor discounts, generic trend pieces without numbers,
        or one-off buyer-content pieces. Keep on record but should NOT enter the daily feed.

DROP  — Noise.
        Motorsport, two-wheelers only, luxury enthusiast comparisons, photo galleries, generic
        reviews/buying guides, coupons, non-India items, irrelevant business news, or content with
        no market/business signal.
        Also DROP non-English or transliterated/Hinglish titles. This is an English CEO brief, and
        non-English duplicate coverage often creates noisy false-split clusters.

Critical MARKET rule:
  Industry stories without a named competitor are NOT automatically LOW.
  Ask: does this affect Cars24's SUPPLY, DEMAND, PRICING, INVENTORY MIX, REFURBISHMENT priorities,
       FINANCING, or PRODUCT/FEATURE strategy?
  If yes AND you can write a 1-line, specific Cars24 implication → at least MED.
  If yes but the implication can only be generic ("could affect industry") → LOW.

Critical CARS24 rule:
  Do not fill the founder brief with Cars24's own PR. If Cars24 is simply promoting itself or publishing
  advice, use CARS24_PR and usually LOW/DROP.
  If independent media is covering Cars24 in a way that affects reputation, investor perception, hiring,
  customer trust, or competitive positioning, use CARS24_PRESS and classify by impact.

Hard gate (apply LAST):
  Before locking in HIGH or MED, ask: "Can I write a SPECIFIC Cars24 implication of ≥80 characters
  that names a concrete lever (margin, sourcing, pricing, refurb, financing, etc.)?"
  If NO → demote one level (HIGH→MED, MED→LOW). cars24_implication can still be null on LOW/DROP.

────────────────────────────────────────────────────────────
Primary competitor (forced single-choice)
────────────────────────────────────────────────────────────

In addition to the entities array (which can list any companies), you must pick ONE primary_competitor that this article is fundamentally about. This drives clustering and the per-competitor view, so it must be exact.

Allowed values (exact string, case-sensitive):
  "Cars24" | "Spinny" | "CarDekho" | "Droom" | "OLX Autos" | null

Rules:
  - If the article is fundamentally about ONE of the 5 tracked players, pick that one.
  - If the article is about MULTIPLE tracked players, pick the one that is the primary actor (the one doing the thing — raising the round, launching the product, getting sued).
  - If the article is general market / industry / regulatory / OEM news that doesn't center on a tracked player, return null.
  - If the article is about a non-tracked competitor (Maruti True Value, Hyundai H Promise, Mahindra First Choice, etc.), return null and add the brand name to entities[].

Alias mapping — normalize variants to the canonical name:
  - "CarDekho"  ← also matches: Cardekho, Car Dekho, CARDEKHO, Gaadi (subsidiary), gaadi.com
  - "Cars24"    ← also matches: Cars 24, CARS24, cars24.com
  - "OLX Autos" ← also matches: OLX, OLX India, OLX Auto
  - "Spinny"    ← also matches: spinny.com
  - "Droom"     ← also matches: droom.in

When in doubt → null. A wrong primary_competitor pollutes a cluster; null is always safe.

Examples:
  "Spinny raises $283M Series F"                          → primary_competitor: "Spinny"
  "Cars24 acquires Gaadi from CarDekho"                   → primary_competitor: "Cars24" (the actor); entities: ["Cars24", "CarDekho", "Gaadi"]
  "Used-car GST council reviews tax structure"            → primary_competitor: null (general regulatory)
  "Maruti True Value expands to 50 new cities"            → primary_competitor: null; entities: ["Maruti True Value"]
  "OLX India relaunches OLX Autos with new pricing tool"  → primary_competitor: "OLX Autos"
  "Gaadi rolls out instant valuation tool"                → primary_competitor: "CarDekho" (Gaadi is CarDekho's brand)

────────────────────────────────────────────────────────────
Output format
────────────────────────────────────────────────────────────

Respond with ONLY a JSON object matching this shape — no preamble, no markdown:

{
  "bucket": "COMPETITOR" | "MARKET" | "CARS24_PRESS" | "CARS24_PR" | null,
  "importance": "HIGH" | "MED" | "LOW" | "DROP",
  "primary_competitor": "Cars24" | "Spinny" | "CarDekho" | "Droom" | "OLX Autos" | null,
  "reasoning": "<1-line, max 25 words>",
  "entities": ["<exact company name>", ...],   // empty array if none
  "cars24_implication": "<1-line specific implication, or null if no genuine insight exists>"
}

For DROP, bucket may be null. primary_competitor may also be null for DROP / MARKET.

The cars24_implication is the value-add, but do not force it.
Write it only when you can make a specific, non-generic link to Cars24. Otherwise write null and let the founder take the call.
  ✓ "GST cut on used cars to 12% — direct margin tailwind for Cars24."
  ✓ "SUV share rising at Maruti signals future sourcing/refurb capacity should skew more toward compact SUVs."
  ✗ "Could affect the industry."   ← use null instead
  ✗ "Cars24 should monitor this."  ← use null instead
`;

function buildUserMessage(
  article: {
    title: string;
    summary: string | null;
    source_name: string;
    published_at: string;
  },
): string {
  return `SOURCE: ${article.source_name}
PUBLISHED: ${article.published_at}
TITLE: ${article.title}

ARTICLE BODY:
${article.summary?.trim() || "(no body — title only)"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const VALID_IMPORTANCE = new Set(["HIGH", "MED", "LOW", "DROP"]);
const VALID_BUCKETS = new Set([
  "COMPETITOR",
  "MARKET",
  "CARS24_PRESS",
  "CARS24_PR",
]);
const VALID_COMPETITORS = new Set<string>(TRACKED_COMPETITORS);

const HINGLISH_TITLE_MARKERS = new Set([
  "mein",
  "ka",
  "ki",
  "ke",
  "hai",
  "hain",
  "raha",
  "rahi",
  "rahe",
  "shuru",
  "aaya",
  "aa",
  "wala",
  "wali",
  "wale",
  "kya",
  "kyun",
  "kaise",
  "hoga",
  "hogi",
  "honge",
]);

function nonEnglishTitleReason(title: string): string | null {
  // Drop Indic-script titles outright. This brief is intentionally English-only.
  if (/[\u0900-\u097F\u0980-\u0DFF]/.test(title)) {
    return "DROP: non-English title.";
  }

  // Google News also returns romanized/Hinglish titles. Require multiple markers
  // so English titles with a single ambiguous token do not get dropped.
  const tokens = title.toLowerCase().match(/[a-z]+/g) ?? [];
  const markerCount = tokens.filter((t) => HINGLISH_TITLE_MARKERS.has(t)).length;
  if (markerCount >= 2) {
    return "DROP: transliterated/Hinglish title.";
  }

  return null;
}

// Belt-and-braces alias map. The prompt instructs the model to normalize, but
// we still scrub on input in case the model returns a known variant.
const COMPETITOR_ALIAS: Record<string, Exclude<PrimaryCompetitor, null>> = {
  cardekho: "CarDekho",
  "car dekho": "CarDekho",
  gaadi: "CarDekho",
  "gaadi.com": "CarDekho",
  cars24: "Cars24",
  "cars 24": "Cars24",
  "cars24.com": "Cars24",
  spinny: "Spinny",
  "spinny.com": "Spinny",
  droom: "Droom",
  "droom.in": "Droom",
  olx: "OLX Autos",
  "olx autos": "OLX Autos",
  "olx auto": "OLX Autos",
  "olx india": "OLX Autos",
};

function normalizePrimaryCompetitor(value: unknown): PrimaryCompetitor {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || ["null", "none", "n/a", "na"].includes(trimmed.toLowerCase())) {
    return null;
  }
  if (VALID_COMPETITORS.has(trimmed)) {
    return trimmed as Exclude<PrimaryCompetitor, null>;
  }
  const aliased = COMPETITOR_ALIAS[trimmed.toLowerCase()];
  return aliased ?? null;
}

function normalizeImplication(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    ["none", "null", "n/a", "na", "no implication"].includes(
      trimmed.toLowerCase(),
    )
  ) {
    return null;
  }
  return trimmed;
}

function validateClassification(raw: unknown): ClassificationResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Classification: not an object");
  }
  const obj = raw as Record<string, unknown>;

  if (
    typeof obj.importance !== "string" || !VALID_IMPORTANCE.has(obj.importance)
  ) {
    throw new Error(`Classification: invalid importance '${obj.importance}'`);
  }
  if (
    obj.importance !== "DROP" &&
    (typeof obj.bucket !== "string" || !VALID_BUCKETS.has(obj.bucket))
  ) {
    throw new Error(`Classification: invalid bucket '${obj.bucket}'`);
  }
  if (
    obj.importance === "DROP" && typeof obj.bucket === "string" &&
    !VALID_BUCKETS.has(obj.bucket)
  ) {
    // Backward compatibility for older prompt variants that returned "DROP" as a bucket.
    obj.bucket = null;
  }
  if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) {
    throw new Error("Classification: reasoning must be a non-empty string");
  }
  if (!Array.isArray(obj.entities)) {
    throw new Error("Classification: entities must be an array");
  }
  if (obj.entities.some((e) => typeof e !== "string")) {
    throw new Error("Classification: entities must contain strings");
  }
  const importance = obj.importance as ClassificationResult["importance"];
  const bucket = (obj.bucket as ClassificationResult["bucket"]) || null;
  const implication = normalizeImplication(obj.cars24_implication);
  const primary_competitor = normalizePrimaryCompetitor(obj.primary_competitor);
  // For HIGH/MED we expect implication; if missing, log but don't fail (model occasionally returns null).
  if ((importance === "HIGH" || importance === "MED") && !implication) {
    console.warn(
      `[classify] importance=${importance} but no implication; reasoning=${obj.reasoning}`,
    );
  }
  // For COMPETITOR bucket we expect a primary_competitor; warn if missing.
  if (bucket === "COMPETITOR" && !primary_competitor) {
    console.warn(
      `[classify] bucket=COMPETITOR but no primary_competitor; reasoning=${obj.reasoning}`,
    );
  }

  return {
    importance,
    bucket,
    reasoning: (obj.reasoning as string).trim(),
    entities: (obj.entities as string[]).map((e) => e.trim()).filter(Boolean),
    primary_competitor,
    cars24_implication: implication,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-article classification
// ─────────────────────────────────────────────────────────────────────────────

async function classifyOneArticle(article: {
  id: string;
  title: string;
  summary: string | null;
  source_name: string;
  published_at: string;
}): Promise<
  {
    id: string;
    result: ClassificationResult;
    cost_usd: number;
  } | { id: string; error: string }
> {
  try {
    const dropReason = nonEnglishTitleReason(article.title);
    if (dropReason) {
      return {
        id: article.id,
        result: {
          importance: "DROP",
          bucket: null,
          reasoning: dropReason,
          entities: [],
          primary_competitor: null,
          cars24_implication: null,
        },
        cost_usd: 0,
      };
    }

    const { data, usage } = await chatJson<unknown>([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(article) },
    ], {
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 400,
    });

    const result = validateClassification(data);
    const cost = costFor(
      "gpt-4o",
      usage.prompt_tokens,
      usage.completion_tokens,
    );
    return { id: article.id, result, cost_usd: cost };
  } catch (err) {
    return {
      id: article.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!isAuthorizedRequest(req)) return unauthorizedResponse();

  const startedAt = Date.now();
  const supabase = getSupabaseClient();

  try {
    let body: { limit?: number; article_ids?: string[] } = {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty body OK */
    }

    const limit = Math.min(body.limit ?? BATCH_SIZE, 100);

    let query = supabase
      .from("articles")
      .select("id, title, summary, source_name, published_at")
      .eq("pipeline_state", "ingested")
      .order("published_at", { ascending: false })
      .limit(limit);

    if (body.article_ids?.length) query = query.in("id", body.article_ids);

    const { data: articles, error } = await query;
    if (error) throw error;
    if (!articles || articles.length === 0) {
      return jsonResponse({
        ok: true,
        message: "No articles to classify.",
        processed: 0,
      });
    }

    let totalCost = 0;
    let totalProcessed = 0;
    let totalErrors = 0;
    const counts: Record<string, number> = { HIGH: 0, MED: 0, LOW: 0, DROP: 0 };

    // Process in batches of CONCURRENCY for parallelism with backpressure.
    for (let i = 0; i < articles.length; i += CONCURRENCY) {
      const batch = articles.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((a) => classifyOneArticle(a)),
      );

      // Persist results
      const updates = results
        .filter((
          r,
        ): r is {
          id: string;
          result: ClassificationResult;
          cost_usd: number;
        } => "result" in r)
        .map(({ id, result }) => ({
          id,
          importance: result.importance,
          bucket: result.bucket,
          reasoning: result.reasoning,
          entities: result.entities,
          primary_competitor: result.primary_competitor,
          cars24_implication: result.cars24_implication,
          classified_at: new Date().toISOString(),
          pipeline_state: result.importance === "DROP"
            ? "dropped"
            : "classified",
        }));

      // Update existing rows. Do not use upsert here: `articles` has required
      // columns such as title/url/published_at, and partial upserts would try
      // to insert NULLs before the conflict handler can update the row.
      if (updates.length > 0) {
        const updateResults = await Promise.all(
          updates.map(({ id, ...patch }) =>
            supabase.from("articles").update(patch).eq("id", id)
          ),
        );
        const failedUpdates = updateResults.filter((r) => r.error);
        if (failedUpdates.length > 0) {
          for (const failed of failedUpdates) {
            console.error(`[classify] update error: ${failed.error?.message}`);
          }
          totalErrors += failedUpdates.length;
        }
      }

      for (const r of results) {
        if ("error" in r) {
          totalErrors++;
          console.error(`[classify] ${r.id}: ${r.error}`);
        } else {
          totalProcessed++;
          totalCost += r.cost_usd;
          counts[r.result.importance] = (counts[r.result.importance] ?? 0) + 1;
        }
      }
    }

    await supabase.from("pipeline_state").upsert({
      id: "classifier",
      last_run_at: new Date().toISOString(),
      last_processed_at: new Date().toISOString(),
      last_run_status: totalErrors === 0
        ? "success"
        : `partial (${totalErrors} errors)`,
      last_run_meta: {
        articles_processed: totalProcessed,
        articles_errored: totalErrors,
        importance_counts: counts,
        cost_usd: Number(totalCost.toFixed(4)),
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return jsonResponse({
      ok: true,
      processed: totalProcessed,
      errors: totalErrors,
      counts,
      cost_usd: Number(totalCost.toFixed(4)),
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error
      ? err.message
      : (typeof err === "object" && err !== null
        ? JSON.stringify(err)
        : String(err));
    console.error(`[classify-articles] fatal: ${msg}`);
    return errorResponse(msg, 500);
  }
});
