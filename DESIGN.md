# DESIGN.md — RAG Q&A over Scaler Support Corpus

**Stack:** Next.js (App Router) on Vercel · OpenAI `text-embedding-3-small` + `gpt-4o` · Upstash Vector · JSON traces to stdout

---

## a. System Architecture

```
                    ┌─────────────────────────────┐   ┌──────────────┐
   corpus/  ──────► │  Ingestion (local script)   │◄──┤   manifest   │
   (PDF/txt/JSON)   │  hash → diff → chunk → embed│──►│ hash → ids   │
                    └──────────────┬──────────────┘   └──────────────┘
                                   │ upsert + delete orphans
                                   ▼
                          ┌──────────────────┐
                          │  Upstash Vector  │
                          │  (cosine, 1536d) │
                          └────────▲─────────┘
                                   │ query top-k
  Browser UI ──POST /api/ask──► ┌──┴───────────────────────────┐
                                │  Ask route (Vercel function) │
                                │  embed → retrieve → filter   │
                                │  → prompt → generate         │
                                └──┬───────────────────────┬───┘
                                   │                       │
                              OpenAI API            JSON trace → stdout
```

**Flow:** (1) Ingest locally — hash files against a manifest, skip unchanged, chunk changed ones, batch-embed, upsert, delete orphans. (2) Query — embed question with the *same* model → top-6 cosine → threshold filter → top-4 into a numbered context block → `gpt-4o` answers with `[n]` citations. (3) Trace — one JSON line per query to stdout.

### Key decisions

| Decision | Why | Trade-off |
|---|---|---|
| **Ingestion runs locally, not on Vercel** | Upstash is a hosted HTTP service, so laptop and deployment write/read the *same* index — no redeploy after re-ingest. An `/api/ingest` route would need the corpus in the deploy bundle, hit the 10s/60s function timeout on PDF parsing + embedding, and expose a destructive public endpoint. | Corpus updates need a CLI run. Production shape is a document-store webhook triggering a background job — same pipeline, different trigger. |
| **Upstash Vector** | HTTP-only client suits stateless serverless functions (no connection pooling). Metadata stored with vectors → retrieval is one round-trip, no join back to a doc store. | Less control than pgvector (no hybrid SQL filtering, no BM25). Isolated behind a `vectorstore.ts` interface — swapping is ~30 lines. |
| **No RAG framework** | Per the constraint, and the pipeline is ~150 lines. A framework would hide the exact retrieval and prompt behaviour this doc has to defend. | Hand-writing batching and retries. |
| **Traces to stdout, not SQLite** | Vercel's filesystem is ephemeral per-invocation — SQLite would silently lose data. Structured stdout is durable via log drains. | No SQL over traces without a drain. The trace *schema* is the deliverable and it's drain-ready. |

---

## b. Chunking Strategy

**Structure-aware, dispatched by file type** — not one blind splitter across six heterogeneous files.

| Type | Unit | Why |
|---|---|---|
| Plain text (FAQ, refund, eligibility) | One chunk per Q&A pair / numbered clause | An FAQ answer *is* the ideal retrieval unit. Splitting mid-answer retrieves well but answers badly. |
| PDFs | Text per page, then recursive split `\n\n` → `\n` → sentence | No reliable semantic markers post-extraction. Page kept as `section` metadata so citations are human-verifiable. |
| Pricing JSON | One chunk per program record, flattened to `Program: X. Fee: Y.` | Embedding raw JSON pollutes the vector with syntax. **Never split a record** — a fee severed from its program name is a hallucination source. |

**~500 target / 800 cap / 80 overlap (15%).** 500 because these docs are dense and factual — a policy clause is 2–5 sentences. Larger dilutes the embedding across topics; smaller severs the subject from its condition ("…within 15 days" without "refund request must be filed"). 15% overlap guards boundary-splits without inflating the index with near-duplicates that would crowd top-k. **Semantic units are never force-split** even under the cap — uniform size isn't the goal, retrievability is.

*Known gap:* PDF tables flatten to unusable linear text. See (f2).

---

## b2. Re-Ingestion, Duplicates, Changed Content

Naive re-ingest fails two ways: duplicate vectors, or **orphans** — chunks whose source content is gone but which still get retrieved and cited. Orphans are worse: stale policy, confidently sourced.

**Deterministic IDs** — `sha256(source + chunk_index + chunk_text)[:16]`, not UUIDs. Upsert becomes idempotent, so re-uploading an identical PDF rewrites identical vectors in place. Cost of a duplicate upload is one embedding batch, not a corrupted index.

**File-hash short-circuit** — a manifest maps `source → file_hash → [chunk_ids]`. Matching hash skips the file entirely: no parse, no embed, no cost. This is what makes re-ingest cheap enough to run routinely.

**Diff and reconcile** for changed files:

```
to_upsert = new_ids - old_ids     # new or modified
to_delete = old_ids - new_ids     # orphans
unchanged = old_ids & new_ids     # skip, no embed cost
```

**Order: upsert → delete → write manifest.** If delete succeeded and upsert failed, the index has a gap; the reverse leaves a brief duplicate — the cheaper failure. Manifest written last, so a crash leaves it describing the *old* state and the next run retries. Since IDs depend on `chunk_text`, a one-line edit to a 40-chunk PDF re-embeds 1–2 chunks.

This also makes ingest **safe to run against the live index** — upserts are atomic per vector, so a concurrent query sees a consistent mix of old and new, never a corrupted chunk.

*Caveat:* `chunk_index` is in the hash, so inserting a paragraph near the top cascades and invalidates every downstream chunk. Dropping it avoids the cascade but loses the ability to distinguish two identical chunks in one file. I keep it — a full re-embed here costs cents.

---

## c. Retrieval Design

**Embedding — `text-embedding-3-small` (1536d).** Strong quality per dollar on short factual English, which is this corpus exactly; ~5× cheaper than `-large`. Same vendor as generation, one auth path. **Same model at ingest and query** — mismatched embedding spaces produce silently wrong retrieval, not errors.

**Store — Upstash Vector.** Rationale in (a). Rejected: in-memory (rebuilt per cold start), pgvector (connection management from serverless), Pinecone (heavier setup for a 2.5h build).

**Metric — cosine.** OpenAI embeddings are L2-normalized so cosine and dot rank identically, but cosine is bounded `[-1,1]`. That bound is what makes a **fixed threshold portable** across queries; with unbounded dot product no such constant is meaningful.

### How k and the threshold were derived

Both are **empirical constants fit to the eval set**, not principled values. Anyone claiming a first-principles cosine threshold is guessing.

**k — measure recall@k, find the elbow.** Run every eval query at k=20, log where the expected chunk ranks, plot recall@k. It rises steeply then flattens. Here recall@4 ≈ recall@10, so six extra chunks buy ~nothing and dilute context on *every* query. **Settled: fetch 6, use top 4 after filtering.** Over-fetch-then-filter lets a strong single match win alone while a diffuse question still gets breadth; fixed k forces weak chunks in regardless. Higher k also triggers **"lost in the middle"** — mid-context content is attended to less, so a large k can bury the answer.

**Threshold — find the valley between two distributions.** From the same run: relevant chunks scored ~0.5–0.8, irrelevant ~0.15–0.35. **0.35 sits in the gap** — a valley in a bimodal distribution, re-derived whenever corpus or embedding model changes.

**The trade-off is asymmetric and I bias deliberately.** Too high → false refusals, looks useless. Too low → weak context reaches the model, the primary driver of confident wrong answers. For a bot answering questions about money and eligibility, a refusal is recoverable (escalate to human); a wrong refund policy is not. **So I err high.**

*Limitation:* cosine scores aren't calibrated across query types — short keyword vs long conversational queries produce different distributions, so one global threshold is a compromise. Fixes: a *relative* threshold (within 0.15 of top score), or a reranker — cross-encoder scores are far better calibrated, which is why reranking is (g)'s top item.

---

## d. Answer Generation

### System prompt

```
You are a support assistant for an edtech company. Answer the user's
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

Context:
[1] (source: refund_policy.txt, section: Clause 3)
<chunk text>
...
```

### Grounding — four layers, because prompt instructions alone aren't a guarantee

1. **Retrieval gate** — the threshold means the model often never sees weak context to be tempted by.
2. **Closed-book instruction** — explicit prohibition on outside knowledge.
3. **Mandatory `[n]` citations** — an uncited claim becomes structurally visible to a reviewer *and* to the eval judge.
4. **`temperature = 0`** — deterministic, reproducible, comparable across eval runs.

Retrieved chunks are returned to the client so users verify rather than trust.

### No relevant context

If zero chunks clear the threshold, **the LLM is never called.** Return the fixed refusal, `sources: []`, `no_context: true`. Short-circuiting is faster, cheaper, deterministic, and eliminates the case where a model "helpfully" answers from parametric memory. `no_context` rate is then a first-class production signal.

---

## e. Instrumentation

One JSON line per query to stdout, captured by Vercel logs.

```json
{
  "trace_id": "uuid",
  "ts": "2026-07-23T10:14:22.118Z",
  "query": "What is the refund policy after 15 days?",
  "retrieval": {
    "chunks": [
      {"id": "refund_policy.txt#3", "source": "refund_policy.txt",
       "score": 0.71, "used_in_prompt": true},
      {"id": "faq.txt#12", "score": 0.33, "used_in_prompt": false}
    ],
    "max_score": 0.71, "chunks_above_threshold": 3
  },
  "prompt_tokens": 1420, "completion_tokens": 96,
  "answer": "...", "cited_sources": ["refund_policy.txt#3"],
  "no_context": false,
  "latency_ms": {"embed": 118, "retrieve": 43, "generate": 1310, "total": 1489},
  "model": {"embed": "text-embedding-3-small", "generate": "gpt-4o"},
  "error": null
}
```

**Why these fields:** per-stage latency separates "OpenAI is slow" from "the vector store is slow" — one aggregate number can't. **Scores for rejected chunks** are the most diagnostic field, showing what *nearly* matched. `used_in_prompt` separates "retrieval failed" from "filter cut it." `cited_sources` vs retrieved chunks reveals a model that declined *despite* having context — a prompt problem, not retrieval.

### Debugging a retrieval failure

Given "the bot didn't know about placement eligibility," pull the trace:

- **`max_score` < threshold** → content absent, or phrased too differently for the embedding. Verify by embedding the expected passage and re-querying.
- **`max_score` high but wrong doc retrieved** → chunking problem: answer and subject split across vectors, or a near-duplicate crowded top-k.
- **Right chunk, `used_in_prompt: true`, still declined** → generation problem: prompt too conservative, or chunk text garbled from PDF extraction.
- **`error` non-null** → upstream API failure, not a RAG failure.

Each branch points at a different component. That's the purpose of logging stages separately rather than logging only the answer.

---

## f. Evaluation

**Test suite** — `eval/test_cases.json`, 10 cases: direct lookups (refund window, program fee, eligibility cutoff); one spanning two documents (multi-hop); one PDF-only (tests extraction); one pricing-JSON-only (tests structured chunking); **one out-of-corpus** ("Do you offer visa sponsorship?") expecting the refusal; one ambiguous. Each: `{id, query, expected_answer, expected_source, type}`.

### Metrics — decomposed by stage

A single accuracy number is useless because it doesn't tell you *what to fix*. LLM-judged metrics use `gpt-4o-mini` — a different tier from the generator, since a model grading itself invites self-consistency bias.

- **Tier 1, Retrieval:** context precision / recall@k (deterministic) — did `expected_source` get retrieved? **This is the ceiling on everything downstream.** At 0.6, no prompt engineering gets past 60%.
- **Tier 2, Generation:** *faithfulness* (does the answer contradict retrieved context — the hallucination metric, primary for a support bot) and *answer correctness* (semantic match, so paraphrase isn't punished).
- **Tier 3, Behavioral:** refusal accuracy on out-of-corpus queries, reported separately, **never averaged in**. A system scoring 0.9 that never refuses is more dangerous than 0.75 that refuses correctly — its failures are silent.
- **Tier 4, Production:** `no_context` rate (best leading indicator, free from traces), thumbs-down joined on `trace_id`, escalation-to-human rate (the actual business metric), p95 latency and cost/query.

**The decomposition is the point:** high recall + low correctness → generation bug. Low recall → retrieval bug.

Pass: faithfulness ≥ 0.8 **and** correctness ≥ 0.7. Per-case table, aggregates, non-zero exit on regression so it can gate a deploy.

### Limits — stated honestly

- **10 cases isn't statistically meaningful.** One flip moves the aggregate 10%.
- **I authored both questions and expected answers** — it tests what I anticipated. Real users ask malformed, multi-part questions I didn't imagine.
- **The threshold was fit on the same set it's evaluated on** — train-on-test. With 10 cases there's no meaningful holdout. So the eval measures *whether the pipeline works end-to-end*, not whether the threshold generalizes.
- **The judge is itself an LLM** — lenient on partially-correct answers, inconsistent at the margins. Track as a trend, not ground truth per case.
- No latency/cost budget in eval; no adversarial testing.

**In one line:** offline eval is a regression gate ("did I break something"), not a quality measure ("is this good"). Production traces answer the second, and the eval set should grow by harvesting real failed queries from them.

---

## f2. Decisions I Can't Fully Defend Yet

Named deliberately — better than having them found.

- **Chunk size 500 is reasoned, not measured.** Derived from observed clause density, not A/B'd against 300 or 800 with recall@k as the outcome. That experiment is cheap and is the first thing I'd run. 15% overlap is likewise convention.
- **0.35 is fit to 10 queries.** Right *method*; sample size makes the specific number soft.
- **`gpt-4o` may be overkill.** The task is extractive summarization over supplied context — `gpt-4o-mini` may handle it at a fraction of cost and latency. I chose 4o to de-risk citation-format instruction-following under time pressure. Correct resolution is running the eval against both; I have the harness, I haven't run it.
- **Multi-hop is structurally unsupported.** Single-shot retrieval: one embedding, one query. A question needing facts from two documents only works if both land in the top-4 for one query vector. No decomposition or iterative retrieval. The eval includes such a case to expose this rather than hide it.
- **No conversational memory.** "What about for the DSA track?" has no referent. Needs query rewriting against history.
- **PDF table extraction is known-broken**, and those tables are exactly what users ask about — most likely source of a live demo failure.
- **No auth or rate limiting on `/api/ask`.** A public endpoint calling `gpt-4o` is a wallet-drain vector. Cheapest fix is IP rate limiting via Upstash Ratelimit (same vendor, ~5 lines) — a deliberate scope call, not an oversight.
- **Prompt injection untested.** Corpus is trusted here; user uploads would flow straight into the context block.

---

## g. With More Time

1. **Hybrid retrieval (BM25 + dense) with reranking.** Dense embeddings miss exact-match queries — program codes, rupee amounts, clause numbers. A keyword arm catches those; a cross-encoder rerank over merged top-20 → top-4 raises precision and fixes the threshold-calibration problem in (c). Highest-value change.
2. **Persistent traces + feedback loop.** Route stdout to Axiom/Postgres, add thumbs up/down joined on `trace_id`. Turns the eval set from something I invented into something users generate, and makes `no_context` rate, p95 latency, and cost/query real dashboards.
3. **Layout-aware PDF parsing.** Convert tables to markdown before chunking so structure survives into the embedding.

*Queued:* embedding cache, streaming responses, webhook-triggered re-ingest.

---

## h. Operating the Pipeline

### Environment

Laptop and Vercel point at the **same** Upstash index — that's what makes local ingestion work against a hosted app.

`.env.local` (git-ignored) and Vercel → Settings → Environment Variables, **identical values**:

```
OPENAI_API_KEY=sk-...
UPSTASH_VECTOR_REST_URL=https://xxx-vector.upstash.io
UPSTASH_VECTOR_REST_TOKEN=...
```

A mismatched URL means the app queries an empty index and every answer is a refusal.

### Commands

```bash
npm install
npm run ingest        # build/refresh index (local)
npm run ingest:force  # ignore manifest, re-embed all
npm run dev           # local app at :3000
npm run eval          # eval suite against current index
```

`--force` is for when chunking strategy or embedding model changed — content hashes are unchanged but the vectors are stale.

### Deploy order

```bash
npm run ingest   # 1. index must exist before the app serves queries
npm run eval     # 2. verify retrieval
vercel --prod    # 3. deploy
```

Ingest first: a deployed app against an empty index refuses every query and looks broken.

---

## i. Implementation Plan

### Layout

```
scaler-rag/
├── DESIGN.md, README.md, package.json, tsconfig.json
├── .env.local                 # git-ignored
├── .ingest_manifest.json      # committed — hash → chunk_ids
├── corpus/                    # 2 PDF, 3 txt, 1 json
├── scripts/ingest.ts          # CLI: hash → diff → chunk → embed → upsert
├── src/
│   ├── lib/
│   │   ├── config.ts          # env validation + tunables
│   │   ├── parse.ts           # per-filetype → RawDoc[]
│   │   ├── chunk.ts           # RawDoc[] → Chunk[], deterministic IDs
│   │   ├── embed.ts           # OpenAI embeddings, batched + retry
│   │   ├── vectorstore.ts     # Upstash behind an interface
│   │   ├── retrieve.ts        # embed → topK → threshold filter
│   │   ├── generate.ts        # prompt assembly → gpt-4o
│   │   └── trace.ts           # structured JSON → stdout
│   └── app/
│       ├── page.tsx           # minimal UI
│       └── api/ask/route.ts   # orchestration only, no RAG logic
└── eval/test_cases.json, run_eval.ts
```

### Module contracts

```ts
type RawDoc = { source: string; section: string; text: string };
type Chunk  = { id: string; text: string; source: string;
                section: string; chunkIndex: number };
type Scored = Chunk & { score: number; usedInPrompt: boolean };
```

| Module | Contract | Why separate |
|---|---|---|
| `parse.ts` | `path → RawDoc[]` | Isolates PDF extraction quirks; swapping libraries touches one file. |
| `chunk.ts` | `RawDoc[] → Chunk[]` | Most likely thing to change after eval. Deterministic IDs computed here. |
| `embed.ts` | `string[] → number[][]` | Batching/retry in one place; shared by ingest and query so the **same model** is guaranteed on both paths. |
| `vectorstore.ts` | `upsert / query / delete` | Only file that knows about Upstash. |
| `retrieve.ts` | `query → Scored[]` | Where k and threshold live. Testable without an LLM. |
| `generate.ts` | `query + chunks → answer` | Isolated from retrieval so eval can attribute failures. |
| `trace.ts` | `trace → stdout` | One schema, one writer. |

### `config.ts` — every tuned constant in one place

```ts
export const CONFIG = {
  CHUNK_TARGET_TOKENS: 500, CHUNK_MAX_TOKENS: 800, CHUNK_OVERLAP_TOKENS: 80,
  TOP_K_FETCH: 6, TOP_K_USE: 4, SCORE_THRESHOLD: 0.35,
  EMBED_MODEL: "text-embedding-3-small",
  GEN_MODEL: "gpt-4o", JUDGE_MODEL: "gpt-4o-mini",
  TEMPERATURE: 0,
} as const;
```

Validate required env vars here and throw at import — a missing token should fail loudly on boot, not silently return zero results on the first query.

### Build order

1. `config.ts` + `vectorstore.ts` — verify Upstash connectivity with a dummy vector first.
2. `parse.ts` → `chunk.ts` — run standalone, print chunk count and boundaries, **eyeball them before embedding anything**.
3. `embed.ts` + `scripts/ingest.ts` — full ingest, confirm vector count matches chunk count.
4. `retrieve.ts` — query the index directly from a script, sanity-check scores before writing any prompt code.
5. `generate.ts` + `trace.ts` → `api/ask/route.ts`.
6. `page.tsx` — input, answer, expandable source chunks with scores.
7. `eval/` — test cases, then judge.

Steps 2 and 4 are checkpoints: bad chunks or bad retrieval invalidate everything downstream, and both are visible without an LLM.

### Dependencies

`next, react, react-dom, openai, @upstash/vector, pdf-parse, tsx, typescript, @types/node`

Deliberately thin — no LangChain/LlamaIndex, per the constraint and because a framework would obscure the retrieval and prompt behaviour this document has to defend.