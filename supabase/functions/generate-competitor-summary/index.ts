// =============================================================================
// generate-competitor-summary
// =============================================================================
// For each requested competitor and scope (week | quarter), pulls the relevant
// stories and asks gpt-4o to produce a themed summary:
//
//   {
//     "themes": [
//       { "title": "Funding & valuation", "bullets": ["...", "..."], "story_ids": ["..."] },
//       { "title": "Product launches",   "bullets": ["..."],         "story_ids": ["..."] }
//     ],
//     "context_line": "Funding round drove most of this week's coverage."
//   }
//
// Hierarchical: weekly summaries are produced from individual stories.
//               quarterly summaries are produced from the last ~12 weekly summaries
//               (avoids context-window blowup and produces tighter output).
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
// Prompt — weekly themed summary
// ─────────────────────────────────────────────────────────────────────────────

const WEEKLY_PROMPT =
  `You produce a themed summary of one competitor's news for the Cars24 leadership team.

Group the supplied stories into 2-4 coherent THEMES. Each theme has:
  - A short title (3-6 words, e.g. "Funding & valuation", "Layoffs", "City expansion")
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
// Prompt — quarterly themed summary (built from weekly summaries)
// ─────────────────────────────────────────────────────────────────────────────

const QUARTERLY_PROMPT =
  `You produce a 90-day strategic narrative summary of ONE competitor's news for Cars24 leadership.

You will be given weekly summaries (themed) or raw stories. Roll them up into 3-5 narrative ARCS that have played out over the quarter. Each arc has:
  - A title (4-8 words, e.g. "Aggressive city-by-city expansion", "Pre-IPO positioning")
  - 2-4 bullets that trace the arc chronologically (Bloomberg-terse, max 30 words each)
  - story_ids that support the arc, when supplied in the input

Plus a context_line (max 22 words) capturing the dominant strategic theme of the quarter.

Anti-bloat rules:
  - Don't list every individual event; abstract to the pattern.
  - Don't invent strategy claims not supported by the underlying weekly summaries.
  - If little happened, return one arc "Quiet quarter" with one bullet.

Respond with ONLY a JSON object:
{
  "context_line": "<one line>",
  "themes": [
    { "title": "<...>", "bullets": ["<...>"], "story_ids": ["<uuid>"] }
  ]
}`;

interface ThemedSummary {
  context_line: string;
  themes: Array<{ title: string; bullets: string[]; story_ids?: string[] }>;
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
      bullets: (t.bullets as unknown[]).filter((b): b is string =>
        typeof b === "string"
      ).map((s) => s.trim()),
      story_ids: Array.isArray(t.story_ids)
        ? (t.story_ids as unknown[]).filter((x): x is string =>
          typeof x === "string"
        )
        : undefined,
    };
  });
  return { context_line: obj.context_line.trim(), themes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly + quarterly generation
// ─────────────────────────────────────────────────────────────────────────────

async function fetchStoriesForCompetitor(
  supabase: ReturnType<typeof getSupabaseClient>,
  competitor: string,
  daysBack: number,
  minImportance: "MED" | "LOW" = "MED",
): Promise<StoryRow[]> {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString();
  const importanceFilter = minImportance === "MED"
    ? ["HIGH", "MED"]
    : ["HIGH", "MED", "LOW"];
  const query = supabase
    .from("stories")
    .select(
      "id, title, summary, cars24_implication, importance, primary_competitor, entities, published_at, primary_source_name, source_count",
    )
    .gte("published_at", cutoff)
    .in("importance", importanceFilter)
    .eq("primary_competitor", competitor)
    .order("published_at", { ascending: false });

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as StoryRow[];
}

async function generateWeeklySummary(competitor: string): Promise<{
  summary: ThemedSummary;
  stories: StoryRow[];
  cost_usd: number;
}> {
  const supabase = getSupabaseClient();
  const stories = await fetchStoriesForCompetitor(
    supabase,
    competitor,
    7,
    "MED",
    false,
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

  const userMsg =
    `COMPETITOR: ${competitor}\nWINDOW: last 7 days\nSTORIES (${stories.length}):\n\n${
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

async function generateQuarterlySummary(competitor: string): Promise<{
  summary: ThemedSummary;
  cost_usd: number;
  weekly_count: number;
  story_count: number;
}> {
  const supabase = getSupabaseClient();
  const rawStories = await fetchStoriesForCompetitor(
    supabase,
    competitor,
    90,
    "MED",
  );
  // Pull the most recent 12 weekly summaries we have stored.
  const { data: weeklies, error } = await supabase
    .from("competitor_summaries")
    .select("period_end, themed_summary, story_count")
    .eq("competitor", competitor)
    .eq("scope", "week")
    .order("period_end", { ascending: false })
    .limit(12);
  if (error) throw error;

  if (!weeklies || weeklies.length < 4) {
    // Day-one behavior: use raw 90-day stories until enough weekly roll-ups
    // exist. Otherwise "quarter" would only summarize this week.
    if (rawStories.length === 0) {
      return {
        summary: {
          context_line:
            `Quiet quarter for ${competitor} — no material moves logged.`,
          themes: [{ title: "Quiet quarter", bullets: ["No material moves."] }],
        },
        cost_usd: 0,
        weekly_count: 0,
        story_count: 0,
      };
    }
    // Fall through to a story-based quarterly.
    const userMsg = `COMPETITOR: ${competitor}\nWINDOW: last 90 days (${
      weeklies?.length ?? 0
    } weekly roll-up(s) available — using raw stories for day-one depth)\nSTORIES:\n\n${
      rawStories.slice(0, 40).map((s) =>
        `STORY ${s.id}\n${s.published_at.slice(0, 10)} — ${s.title}: ${
          s.summary.slice(0, 220)
        }`
      ).join("\n\n")
    }`;
    const { data, usage } = await chatJson<unknown>([
      { role: "system", content: QUARTERLY_PROMPT },
      { role: "user", content: userMsg },
    ], { model: "gpt-4o", temperature: 0.2, max_tokens: 1100 });
    const summary = validateThemed(data);
    return {
      summary,
      cost_usd: costFor("gpt-4o", usage.prompt_tokens, usage.completion_tokens),
      weekly_count: weeklies?.length ?? 0,
      story_count: rawStories.length,
    };
  }

  const rawStoryCount = weeklies.reduce(
    (sum, w) => sum + (w.story_count ?? 0),
    0,
  );
  const weeklyText = weeklies.reverse().map((w) => {
    const t = w.themed_summary as ThemedSummary;
    const themesStr = t.themes.map((th) => {
      const ids = th.story_ids?.length
        ? ` [story_ids: ${th.story_ids.join(", ")}]`
        : "";
      return `   • ${th.title}${ids}: ${th.bullets.join(" / ")}`;
    }).join("\n");
    return `WEEK ENDING ${w.period_end} (${w.story_count} stor${
      w.story_count === 1 ? "y" : "ies"
    }):\n   Context: ${t.context_line}\n${themesStr}`;
  }).join("\n\n");

  const userMsg =
    `COMPETITOR: ${competitor}\nWINDOW: last 90 days, derived from ${weeklies.length} weekly summaries\n\n${weeklyText}`;

  const { data, usage } = await chatJson<unknown>([
    { role: "system", content: QUARTERLY_PROMPT },
    { role: "user", content: userMsg },
  ], { model: "gpt-4o", temperature: 0.2, max_tokens: 1100 });

  const summary = validateThemed(data);
  return {
    summary,
    cost_usd: costFor("gpt-4o", usage.prompt_tokens, usage.completion_tokens),
    weekly_count: weeklies.length,
    story_count: rawStoryCount,
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
    let body: { competitors?: string[]; scopes?: Array<"week" | "quarter"> } =
      {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty */
    }

    const competitors = body.competitors ?? DEFAULT_COMPETITORS;
    const scopes = body.scopes ?? DEFAULT_SCOPES;

    let totalCost = 0;
    const results: Array<{
      competitor: string;
      scope: string;
      story_count: number;
      cost_usd: number;
      status: "ok" | "error";
      error?: string;
    }> = [];

    for (const competitor of competitors) {
      for (const scope of scopes) {
        try {
          if (scope === "week") {
            const { summary, stories, cost_usd } = await generateWeeklySummary(
              competitor,
            );
            const periodEnd = new Date().toISOString().slice(0, 10);
            const periodStart = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
              .toISOString().slice(0, 10);

            const { error: upsertErr } = await supabase
              .from("competitor_summaries")
              .upsert({
                competitor,
                scope: "week",
                period_start: periodStart,
                period_end: periodEnd,
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
            const { summary, cost_usd, weekly_count, story_count } =
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
                context_line: summary.context_line,
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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-competitor-summary] fatal: ${msg}`);
    return errorResponse(msg, 500);
  }
});
