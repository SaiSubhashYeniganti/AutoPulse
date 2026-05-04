// =============================================================================
// synthesize-stories
// =============================================================================
// For every cluster with needs_synthesis=true (and at least one MED+ article),
// asks gpt-4o to produce ONE editorial story:
//   - title              (Bloomberg-terse, 60 chars max)
//   - short_summary      (1 sentence, 140 chars max)
//   - summary            (3-4 sentences, no meta-commentary)
//   - cars24_implication (1 line, specific & actionable)
//   - importance         (max of member articles)
//
// Then upserts into stories table. Picks an image from the member articles.
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
import type { SynthesisResult } from "../_shared/types.ts";

const BATCH_SIZE = parseInt(Deno.env.get("SYNTHESIZE_BATCH_SIZE") ?? "15", 10);
const CONCURRENCY = parseInt(Deno.env.get("SYNTHESIZE_CONCURRENCY") ?? "3", 10);

// ─────────────────────────────────────────────────────────────────────────────
// Synthesizer prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYNTHESIZE_SYSTEM_PROMPT =
  `You are an editorial writer for the Cars24 leadership team's daily intelligence brief.

Multiple news articles cover the same real-world event from different angles. You consolidate them into one tight, professionally-edited story.

────────────────────────────────────────────────────────────
Voice & format
────────────────────────────────────────────────────────────

- Voice: Bloomberg / Reuters terse. Lead with the news, not the framing.
- Tense: past for what happened, present for ongoing.
- No meta-commentary ("This development highlights...", "It will be interesting to see...", "Industry observers note..."). Just facts.
- No filler conclusions. End on the last fact, not a summary sentence.
- Numbers: keep specifics from the articles ($, ₹, %, dates, city counts). Do not round or estimate.
- Names: use full company names on first mention.
- Indian English. ₹ for INR amounts. Cr / Lakh OK in context.

────────────────────────────────────────────────────────────
Output fields
────────────────────────────────────────────────────────────

title: 60 characters max. State the news, not the topic.
  ✓ "Spinny raises $283M Series F led by Tiger Global"
  ✗ "Spinny in the news: a major funding update"

short_summary: ONE sentence, 140 characters MAX. The single most-important fact
  in the story, written so a busy CEO scanning a list of 5 headlines understands
  what happened without expanding the row. Numbers and concrete actors.
  ✓ "Spinny hires Morgan Stanley and JP Morgan as it readies a 2026 IPO at a $3.5B target."
  ✓ "GST council cuts used-car GST from 18% to 12%, effective 1 June."
  ✗ "A major development in the used-car industry has emerged."   ← vague
  ✗ Same as the title, just with extra words.                       ← redundant
  Hard limit: 140 characters. Count and trim if needed.

summary: 3-4 sentences. ~70 words target. Pull the unique facts from each
  source into one complete narrative. Different outlets emphasize different
  facets (dollar amount, regulatory angle, strategic context); your job is to
  combine them so the reader gets the full picture without reading 5 articles.
  NEVER end mid-sentence or mid-word. The last character must be a period.

cars24_implication: 1 line, max 25 words. Specific and actionable. What does
  this concretely mean for Cars24's used-car business in India? If the event
  doesn't materially affect Cars24, return an empty string "" — do NOT
  fabricate an implication.
  ✓ "Pressure on Cars24 to defend Tier 1 share — Spinny's UAE expansion validates the cross-border thesis."
  ✗ "Could affect the industry in interesting ways."   ← too vague
  ✗ "Cars24 should monitor this development."          ← not actionable

importance: HIGH | MED | LOW. Use the maximum importance across the member
  articles. Don't downgrade for a quiet day or upgrade for a loud one.

────────────────────────────────────────────────────────────
Output format
────────────────────────────────────────────────────────────

Respond with ONLY a JSON object, no markdown fences, no preamble:

{
  "title": "<...>",
  "short_summary": "<one sentence, ≤140 chars>",
  "summary": "<...>",
  "cars24_implication": "<...>",
  "importance": "HIGH" | "MED" | "LOW"
}`;

interface ClusterMember {
  id: string;
  title: string;
  summary: string | null;
  source_name: string;
  url: string;
  published_at: string;
  image_url: string | null;
  importance: string;
  bucket: string;
  entities: string[];
}

interface ClusterRow {
  id: string;
  theme: string | null;
  primary_competitor: string | null;
  article_count: number;
  members: ClusterMember[];
}

const VALID_STORY_IMP = new Set(["HIGH", "MED", "LOW"]);

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

const SHORT_SUMMARY_MAX_CHARS = 140;

// Trim a short_summary to ≤140 chars, prefer cutting at the last sentence/space
// boundary so it never ends mid-word.
function trimShortSummary(text: string): string {
  let s = text.trim().replace(/\s+/g, " ");
  if (s.length <= SHORT_SUMMARY_MAX_CHARS) return s;
  const cut = s.slice(0, SHORT_SUMMARY_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  s = (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trim();
  if (!/[.!?]$/.test(s)) {
    s = s.slice(0, SHORT_SUMMARY_MAX_CHARS - 1).trimEnd() + "…";
  }
  return s;
}

function validateSynthesis(raw: unknown): SynthesisResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Synthesis: not an object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.title !== "string" || obj.title.length === 0) {
    throw new Error("Synthesis: title required");
  }
  if (typeof obj.summary !== "string" || obj.summary.length === 0) {
    throw new Error("Synthesis: summary required");
  }
  if (
    typeof obj.importance !== "string" || !VALID_STORY_IMP.has(obj.importance)
  ) {
    throw new Error(`Synthesis: invalid importance '${obj.importance}'`);
  }

  // Implication can be empty/none (means "no Cars24 angle"); store as null.
  const implication = normalizeImplication(obj.cars24_implication);

  let summary = obj.summary.trim();
  // Defensive: model occasionally truncates mid-sentence; trim back to last sentence end.
  if (!/[.!?]$/.test(summary)) {
    const lastSentence = Math.max(
      summary.lastIndexOf("."),
      summary.lastIndexOf("!"),
      summary.lastIndexOf("?"),
    );
    if (lastSentence > 20) summary = summary.slice(0, lastSentence + 1);
  }

  // short_summary: prefer LLM output, fall back to first sentence of summary
  // if missing/blank. Always trimmed to ≤140 chars in case the model overshoots.
  let shortSummary: string;
  if (typeof obj.short_summary === "string" && obj.short_summary.trim()) {
    shortSummary = trimShortSummary(obj.short_summary);
  } else {
    const firstSentence = summary.split(/(?<=[.!?])\s/)[0] ?? summary;
    shortSummary = trimShortSummary(firstSentence);
  }

  return {
    title: obj.title.trim().slice(0, 200),
    short_summary: shortSummary,
    summary,
    cars24_implication: implication,
    importance: obj.importance as SynthesisResult["importance"],
  };
}

function buildSynthesizeUserMessage(cluster: ClusterRow): string {
  const articles = cluster.members
    .map((m, i) => {
      return `── Article ${i + 1} ──
SOURCE: ${m.source_name}
PUBLISHED: ${m.published_at}
TITLE: ${m.title}
ENTITIES: ${m.entities.join(", ") || "(none)"}
SUMMARY: ${m.summary?.trim() || "(no body)"}
URL: ${m.url}`;
    })
    .join("\n\n");

  return `Cluster ${cluster.id} — ${cluster.members.length} article(s) about the same event.\n\n${articles}\n\nProduce the consolidated story.`;
}

// Pick the best image from cluster members. Prefer larger images from primary sources.
function pickImage(members: ClusterMember[]): string | null {
  const withImage = members.filter((m) => m.image_url);
  if (withImage.length === 0) return null;
  // Prefer non-Google-News images (Google News surfaces low-res thumbs).
  const direct = withImage.find((m) =>
    !m.source_name.toLowerCase().startsWith("google news")
  );
  return (direct ?? withImage[0]).image_url;
}

// Pick the highest-importance member; tie-break by primary source preference.
function rankMaxImportance(members: ClusterMember[]): "HIGH" | "MED" | "LOW" {
  const order = { HIGH: 3, MED: 2, LOW: 1, DROP: 0 };
  let best: keyof typeof order = "LOW";
  for (const m of members) {
    if ((order[m.importance as keyof typeof order] ?? 0) > order[best]) {
      best = m.importance as keyof typeof order;
    }
  }
  return best === "DROP" ? "LOW" : best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-cluster synthesis
// ─────────────────────────────────────────────────────────────────────────────

async function synthesizeOne(cluster: ClusterRow): Promise<
  {
    cluster_id: string;
    story_id: string;
    cost_usd: number;
  } | { cluster_id: string; error: string }
> {
  try {
    const { data: rawStory, usage } = await chatJson<unknown>([
      { role: "system", content: SYNTHESIZE_SYSTEM_PROMPT },
      { role: "user", content: buildSynthesizeUserMessage(cluster) },
    ], {
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 800,
    });

    const result = validateSynthesis(rawStory);
    const cost = costFor(
      "gpt-4o",
      usage.prompt_tokens,
      usage.completion_tokens,
    );

    // Combine entities across all member articles, deduped.
    const allEntities = Array.from(
      new Set(cluster.members.flatMap((m) => m.entities)),
    ).filter(Boolean);

    // Sort members by published_at ascending so the earliest is "primary"
    // (used for source attribution: who broke the story).
    const sortedByDate = [...cluster.members].sort(
      (a, b) =>
        new Date(a.published_at).getTime() - new Date(b.published_at).getTime(),
    );
    const primary = sortedByDate[0];
    // Latest article date drives the story's published_at (i.e. "when did this
    // story last show signs of life?"). This is what every recency window in
    // the brief and UI filters by — using the earliest date would hide
    // long-running stories like "Cars24 founders exit" whose first article
    // could be 50+ days old but whose latest coverage is today.
    const latest = sortedByDate[sortedByDate.length - 1];

    const sourceArticles = cluster.members.map((m) => ({
      name: m.source_name,
      url: m.url,
      published_at: m.published_at,
      title: m.title,
    }));

    // Decide importance: prefer LLM's call but never lower than max-of-members.
    const memberMax = rankMaxImportance(cluster.members);
    const order = { HIGH: 3, MED: 2, LOW: 1 };
    const finalImportance = order[result.importance] >= order[memberMax]
      ? result.importance
      : memberMax;

    const supabase = getSupabaseClient();
    const { data: storyRow, error: upsertErr } = await supabase
      .from("stories")
      .upsert({
        cluster_id: cluster.id,
        title: result.title,
        short_summary: result.short_summary,
        summary: result.summary,
        cars24_implication: result.cars24_implication,
        importance: finalImportance,
        bucket: primary.bucket,
        // Inherited from the cluster (which inherited it from the founding article).
        // All members of a cluster share the same primary_competitor by construction.
        primary_competitor: cluster.primary_competitor,
        entities: allEntities,
        source_count: cluster.members.length,
        source_articles: sourceArticles,
        primary_source_name: primary.source_name,
        primary_source_url: primary.url,
        image_url: pickImage(cluster.members),
        // Track the cluster's latest activity, not the earliest article.
        // See note above on `latest` — this is what makes long-running stories
        // (founder exits, multi-week acquisitions) visible in recency windows.
        published_at: latest.published_at,
        updated_at: new Date().toISOString(),
      }, { onConflict: "cluster_id" })
      .select("id")
      .single();

    if (upsertErr) throw upsertErr;

    // Mark cluster as synthesized; mark all members as 'synthesized'.
    await supabase.from("clusters").update({
      needs_synthesis: false,
      theme: result.title.slice(0, 200),
      updated_at: new Date().toISOString(),
    }).eq("id", cluster.id);

    await supabase.from("articles").update({
      pipeline_state: "synthesized",
    }).eq("cluster_id", cluster.id);

    return { cluster_id: cluster.id, story_id: storyRow.id, cost_usd: cost };
  } catch (err) {
    return {
      cluster_id: cluster.id,
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
    let body: { limit?: number; cluster_ids?: string[]; force?: boolean } = {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty */
    }

    const limit = Math.min(body.limit ?? BATCH_SIZE, 50);

    // Get clusters needing synthesis (or specific ones / forced re-synthesis).
    let clusterQuery = supabase
      .from("clusters")
      .select("id, theme, primary_competitor, article_count")
      .gt("article_count", 0)
      .eq("is_archived", false)
      .order("latest_article_at", { ascending: false })
      .limit(limit);

    if (body.cluster_ids?.length) {
      clusterQuery = clusterQuery.in("id", body.cluster_ids);
    } else if (!body.force) {
      clusterQuery = clusterQuery.eq("needs_synthesis", true);
    }

    const { data: clusters, error: clusterErr } = await clusterQuery;
    if (clusterErr) throw clusterErr;
    if (!clusters || clusters.length === 0) {
      return jsonResponse({
        ok: true,
        message: "No clusters to synthesize.",
        processed: 0,
      });
    }

    // Pull all member articles for these clusters in one query.
    const clusterIds = clusters.map((c) => c.id);
    const { data: members, error: memberErr } = await supabase
      .from("articles")
      .select(
        "id, cluster_id, title, summary, source_name, url, published_at, image_url, importance, bucket, entities",
      )
      .in("cluster_id", clusterIds)
      .neq("importance", "DROP");
    if (memberErr) throw memberErr;

    const membersByCluster = new Map<string, ClusterMember[]>();
    for (const m of members ?? []) {
      const arr = membersByCluster.get(m.cluster_id!) ?? [];
      arr.push(m as ClusterMember);
      membersByCluster.set(m.cluster_id!, arr);
    }

    // Filter out clusters whose max importance is below MED — synthesizing LOW-only
    // clusters is wasted spend (they never appear in the brief or competitor pulse).
    const clusterRows: ClusterRow[] = clusters.map((c) => ({
      id: c.id,
      theme: c.theme,
      primary_competitor: c.primary_competitor,
      article_count: c.article_count,
      members: membersByCluster.get(c.id) ?? [],
    }));
    const eligible = clusterRows.filter((c) =>
      c.members.some((m) => m.importance === "HIGH" || m.importance === "MED")
    );
    const eligibleIds = new Set(eligible.map((c) => c.id));
    const skippedLowImportance = clusterRows.filter((c) => !eligibleIds.has(c.id));

    // LOW-only clusters are intentionally not synthesized (they never appear in
    // the brief or competitor analysis), but they still need to be marked done.
    // Otherwise they remain needs_synthesis=true forever and block reset loops.
    if (skippedLowImportance.length > 0) {
      const skippedIds = skippedLowImportance.map((c) => c.id);
      await supabase.from("clusters").update({
        needs_synthesis: false,
        updated_at: new Date().toISOString(),
      }).in("id", skippedIds);
      await supabase.from("articles").update({
        pipeline_state: "synthesized",
      }).in("cluster_id", skippedIds);
    }

    if (eligible.length === 0) {
      return jsonResponse({
        ok: true,
        message: "No clusters meet the MED+ importance bar.",
        clusters_seen: clusters.length,
        clusters_skipped_low_importance: skippedLowImportance.length,
        processed: 0,
      });
    }

    let totalCost = 0;
    let processed = 0;
    let errors = 0;

    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
      const batch = eligible.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(synthesizeOne));
      for (const r of results) {
        if ("error" in r) {
          errors++;
          console.error(`[synthesize] ${r.cluster_id}: ${r.error}`);
        } else {
          processed++;
          totalCost += r.cost_usd;
        }
      }
    }

    await supabase.from("pipeline_state").upsert({
      id: "synthesizer",
      last_run_at: new Date().toISOString(),
      last_processed_at: new Date().toISOString(),
      last_run_status: errors === 0 ? "success" : `partial (${errors} errors)`,
      last_run_meta: {
        clusters_synthesized: processed,
        clusters_errored: errors,
        clusters_skipped_low_importance: skippedLowImportance.length,
        cost_usd: Number(totalCost.toFixed(4)),
        elapsed_ms: Date.now() - startedAt,
      },
    });

    return jsonResponse({
      ok: true,
      processed,
      errors,
      skipped_low_importance: clusters.length - eligible.length,
      cost_usd: Number(totalCost.toFixed(4)),
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error
      ? err.message
      : (typeof err === "object" && err !== null
        ? JSON.stringify(err)
        : String(err));
    console.error(`[synthesize-stories] fatal: ${msg}`);
    return errorResponse(msg, 500);
  }
});
