import { Index } from "@upstash/vector";
import { ENV } from "./config";
import type { Chunk } from "./types";

// The ONLY file that knows about Upstash. Swapping stores touches ~this file.
// (DESIGN §a/§i)

type StoredMeta = {
  text: string;
  source: string;
  section: string;
  chunkIndex: number;
};

export type QueryHit = { chunk: Chunk; score: number };

const index = new Index({
  url: ENV.UPSTASH_VECTOR_REST_URL,
  token: ENV.UPSTASH_VECTOR_REST_TOKEN,
});

// Metadata stored WITH the vector → retrieval is one round-trip, no doc-store join.
export async function upsert(chunks: Chunk[], vectors: number[][]): Promise<void> {
  const payload = chunks.map((c, i) => ({
    id: c.id,
    vector: vectors[i],
    metadata: {
      text: c.text,
      source: c.source,
      section: c.section,
      chunkIndex: c.chunkIndex,
    } satisfies StoredMeta,
  }));
  // Upserts are atomic per vector; batch to keep requests reasonable.
  for (let i = 0; i < payload.length; i += 100) {
    await index.upsert(payload.slice(i, i + 100));
  }
}

export async function query(vector: number[], topK: number): Promise<QueryHit[]> {
  const res = await index.query({ vector, topK, includeMetadata: true });
  return res.map((r) => {
    const m = r.metadata as StoredMeta;
    return {
      score: r.score,
      chunk: {
        id: String(r.id),
        text: m.text,
        source: m.source,
        section: m.section,
        chunkIndex: m.chunkIndex,
      },
    };
  });
}

export async function remove(ids: string[]): Promise<void> {
  if (ids.length) await index.delete(ids);
}

export async function stats(): Promise<{ vectorCount: number }> {
  const info = await index.info();
  return { vectorCount: info.vectorCount };
}
