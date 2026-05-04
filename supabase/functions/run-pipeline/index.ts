// =============================================================================
// run-pipeline
// =============================================================================
// Single entry point that chains all stages in the right order. Used by:
//   - pg_cron (every 2h: ingest → classify → route → synthesize)
//   - Manual smoke testing (curl this with stages: ["ingest"] to test in isolation)
//
// Each stage is invoked via its own HTTP endpoint (separate function deployment).
// We keep them deployed separately so they can be rerun individually for debugging.
// =============================================================================

import {
  corsHeaders,
  errorResponse,
  getBackendApiKey,
  isAuthorizedRequest,
  jsonResponse,
  unauthorizedResponse,
} from "../_shared/supabase.ts";

type Stage =
  | "ingest"
  | "classify"
  | "embed"
  | "route"
  | "synthesize"
  | "brief"
  | "competitor";

const STAGE_TO_FUNCTION: Record<Stage, string> = {
  ingest: "rss-ingest",
  classify: "classify-articles",
  embed: "route-articles", // embed + route happen in the same function
  route: "route-articles",
  synthesize: "synthesize-stories",
  brief: "generate-daily-brief",
  competitor: "generate-competitor-summary",
};

const DEFAULT_STAGES: Stage[] = ["ingest", "classify", "route", "synthesize"];

interface StageResult {
  stage: Stage;
  function_name: string;
  status: "ok" | "error";
  http_status: number;
  body: unknown;
  elapsed_ms: number;
  error?: string;
}

async function callStage(
  stage: Stage,
  baseUrl: string,
  apiKey: string,
  payload: Record<string, unknown> = {},
): Promise<StageResult> {
  const fnName = STAGE_TO_FUNCTION[stage];
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl}/functions/v1/${fnName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch { /* keep as text */ }

    return {
      stage,
      function_name: fnName,
      status: res.ok ? "ok" : "error",
      http_status: res.status,
      body,
      elapsed_ms: Date.now() - startedAt,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      stage,
      function_name: fnName,
      status: "error",
      http_status: 0,
      body: null,
      elapsed_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (!isAuthorizedRequest(req)) return unauthorizedResponse();

  const startedAt = Date.now();

  try {
    let body: {
      stages?: Stage[];
      stop_on_error?: boolean;
      stage_payloads?: Partial<Record<Stage, Record<string, unknown>>>;
    } = {};
    try {
      if (req.body) body = await req.json();
    } catch {
      /* empty */
    }

    const stages = body.stages ?? DEFAULT_STAGES;
    const stopOnError = body.stop_on_error ?? false;
    const stagePayloads = body.stage_payloads ?? {};

    // Dedup consecutive duplicate function calls (e.g. ["embed", "route"]
    // both map to route-articles, so run it once).
    const dedup: Stage[] = [];
    for (const s of stages) {
      if (!(s in STAGE_TO_FUNCTION)) {
        return errorResponse(`Unknown pipeline stage: ${s}`, 400);
      }

      const lastStage = dedup[dedup.length - 1];
      const lastFunction = lastStage ? STAGE_TO_FUNCTION[lastStage] : null;
      const currentFunction = STAGE_TO_FUNCTION[s];
      if (lastFunction !== currentFunction) {
        dedup.push(s);
      }
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = getBackendApiKey();
    if (!supabaseUrl || !serviceKey) {
      return errorResponse("SUPABASE_URL or BACKEND_API_KEY not set");
    }
    const apiKey = serviceKey;

    const results: StageResult[] = [];
    for (const stage of dedup) {
      const r = await callStage(stage, supabaseUrl, apiKey, stagePayloads[stage] ?? {});
      results.push(r);
      if (r.status === "error" && stopOnError) {
        return jsonResponse({
          ok: false,
          stopped_after_stage: stage,
          results,
          elapsed_ms: Date.now() - startedAt,
        }, 500);
      }
    }

    const errorCount = results.filter((r) => r.status === "error").length;
    return jsonResponse({
      ok: errorCount === 0,
      stages_run: results.length,
      errors: errorCount,
      results,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 500);
  }
});
