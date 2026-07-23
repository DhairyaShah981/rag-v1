import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { CONFIG, ENV, REFUSAL } from "../src/lib/config";
import { generate } from "../src/lib/generate";
import { retrieve } from "../src/lib/retrieve";
import type { Scored } from "../src/lib/types";

type Case = {
  id: string;
  query: string;
  expected_answer: string;
  expected_source: string | null;
  type: string;
};

// Gate thresholds (DESIGN §f).
const PASS_FAITHFULNESS = 0.8;
const PASS_CORRECTNESS = 0.7;

const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

type Row = {
  id: string;
  type: string;
  retrieved: boolean | null; // Tier 1: expected_source in fetched top-k
  faithfulness: number | null; // Tier 2
  correctness: number | null; // Tier 2
  refused: boolean;
  refusalCorrect: boolean | null; // Tier 3 (out_of_corpus only)
};

async function main() {
  const raw = JSON.parse(readFileSync("eval/test_cases.json", "utf8"));
  const cases: Case[] = Array.isArray(raw) ? raw : raw.cases;
  const rows: Row[] = [];

  for (const c of cases) {
    const r = await retrieve(c.query);
    const retrievedSources = new Set(r.scored.map((s) => s.source));

    // Tier 1 — deterministic retrieval recall@k.
    const retrieved =
      c.expected_source == null ? null : retrievedSources.has(c.expected_source);

    let answer = REFUSAL;
    let faithfulness: number | null = null;
    let correctness: number | null = null;

    if (r.used.length > 0) {
      const g = await generate(c.query, r.used);
      answer = g.answer;
    }

    // A refusal is either the no-context short-circuit OR the LLM emitting the
    // fixed refusal via the closed-book instruction — both count. (DESIGN §d)
    const refused = r.used.length === 0 || answer.trim() === REFUSAL;

    // Tier 3 — refusal accuracy for out-of-corpus (scored separately).
    const refusalCorrect =
      c.type === "out_of_corpus" ? refused : null;

    // Tier 2 — judge (gpt-4o-mini) only on in-corpus cases with a real answer.
    if (c.type !== "out_of_corpus") {
      if (refused) {
        // False refusal on an in-corpus question: wrong, but not unfaithful.
        faithfulness = 1;
        correctness = 0;
      } else {
        const j = await judge(c, answer, r.used);
        faithfulness = j.faithfulness;
        correctness = j.correctness;
      }
    }

    rows.push({
      id: c.id,
      type: c.type,
      retrieved,
      faithfulness,
      correctness,
      refused,
      refusalCorrect,
    });
    process.stdout.write(
      `  ${pad(c.id, 22)} ${pad(c.type, 18)} ret=${fmt(retrieved)} faith=${fmtNum(faithfulness)} corr=${fmtNum(correctness)} refused=${refused}\n`,
    );
  }

  report(rows);
}

async function judge(c: Case, answer: string, context: Scored[]) {
  const ctx = context.map((s, i) => `[${i + 1}] ${s.text}`).join("\n\n");
  const prompt = `You grade a support-bot answer. Score strictly.

QUESTION:
${c.query}

REFERENCE ANSWER (ground truth, may be a description of the correct answer):
${c.expected_answer}

RETRIEVED CONTEXT (the only info the bot was given):
${ctx}

BOT ANSWER:
${answer}

Return JSON with:
- "faithfulness": 0..1 — 1 if every claim in BOT ANSWER is supported by RETRIEVED CONTEXT with no contradiction or outside info; lower if it hallucinates.
- "correctness": 0..1 — how well BOT ANSWER matches the REFERENCE ANSWER in meaning (ignore phrasing; partial credit allowed).
- "note": one short sentence.`;

  const res = await openai.chat.completions.create({
    model: CONFIG.JUDGE_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  return {
    faithfulness: clamp(parsed.faithfulness),
    correctness: clamp(parsed.correctness),
  };
}

function report(rows: Row[]) {
  const graded = rows.filter((r) => r.faithfulness != null);
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  const faith = avg(graded.map((r) => r.faithfulness!));
  const corr = avg(graded.map((r) => r.correctness!));

  const tier1 = rows.filter((r) => r.retrieved != null);
  const recall = avg(tier1.map((r) => (r.retrieved ? 1 : 0)));

  const refusalCases = rows.filter((r) => r.refusalCorrect != null);
  const refusalAcc = avg(refusalCases.map((r) => (r.refusalCorrect ? 1 : 0)));
  const falseRefusals = rows.filter(
    (r) => r.type !== "out_of_corpus" && r.refused,
  ).length;

  console.log("\n=== Aggregates ===");
  console.log(`Tier 1  retrieval recall@${CONFIG.TOP_K_FETCH}: ${pct(recall)} (${tier1.length} cases)`);
  console.log(`Tier 2  faithfulness:             ${pct(faith)}  (gate ≥ ${PASS_FAITHFULNESS})`);
  console.log(`Tier 2  correctness:              ${pct(corr)}  (gate ≥ ${PASS_CORRECTNESS})`);
  console.log(`Tier 3  refusal accuracy:         ${pct(refusalAcc)} (${refusalCases.length} out-of-corpus, reported separately)`);
  console.log(`        false refusals (in-corpus): ${falseRefusals}`);

  const pass = faith >= PASS_FAITHFULNESS && corr >= PASS_CORRECTNESS;
  console.log(`\nGATE: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  if (!pass) {
    console.log(
      "Decomposition hint: low recall → retrieval bug; high recall + low correctness → generation bug.",
    );
    process.exit(1);
  }
}

const clamp = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
const pad = (s: string, n: number) => s.padEnd(n);
const fmt = (b: boolean | null) => (b == null ? " -  " : b ? "yes " : "NO  ");
const fmtNum = (n: number | null) => (n == null ? " -  " : n.toFixed(2));
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

main().catch((err) => {
  console.error("eval failed:", err);
  process.exit(1);
});
