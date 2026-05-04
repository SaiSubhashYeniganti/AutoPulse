// =============================================================================
// rss-ingest
// =============================================================================
// Pulls every active source, parses RSS / Google News, dedupes by URL, inserts
// new articles in pipeline_state='ingested'. Updates source watermarks.
//
// Idempotent: re-running just inserts nothing (conflict on articles.url).
//
// Trigger:
//   - pg_cron (every 2h via run-pipeline)
//   - manual:  curl -X POST <url>/functions/v1/rss-ingest \
//                -H "Authorization: Bearer <service-role>"
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
import type { Source } from "../_shared/types.ts";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ARTICLES_PER_SOURCE = parseInt(
  Deno.env.get("MAX_ARTICLES_PER_SOURCE") ?? "25",
  10,
);
const BACKFILL_HOURS = parseInt(Deno.env.get("BACKFILL_HOURS") ?? "720", 10);
const FETCH_RETRIES = parseInt(Deno.env.get("FETCH_RETRIES") ?? "2", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface IngestStats {
  source: string;
  fetched: number;
  inserted: number;
  skipped: number;
  status: "ok" | "error";
  error?: string;
}

async function fetchWithTimeout(
  url: string,
  ms = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some feeds (Moneycontrol, ETAuto) 403 generic UAs; mimic a browser.
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
      // Google News can transiently 503 from serverless IPs after bursty backfills.
      await sleep(800 * (attempt + 1));
    }
  }
  return last!;
}

async function ingestOneSource(source: Source): Promise<IngestStats> {
  const supabase = getSupabaseClient();
  const stats: IngestStats = {
    source: source.name,
    fetched: 0,
    inserted: 0,
    skipped: 0,
    status: "ok",
  };

  try {
    const res = await fetchWithRetry(source.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const xml = await res.text();
    const { items } = parseFeed(xml);

    // Apply per-source cap and the backfill cutoff.
    const cutoff = new Date(Date.now() - BACKFILL_HOURS * 60 * 60 * 1000);
    const recent = items
      .filter((it: ParsedItem) => it.pubDate >= cutoff)
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
      .slice(0, MAX_ARTICLES_PER_SOURCE);

    stats.fetched = recent.length;

    if (recent.length === 0) {
      // Update watermark even on empty fetches so we know the source is alive.
      await supabase.from("sources").update({
        last_fetched_at: new Date().toISOString(),
        last_status: "ok (0 items)",
      }).eq("id", source.id);
      return stats;
    }

    // For Google News items the publisher comes inside the description as
    // <font color="#6f6f6f">Source Name</font>. Use that when available;
    // otherwise fall back to the source row's name (e.g. "Google News: Spinny").
    const rows = recent.map((it) => ({
      source_id: source.id,
      source_name: source.source_type === "google_news" && it.originalSource
        ? it.originalSource
        : source.name,
      title: it.title.slice(0, 500),
      summary: it.description,
      url: it.link,
      image_url: it.imageUrl,
      published_at: it.pubDate.toISOString(),
      pipeline_state: "ingested",
    }));

    // Insert with conflict-on-url to dedup. We ignore conflicts (existing rows
    // are correct; we don't overwrite enriched fields).
    const { data, error } = await supabase
      .from("articles")
      .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
      .select("id");

    if (error) throw error;

    stats.inserted = data?.length ?? 0;
    stats.skipped = rows.length - stats.inserted;

    await supabase.from("sources").update({
      last_fetched_at: new Date().toISOString(),
      last_status: `ok (${stats.inserted} new / ${stats.skipped} dup)`,
    }).eq("id", source.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stats.status = "error";
    stats.error = msg;
    console.error(`[rss-ingest] ${source.name}: ${msg}`);
    await getSupabaseClient().from("sources").update({
      last_fetched_at: new Date().toISOString(),
      last_status: `error: ${msg.slice(0, 200)}`,
    }).eq("id", source.id);
  }

  return stats;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!isAuthorizedRequest(req)) return unauthorizedResponse();

  const startedAt = Date.now();
  const supabase = getSupabaseClient();

  try {
    // Optional body: { source_ids?: string[], force?: boolean }
    let body: { source_ids?: string[]; force?: boolean } = {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty body is fine */
    }

    let query = supabase.from("sources").select("*").eq("is_active", true);
    if (body.source_ids?.length) query = query.in("id", body.source_ids);

    const { data: sources, error } = await query;
    if (error) throw error;
    if (!sources || sources.length === 0) {
      return jsonResponse({
        ok: true,
        message: "No active sources to ingest.",
        stats: [],
      });
    }

    // Skip sources that were fetched too recently (unless ?force=true).
    const eligible = (sources as Source[]).filter((s) => {
      if (body.force) return true;
      if (!s.last_fetched_at) return true;
      const sinceMs = Date.now() - new Date(s.last_fetched_at).getTime();
      return sinceMs >= s.fetch_interval_minutes * 60_000;
    });

    // Concurrent ingest, capped at 5 to be polite.
    const stats: IngestStats[] = [];
    const concurrency = 3;
    for (let i = 0; i < eligible.length; i += concurrency) {
      const batch = eligible.slice(i, i + concurrency);
      const results = await Promise.all(batch.map((s) => ingestOneSource(s)));
      stats.push(...results);
    }

    const totalInserted = stats.reduce((a, s) => a + s.inserted, 0);
    const totalErrors = stats.filter((s) => s.status === "error").length;

    await supabase.from("pipeline_state").upsert({
      id: "rss_ingest",
      last_run_at: new Date().toISOString(),
      last_run_status: totalErrors === 0
        ? "success"
        : `partial (${totalErrors} errors)`,
      last_run_meta: {
        sources_total: sources.length,
        sources_eligible: eligible.length,
        sources_skipped_throttle: sources.length - eligible.length,
        articles_inserted: totalInserted,
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return jsonResponse({
      ok: true,
      sources_processed: eligible.length,
      sources_skipped_throttle: sources.length - eligible.length,
      articles_inserted: totalInserted,
      elapsed_ms: Date.now() - startedAt,
      stats,
    });
  } catch (err) {
    const msg = err instanceof Error
      ? err.message
      : (typeof err === "object" && err !== null
        ? JSON.stringify(err)
        : String(err));
    console.error(`[rss-ingest] fatal: ${msg}`);
    return errorResponse(msg, 500);
  }
});
