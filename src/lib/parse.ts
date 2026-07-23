import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { RawDoc } from "./types";

// path → RawDoc[]. Isolates all per-filetype extraction quirks (DESIGN §i).
// Each RawDoc is a *semantic unit*: a Q&A pair / clause (txt), a page (pdf),
// or a program record (json). chunk.ts only sub-splits units that exceed the cap.

export async function parseFile(path: string): Promise<RawDoc[]> {
  const ext = extname(path).toLowerCase();
  if (ext === ".txt") return parseTxt(path);
  if (ext === ".json") return parseJson(path);
  if (ext === ".pdf") return parsePdf(path);
  throw new Error(`Unsupported file type: ${path}`);
}

// --- Plain text: one RawDoc per blank-line-separated block (Q&A pair / clause) ---
function parseTxt(path: string): RawDoc[] {
  const source = basename(path);
  const raw = readFileSync(path, "utf8");
  const blocks = raw
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((text, i) => ({ source, section: sectionLabel(text, i), text }));
}

function sectionLabel(text: string, i: number): string {
  const clause = text.match(/^(?:clause\s+)?(\d+(?:\.\d+)*)[.):]/i);
  if (clause) return `Clause ${clause[1]}`;
  const q = text.match(/^Q[:.)]\s*(.{0,60})/i);
  if (q) return `Q: ${q[1].trim().replace(/\s+/g, " ")}`;
  const heading = text.match(/^#+\s*(.{0,60})/);
  if (heading) return heading[1].trim();
  return `Section ${i + 1}`;
}

// --- Pricing JSON: one RawDoc per program record, flattened. Never split. ---
function parseJson(path: string): RawDoc[] {
  const source = basename(path);
  const data = JSON.parse(readFileSync(path, "utf8"));
  const records: Record<string, unknown>[] = Array.isArray(data)
    ? data
    : Object.entries(data).map(([k, v]) => ({
        _key: k,
        ...(v && typeof v === "object" ? (v as object) : { value: v }),
      }));
  return records.map((rec, i) => {
    const name =
      (rec.program ?? rec.name ?? rec.title ?? rec._key ?? `Record ${i + 1}`) as string;
    return { source, section: String(name), text: flattenRecord(rec) };
  });
}

function flattenRecord(rec: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (k === "_key") continue;
    parts.push(`${humanize(k)}: ${stringifyVal(v)}.`);
  }
  return parts.join(" ");
}

function humanize(k: string): string {
  const s = k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function stringifyVal(v: unknown): string {
  if (v === null || v === undefined) return "N/A";
  if (Array.isArray(v)) return v.map(stringifyVal).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as object)
      .map(([k, val]) => `${humanize(k)} ${stringifyVal(val)}`)
      .join(", ");
  }
  return String(v);
}

// --- PDF: one RawDoc per page; page kept as `section` for verifiable citations ---
async function parsePdf(path: string): Promise<RawDoc[]> {
  // Subpath import avoids pdf-parse's debug harness reading a test file on import.
  const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
  const source = basename(path);
  const buffer = readFileSync(path);
  const pages: string[] = [];
  await pdfParse(buffer, {
    pagerender: async (pageData: {
      getTextContent: (o: object) => Promise<{ items: { str: string }[] }>;
    }) => {
      const tc = await pageData.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false,
      });
      const text = tc.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
      pages.push(text);
      return text;
    },
  });
  return pages
    .map((text, i) => ({ source, section: `Page ${i + 1}`, text }))
    .filter((d) => d.text.length > 0);
}
