// =============================================================================
// route-articles
// =============================================================================
// For every article in pipeline_state='classified':
//   1. Embed title+summary with text-embedding-3-small (1536 dims)
//   2. Find top-K candidate clusters by cosine similarity (pgvector)
//   3. Send article + candidates to gpt-4o → decides: route_to_existing | create_new
//   4. Apply decision (assign cluster_id; create cluster if needed; refresh aggregates)
//   5. Mark pipeline_state = 'routed' (or 'embedded' if no clustering happened)
//
// This is the "hybrid clustering" pattern from the README:
//   - Pure-LLM clustering doesn't scale beyond ~12 active clusters
//   - Pure-embedding clustering overfits on shared vocabulary (every article
//     about "used cars India" looks similar; only the LLM can tell which are
//     the same EVENT vs same TOPIC)
//   - Embeddings filter to top-K → LLM picks → both scale + accuracy
// =============================================================================

import { getSupabaseClient, jsonResponse, errorResponse, corsHeaders, isAuthorizedRequest, unauthorizedResponse } from "../_shared/supabase.ts";
import { embed, chatJson, costFor } from "../_shared/openai.ts";
import { toVectorLiteral } from "../_shared/vector.ts";
import type { PrimaryCompetitor, RoutingDecision } from "../_shared/types.ts";

const BATCH_SIZE = parseInt(Deno.env.get("ROUTE_BATCH_SIZE") ?? "20", 10);
const ROUTER_K = parseInt(Deno.env.get("ROUTER_CANDIDATE_K") ?? "12", 10);
// Lookback for candidate clusters: anything older than this is invisible to
// the router (a fresh article on the same theme will start a new cluster).
// Aligned to archival ceiling (14d): there's no point looking further back than
// archival allows.
const CLUSTER_LOOKBACK_DAYS = parseInt(Deno.env.get("CLUSTER_LOOKBACK_DAYS") ?? "14", 10);
// Max temporal gap (days) between the new article and the cluster's latest
// article. Stops semantically-similar but time-distant events from merging
// (e.g. a March 12 founder-exit article being routed into a May 1 founder-exit
// cluster — same theme, different events).
const MAX_EVENT_GAP_DAYS = parseInt(Deno.env.get("MAX_EVENT_GAP_DAYS") ?? "14", 10);
// Cosine distance threshold for auto-routing (skip LLM call). For competitor
// stories we use a looser threshold (0.15) because near-duplicate competitor
// headlines are common and false splits are visible in the brief. For neutral
// MARKET stories we keep a tighter threshold (0.08) because vocabulary overlap
// can be misleading.
const AUTO_ROUTE_DISTANCE_COMPETITOR = parseFloat(Deno.env.get("AUTO_ROUTE_DISTANCE_COMPETITOR") ?? "0.15");
const AUTO_ROUTE_DISTANCE_MARKET = parseFloat(Deno.env.get("AUTO_ROUTE_DISTANCE_MARKET") ?? "0.08");

// ─────────────────────────────────────────────────────────────────────────────
// Router LLM prompt
// ─────────────────────────────────────────────────────────────────────────────

const ROUTER_SYSTEM_PROMPT = `You decide whether a new auto-industry news article belongs to an existing story cluster (a group of articles about the same real-world event) or starts a new cluster.

A "real-world event" is a single happening — one funding round, one product launch, one regulatory action, one acquisition, one executive exit. Multiple outlets writing about the same event = same cluster.

────────────────────────────────────────────────────────────
Decision rules
────────────────────────────────────────────────────────────

ROUTE TO EXISTING when:
  - The new article and a candidate cluster cover the same specific event
    (same company + same action + same approximate timeframe).
  - Different angles on the same event (e.g. one focuses on the dollar amount,
    another on the strategic angle) STILL belong together — synthesis pulls
    those facets into one editorial story later.
  - Follow-up coverage (analysts react, stock moves, official statement
    follows the news break) belongs with the original break.
  - For competitor IPO/funding/M&A coverage, treat planning, bankers hired,
    timeline, valuation, filing, and investor-angle articles within 14 days as
    the SAME event narrative unless they clearly refer to separate transactions.
    Reported timeline differences (2025 vs 2026 listing) are source variance,
    not a new event by themselves.

CREATE NEW when:
  - Same companies but DIFFERENT events. (Spinny launching in UAE ≠ Spinny
    raising a Series F. Cars24 founder X stepping down ≠ Cars24 founder Y
    stepping down weeks later.)
  - Same theme but different specifics. (Two different used-car GST policy
    proposals are two events, not one.)
  - You can't find any candidate that's a clear match.

────────────────────────────────────────────────────────────
Default when uncertain
────────────────────────────────────────────────────────────

Apply these in order — the first that fits wins.

  (a) If the new article and a candidate share the SAME primary_competitor
      AND the same strategic event family (IPO/listing/funding/M&A/leadership/
      launch/partnership/layoffs) AND their timestamps are within 14 days of
      each other → route_to_existing. False splits in a competitor's narrative
      show up as duplicate stories in the brief, which is the central failure
      mode we're trying to avoid.

  (b) If the new article and a candidate share the SAME primary_competitor
      but DIFFERENT action verbs → create_new. Same company, different event.
      Exception: IPO/listing/funding/M&A lifecycle articles often use different
      verbs ("plans", "hires banks", "files", "targets") for the same event.

  (c) For MARKET-bucket articles with NO primary_competitor → when unsure,
      create_new. Market vocabulary overlaps too much for safe merges
      ("auto sales rise", "EV demand grows" recurs across unrelated events).

────────────────────────────────────────────────────────────
Output format
────────────────────────────────────────────────────────────

Respond with ONLY a JSON object — no preamble, no markdown:

{
  "decision": "route_to_existing" | "create_new",
  "cluster_id": "<uuid of chosen candidate, or null>",
  "reasoning": "<1-line, max 20 words — name the action verb if applicable>"
}`;

interface CandidateCluster {
  cluster_id: string;
  theme: string | null;
  article_count: number;
  cosine_distance: number;
  latest_article_at: string;
  sample_titles: string[];
}

interface ClassifiedArticle {
  id: string;
  title: string;
  summary: string | null;
  source_name: string;
  published_at: string;
  importance: string;
  reasoning: string;
  entities: string[];
  primary_competitor: PrimaryCompetitor;
  cars24_implication: string | null;
}

function buildRouterUserMessage(article: ClassifiedArticle, candidates: CandidateCluster[]): string {
  const articleBlock = `NEW ARTICLE
TITLE: ${article.title}
SOURCE: ${article.source_name}
PUBLISHED: ${article.published_at}
ENTITIES: ${article.entities.join(", ") || "(none)"}
IMPORTANCE: ${article.importance}
SUMMARY: ${article.summary?.slice(0, 600) ?? "(no body)"}`;

  if (candidates.length === 0) {
    return `${articleBlock}\n\nCANDIDATES: (none — no recent clusters)\n\nDecision: must be "create_new".`;
  }

  const candidateBlocks = candidates.map((c, i) => {
    return `CANDIDATE ${i + 1} (cluster_id=${c.cluster_id}, ${c.article_count} article(s), latest ${c.latest_article_at}, cosine_distance=${c.cosine_distance.toFixed(3)})
THEME: ${c.theme ?? "(no theme yet)"}
RECENT TITLES IN CLUSTER:
${c.sample_titles.map((t) => `  • ${t}`).join("\n")}`;
  }).join("\n\n");

  return `${articleBlock}\n\n${candidateBlocks}\n\nReturn the decision.`;
}

const VALID_DECISIONS = new Set(["route_to_existing", "create_new"]);

function validateRouting(raw: unknown, candidateIds: Set<string>): RoutingDecision {
  if (!raw || typeof raw !== "object") throw new Error("Routing: not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.decision !== "string" || !VALID_DECISIONS.has(obj.decision)) {
    throw new Error(`Routing: invalid decision '${obj.decision}'`);
  }
  if (typeof obj.reasoning !== "string") throw new Error("Routing: reasoning required");

  const decision = obj.decision as RoutingDecision["decision"];
  let cluster_id: string | null = null;

  if (decision === "route_to_existing") {
    if (typeof obj.cluster_id !== "string") {
      throw new Error("Routing: route_to_existing requires cluster_id");
    }
    if (!candidateIds.has(obj.cluster_id)) {
      // Safety: model hallucinated a cluster_id not in the candidate list.
      throw new Error(`Routing: cluster_id ${obj.cluster_id} not in candidate set`);
    }
    cluster_id = obj.cluster_id;
  }

  return { decision, cluster_id, reasoning: (obj.reasoning as string).trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster operations
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCandidateClusters(
  embedding: number[],
  k: number,
  competitor: PrimaryCompetitor,
  articlePublishedAt: string,
): Promise<CandidateCluster[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("find_candidate_clusters", {
    query_embedding: toVectorLiteral(embedding),
    candidate_count: k,
    lookback_days: CLUSTER_LOOKBACK_DAYS,
    competitor: competitor,
    article_published_at: articlePublishedAt,
    max_event_gap_days: MAX_EVENT_GAP_DAYS,
  });
  if (error) throw new Error(`find_candidate_clusters failed: ${error.message}`);

  const clusters = (data ?? []) as Array<{
    cluster_id: string;
    theme: string | null;
    article_count: number;
    cosine_distance: number;
    latest_article_at: string;
    primary_competitor: string | null;
  }>;
  if (clusters.length === 0) return [];

  // Pull a few sample titles per cluster so the LLM can reason about them.
  const ids = clusters.map((c) => c.cluster_id);
  const { data: sampleArticles, error: sampleErr } = await supabase
    .from("articles")
    .select("cluster_id, title, published_at")
    .in("cluster_id", ids)
    .order("published_at", { ascending: false });
  if (sampleErr) throw sampleErr;

  const titlesByCluster = new Map<string, string[]>();
  for (const row of sampleArticles ?? []) {
    const arr = titlesByCluster.get(row.cluster_id) ?? [];
    if (arr.length < 4) arr.push(row.title);
    titlesByCluster.set(row.cluster_id, arr);
  }

  return clusters.map((c) => ({
    ...c,
    sample_titles: titlesByCluster.get(c.cluster_id) ?? [],
  }));
}

async function createCluster(article: ClassifiedArticle, embedding: number[]): Promise<string> {
  const supabase = getSupabaseClient();
  // Use the article's title as the initial theme; synthesizer will overwrite.
  // primary_competitor is set ONCE here at cluster birth and never changes.
  // The router (find_candidate_clusters) only matches articles to clusters
  // with the same primary_competitor, so this stays consistent over time.
  const { data, error } = await supabase
    .from("clusters")
    .insert({
      centroid: toVectorLiteral(embedding),
      theme: article.title.slice(0, 200),
      primary_competitor: article.primary_competitor,
      earliest_article_at: article.published_at,
      latest_article_at: article.published_at,
      article_count: 0, // will be set by refresh_cluster_aggregates
      needs_synthesis: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createCluster failed: ${error.message}`);
  return data.id;
}

async function attachToCluster(
  articleId: string,
  clusterId: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error: updErr } = await supabase
    .from("articles")
    .update({
      cluster_id: clusterId,
      routed_at: new Date().toISOString(),
      pipeline_state: "routed",
    })
    .eq("id", articleId);
  if (updErr) throw updErr;

  const { error: rpcErr } = await supabase.rpc("refresh_cluster_aggregates", {
    target_cluster_id: clusterId,
  });
  if (rpcErr) throw rpcErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-article routing
// ─────────────────────────────────────────────────────────────────────────────

async function routeOne(
  article: ClassifiedArticle,
  embedding: number[],
): Promise<{ id: string; decision: string; cluster_id: string; cost_usd: number; auto_routed: boolean } | { id: string; error: string }> {
  try {
    // Restrict candidates to clusters with the same primary_competitor AND
    // within MAX_EVENT_GAP_DAYS of the new article. This is the structural fix
    // that prevents cross-competitor merges and same-theme-different-event
    // merges (e.g. founder X exit cluster + founder Y exit article).
    const candidates = await fetchCandidateClusters(
      embedding,
      ROUTER_K,
      article.primary_competitor,
      article.published_at,
    );

    // Auto-route shortcut: if the top candidate is *very* close, skip the LLM
    // call. Use a looser threshold for competitor stories (false splits there
    // are visible in the brief) and a tighter threshold for neutral MARKET
    // stories (vocabulary overlap can be misleading).
    const autoRouteThreshold = article.primary_competitor !== null
      ? AUTO_ROUTE_DISTANCE_COMPETITOR
      : AUTO_ROUTE_DISTANCE_MARKET;
    if (candidates.length > 0 && candidates[0].cosine_distance < autoRouteThreshold) {
      const target = candidates[0].cluster_id;
      await attachToCluster(article.id, target);
      return { id: article.id, decision: "route_to_existing", cluster_id: target, cost_usd: 0, auto_routed: true };
    }

    // No candidates → create new without LLM
    if (candidates.length === 0) {
      const newId = await createCluster(article, embedding);
      await attachToCluster(article.id, newId);
      return { id: article.id, decision: "create_new", cluster_id: newId, cost_usd: 0, auto_routed: true };
    }

    // Otherwise: ask the LLM.
    const { data: rawDecision, usage } = await chatJson<unknown>([
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      { role: "user", content: buildRouterUserMessage(article, candidates) },
    ], {
      model: "gpt-4o",
      temperature: 0.1,
      max_tokens: 250,
    });

    const candidateIds = new Set(candidates.map((c) => c.cluster_id));
    const decision = validateRouting(rawDecision, candidateIds);
    const cost = costFor("gpt-4o", usage.prompt_tokens, usage.completion_tokens);

    let targetClusterId: string;
    if (decision.decision === "route_to_existing" && decision.cluster_id) {
      targetClusterId = decision.cluster_id;
    } else {
      targetClusterId = await createCluster(article, embedding);
    }

    await attachToCluster(article.id, targetClusterId);
    return { id: article.id, decision: decision.decision, cluster_id: targetClusterId, cost_usd: cost, auto_routed: false };
  } catch (err) {
    return { id: article.id, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!isAuthorizedRequest(req)) return unauthorizedResponse();

  const startedAt = Date.now();
  const supabase = getSupabaseClient();

  try {
    let body: { limit?: number; archive_stale?: boolean } = {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty */
    }

    const limit = Math.min(body.limit ?? BATCH_SIZE, 50);
    const archiveStale = body.archive_stale ?? true;

    // Defense in depth: archive stale clusters BEFORE routing, even if the
    // scheduled cron job lagged or hasn't run yet.
    //
    // During historical reset/backfill reroutes, callers should set
    // archive_stale=false. Otherwise a 60-day-old cluster created in batch N
    // would be archived at the start of batch N+1 before another article from
    // the same historical event can attach to it.
    if (archiveStale) {
      const { data: archivedCount, error: archErr } = await supabase.rpc(
        "archive_stale_clusters",
        { max_age_days: MAX_EVENT_GAP_DAYS },
      );
      if (archErr) {
        console.warn(`[route] archive_stale_clusters failed: ${archErr.message}`);
      } else if ((archivedCount ?? 0) > 0) {
        console.log(`[route] pre-routing archived ${archivedCount} stale clusters`);
      }
    }

    // Pull classified articles that haven't been routed yet.
    // We DO route LOW (so synthesizer can see source breadth); we don't route DROP (those moved to 'dropped').
    const { data: articles, error: fetchErr } = await supabase
      .from("articles")
      .select("id, title, summary, source_name, published_at, importance, reasoning, entities, primary_competitor, cars24_implication")
      .eq("pipeline_state", "classified")
      .order("published_at", { ascending: false })
      .limit(limit);

    if (fetchErr) throw fetchErr;
    if (!articles || articles.length === 0) {
      return jsonResponse({ ok: true, message: "No articles to route.", processed: 0 });
    }

    // ── Phase 1: embed all in one API call (cheaper + faster than per-article).
    const embedTexts = articles.map((a) => `${a.title}\n\n${a.summary?.slice(0, 800) ?? ""}`);
    const { embeddings, usage: embedUsage } = await embed(embedTexts);
    const embeddingCost = costFor("text-embedding-3-small", embedUsage.total_tokens, 0);

    // Persist embeddings. Do not use partial upserts against `articles`: the
    // table has required columns and Postgres validates missing NOT NULL fields
    // before ON CONFLICT can turn an insert into an update.
    {
      const embeddedAt = new Date().toISOString();
      const updateResults = await Promise.all(articles.map((a, i) =>
        supabase
          .from("articles")
          .update({
            embedding: toVectorLiteral(embeddings[i]),
            embedded_at: embeddedAt,
          })
          .eq("id", a.id)
      ));
      const failed = updateResults.find((r) => r.error);
      if (failed?.error) throw failed.error;
    }

    // ── Phase 2: route. SEQUENTIAL (not parallel) — each routing decision affects
    // future candidate sets, so concurrency would create races.
    let routerCost = 0;
    let processed = 0;
    let errors = 0;
    let autoRouted = 0;
    const decisionCounts = { route_to_existing: 0, create_new: 0 };

    for (let i = 0; i < articles.length; i++) {
      const article = articles[i] as ClassifiedArticle;
      const r = await routeOne(article, embeddings[i]);
      if ("error" in r) {
        errors++;
        console.error(`[route] ${r.id}: ${r.error}`);
      } else {
        processed++;
        routerCost += r.cost_usd;
        if (r.auto_routed) autoRouted++;
        decisionCounts[r.decision as "route_to_existing" | "create_new"]++;
      }
    }

    const totalCost = embeddingCost + routerCost;

    await supabase.from("pipeline_state").upsert({
      id: "router",
      last_run_at: new Date().toISOString(),
      last_processed_at: new Date().toISOString(),
      last_run_status: errors === 0 ? "success" : `partial (${errors} errors)`,
      last_run_meta: {
        articles_processed: processed,
        articles_errored: errors,
        auto_routed: autoRouted,
        decision_counts: decisionCounts,
        archive_stale: archiveStale,
        embed_cost_usd: Number(embeddingCost.toFixed(4)),
        router_cost_usd: Number(routerCost.toFixed(4)),
        total_cost_usd: Number(totalCost.toFixed(4)),
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return jsonResponse({
      ok: true,
      processed,
      errors,
      auto_routed: autoRouted,
      decision_counts: decisionCounts,
      cost_usd: { embed: embeddingCost, router: routerCost, total: totalCost },
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err));
    console.error(`[route-articles] fatal: ${msg}`);
    return errorResponse(msg, 500);
  }
});
