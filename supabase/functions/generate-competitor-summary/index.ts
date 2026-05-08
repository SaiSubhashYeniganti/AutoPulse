// =============================================================================
// generate-competitor-summary
// =============================================================================
// Two outputs per competitor, with very different shapes:
//
//   week  — themed digest of the previous Mon-Sun window. Generated ONCE per
//           week, on Monday morning. Other days are no-ops unless `force:true`
//           is passed in the body. Output shape:
//             { context_line, themes: [{title, bullets, story_ids}] }
//
//   quarter — exhaustive event ledger for the last 90 days, computed from
//             raw stories (NOT from weekly rollups — those are lossy). Three
//             LLM passes:
//               1. Extract structured events  (gpt-4o-mini, cheap + reliable).
//               2. Detect narrative patterns over those events (optional).
//               3. Write TL;DR + Cars24 implications on top.
//             Output shape:
//               { tldr, events: [...], patterns: [...], cars24_implications: [...] }
//
// Why these shapes?
//   The weekly is "what happened this week" — short, themed, fine to compress.
//   The quarterly is "what did Spinny actually DO" — it must be exhaustive.
//   The reader scans the event ledger to find launches / acquisitions / hires
//   they should know about. Patterns are commentary on top, not a replacement.
//
// Why query by entities (quarterly) and primary_competitor (weekly)?
//   Weekly: stays strict — `primary_competitor = X` so the digest is clean.
//   Quarterly: widens to `entities @> ['X']` for recall. Over 90 days, mis-
//   classifications of `primary_competitor` add up; the LLM can drop false
//   positives from the ledger far more easily than it can recover false
//   negatives we never showed it.
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

const DEFAULT_COMPETITORS = [
  "Cars24",
  "Spinny",
  "CarDekho",
  "Droom",
  "OLX Autos",
];
const DEFAULT_SCOPES: Array<"week" | "quarter"> = ["week", "quarter"];

interface StoryRow {
  id: string;
  title: string;
  summary: string;
  cars24_implication: string | null;
  importance: "HIGH" | "MED" | "LOW";
  primary_competitor: string | null;
  entities: string[];
  published_at: string;
  primary_source_name: string | null;
  source_count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly prompt (themed digest — same shape as before, single Mon-Sun window)
// ─────────────────────────────────────────────────────────────────────────────

const WEEKLY_PROMPT =
  `You produce a themed digest of one competitor's news for the Cars24 leadership team, covering ONE Monday-to-Sunday week.

Group the supplied stories into 2-4 coherent THEMES. Each theme has:
  - A short title (3-6 words, e.g. "Funding & valuation", "City expansion", "Product launches")
  - 1-3 bullets summarizing what happened (Bloomberg-terse, max 25 words each)
  - The story_ids that belong to it

Plus a single context_line (max 18 words) capturing the dominant story of the week.

Anti-bloat rules:
  - Do not invent facts not in the supplied stories.
  - Do not include themes with only fluff. If the week was quiet, return one theme called "Routine" with one bullet ("No material moves").
  - Do not repeat the cars24_implication — it's already shown next to each story.

Respond with ONLY a JSON object:
{
  "context_line": "<one line>",
  "themes": [
    { "title": "<...>", "bullets": ["<...>"], "story_ids": ["<uuid>"] }
  ]
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Quarterly pass 1 — extract structured events
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACT_PROMPT =
  `You read a list of news stories about ONE competitor over the last 90 days and extract every MATERIAL event into a structured ledger.

A "material event" is something a Cars24 executive would want to know happened. Examples:
  - funding round, IPO filing, secondary sale
  - acquisition, merger, divestiture
  - product or feature launch (named product, named feature)
  - geographic expansion (new city, new country, store opening)
  - senior hire, executive departure, board change
  - partnership, integration, distribution deal
  - regulatory action, lawsuit, investigation, settlement
  - layoff, restructuring, hiring freeze
  - pricing change, fee change, commission change

NOT material:
  - generic op-eds about the company
  - "industry trends" pieces that mention the company in passing
  - puff pieces, listicles, awards, generic interviews
  - rumor pieces with no named source AND no concrete claim
  - duplicate coverage of the same event (skip duplicates — pick the clearest one as the canonical story_id)

For each material event, output a row:
  - date: the YYYY-MM-DD the event happened (use the story's published_at if no other date is given)
  - type: ONE of: funding | acquisition | product | expansion | hire | departure | partnership | regulatory | layoff | pricing | other
  - headline: a single line, max 22 words. Lead with the verb. Include named amounts, named cities, named people, named products. Example: "Apr 12 — Acquired XYZ Auto-Finance for ₹400Cr to launch captive lending arm."
  - story_id: the source story's id

Critical rules:
  - Be EXHAUSTIVE. Every launch, every acquisition, every senior hire gets its own row. Do not group three product launches into one "active product cadence" row — that's wrong.
  - If a story covers two material events, output two rows.
  - If two stories cover the same event, pick one canonical story_id and skip the other.
  - Do NOT invent facts. If the headline can't be supported by the story, drop it.
  - "type: other" is a real escape hatch — use it for material events that don't fit the named types (e.g. major customer-experience controversy, policy change). Don't shove ill-fitting events into "product" or "partnership."
  - If the 90 days are genuinely quiet (zero material events), return an empty events array.

Respond with ONLY a JSON object:
{
  "events": [
    { "date": "YYYY-MM-DD", "type": "<one of the 11>", "headline": "<...>", "story_id": "<uuid>" }
  ]
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Quarterly pass 2 — detect patterns across the event list
// ─────────────────────────────────────────────────────────────────────────────

const PATTERN_PROMPT =
  `You are given a structured ledger of one competitor's material events over the last 90 days. Identify NARRATIVE PATTERNS across multiple events.

A pattern is a strategic thread that 2 or more events trace out. Examples:
  - "Aggressive financing push": acquisition of a lender + 2 lending partnerships → captive auto-loan setup
  - "Tier-2 expansion accelerating": 5 new tier-2 cities in 90 days vs 1 in prior quarter
  - "Pre-IPO positioning": senior hires + new audit committee + reduced burn

Strict rules:
  - A pattern needs at least 2 supporting events. Single events are NOT patterns; they belong to the ledger only.
  - Patterns must be supported by the ledger as given. Do not invent events.
  - If you don't see a clear pattern, return an empty patterns array. Empty is correct and expected. Do NOT pad.
  - At most 4 patterns per competitor.
  - Description: 1-2 sentences naming the strategic thread and what it suggests.

Respond with ONLY a JSON object:
{
  "patterns": [
    { "title": "<4-8 words>", "description": "<1-2 sentences>", "story_ids": ["<uuid>", "<uuid>"] }
  ]
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Quarterly pass 3 — write TL;DR + Cars24 implications
// ─────────────────────────────────────────────────────────────────────────────

const TLDR_PROMPT =
  `You write the executive headline for one competitor's quarter and the Cars24-specific "so what."

Inputs you have:
  - Competitor name
  - Their material event ledger (last 90 days)
  - Any narrative patterns we detected (may be empty)

Outputs:
  1. tldr (1-2 sentences, max 40 words): the headline of the quarter. What materially changed about this competitor that Cars24 leadership should know? Plain English, no hedging.
  2. cars24_implications (0-4 lines, max 22 words each): quarter-level "so what for Cars24" — concrete, actionable, never generic.
     ✓ "The financing push directly competes with Cars24 Financial Services — defend our auto-loan funnel in the next 2 quarters."
     ✗ "Cars24 should monitor this development."
     ✗ "Could have implications for the industry."
     If there is no genuine Cars24 implication, return an empty array. Empty is correct.

Anti-bloat rules:
  - Don't restate the ledger. The reader already sees it.
  - Don't pad to fill the 4 slots. 1-2 sharp implications beats 4 weak ones.
  - Implications are for Cars24 specifically — not generic industry commentary.

Respond with ONLY a JSON object:
{
  "tldr": "<1-2 sentences>",
  "cars24_implications": ["<line>", "<line>"]
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Type contracts + validators
// ─────────────────────────────────────────────────────────────────────────────

interface ThemedSummary {
  context_line: string;
  themes: Array<{ title: string; bullets: string[]; story_ids?: string[] }>;
}

const EVENT_TYPES = new Set([
  "funding",
  "acquisition",
  "product",
  "expansion",
  "hire",
  "departure",
  "partnership",
  "regulatory",
  "layoff",
  "pricing",
  "other",
]);

interface LedgerEvent {
  date: string;
  type: string;
  headline: string;
  story_id: string;
}

interface LedgerPattern {
  title: string;
  description: string;
  story_ids: string[];
}

interface EventLedgerSummary {
  tldr: string;
  events: LedgerEvent[];
  patterns: LedgerPattern[];
  cars24_implications: string[];
}

function validateThemed(raw: unknown): ThemedSummary {
  if (!raw || typeof raw !== "object") throw new Error("Themed: not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.context_line !== "string") {
    throw new Error("Themed: context_line required");
  }
  if (!Array.isArray(obj.themes)) {
    throw new Error("Themed: themes must be array");
  }
  const themes = (obj.themes as Array<Record<string, unknown>>).map((t) => {
    if (typeof t.title !== "string") {
      throw new Error("Themed: theme.title required");
    }
    if (!Array.isArray(t.bullets)) {
      throw new Error("Themed: theme.bullets must be array");
    }
    return {
      title: t.title.trim(),
      bullets: (t.bullets as unknown[])
        .filter((b): b is string => typeof b === "string")
        .map((s) => s.trim()),
      story_ids: Array.isArray(t.story_ids)
        ? (t.story_ids as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
        : undefined,
    };
  });
  return { context_line: obj.context_line.trim(), themes };
}

function validateEvents(raw: unknown, validStoryIds: Set<string>): LedgerEvent[] {
  if (!raw || typeof raw !== "object") throw new Error("Events: not an object");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.events)) {
    throw new Error("Events: events must be array");
  }
  const out: LedgerEvent[] = [];
  for (const e of obj.events as Array<Record<string, unknown>>) {
    if (
      typeof e.date !== "string" ||
      typeof e.type !== "string" ||
      typeof e.headline !== "string" ||
      typeof e.story_id !== "string"
    ) continue;
    const type = EVENT_TYPES.has(e.type) ? e.type : "other";
    // Drop hallucinated story_ids — the LLM occasionally invents UUIDs.
    if (!validStoryIds.has(e.story_id)) continue;
    out.push({
      date: e.date.slice(0, 10),
      type,
      headline: e.headline.trim(),
      story_id: e.story_id,
    });
  }
  // Sort newest first.
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

function validatePatterns(
  raw: unknown,
  validStoryIds: Set<string>,
): LedgerPattern[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.patterns)) return [];
  const out: LedgerPattern[] = [];
  for (const p of obj.patterns as Array<Record<string, unknown>>) {
    if (
      typeof p.title !== "string" ||
      typeof p.description !== "string" ||
      !Array.isArray(p.story_ids)
    ) continue;
    const ids = (p.story_ids as unknown[])
      .filter((x): x is string => typeof x === "string")
      .filter((x) => validStoryIds.has(x));
    // Patterns must be supported by ≥2 events. The prompt enforces this but we
    // re-check here so a model lapse can't slip through.
    if (ids.length < 2) continue;
    out.push({
      title: p.title.trim(),
      description: p.description.trim(),
      story_ids: ids,
    });
  }
  return out.slice(0, 4);
}

function validateTldr(raw: unknown): {
  tldr: string;
  cars24_implications: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { tldr: "", cars24_implications: [] };
  }
  const obj = raw as Record<string, unknown>;
  const tldr = typeof obj.tldr === "string" ? obj.tldr.trim() : "";
  const impls = Array.isArray(obj.cars24_implications)
    ? (obj.cars24_implications as unknown[])
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 4)
    : [];
  return { tldr, cars24_implications: impls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Story fetchers
// ─────────────────────────────────────────────────────────────────────────────

const STORY_COLUMNS =
  "id, title, summary, cars24_implication, importance, primary_competitor, entities, published_at, primary_source_name, source_count";

// Strict fetcher — used by the WEEKLY digest. primary_competitor = X only.
async function fetchStoriesByPrimary(
  supabase: ReturnType<typeof getSupabaseClient>,
  competitor: string,
  daysBack: number,
  windowEnd?: Date,
): Promise<StoryRow[]> {
  const end = (windowEnd ?? new Date()).toISOString();
  const start = new Date(
    (windowEnd ?? new Date()).getTime() - daysBack * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await supabase
    .from("stories")
    .select(STORY_COLUMNS)
    .gte("published_at", start)
    .lt("published_at", end)
    .in("importance", ["HIGH", "MED"])
    .eq("primary_competitor", competitor)
    .order("published_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as StoryRow[];
}

// Wide fetcher — used by the QUARTERLY ledger. Includes LOW, and also includes
// stories that *mention* the competitor in `entities[]` but were classified
// as primary_competitor for another company (or null). The extractor pass
// drops noise; we just need recall here.
async function fetchStoriesByEntity(
  supabase: ReturnType<typeof getSupabaseClient>,
  competitor: string,
  daysBack: number,
): Promise<StoryRow[]> {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString();
  // Two queries OR'd together because PostgREST `or()` with `cs` (contains)
  // and `eq` is awkward to express portably. We dedupe by id at the end.
  const [byPrimary, byEntity] = await Promise.all([
    supabase
      .from("stories")
      .select(STORY_COLUMNS)
      .gte("published_at", cutoff)
      .eq("primary_competitor", competitor)
      .order("published_at", { ascending: false })
      .limit(200),
    supabase
      .from("stories")
      .select(STORY_COLUMNS)
      .gte("published_at", cutoff)
      .contains("entities", [competitor])
      .order("published_at", { ascending: false })
      .limit(200),
  ]);
  if (byPrimary.error) throw byPrimary.error;
  if (byEntity.error) throw byEntity.error;
  const seen = new Set<string>();
  const out: StoryRow[] = [];
  for (const row of [...(byPrimary.data ?? []), ...(byEntity.data ?? [])] as StoryRow[]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  out.sort((a, b) =>
    new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly: one pass, themed digest, single Mon-Sun window
// ─────────────────────────────────────────────────────────────────────────────

interface WeekWindow {
  periodStart: string; // YYYY-MM-DD (Monday)
  periodEnd: string; // YYYY-MM-DD (Sunday)
  startDate: Date;
  endDate: Date;
}

// Returns the Monday-Sunday window covering the previous calendar week.
// runAt = now. Example: if today is Wed Apr 17, returns Apr 8 (Mon) -> Apr 14 (Sun).
function previousWeekWindow(runAt: Date): WeekWindow {
  const d = new Date(
    Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate()),
  );
  // JS getUTCDay: 0 = Sun, 1 = Mon, ... 6 = Sat
  const dow = d.getUTCDay();
  // Days back to *this* week's Monday: if dow=1 (Mon) it's 0; if dow=0 (Sun) it's 6.
  const daysBackToThisMon = (dow + 6) % 7;
  const thisMon = new Date(d);
  thisMon.setUTCDate(d.getUTCDate() - daysBackToThisMon);
  // Previous Mon = thisMon - 7. Previous Sun (end of week, exclusive boundary
  // = thisMon).
  const prevMon = new Date(thisMon);
  prevMon.setUTCDate(thisMon.getUTCDate() - 7);
  const prevSun = new Date(thisMon);
  prevSun.setUTCDate(thisMon.getUTCDate() - 1);
  return {
    periodStart: prevMon.toISOString().slice(0, 10),
    periodEnd: prevSun.toISOString().slice(0, 10),
    startDate: prevMon,
    endDate: thisMon, // exclusive end (start of this Mon)
  };
}

async function generateWeeklySummary(
  competitor: string,
  windowSpec: WeekWindow,
): Promise<{
  summary: ThemedSummary;
  stories: StoryRow[];
  cost_usd: number;
}> {
  const supabase = getSupabaseClient();
  const stories = await fetchStoriesByPrimary(
    supabase,
    competitor,
    7,
    windowSpec.endDate,
  );

  if (stories.length === 0) {
    return {
      summary: {
        context_line: `No material coverage of ${competitor} this week.`,
        themes: [{
          title: "Routine",
          bullets: ["No material moves."],
          story_ids: [],
        }],
      },
      stories: [],
      cost_usd: 0,
    };
  }

  const userMsg = `COMPETITOR: ${competitor}
WEEK: ${windowSpec.periodStart} (Mon) → ${windowSpec.periodEnd} (Sun)
STORIES (${stories.length}):

${
    stories.map((s) =>
      `STORY ${s.id}\nTITLE: ${s.title}\nSUMMARY: ${s.summary}\nIMPORTANCE: ${s.importance}\nDATE: ${s.published_at}`
    ).join("\n\n")
  }`;

  const { data, usage } = await chatJson<unknown>([
    { role: "system", content: WEEKLY_PROMPT },
    { role: "user", content: userMsg },
  ], { model: "gpt-4o", temperature: 0.2, max_tokens: 900 });

  const summary = validateThemed(data);
  const cost = costFor("gpt-4o", usage.prompt_tokens, usage.completion_tokens);
  return { summary, stories, cost_usd: cost };
}

// ─────────────────────────────────────────────────────────────────────────────
// Quarterly: 3-pass event ledger
// ─────────────────────────────────────────────────────────────────────────────

async function generateQuarterlySummary(competitor: string): Promise<{
  summary: EventLedgerSummary;
  cost_usd: number;
  story_count: number;
}> {
  const supabase = getSupabaseClient();
  const stories = await fetchStoriesByEntity(supabase, competitor, 90);

  if (stories.length === 0) {
    return {
      summary: {
        tldr: `Quiet quarter for ${competitor} — no material coverage logged.`,
        events: [],
        patterns: [],
        cars24_implications: [],
      },
      cost_usd: 0,
      story_count: 0,
    };
  }

  // Pass 1 — extraction. Cap at 80 stories to keep input bounded; sorted newest
  // first, so if we exceed that ceiling we'd lose oldest. In practice 90 days
  // × 1 competitor stays under the cap.
  const inputStories = stories.slice(0, 80);
  const validIds = new Set(inputStories.map((s) => s.id));
  const extractInput = `COMPETITOR: ${competitor}
WINDOW: last 90 days
STORIES (${inputStories.length}):

${
    inputStories.map((s) =>
      `STORY ${s.id}
DATE: ${s.published_at.slice(0, 10)}
TITLE: ${s.title}
SUMMARY: ${s.summary.slice(0, 280)}
IMPORTANCE: ${s.importance}
PRIMARY_COMPETITOR: ${s.primary_competitor ?? "null"}`
    ).join("\n\n")
  }`;

  let totalCost = 0;
  const { data: extractData, usage: extractUsage } = await chatJson<unknown>([
    { role: "system", content: EXTRACT_PROMPT },
    { role: "user", content: extractInput },
  ], { model: "gpt-4o-mini", temperature: 0.1, max_tokens: 2400 });
  totalCost += costFor(
    "gpt-4o-mini",
    extractUsage.prompt_tokens,
    extractUsage.completion_tokens,
  );
  const events = validateEvents(extractData, validIds);

  // Pass 2 — pattern detection. Skip if <2 events (a pattern needs ≥2).
  let patterns: LedgerPattern[] = [];
  if (events.length >= 2) {
    const eventValidIds = new Set(events.map((e) => e.story_id));
    const patternInput = `COMPETITOR: ${competitor}
EVENT LEDGER (${events.length} events, newest first):

${
      events.map((e) =>
        `${e.date} [${e.type}] ${e.headline} (story_id: ${e.story_id})`
      ).join("\n")
    }`;
    const { data: patternData, usage: patternUsage } = await chatJson<unknown>(
      [
        { role: "system", content: PATTERN_PROMPT },
        { role: "user", content: patternInput },
      ],
      { model: "gpt-4o-mini", temperature: 0.2, max_tokens: 800 },
    );
    totalCost += costFor(
      "gpt-4o-mini",
      patternUsage.prompt_tokens,
      patternUsage.completion_tokens,
    );
    patterns = validatePatterns(patternData, eventValidIds);
  }

  // Pass 3 — TL;DR + Cars24 implications. Always runs (even on empty events,
  // we want a "quiet quarter" headline). But if events.length === 0 we already
  // returned a quiet-quarter shape above.
  const tldrInput = `COMPETITOR: ${competitor}
EVENT LEDGER (${events.length} events):
${
    events.map((e) => `  ${e.date} [${e.type}] ${e.headline}`).join("\n") ||
    "  (none)"
  }

PATTERNS (${patterns.length}):
${
    patterns.map((p) => `  ${p.title}: ${p.description}`).join("\n") ||
    "  (none)"
  }`;
  const { data: tldrData, usage: tldrUsage } = await chatJson<unknown>([
    { role: "system", content: TLDR_PROMPT },
    { role: "user", content: tldrInput },
  ], { model: "gpt-4o", temperature: 0.3, max_tokens: 600 });
  totalCost += costFor(
    "gpt-4o",
    tldrUsage.prompt_tokens,
    tldrUsage.completion_tokens,
  );
  const { tldr, cars24_implications } = validateTldr(tldrData);

  return {
    summary: {
      tldr: tldr ||
        `${competitor} had ${events.length} material event${
          events.length === 1 ? "" : "s"
        } in the last 90 days.`,
      events,
      patterns,
      cars24_implications,
    },
    cost_usd: totalCost,
    story_count: stories.length,
  };
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
    let body: {
      competitors?: string[];
      scopes?: Array<"week" | "quarter">;
      // `force: true` runs the weekly even on a non-Monday. Useful for backfills
      // and for the cron job that runs daily — the cron can call without force
      // and let the function decide.
      force?: boolean;
    } = {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty body is fine */
    }

    const competitors = body.competitors ?? DEFAULT_COMPETITORS;
    const scopes = body.scopes ?? DEFAULT_SCOPES;
    const force = body.force === true;

    // Weekly cadence guard. The weekly digest covers a fixed Mon-Sun window
    // and is generated ONCE per week (Monday morning). On other days we skip
    // to avoid (a) re-LLM'ing the same window, and (b) producing a sliding
    // 7-day window that overlaps yesterday's by 6 days. force=true overrides.
    const now = new Date();
    const isMonday = now.getUTCDay() === 1;
    const skipWeekly = scopes.includes("week") && !isMonday && !force;

    let totalCost = 0;
    const results: Array<{
      competitor: string;
      scope: string;
      story_count: number;
      cost_usd: number;
      status: "ok" | "skipped" | "error";
      reason?: string;
      error?: string;
    }> = [];

    const weekWindow = previousWeekWindow(now);

    for (const competitor of competitors) {
      for (const scope of scopes) {
        try {
          if (scope === "week") {
            if (skipWeekly) {
              results.push({
                competitor,
                scope,
                story_count: 0,
                cost_usd: 0,
                status: "skipped",
                reason:
                  "Weekly runs only on Mondays for the previous Mon-Sun window. Pass force:true to override.",
              });
              continue;
            }
            const { summary, stories, cost_usd } = await generateWeeklySummary(
              competitor,
              weekWindow,
            );

            const { error: upsertErr } = await supabase
              .from("competitor_summaries")
              .upsert({
                competitor,
                scope: "week",
                period_start: weekWindow.periodStart,
                period_end: weekWindow.periodEnd,
                context_line: summary.context_line,
                themed_summary: summary,
                story_count: stories.length,
              }, { onConflict: "competitor,scope,period_end" });
            if (upsertErr) throw upsertErr;

            totalCost += cost_usd;
            results.push({
              competitor,
              scope,
              story_count: stories.length,
              cost_usd,
              status: "ok",
            });
          } else {
            const { summary, cost_usd, story_count } =
              await generateQuarterlySummary(competitor);
            const periodEnd = new Date().toISOString().slice(0, 10);
            const periodStart = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)
              .toISOString().slice(0, 10);

            const { error: upsertErr } = await supabase
              .from("competitor_summaries")
              .upsert({
                competitor,
                scope: "quarter",
                period_start: periodStart,
                period_end: periodEnd,
                context_line: summary.tldr,
                themed_summary: summary,
                story_count,
              }, { onConflict: "competitor,scope,period_end" });
            if (upsertErr) throw upsertErr;

            totalCost += cost_usd;
            results.push({
              competitor,
              scope,
              story_count,
              cost_usd,
              status: "ok",
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[competitor-summary] ${competitor}/${scope}: ${msg}`);
          results.push({
            competitor,
            scope,
            story_count: 0,
            cost_usd: 0,
            status: "error",
            error: msg,
          });
        }
      }
    }

    return jsonResponse({
      ok: true,
      results,
      cost_usd: Number(totalCost.toFixed(4)),
      elapsed_ms: Date.now() - startedAt,
      week_window: weekWindow,
      weekly_skipped: skipWeekly,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-competitor-summary] fatal: ${msg}`);
    return errorResponse(msg, 500);
  }
});
