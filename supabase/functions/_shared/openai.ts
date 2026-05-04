// Thin OpenAI wrapper for Edge Functions.
// Uses fetch directly so we don't pull in the SDK (smaller cold start).

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" } | { type: "text" };
  retries?: number;
}

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

export class OpenAIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "OpenAIError";
  }
}

function getApiKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY env var is missing.");
  return key;
}

// ----- Chat completions ------------------------------------------------------

export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<{
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> {
  const {
    model = DEFAULT_MODEL,
    temperature = 0.2,
    max_tokens = 2048,
    response_format,
    retries = 2,
  } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens,
  };
  if (response_format) body.response_format = response_format;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getApiKey()}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        // 429 / 5xx → backoff and retry
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const delay = 1000 * Math.pow(2, attempt) + Math.random() * 250;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new OpenAIError(`OpenAI ${res.status}: ${errBody.slice(0, 300)}`, res.status, errBody);
      }

      const json = await res.json();
      return {
        content: json.choices?.[0]?.message?.content ?? "",
        usage: json.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

export async function chatJson<T>(messages: ChatMessage[], options: ChatOptions = {}): Promise<{
  data: T;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> {
  const result = await chat(messages, {
    ...options,
    response_format: { type: "json_object" },
  });
  let data: T;
  try {
    data = JSON.parse(result.content);
  } catch (err) {
    throw new Error(
      `OpenAI returned invalid JSON: ${(err as Error).message}\nRaw: ${result.content.slice(0, 500)}`,
    );
  }
  return { data, usage: result.usage };
}

// ----- Embeddings ------------------------------------------------------------

export async function embed(texts: string[], model = DEFAULT_EMBED_MODEL): Promise<{
  embeddings: number[][];
  usage: { prompt_tokens: number; total_tokens: number };
}> {
  if (texts.length === 0) return { embeddings: [], usage: { prompt_tokens: 0, total_tokens: 0 } };

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new OpenAIError(`OpenAI embeddings ${res.status}: ${errBody.slice(0, 300)}`, res.status, errBody);
  }

  const json = await res.json();
  return {
    embeddings: json.data.map((d: { embedding: number[] }) => d.embedding),
    usage: json.usage,
  };
}

// ----- Cost estimation -------------------------------------------------------
// Rough numbers for budget tracking. Update if OpenAI prices change.

export const PRICING = {
  "gpt-4o": { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
  "gpt-4o-mini": { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  "text-embedding-3-small": { input: 0.02 / 1_000_000, output: 0 },
};

export function costFor(
  model: keyof typeof PRICING,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  return promptTokens * p.input + completionTokens * p.output;
}
