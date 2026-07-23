import OpenAI from "openai";
import { CONFIG, ENV } from "./config";

const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

// string[] → number[][]. Batching + retry in ONE place, shared by ingest and
// query, so the SAME embedding model is guaranteed on both paths. (DESIGN §c/§i)
export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += CONFIG.EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + CONFIG.EMBED_BATCH_SIZE);
    const res = await withRetry(() =>
      openai.embeddings.create({ model: CONFIG.EMBED_MODEL, input: batch }),
    );
    // API preserves input order.
    for (const d of res.data) out.push(d.embedding);
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      // Retry only transient failures; fail fast on 4xx (bad key, bad request).
      if (status && status < 500 && status !== 429) throw err;
      await sleep(500 * 2 ** a);
    }
  }
  throw lastErr;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
