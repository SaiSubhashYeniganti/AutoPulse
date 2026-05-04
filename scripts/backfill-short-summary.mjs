// One-off backfill: generate a short_summary for every story that doesn't have one.
//
// Why a node script instead of a new Edge Function:
//   - One-time job, ~136 stories. No reason to ship infra for it.
//   - Plain fetch + Supabase REST. No npm deps required.
//   - Costs ~$0.02 with gpt-4o-mini.
//
// Usage:
//   node scripts/backfill-short-summary.mjs
//
// Env (auto-read from project .env via dotenv-style parser below):
//   NEXT_PUBLIC_SUPABASE_URL
//   BACKEND_API_KEY            (the sb_secret_... key, full DB write access)
//   OPENAI_API_KEY

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile() {
  const candidates = [".env.local", ".env", "web/.env.local", "web/.env"];
  for (const f of candidates) {
    const p = resolve(process.cwd(), f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
}
loadEnvFile();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const BACKEND_KEY =
  process.env.BACKEND_API_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !BACKEND_KEY || !OPENAI_KEY) {
  console.error("Missing required env: NEXT_PUBLIC_SUPABASE_URL, BACKEND_API_KEY, OPENAI_API_KEY");
  process.exit(1);
}

const SYSTEM_PROMPT = `You write one-sentence summaries for a CEO scanning a feed of news headlines.

Given a story's title and full summary, produce ONE sentence (≤140 characters) that captures the single most important fact. Numbers and concrete actors. No filler. The reader should know what happened without expanding the row.

Examples:
  ✓ "Spinny hires Morgan Stanley and JP Morgan as it readies a 2026 IPO at a $3.5B target."
  ✓ "GST council cuts used-car GST from 18% to 12%, effective 1 June."
  ✗ "A major development in the used-car industry has emerged."   (vague)
  ✗ Same as the title with extra words.                            (redundant)

Respond with ONLY a JSON object:
{ "short_summary": "<one sentence, ≤140 chars>" }`;

async function fetchStories() {
  const url = new URL(`${SUPABASE_URL}/rest/v1/stories`);
  url.searchParams.set("select", "id,title,summary,short_summary");
  url.searchParams.set("short_summary", "is.null");
  url.searchParams.set("limit", "1000");
  const res = await fetch(url, {
    headers: { apikey: BACKEND_KEY, Authorization: `Bearer ${BACKEND_KEY}` },
  });
  if (!res.ok) throw new Error(`fetch stories: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function generateShort(title, summary) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 120,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `TITLE: ${title}\n\nSUMMARY: ${summary}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content);
  let s = String(parsed.short_summary ?? "").trim().replace(/\s+/g, " ");
  if (!s) throw new Error("empty short_summary");
  if (s.length > 160) {
    const cut = s.slice(0, 160);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trim();
    if (!/[.!?]$/.test(s)) s += "…";
  }
  return s;
}

async function patchStory(id, shortSummary) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/stories?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        apikey: BACKEND_KEY,
        Authorization: `Bearer ${BACKEND_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ short_summary: shortSummary }),
    },
  );
  if (!res.ok) throw new Error(`patch ${id}: ${res.status} ${await res.text()}`);
}

async function runBatch(items, fn, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(chunk.map(fn));
    results.push(...settled);
    process.stdout.write(`  processed ${Math.min(i + concurrency, items.length)}/${items.length}\r`);
  }
  process.stdout.write("\n");
  return results;
}

async function main() {
  const stories = await fetchStories();
  console.log(`Found ${stories.length} stories without short_summary.`);
  if (stories.length === 0) return;

  let ok = 0;
  let failed = 0;

  const settled = await runBatch(stories, async (s) => {
    try {
      const short = await generateShort(s.title, s.summary);
      await patchStory(s.id, short);
      return { id: s.id, short };
    } catch (e) {
      throw new Error(`${s.id}: ${e.message}`);
    }
  });

  for (const r of settled) {
    if (r.status === "fulfilled") ok++;
    else {
      failed++;
      console.error(`  FAIL ${r.reason?.message ?? r.reason}`);
    }
  }

  console.log(`\nDone. ok=${ok} failed=${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
