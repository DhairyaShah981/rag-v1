import { existsSync } from "node:fs";

// tsx CLI scripts don't auto-load .env.local (Next.js does for the app). Load it
// here if present so ingest/eval work locally. On Vercel the file is absent and
// env vars are already injected — the guard skips it.
if (existsSync(".env.local")) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* already loaded or unreadable — fall through to injected env */
  }
}

function required(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  // Fail loudly at import, not silently on the first query. (DESIGN §i)
  throw new Error(`Missing required env var: ${names.join(" or ")}. See .env.local.example`);
}

// Getters validate on first access. embed.ts / vectorstore.ts read these at
// module top-level, so a missing var throws at import (boot) on any path that
// actually needs OpenAI/Upstash — while parse/chunk and `ingest --dry` stay
// runnable without secrets.
export const ENV = {
  get OPENAI_API_KEY() {
    return required("OPENAI_API_KEY");
  },
  // Accept the Upstash Vercel-Marketplace prefix (rag_*) or the plain name.
  get UPSTASH_VECTOR_REST_URL() {
    return required("UPSTASH_VECTOR_REST_URL", "rag_UPSTASH_VECTOR_REST_URL");
  },
  get UPSTASH_VECTOR_REST_TOKEN() {
    return required("UPSTASH_VECTOR_REST_TOKEN", "rag_UPSTASH_VECTOR_REST_TOKEN");
  },
};

// Every tuned constant in one place (DESIGN §i).
export const CONFIG = {
  CHUNK_TARGET_TOKENS: 500,
  CHUNK_MAX_TOKENS: 800,
  CHUNK_OVERLAP_TOKENS: 80,
  TOP_K_FETCH: 6,
  TOP_K_USE: 4,
  SCORE_THRESHOLD: 0.35,
  EMBED_MODEL: "text-embedding-3-small",
  EMBED_DIM: 1536,
  GEN_MODEL: "gpt-4o",
  JUDGE_MODEL: "gpt-4o-mini",
  TEMPERATURE: 0,
  EMBED_BATCH_SIZE: 96,
} as const;

export const REFUSAL =
  "I don't have information about that in the available documents.";
