import { createClient } from "@supabase/supabase-js";

// Public read-only client. The anon key combined with our RLS policies (in
// schema.sql) only exposes stories, daily_briefs, and competitor_summaries.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set in .env.local",
  );
}

export const supabase = createClient(url, publishableKey, {
  auth: { persistSession: false },
});

// ─── Types matching schema.sql ───────────────────────────────────────────────

export type Importance = "HIGH" | "MED" | "LOW";

export interface SourceArticle {
  name: string;
  url: string;
  published_at: string;
  title: string;
}

export interface HeroStory {
  story_id: string;
  // cluster_id is included on stories produced by the post-2026-05-04 brief
  // generator; older briefs may omit it. Treat as optional everywhere.
  cluster_id?: string;
  title: string;
  short_summary: string | null;
  summary: string;
  cars24_implication: string | null;
  importance: Importance;
  bucket: string;
  primary_competitor: string | null;
  entities: string[];
  source_count: number;
  source_articles: SourceArticle[];
  primary_source_name: string | null;
  primary_source_url: string | null;
  image_url: string | null;
  published_at: string;
}

export interface StillDevelopingItem {
  story_id: string;
  cluster_id: string;
  title: string;
  primary_competitor: string | null;
  bucket: string;
  source_count: number;
  latest_update_at: string;
  days_running: number;
  first_seen_in_brief: string;
}

export interface CompetitorPulseRow {
  competitor: string;
  story_count_7d: number;
  story_count_prev_7d: number;
  delta_pct: number | null;
  sparkline_daily: number[];
  context_line: string;
  story_ids: string[];
}

export interface DailyBrief {
  id: string;
  brief_date: string;
  // ── Today (last 24-72h) — Market & Competitors lane (default Feed sub-tab)
  hero_stories: HeroStory[];
  // ── Today — Cars24 mentions lane (Cars24 sub-tab)
  hero_cars24: HeroStory[];
  // ── This week (last 7d, HIGH-only or count-cap) — same two lanes
  weekly_recap: HeroStory[];
  weekly_cars24: HeroStory[];
  // ── Previously-shown stories with new activity in their cluster
  still_developing: StillDevelopingItem[];
  window_hours: number;
  is_quiet_day: boolean;
  quiet_day_note: string | null;
  competitor_pulse: CompetitorPulseRow[];
  total_stories_in_window: number;
  ai_cost_usd: number | null;
  generated_at: string;
}

export interface ThemedSummary {
  context_line: string;
  themes: Array<{ title: string; bullets: string[]; story_ids?: string[] }>;
}

export interface CompetitorSummary {
  id: string;
  competitor: string;
  scope: "week" | "quarter";
  period_start: string;
  period_end: string;
  context_line: string | null;
  themed_summary: ThemedSummary;
  story_count: number;
  generated_at: string;
}

export interface Story {
  id: string;
  cluster_id: string;
  title: string;
  short_summary: string | null;
  summary: string;
  cars24_implication: string | null;
  importance: Importance;
  bucket: string;
  entities: string[];
  source_count: number;
  source_articles: SourceArticle[];
  primary_source_name: string | null;
  primary_source_url: string | null;
  image_url: string | null;
  published_at: string;
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

export async function getLatestBrief(): Promise<DailyBrief | null> {
  const { data, error } = await supabase
    .from("daily_briefs")
    .select("*")
    .order("brief_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[getLatestBrief]", error);
    return null;
  }
  return data as DailyBrief | null;
}

export async function getYesterdayBrief(skipDate: string | null): Promise<DailyBrief | null> {
  let query = supabase.from("daily_briefs").select("*").order("brief_date", { ascending: false }).limit(1);
  if (skipDate) query = query.lt("brief_date", skipDate);
  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error("[getYesterdayBrief]", error);
    return null;
  }
  return data as DailyBrief | null;
}

export async function getCompetitorSummary(
  competitor: string,
  scope: "week" | "quarter",
): Promise<CompetitorSummary | null> {
  const { data, error } = await supabase
    .from("competitor_summaries")
    .select("*")
    .eq("competitor", competitor)
    .eq("scope", scope)
    .order("period_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[getCompetitorSummary]", error);
    return null;
  }
  return data as CompetitorSummary | null;
}

export async function getStoriesByIds(ids: string[]): Promise<Story[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("stories")
    .select("*")
    .in("id", ids)
    .order("published_at", { ascending: false });
  if (error) {
    console.error("[getStoriesByIds]", error);
    return [];
  }
  return (data ?? []) as Story[];
}

// ─── Feed: full archive of last N days ────────────────────────────────────────
// Used by the /feed/week page.

export interface FeedQueryOptions {
  days: number;
  buckets: string[]; // e.g. ["MARKET","COMPETITOR"] or ["CARS24_PRESS","CARS24_PR"]
  importance?: Array<"HIGH" | "MED" | "LOW">;
}

export async function getFeedStories(opts: FeedQueryOptions): Promise<Story[]> {
  const cutoff = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();
  let q = supabase
    .from("stories")
    .select("*")
    .gte("published_at", cutoff)
    .in("bucket", opts.buckets)
    .order("published_at", { ascending: false })
    .limit(200);
  if (opts.importance && opts.importance.length > 0) {
    q = q.in("importance", opts.importance);
  }
  const { data, error } = await q;
  if (error) {
    console.error("[getFeedStories]", error);
    return [];
  }
  return (data ?? []) as Story[];
}

// ─── Competitors page: stories for one competitor over a time window ──────────
// Uses primary_competitor (not entities[]) because the classifier explicitly
// assigns a single primary subject — same field that drives clustering. This
// guarantees no cross-competitor leakage.

export async function getStoriesByCompetitor(
  competitor: string,
  days: number,
): Promise<Story[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("stories")
    .select("*")
    .eq("primary_competitor", competitor)
    .gte("published_at", cutoff)
    .order("published_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("[getStoriesByCompetitor]", error);
    return [];
  }
  // Sort client-side by importance DESC, then published_at DESC. We can't use
  // SQL ORDER BY for importance because it's a text column and HIGH/MED/LOW
  // lexical order is wrong. We pull at most 200 rows so the cost is trivial.
  const rank: Record<string, number> = { HIGH: 3, MED: 2, LOW: 1 };
  const stories = (data ?? []) as Story[];
  stories.sort((a, b) => {
    const r = (rank[b.importance] ?? 0) - (rank[a.importance] ?? 0);
    if (r !== 0) return r;
    return (
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    );
  });
  return stories;
}

// Aggregate competitor counts (last 90d) so the left-rail picker can sort by
// information depth. Cheap query — pulls only primary_competitor.
export async function getCompetitorCounts90d(): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("stories")
    .select("primary_competitor")
    .gte("published_at", cutoff)
    .not("primary_competitor", "is", null)
    .limit(1000);
  if (error) {
    console.error("[getCompetitorCounts90d]", error);
    return {};
  }
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { primary_competitor: string }[]) {
    counts[row.primary_competitor] = (counts[row.primary_competitor] ?? 0) + 1;
  }
  return counts;
}
