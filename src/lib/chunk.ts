import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { CONFIG } from "./config";
import type { Chunk, RawDoc } from "./types";

// cl100k_base is close enough for sizing; exact match to the embed tokenizer
// isn't needed — we only use counts to bound chunk length. (DESIGN §b)
const enc = getEncoding("cl100k_base");
const tok = (s: string) => enc.encode(s).length;

// RawDoc[] → Chunk[] with deterministic IDs. A semantic unit under the cap is
// emitted whole (never force-split); only oversized units (big PDF pages) are
// sub-split recursively paragraph → sentence, with token overlap. (DESIGN §b)
export function chunkDocs(docs: RawDoc[]): Chunk[] {
  const chunks: Chunk[] = [];
  const counter = new Map<string, number>();

  for (const doc of docs) {
    const pieces =
      tok(doc.text) <= CONFIG.CHUNK_MAX_TOKENS
        ? [doc.text.trim()]
        : pack(atomicSegments(doc.text));

    for (const text of pieces) {
      if (!text) continue;
      const idx = counter.get(doc.source) ?? 0;
      counter.set(doc.source, idx + 1);
      chunks.push({
        id: makeId(doc.source, idx, text),
        text,
        source: doc.source,
        section: doc.section,
        chunkIndex: idx,
      });
    }
  }
  return chunks;
}

// sha256(source + chunkIndex + chunkText)[:16] → idempotent upserts. (DESIGN §b2)
export function makeId(source: string, chunkIndex: number, text: string): string {
  return createHash("sha256")
    .update(`${source}${chunkIndex}${text}`)
    .digest("hex")
    .slice(0, 16);
}

// Break oversized text into atomic segments (paragraph → sentence → hard token
// split as last resort) so packing never severs a sentence mid-way.
function atomicSegments(text: string): string[] {
  const segs: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (tok(p) <= CONFIG.CHUNK_TARGET_TOKENS) {
      segs.push(p);
      continue;
    }
    for (const sent of p.split(/(?<=[.!?])\s+/)) {
      const s = sent.trim();
      if (!s) continue;
      if (tok(s) <= CONFIG.CHUNK_MAX_TOKENS) segs.push(s);
      else segs.push(...hardSplit(s));
    }
  }
  return segs;
}

// Greedy pack segments to ~TARGET tokens, carrying an OVERLAP-token tail into
// the next chunk to guard boundary splits without near-duplicate crowding.
function pack(segs: string[]): string[] {
  const { CHUNK_TARGET_TOKENS: target, CHUNK_OVERLAP_TOKENS: overlap } = CONFIG;
  const chunks: string[] = [];
  let cur: string[] = [];
  let curTok = 0;

  for (const seg of segs) {
    const t = tok(seg);
    if (curTok + t > target && cur.length) {
      chunks.push(cur.join(" "));
      const tail: string[] = [];
      let tailTok = 0;
      for (let i = cur.length - 1; i >= 0 && tailTok < overlap; i--) {
        tail.unshift(cur[i]);
        tailTok += tok(cur[i]);
      }
      cur = tail;
      curTok = tailTok;
    }
    cur.push(seg);
    curTok += t;
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}

// Last resort for a single monster sentence exceeding the cap.
function hardSplit(s: string): string[] {
  const ids = enc.encode(s);
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += CONFIG.CHUNK_TARGET_TOKENS) {
    out.push(enc.decode(ids.slice(i, i + CONFIG.CHUNK_TARGET_TOKENS)));
  }
  return out;
}
