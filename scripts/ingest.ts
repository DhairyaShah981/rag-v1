import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkDocs } from "../src/lib/chunk.js";
import { parseFile } from "../src/lib/parse.js";
import type { Chunk } from "../src/lib/types.js";

const CORPUS_DIR = "corpus";
const MANIFEST_PATH = ".ingest_manifest.json";
const EXTS = new Set([".txt", ".pdf", ".json"]);

type ManifestEntry = { file_hash: string; chunk_ids: string[] };
type Manifest = Record<string, ManifestEntry>;

const force = process.argv.includes("--force");
const dry = process.argv.includes("--dry");

async function main() {
  if (!existsSync(CORPUS_DIR)) {
    throw new Error(`No ${CORPUS_DIR}/ directory. Add corpus files first.`);
  }
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => EXTS.has(f.slice(f.lastIndexOf(".")).toLowerCase()))
    .sort();
  if (files.length === 0) throw new Error(`No corpus files in ${CORPUS_DIR}/`);

  const manifest: Manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
    : {};

  const newManifest: Manifest = {};
  const produced = new Map<string, Chunk>();
  let skipped = 0;

  for (const file of files) {
    const path = join(CORPUS_DIR, file);
    const hash = fileHash(path);

    // File-hash short-circuit: matching hash skips parse+embed entirely. (DESIGN §b2)
    if (!force && !dry && manifest[file]?.file_hash === hash) {
      newManifest[file] = manifest[file];
      skipped++;
      console.log(`  skip   ${file} (unchanged, ${manifest[file].chunk_ids.length} chunks)`);
      continue;
    }

    const docs = await parseFile(path);
    const chunks = chunkDocs(docs);
    newManifest[file] = { file_hash: hash, chunk_ids: chunks.map((c) => c.id) };
    for (const c of chunks) produced.set(c.id, c);
    console.log(`  parse  ${file} → ${docs.length} units → ${chunks.length} chunks`);
  }

  if (dry) return inspect(produced);

  const oldIds = new Set(Object.values(manifest).flatMap((e) => e.chunk_ids));
  const newIds = new Set(Object.values(newManifest).flatMap((e) => e.chunk_ids));

  // Diff and reconcile (DESIGN §b2).
  const toUpsertIds = force
    ? [...produced.keys()]
    : [...newIds].filter((id) => !oldIds.has(id));
  const toDelete = [...oldIds].filter((id) => !newIds.has(id));
  const toUpsert = toUpsertIds
    .map((id) => produced.get(id))
    .filter((c): c is Chunk => Boolean(c));

  console.log(
    `\nfiles: ${files.length} (skipped ${skipped}) · upsert ${toUpsert.length} · delete ${toDelete.length} · unchanged ${newIds.size - toUpsert.length}`,
  );

  // Order: upsert → delete → write manifest. A crash before the manifest write
  // leaves it describing the OLD state, so the next run retries. (DESIGN §b2)
  if (toUpsert.length) {
    const { embed } = await import("../src/lib/embed.js");
    const { upsert } = await import("../src/lib/vectorstore.js");
    console.log(`embedding ${toUpsert.length} chunks...`);
    const vectors = await embed(toUpsert.map((c) => c.text));
    await upsert(toUpsert, vectors);
    console.log("upserted.");
  }
  if (toDelete.length) {
    const { remove } = await import("../src/lib/vectorstore.js");
    await remove(toDelete);
    console.log(`deleted ${toDelete.length} orphans.`);
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(newManifest, null, 2) + "\n");
  console.log(`manifest written → ${MANIFEST_PATH}`);

  const { stats } = await import("../src/lib/vectorstore.js");
  const { vectorCount } = await stats();
  console.log(`index vector count: ${vectorCount} (expected ${newIds.size})`);
  if (vectorCount !== newIds.size) {
    console.warn("⚠  vector count != chunk count — check for leftover/orphan vectors.");
  }
}

// Checkpoint 2: eyeball chunk boundaries before embedding anything. (DESIGN §i)
function inspect(produced: Map<string, Chunk>) {
  console.log(`\n--- DRY RUN: ${produced.size} chunks, no embedding ---\n`);
  const bySource = new Map<string, Chunk[]>();
  for (const c of produced.values()) {
    (bySource.get(c.source) ?? bySource.set(c.source, []).get(c.source)!).push(c);
  }
  for (const [source, chunks] of bySource) {
    console.log(`\n=== ${source}: ${chunks.length} chunks ===`);
    for (const c of chunks) {
      const preview = c.text.replace(/\s+/g, " ").slice(0, 120);
      console.log(`  [${c.chunkIndex}] (${c.section}) ${c.text.length} chars\n      "${preview}${c.text.length > 120 ? "…" : ""}"`);
    }
  }
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

main().catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});
