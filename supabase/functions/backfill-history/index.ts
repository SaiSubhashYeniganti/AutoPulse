// =============================================================================
// backfill-history
// =============================================================================
// One-shot historical backfill for the demo / first deploy.
//
// Google News RSS supports date operators in the query string:
//   "Spinny" after:2026-02-01 before:2026-02-15
//
// We walk backward in 14-day windows across the last 90 days, query competitor
// and market topics, then insert articles as pipeline_state='ingested'. The
// normal classifier/router/synthesizer pipeline handles the intelligence layer.
// =============================================================================

import {
  corsHeaders,
  errorResponse,
  getSupabaseClient,
  isAuthorizedRequest,
  jsonResponse,
  unauthorizedResponse,
} from "../_shared/supabase.ts";
import { ParsedItem, parseFeed } from "../_shared/rss.ts";

const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_DAYS_BACK = 90;
const DEFAULT_PERIOD_DAYS = 14;
const DEFAULT_MAX_ITEMS_PER_QUERY_PERIOD = 12;
const FETCH_RETRIES = 2;

// All 5 competitor queries use the same event-oriented verb list, so the
// historical backfill matches the live RSS sources defined in seed.sql.
// Without the verb list, queries like "CarDekho" return mostly the company's
// own car-review content rather than news *about* them.
const COMPETITOR_VERBS =
  '(funding OR raises OR acquires OR acquisition OR layoffs OR launches OR partnership OR IPO OR appoints OR exits OR hires OR resigns OR "steps down" OR profit OR loss OR revenue)';

const DEFAULT_QUERIES: Array<{ label: string; query: string }> = [
  { label: "Cars24", query: `"Cars24" ${COMPETITOR_VERBS}` },
  { label: "Spinny", query: `"Spinny" ${COMPETITOR_VERBS}` },
  { label: "CarDekho", query: `"CarDekho" ${COMPETITOR_VERBS}` },
  { label: "Droom", query: `"Droom" ${COMPETITOR_VERBS}` },
  { label: "OLX Autos", query: `"OLX Autos" ${COMPETITOR_VERBS}` },
  { label: "Indian auto industry", query: "Indian auto industry" },
  { label: "India car sales", query: 'auto sales India OR "car sales" India' },
  { label: "Used cars India", query: '"used car" India OR "used cars" India' },
  {
    label: "Scrappage and end-of-life rules",
    query: '"scrappage" India OR "end-of-life vehicle" India',
  },
  {
    label: "Used car pricing",
    query: '"car depreciation" India OR "used car prices" India',
  },
];

interface QueryStats {
  label: string;
  period_start: string;
  period_end: string;
  fetched: number;
  inserted: number;
  skipped: number;
  status: "ok" | "error";
  error?: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildWindows(
  daysBack: number,
  periodDays: number,
): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  const now = new Date();
  for (let offset = daysBack; offset > 0; offset -= periodDays) {
    const start = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const endOffset = Math.max(offset - periodDays, 0);
    const end = new Date(now.getTime() - endOffset * 24 * 60 * 60 * 1000);
    windows.push({ start, end });
  }
  return windows;
}

function googleNewsUrl(query: string, start: Date, end: Date): string {
  const q = `${query} after:${isoDate(start)} before:${isoDate(end)}`;
  return `https://news.google.com/rss/search?q=${
    encodeURIComponent(q)
  }&hl=en-IN&gl=IN&ceid=IN:en`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Cars24Brief/1.0)",
        Accept:
          "application/rss+xml, application/xml, application/atom+xml, text/xml, */*",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const res = await fetchWithTimeout(url);
    last = res;
    if (![429, 500, 502, 503, 504].includes(res.status)) return res;
    if (attempt < FETCH_RETRIES) {
      await sleep(800 * (attempt + 1));
    }
  }
  return last!;
}

async function ingestQueryPeriod(
  label: string,
  query: string,
  start: Date,
  end: Date,
  maxItems: number,
): Promise<QueryStats> {
  const supabase = getSupabaseClient();
  const stats: QueryStats = {
    label,
    period_start: isoDate(start),
    period_end: isoDate(end),
    fetched: 0,
    inserted: 0,
    skipped: 0,
    status: "ok",
  };

  try {
    const res = await fetchWithRetry(googleNewsUrl(query, start, end));
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const xml = await res.text();
    const { items } = parseFeed(xml);
    const recent = items
      .filter((it: ParsedItem) => it.pubDate >= start && it.pubDate < end)
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
      .slice(0, maxItems);

    stats.fetched = recent.length;
    if (recent.length === 0) return stats;

    const rows = recent.map((it) => ({
      source_id: null,
      source_name: it.originalSource ?? `Google News Backfill: ${label}`,
      title: it.title.slice(0, 500),
      summary: it.description,
      url: it.link,
      image_url: it.imageUrl,
      published_at: it.pubDate.toISOString(),
      pipeline_state: "ingested",
    }));

    const { data, error } = await supabase
      .from("articles")
      .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
      .select("id");

    if (error) throw error;

    stats.inserted = data?.length ?? 0;
    stats.skipped = rows.length - stats.inserted;
  } catch (err) {
    stats.status = "error";
    stats.error = err instanceof Error ? err.message : String(err);
    console.error(
      `[backfill-history] ${label} ${stats.period_start}..${stats.period_end}: ${stats.error}`,
    );
  }

  return stats;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!isAuthorizedRequest(req)) return unauthorizedResponse();

  const startedAt = Date.now();

  try {
    let body: {
      days_back?: number;
      period_days?: number;
      max_items_per_query_period?: number;
      queries?: Array<{ label: string; query: string }>;
    } = {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty */
    }

    const daysBack = Math.min(
      Math.max(body.days_back ?? DEFAULT_DAYS_BACK, 7),
      120,
    );
    const periodDays = Math.min(
      Math.max(body.period_days ?? DEFAULT_PERIOD_DAYS, 7),
      30,
    );
    const maxItems = Math.min(
      Math.max(
        body.max_items_per_query_period ?? DEFAULT_MAX_ITEMS_PER_QUERY_PERIOD,
        3,
      ),
      25,
    );
    const queries = body.queries?.length ? body.queries : DEFAULT_QUERIES;
    const windows = buildWindows(daysBack, periodDays);

    const stats: QueryStats[] = [];
    for (const window of windows) {
      for (const q of queries) {
        stats.push(
          await ingestQueryPeriod(
            q.label,
            q.query,
            window.start,
            window.end,
            maxItems,
          ),
        );
      }
    }

    const inserted = stats.reduce((sum, s) => sum + s.inserted, 0);
    const fetched = stats.reduce((sum, s) => sum + s.fetched, 0);
    const errors = stats.filter((s) => s.status === "error").length;

    await getSupabaseClient().from("pipeline_state").upsert({
      id: "historical_backfill",
      last_run_at: new Date().toISOString(),
      last_run_status: errors === 0 ? "success" : `partial (${errors} errors)`,
      last_run_meta: {
        days_back: daysBack,
        period_days: periodDays,
        queries: queries.length,
        periods: windows.length,
        fetched,
        inserted,
        skipped_duplicates: stats.reduce((sum, s) => sum + s.skipped, 0),
        errors,
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return jsonResponse({
      ok: errors === 0,
      days_back: daysBack,
      period_days: periodDays,
      queries: queries.length,
      periods: windows.length,
      fetched,
      inserted,
      errors,
      stats,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backfill-history] fatal: ${msg}`);
    return errorResponse(msg, 500);
  }
});
