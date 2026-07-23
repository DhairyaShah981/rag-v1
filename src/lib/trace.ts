// One JSON line per query to stdout, captured by Vercel logs. One schema, one
// writer. (DESIGN §e) Durable via log drains; Vercel's FS is ephemeral so no file.

export type Trace = {
  trace_id: string;
  ts: string;
  query: string;
  retrieval: {
    chunks: {
      id: string;
      source: string;
      score: number;
      used_in_prompt: boolean;
    }[];
    max_score: number;
    chunks_above_threshold: number;
  };
  prompt_tokens: number;
  completion_tokens: number;
  answer: string;
  cited_sources: string[];
  no_context: boolean;
  latency_ms: { embed: number; retrieve: number; generate: number; total: number };
  model: { embed: string; generate: string };
  error: string | null;
};

export function writeTrace(trace: Trace): void {
  process.stdout.write(JSON.stringify(trace) + "\n");
}
