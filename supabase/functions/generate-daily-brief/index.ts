// =============================================================================
// generate-daily-brief
// =============================================================================
// Assembles a single daily_briefs row served by the website. Five pieces:
//
//   1. hero_stories  — Today (24h primary, widens to 48h/72h on a quiet day),
//                      MARKET + COMPETITOR buckets. Selection rule:
//                        • All HIGH-importance stories
//                        • All MED-importance stories that have a non-null
//                          cars24_implication (we don't include MED without
//                          implication — those are noise; they live in the
//                          /feed/week archive instead)
//                      No upper cap. Strict no-repeat: any story shown on a
//                      prior day is excluded.
//
//   2. hero_cars24   — Today, CARS24_PRESS + CARS24_PR buckets. Same selection
//                      rule. Lane uses a 14d primary window because Cars24
//                      self-coverage is naturally sparser than market news.
//
//   3. weekly_recap  — Last 7d, MARKET + COMPETITOR. Selection rule:
//                        • All HIGH stories
//                        • If fewer than WEEKLY_RECAP_MIN HIGH exist, top up
//                          with MED-with-implication to reach the floor
//                      No upper cap. Dedup against today's cluster_ids.
//
//   4. weekly_cars24 — Last 14d (matches Cars24 lane window), CARS24_*. Same
//                      shape as weekly_recap.
//
//   5. still_developing — Compact one-liners for stories that WERE previously a
//                          hero AND have had new activity since their last
//                          appearance. Market + competitor lane only.
//
//   6. competitor_pulse — Per-competitor 7d strip with sparkline + 1-line
//                          context.
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

// Floor used by the dynamic-window expansion. The hero will try widening to
// 48h then 72h if the 24h window has fewer than this many fresh stories.
// There is NO upper cap — every HIGH and every MED-with-implication shows.
const HERO_MIN_COUNT = parseInt(Deno.env.get("HERO_MIN_COUNT") ?? "3", 10);
// Floor for weekly recap. If fewer than this many HIGH stories exist in the
// 7d window, top up with MED-with-implication to avoid an empty section.
const WEEKLY_RECAP_MIN = parseInt(Deno.env.get("WEEKLY_RECAP_MIN") ?? "5", 10);
const STILL_DEVELOPING_MAX = parseInt(Deno.env.get("STILL_DEVELOPING_MAX") ?? "8", 10);
const COMPETITORS = [
  "Cars24",
  "Spinny",
  "CarDekho",
  "Droom",
  "OLX Autos",
  "Maruti True Value",
];

// Bucket lanes for the two feed tabs. Defined as module constants so the brief
// shape stays in lock-step with the frontend tab definitions.
const MARKET_COMPETITOR_BUCKETS = ["MARKET", "COMPETITOR"];
const CARS24_BUCKETS = ["CARS24_PRESS", "CARS24_PR"];

interface StoryRow {
  id: string;
  cluster_id: string;
  title: string;
  short_summary: string | null;
  summary: string;
  cars24_implication: string | null;
  importance: "HIGH" | "MED" | "LOW";
  bucket: string;
  primary_competitor: string | null;
  entities: string[];
  source_count: number;
  source_articles: Array<
    { name: string; url: string; published_at: string; title: string }
  >;
  primary_source_name: string | null;
  primary_source_url: string | null;
  image_url: string | null;
  published_at: string;
}

interface StillDevelopingItem {
  story_id: string;
  cluster_id: string;
  title: string;
  primary_competitor: string | null;
  bucket: string;
  source_count: number;
  latest_update_at: string;
  days_running: number;
  first_seen_in_brief: string; // brief_date when first promoted to hero
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-competitor 1-line context prompt
// ─────────────────────────────────────────────────────────────────────────────
// Generates the "Funding driving 250% mention spike" line shown next to each
// competitor's sparkline. ONE LLM call per active competitor, only if there are stories.

const PULSE_CONTEXT_PROMPT =
  `You write the one-line context shown next to a competitor's 7-day mention sparkline in an executive brief.

Given a competitor name and the titles of recent stories about them, write a SINGLE line (max 18 words) explaining what's driving recent activity. State what's actually happening — funding, expansion, layoffs, product launch, controversy, lawsuit, etc.

If the stories are mixed/low-signal, just say "Routine coverage; no major moves."
If there's only 1 story, summarize that one event in a phrase.

Respond with ONLY a JSON object:
{"context": "<one line>"}`;

interface CompetitorPulse {
  competitor: string;
  story_count_7d: number;
  story_count_prev_7d: number;
  delta_pct: number | null;
  sparkline_daily: number[]; // 7 ints, oldest → newest
  context_line: string;
  story_ids: string[]; // ids of MED+ stories this week (for click-through)
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero selection
// ─────────────────────────────────────────────────────────────────────────────

async function fetchStoriesInWindow(
  supabase: ReturnType<typeof getSupabaseClient>,
  hours: number,
  buckets: string[],
  now: Date,
  importance: string[] = ["HIGH", "MED"],
): Promise<StoryRow[]> {
  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
  const upper = now.toISOString();
  let query = supabase
    .from("stories")
    .select("*")
    .gte("published_at", cutoff)
    .lte("published_at", upper)
    .in("importance", importance)
    .in("bucket", buckets);
  const { data, error } = await query
    .order("importance", { ascending: false })
    .order("published_at", { ascending: false })
    .limit(80);
  if (error) throw error;
  return (data ?? []) as StoryRow[];
}

// Returns a Set of story_ids and a Map of story_id → first_seen_brief_date
// across ALL previous briefs (both market+competitor hero AND cars24 hero).
// Strict no-repeat rule: a story shown on any prior day in either lane is not
// eligible for today's hero in either lane.
async function fetchPreviouslyShownStoryIds(
  supabase: ReturnType<typeof getSupabaseClient>,
  todayDate: string,
): Promise<{ ids: Set<string>; firstSeen: Map<string, string> }> {
  const { data, error } = await supabase
    .from("daily_briefs")
    .select("brief_date, hero_stories, hero_cars24")
    .lt("brief_date", todayDate)
    .order("brief_date", { ascending: true }); // earliest first so firstSeen captures earliest
  if (error) throw error;

  const ids = new Set<string>();
  const firstSeen = new Map<string, string>();
  for (const row of data ?? []) {
    const heroLists: Array<Array<{ story_id?: string }>> = [
      (row.hero_stories ?? []) as Array<{ story_id?: string }>,
      (row.hero_cars24 ?? []) as Array<{ story_id?: string }>,
    ];
    for (const list of heroLists) {
      for (const h of list) {
        if (typeof h.story_id !== "string") continue;
        ids.add(h.story_id);
        if (!firstSeen.has(h.story_id)) firstSeen.set(h.story_id, row.brief_date);
      }
    }
  }
  return { ids, firstSeen };
}

// Hero selection (today's lane).
//   - All HIGH stories pass.
//   - MED stories pass ONLY if they have a non-null cars24_implication.
//     Rationale: a MED story without an implication is the LLM's own admission
//     that it can't articulate why it matters to Cars24 — that doesn't earn a
//     spot in a 2-minute CEO brief.
//   - Strict no-repeat: any story_id from any prior brief is excluded.
//   - No upper cap. If today is heavy, we show all of it; if today is quiet,
//     the dynamic window expansion in buildHero will widen the lookback.
function selectHero(
  stories: StoryRow[],
  previouslyShown: Set<string>,
): StoryRow[] {
  const fresh = stories.filter((s) => !previouslyShown.has(s.id));
  const high = fresh.filter((s) => s.importance === "HIGH");
  const med = fresh.filter(
    (s) => s.importance === "MED" && hasImplication(s.cars24_implication),
  );
  return [...high, ...med];
}

// Weekly recap selection. Same gate as hero (HIGH always; MED only with
// implication), deduped against today's cluster_ids so the same story doesn't
// show in both "Today" and "This week".
//
// Floor = max(WEEKLY_RECAP_MIN, all-HIGH count). No upper cap. So a heavy news
// week shows every HIGH; a quiet week pads with MED-with-implication to reach
// the floor; a truly dead week shows what little there is.
function selectWeekly(
  weekPool: StoryRow[],
  todayClusterIds: Set<string>,
): StoryRow[] {
  const fresh = weekPool.filter((s) => !todayClusterIds.has(s.cluster_id));
  const high = fresh.filter((s) => s.importance === "HIGH");
  const med = fresh.filter(
    (s) => s.importance === "MED" && hasImplication(s.cars24_implication),
  );
  // Always include all HIGH. If still under the floor, pad with MED.
  if (high.length >= WEEKLY_RECAP_MIN) return high;
  const padCount = WEEKLY_RECAP_MIN - high.length;
  return [...high, ...med.slice(0, padCount)];
}

// "Has a real implication" = non-null AND looks substantive (not a one-word
// dodge like "None" or "N/A" that occasionally slips through normalization).
function hasImplication(text: string | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;
  return true;
}

// Project a StoryRow into the JSON shape the frontend reads. Used for hero +
// weekly recap (same shape).
function projectStory(s: StoryRow) {
  return {
    story_id: s.id,
    cluster_id: s.cluster_id,
    title: s.title,
    short_summary: s.short_summary,
    summary: s.summary,
    cars24_implication: s.cars24_implication,
    importance: s.importance,
    bucket: s.bucket,
    primary_competitor: s.primary_competitor,
    entities: s.entities,
    source_count: s.source_count,
    source_articles: s.source_articles,
    primary_source_name: s.primary_source_name,
    primary_source_url: s.primary_source_url,
    image_url: s.image_url,
    published_at: s.published_at,
  };
}

// Build hero with dynamic window expansion. Returns the chosen pool, hero, and
// the window stats so the caller can record quiet-day metadata.
//
// The Cars24 lane uses a fixed 14d window because Cars24 self-coverage is
// naturally sparser than market news; a 24h window keeps that tab perpetually
// empty, but a 90d window belongs in the archive, not the daily feed.
async function buildHero(
  supabase: ReturnType<typeof getSupabaseClient>,
  buckets: string[],
  now: Date,
  previouslyShown: Set<string>,
): Promise<{
  hero: StoryRow[];
  pool: StoryRow[];
  windowHours: number;
  isQuiet: boolean;
  quietNote: string | null;
}> {
  const isCars24Lane = buckets.every((b) => b.startsWith("CARS24_"));
  const ladder = isCars24Lane
    ? [
      { hours: 24 * 14, isQuiet: false, note: null },
    ]
    : [
      { hours: 24, isQuiet: false, note: null },
      { hours: 48, isQuiet: true, note: "Quiet last 24 hours. Showing the last 48." },
      { hours: 72, isQuiet: true, note: "Quiet stretch. Showing the last 72 hours." },
    ];

  let pool: StoryRow[] = [];
  let chosen = ladder[0];
  for (const step of ladder) {
    chosen = step;
    pool = await fetchStoriesInWindow(supabase, step.hours, buckets, now);
    const freshCount = pool.filter((s) => !previouslyShown.has(s.id)).length;
    if (freshCount >= HERO_MIN_COUNT) break;
  }

  return {
    hero: selectHero(pool, previouslyShown),
    pool,
    windowHours: chosen.hours,
    isQuiet: chosen.isQuiet,
    quietNote: chosen.note,
  };
}

// Build the Still Developing list:
//   - Stories whose ID appeared in any previous brief
//   - AND whose cluster has had a new article since the brief that last featured the story
//   - AND whose cluster is still active (not archived; latest_article_at within CLUSTER_LOOKBACK_DAYS)
async function buildStillDeveloping(
  supabase: ReturnType<typeof getSupabaseClient>,
  previouslyShownIds: Set<string>,
  firstSeen: Map<string, string>,
): Promise<StillDevelopingItem[]> {
  if (previouslyShownIds.size === 0) return [];

  // Pull the candidate stories + their clusters.
  const { data: stories, error: storiesErr } = await supabase
    .from("stories")
    .select(
      "id, cluster_id, title, primary_competitor, bucket, source_count, published_at, primary_source_name",
    )
    .in("id", Array.from(previouslyShownIds));
  if (storiesErr) throw storiesErr;
  if (!stories || stories.length === 0) return [];

  // Pull cluster activity for those clusters.
  const clusterIds = stories.map((s) => s.cluster_id);
  const { data: clusters, error: clustersErr } = await supabase
    .from("clusters")
    .select("id, latest_article_at, is_archived")
    .in("id", clusterIds)
    .eq("is_archived", false);
  if (clustersErr) throw clustersErr;
  const clusterById = new Map(
    (clusters ?? []).map((c) => [c.id as string, c as { id: string; latest_article_at: string; is_archived: boolean }]),
  );

  // Need to also know when we LAST showed each story (which brief_date)
  // so we can detect "new activity since that last appearance." Considers
  // both hero lanes — once shown anywhere, it's "shown".
  const { data: lastShownData } = await supabase
    .from("daily_briefs")
    .select("brief_date, hero_stories, hero_cars24, generated_at")
    .order("brief_date", { ascending: false }) // most recent first
    .limit(60);
  const lastShownAt = new Map<string, string>(); // story_id → generated_at of last brief featuring it
  for (const row of lastShownData ?? []) {
    const heroLists: Array<Array<{ story_id?: string }>> = [
      (row.hero_stories ?? []) as Array<{ story_id?: string }>,
      (row.hero_cars24 ?? []) as Array<{ story_id?: string }>,
    ];
    for (const list of heroLists) {
      for (const h of list) {
        if (typeof h.story_id !== "string") continue;
        if (!lastShownAt.has(h.story_id)) {
          lastShownAt.set(h.story_id, row.generated_at as string);
        }
      }
    }
  }

  const today = Date.now();
  const items: StillDevelopingItem[] = [];

  for (const s of stories) {
    const cluster = clusterById.get(s.cluster_id as string);
    if (!cluster) continue; // archived or missing → drop from still developing

    const lastShown = lastShownAt.get(s.id as string);
    if (!lastShown) continue; // shouldn't happen, but defensive

    // Has the cluster had new activity since we last showed this story?
    if (new Date(cluster.latest_article_at).getTime() <= new Date(lastShown).getTime()) {
      continue; // no new development; don't surface
    }

    const firstSeenDate = firstSeen.get(s.id as string) ?? s.published_at;
    const daysRunning = Math.max(
      1,
      Math.floor((today - new Date(firstSeenDate).getTime()) / (24 * 60 * 60 * 1000)),
    );

    items.push({
      story_id: s.id as string,
      cluster_id: s.cluster_id as string,
      title: s.title as string,
      primary_competitor: (s.primary_competitor as string | null) ?? null,
      bucket: s.bucket as string,
      source_count: s.source_count as number,
      latest_update_at: cluster.latest_article_at,
      days_running: daysRunning,
      first_seen_in_brief: firstSeenDate,
    });
  }

  // Sort: most recent activity first.
  items.sort(
    (a, b) =>
      new Date(b.latest_update_at).getTime() - new Date(a.latest_update_at).getTime(),
  );
  return items.slice(0, STILL_DEVELOPING_MAX);
}

// ─────────────────────────────────────────────────────────────────────────────
// Competitor pulse computation
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCompetitorStories(
  supabase: ReturnType<typeof getSupabaseClient>,
  competitor: string,
  daysBack: number,
  now: Date,
): Promise<StoryRow[]> {
  const cutoff = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString();
  const upper = now.toISOString();
  const { data, error } = await supabase
    .from("stories")
    .select("*")
    .gte("published_at", cutoff)
    .lte("published_at", upper)
    .contains("entities", [competitor])
    .order("published_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as StoryRow[];
}

function buildSparkline(stories: StoryRow[], daysBack: number, now: Date): number[] {
  const buckets = new Array(daysBack).fill(0) as number[];
  const nowMs = now.getTime();
  for (const s of stories) {
    const ageDays = Math.floor(
      (nowMs - new Date(s.published_at).getTime()) / (24 * 60 * 60 * 1000),
    );
    if (ageDays >= 0 && ageDays < daysBack) buckets[daysBack - 1 - ageDays]++;
  }
  return buckets;
}

async function generateContextLine(
  competitor: string,
  stories: StoryRow[],
): Promise<{ line: string; cost: number }> {
  if (stories.length === 0) {
    return { line: "Quiet — no coverage this week.", cost: 0 };
  }

  const titles = stories.slice(0, 10).map((s) => `• ${s.title}`).join("\n");
  const userMsg =
    `COMPETITOR: ${competitor}\nSTORIES THIS WEEK (${stories.length} total):\n${titles}`;

  try {
    const { data, usage } = await chatJson<{ context: string }>([
      { role: "system", content: PULSE_CONTEXT_PROMPT },
      { role: "user", content: userMsg },
    ], { model: "gpt-4o-mini", temperature: 0.2, max_tokens: 80 });

    const cost = costFor(
      "gpt-4o-mini",
      usage.prompt_tokens,
      usage.completion_tokens,
    );
    return {
      line: data.context?.trim() || "Routine coverage this week.",
      cost,
    };
  } catch (err) {
    console.warn(
      `[brief] pulse context failed for ${competitor}: ${
        (err as Error).message
      }`,
    );
    return {
      line: `${stories.length} stor${
        stories.length === 1 ? "y" : "ies"
      } this week.`,
      cost: 0,
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
    let body: { brief_date?: string; as_of?: string } = {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty */
    }

    // brief_date  → which row to upsert (YYYY-MM-DD).
    // as_of       → the "now" anchor for window calculations. Defaults to actual now;
    //               override to backdate a brief (e.g. for demo: yesterday at 6pm).
    const briefDate = body.brief_date ?? new Date().toISOString().slice(0, 10);
    const now = body.as_of ? new Date(body.as_of) : new Date();

    // ── Load previously-shown story IDs (across BOTH hero lanes).
    const { ids: previouslyShown, firstSeen } = await fetchPreviouslyShownStoryIds(
      supabase,
      briefDate,
    );

    // ── Lane 1: Today — Market & Competitors (default Feed tab) ───────────────
    const market = await buildHero(
      supabase,
      MARKET_COMPETITOR_BUCKETS,
      now,
      previouslyShown,
    );

    // ── Lane 2: Today — Cars24 (sub-tab on Feed) ──────────────────────────────
    // Independent window expansion; Cars24 self-coverage is rarer so this can
    // legitimately be empty even on a busy market day.
    const cars24 = await buildHero(
      supabase,
      CARS24_BUCKETS,
      now,
      previouslyShown,
    );

    // ── Lane 3 + 4: Weekly recap ──────────────────────────────────────────────
    // Dedup against today's cluster_ids in BOTH lanes — if a story made today's
    // hero, it shouldn't pad the weekly list with the same headline.
    const todayClusterIds = new Set<string>([
      ...market.hero.map((s) => s.cluster_id),
      ...cars24.hero.map((s) => s.cluster_id),
    ]);

    // Market+competitor weekly: standard 7-day window.
    const weekMarketPool = await fetchStoriesInWindow(
      supabase,
      24 * 7,
      MARKET_COMPETITOR_BUCKETS,
      now,
    );
    // Cars24 weekly uses the same 14-day window as the Cars24 lane. The full
    // 90-day Cars24 archive lives at /feed/week?tab=cars24.
    const weekCars24Pool = await fetchStoriesInWindow(
      supabase,
      24 * 14,
      CARS24_BUCKETS,
      now,
    );
    const weeklyRecap = selectWeekly(weekMarketPool, todayClusterIds);
    const weeklyCars24 = selectWeekly(weekCars24Pool, todayClusterIds);

    // ── Still Developing: previously-shown stories whose cluster has new activity.
    // Sourced from the market+competitor lane only; Cars24 lane is small enough
    // that "still developing" doesn't add value there.
    const stillDeveloping = await buildStillDeveloping(
      supabase,
      previouslyShown,
      firstSeen,
    );

    // ── Competitor pulse: 7-day window each, with prev 7-day for delta.
    let pulseCost = 0;
    const competitorPulse: CompetitorPulse[] = [];

    for (const competitor of COMPETITORS) {
      const last14d = await fetchCompetitorStories(supabase, competitor, 14, now);
      const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        .toISOString();
      const last7d = last14d.filter((s) => s.published_at >= cutoff7d);
      const prev7d = last14d.filter((s) => s.published_at < cutoff7d);

      const delta = prev7d.length > 0
        ? Math.round(((last7d.length - prev7d.length) / prev7d.length) * 100)
        : (last7d.length > 0 ? null : 0);

      const sparkline = buildSparkline(
        last14d.filter((s) => s.published_at >= cutoff7d),
        7,
        now,
      );

      const { line, cost } = await generateContextLine(competitor, last7d);
      pulseCost += cost;

      competitorPulse.push({
        competitor,
        story_count_7d: last7d.length,
        story_count_prev_7d: prev7d.length,
        delta_pct: delta,
        sparkline_daily: sparkline,
        context_line: line,
        story_ids: last7d.filter((s) => s.importance !== "LOW").map((s) =>
          s.id
        ),
      });
    }

    // ── Persist
    const { error: upsertErr } = await supabase
      .from("daily_briefs")
      .upsert({
        brief_date: briefDate,
        hero_stories: market.hero.map(projectStory),
        hero_cars24: cars24.hero.map(projectStory),
        weekly_recap: weeklyRecap.map(projectStory),
        weekly_cars24: weeklyCars24.map(projectStory),
        still_developing: stillDeveloping,
        // window_hours / quiet flags reflect the MAIN (market+competitor) lane.
        window_hours: market.windowHours,
        is_quiet_day: market.isQuiet,
        quiet_day_note: market.quietNote,
        competitor_pulse: competitorPulse,
        total_stories_in_window: market.pool.length + cars24.pool.length,
        ai_cost_usd: Number(pulseCost.toFixed(4)),
        generated_at: new Date().toISOString(),
      }, { onConflict: "brief_date" });

    if (upsertErr) throw upsertErr;

    await supabase.from("pipeline_state").upsert({
      id: "daily_brief",
      last_run_at: new Date().toISOString(),
      last_run_status: "success",
      last_run_meta: {
        brief_date: briefDate,
        hero_count: market.hero.length,
        hero_cars24_count: cars24.hero.length,
        weekly_recap_count: weeklyRecap.length,
        weekly_cars24_count: weeklyCars24.length,
        still_developing_count: stillDeveloping.length,
        window_hours: market.windowHours,
        cars24_window_hours: cars24.windowHours,
        is_quiet_day: market.isQuiet,
        previously_shown_count: previouslyShown.size,
        competitors_summarized: competitorPulse.length,
        cost_usd: Number(pulseCost.toFixed(4)),
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return jsonResponse({
      ok: true,
      brief_date: briefDate,
      hero_count: market.hero.length,
      hero_cars24_count: cars24.hero.length,
      weekly_recap_count: weeklyRecap.length,
      weekly_cars24_count: weeklyCars24.length,
      still_developing_count: stillDeveloping.length,
      window_hours: market.windowHours,
      cars24_window_hours: cars24.windowHours,
      is_quiet_day: market.isQuiet,
      competitor_pulse_count: competitorPulse.length,
      cost_usd: Number(pulseCost.toFixed(4)),
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-daily-brief] fatal: ${msg}`);
    return errorResponse(msg, 500);
  }
});
