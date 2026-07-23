# Scaler Support RAG

RAG Q&A over the Scaler support corpus. Next.js (App Router) on Vercel · OpenAI
`text-embedding-3-small` + `gpt-4o` · Upstash Vector · JSON traces to stdout.

Full design rationale: [DESIGN.md](./DESIGN.md).

## Setup

1. `npm install`
2. Copy `.env.local.example` → `.env.local` and fill in (same values used on Vercel):
   ```
   OPENAI_API_KEY=sk-...
   UPSTASH_VECTOR_REST_URL=https://xxx-vector.upstash.io   # index: 1536-dim, cosine
   UPSTASH_VECTOR_REST_TOKEN=...
   ```
3. Put the corpus files in `corpus/` (txt / pdf / json).

## Commands

```bash
npm run ingest -- --dry   # parse+chunk only, eyeball chunk boundaries (no embed)
npm run ingest            # build/refresh index (local)
npm run ingest:force      # ignore manifest, re-embed all
npm run dev               # local app at :3000
npm run eval              # tiered eval against current index
```

`--force` is for when chunking or the embedding model changed — content hashes
are unchanged but the stored vectors are stale.

## Deploy order

```bash
npm run ingest    # 1. index must exist before the app serves queries
npm run eval      # 2. verify retrieval + generation gate
vercel --prod     # 3. deploy
```

Laptop and Vercel point at the **same** Upstash index — that's what makes local
ingestion work against the hosted app. A mismatched URL means the app queries an
empty index and every answer is a refusal.

## Layout

```
scripts/ingest.ts     CLI: hash → diff → chunk → embed → upsert → delete → manifest
src/lib/              config · parse · chunk · embed · vectorstore · retrieve · generate · trace · ask
src/app/api/ask       POST { query } → { answer, sources, no_context, cited_sources }
src/app/page.tsx      minimal UI: answer + citations + expandable sources with scores
eval/                 test_cases.json (10) + run_eval.ts (tiered metrics, judge, gate)
.ingest_manifest.json committed — source → file_hash → chunk_ids
```
