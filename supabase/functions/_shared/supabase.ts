// Shared Supabase client used by all Edge Functions.
// BACKEND_API_KEY stores the Supabase secret key (sb_secret_...), which bypasses RLS.

import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

let cached: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cached) return cached;

  const url = Deno.env.get("SUPABASE_URL");
  const key = getBackendApiKey();

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and BACKEND_API_KEY (Supabase secret key) must be set in the Edge Function environment.",
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false },
  });
  return cached;
}

export function getBackendApiKey(): string | null {
  return Deno.env.get("BACKEND_API_KEY") ?? null;
}

export function isAuthorizedRequest(req: Request): boolean {
  const expected = getBackendApiKey();
  if (!expected) return false;

  const apiKey = req.headers.get("apikey");
  const authorization = req.headers.get("authorization");
  const bearer = authorization?.replace(/^Bearer\s+/i, "");

  return apiKey === expected || bearer === expected;
}

export function unauthorizedResponse(): Response {
  return errorResponse(
    "Unauthorized. Send the Supabase secret key in the apikey header.",
    401,
  );
}

// Standard CORS headers (functions are called from cron + the orchestrator + occasional manual curl)
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Tiny helper for consistent JSON responses
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(
  message: string,
  status = 500,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse({ ok: false, error: message, ...extra }, status);
}
