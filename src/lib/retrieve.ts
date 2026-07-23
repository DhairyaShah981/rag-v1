import { CONFIG } from "./config.js";
import { embedOne } from "./embed.js";
import type { Scored } from "./types.js";
import { query } from "./vectorstore.js";

export type RetrieveResult = {
  scored: Scored[]; // ALL fetched, sorted desc by score (rejected included for tracing)
  used: Scored[]; // subset with usedInPrompt = true
  maxScore: number;
  aboveThreshold: number;
  timings: { embed: number; retrieve: number };
};

// query string → Scored[]. Over-fetch TOP_K_FETCH, keep those clearing the
// threshold, use the top TOP_K_USE of them. k and threshold live here. (DESIGN §c)
export async function retrieve(q: string): Promise<RetrieveResult> {
  const t0 = performance.now();
  const vec = await embedOne(q);
  const t1 = performance.now();
  const hits = await query(vec, CONFIG.TOP_K_FETCH);
  const t2 = performance.now();

  // Upstash returns hits sorted by score desc.
  const passing = hits.filter((h) => h.score >= CONFIG.SCORE_THRESHOLD);
  const usedIds = new Set(passing.slice(0, CONFIG.TOP_K_USE).map((h) => h.chunk.id));

  const scored: Scored[] = hits.map((h) => ({
    ...h.chunk,
    score: h.score,
    usedInPrompt: usedIds.has(h.chunk.id),
  }));

  return {
    scored,
    used: scored.filter((s) => s.usedInPrompt),
    maxScore: hits.length ? hits[0].score : 0,
    aboveThreshold: passing.length,
    timings: { embed: Math.round(t1 - t0), retrieve: Math.round(t2 - t1) },
  };
}
