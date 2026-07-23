import { ask } from "@/lib/ask";

// Node.js runtime: uses the openai + @upstash/vector HTTP clients and node:crypto.
export const runtime = "nodejs";
export const maxDuration = 30;

// Orchestration only — all RAG logic lives in src/lib. (DESIGN §i)
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const query = (body as { query?: unknown })?.query;
  if (typeof query !== "string" || !query.trim()) {
    return Response.json({ error: "Missing 'query' string" }, { status: 400 });
  }

  try {
    return Response.json(await ask(query.trim()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return Response.json({ error: message }, { status: 500 });
  }
}
