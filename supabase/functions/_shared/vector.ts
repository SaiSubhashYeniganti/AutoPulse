// Helpers for passing OpenAI embeddings to pgvector through PostgREST.
//
// Supabase/PostgREST accepts pgvector values as vector literals ("[1,2,3]").
// A TypeScript cast like `embedding as unknown as string` only changes the
// compiler's view, not the runtime payload; it still sends a JSON array. These
// helpers make the conversion explicit and keep vector handling consistent.

export function toVectorLiteral(values: number[]): string {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Cannot convert an empty embedding to pgvector literal.");
  }

  return `[${values.map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error(`Embedding contains a non-finite value: ${value}`);
    }
    return Number(value).toString();
  }).join(",")}]`;
}

