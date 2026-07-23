import OpenAI from "openai";
import { CONFIG, ENV } from "./config";
import type { Scored } from "./types";

// Lazy init — see embed.ts.
let _openai: OpenAI | null = null;
const openai = () => (_openai ??= new OpenAI({ apiKey: ENV.OPENAI_API_KEY }));

// Exact system prompt from DESIGN §d.
const SYSTEM_PROMPT = `You are a support assistant for an edtech company. Answer the user's
question using ONLY the numbered context passages provided below.

Rules:
1. Every factual claim must be supported by the context. Cite the
   passage number inline, like [1] or [2][3].
2. If the context does not contain the answer, reply exactly:
   "I don't have information about that in the available documents."
   Do not guess, infer, or use outside knowledge.
3. If context is partially relevant, answer only the part you can
   support and explicitly state what you could not find.
4. Do not mention "context" or "passages" — write as if you know the
   policy. Citations are the only meta-reference.
5. Be concise. Prefer the document's own terminology (exact figures,
   deadlines, policy names) over paraphrase.
6. Applying a rule stated in the context to the user's specific situation is
   NOT outside knowledge. If the context gives a threshold or deadline (e.g.
   "no refund after 15 days") and the user asks about a specific value (e.g.
   "day 20"), apply the rule and answer, citing the passage.`;

export type GenerateResult = {
  answer: string;
  citedSources: string[]; // e.g. ["refund_policy.txt#3"]
  promptTokens: number;
  completionTokens: number;
  timing: { generate: number };
};

// query + chunks → answer. Assumes chunks.length >= 1 (caller short-circuits the
// no-context case, so the LLM is never called on empty context). (DESIGN §d)
export async function generate(q: string, chunks: Scored[]): Promise<GenerateResult> {
  const context = chunks
    .map(
      (c, i) => `[${i + 1}] (source: ${c.source}, section: ${c.section})\n${c.text}`,
    )
    .join("\n\n");

  const t0 = performance.now();
  const res = await openai().chat.completions.create({
    model: CONFIG.GEN_MODEL,
    temperature: CONFIG.TEMPERATURE,
    messages: [
      { role: "system", content: `${SYSTEM_PROMPT}\n\nContext:\n${context}` },
      { role: "user", content: q },
    ],
  });
  const generateMs = Math.round(performance.now() - t0);

  const answer = res.choices[0]?.message?.content?.trim() ?? "";
  return {
    answer,
    citedSources: extractCitations(answer, chunks),
    promptTokens: res.usage?.prompt_tokens ?? 0,
    completionTokens: res.usage?.completion_tokens ?? 0,
    timing: { generate: generateMs },
  };
}

// Map inline [n] markers back to the chunks they reference. cited_sources vs
// retrieved chunks reveals a model that declined despite having context. (DESIGN §e)
function extractCitations(answer: string, chunks: Scored[]): string[] {
  const nums = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) nums.add(Number(m[1]));
  const cited: string[] = [];
  for (const n of nums) {
    const c = chunks[n - 1];
    if (c) cited.push(`${c.source}#${c.chunkIndex}`);
  }
  return cited;
}
