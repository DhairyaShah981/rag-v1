import { randomUUID } from "node:crypto";
import { CONFIG, REFUSAL } from "./config";
import { generate } from "./generate";
import { retrieve } from "./retrieve";
import { writeTrace } from "./trace";
import type { Scored } from "./types";

export type Source = {
  id: string;
  source: string;
  section: string;
  score: number;
  text: string;
};

export type AskResponse = {
  trace_id: string;
  answer: string;
  sources: Source[]; // chunks used in the prompt, returned so users verify
  no_context: boolean;
  cited_sources: string[];
  error: string | null;
};

// Full RAG pipeline + trace. Shared by /api/ask and the eval harness so they
// exercise identical behaviour. If zero chunks clear the threshold, the LLM is
// never called — fixed refusal, sources: [], no_context: true. (DESIGN §d)
export async function ask(q: string): Promise<AskResponse> {
  const trace_id = randomUUID();
  const ts = new Date().toISOString();
  const start = performance.now();

  try {
    const r = await retrieve(q);

    if (r.used.length === 0) {
      const total = Math.round(performance.now() - start);
      writeTrace({
        trace_id,
        ts,
        query: q,
        retrieval: traceRetrieval(r.scored, r.maxScore, r.aboveThreshold),
        prompt_tokens: 0,
        completion_tokens: 0,
        answer: REFUSAL,
        cited_sources: [],
        no_context: true,
        latency_ms: { ...r.timings, generate: 0, total },
        model: { embed: CONFIG.EMBED_MODEL, generate: CONFIG.GEN_MODEL },
        error: null,
      });
      return {
        trace_id,
        answer: REFUSAL,
        sources: [],
        no_context: true,
        cited_sources: [],
        error: null,
      };
    }

    const g = await generate(q, r.used);
    const total = Math.round(performance.now() - start);

    writeTrace({
      trace_id,
      ts,
      query: q,
      retrieval: traceRetrieval(r.scored, r.maxScore, r.aboveThreshold),
      prompt_tokens: g.promptTokens,
      completion_tokens: g.completionTokens,
      answer: g.answer,
      cited_sources: g.citedSources,
      no_context: false,
      latency_ms: { ...r.timings, generate: g.timing.generate, total },
      model: { embed: CONFIG.EMBED_MODEL, generate: CONFIG.GEN_MODEL },
      error: null,
    });

    return {
      trace_id,
      answer: g.answer,
      sources: r.used.map(toSource),
      no_context: false,
      cited_sources: g.citedSources,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const total = Math.round(performance.now() - start);
    writeTrace({
      trace_id,
      ts,
      query: q,
      retrieval: { chunks: [], max_score: 0, chunks_above_threshold: 0 },
      prompt_tokens: 0,
      completion_tokens: 0,
      answer: "",
      cited_sources: [],
      no_context: false,
      latency_ms: { embed: 0, retrieve: 0, generate: 0, total },
      model: { embed: CONFIG.EMBED_MODEL, generate: CONFIG.GEN_MODEL },
      error: msg,
    });
    throw err;
  }
}

function traceRetrieval(scored: Scored[], maxScore: number, aboveThreshold: number) {
  return {
    chunks: scored.map((c) => ({
      id: `${c.source}#${c.chunkIndex}`,
      source: c.source,
      score: Number(c.score.toFixed(4)),
      used_in_prompt: c.usedInPrompt,
    })),
    max_score: Number(maxScore.toFixed(4)),
    chunks_above_threshold: aboveThreshold,
  };
}

function toSource(c: Scored): Source {
  return {
    id: `${c.source}#${c.chunkIndex}`,
    source: c.source,
    section: c.section,
    score: Number(c.score.toFixed(4)),
    text: c.text,
  };
}
