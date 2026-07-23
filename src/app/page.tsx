"use client";

import { useState } from "react";

type Source = {
  id: string;
  source: string;
  section: string;
  score: number;
  text: string;
};
type AskResponse = {
  trace_id: string;
  answer: string;
  sources: Source[];
  no_context: boolean;
  cited_sources: string[];
  error: string | null;
};

export default function Home() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<AskResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setErr(null);
    setRes(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setRes(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>Scaler Support Assistant</h1>
      <p style={{ color: "#9aa4ad", fontSize: 14, marginTop: 4 }}>
        Grounded answers with citations, over the support corpus.
      </p>

      <form onSubmit={submit} style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. What is the refund policy after 15 days?"
          style={{
            flex: 1,
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid #2a2f36",
            background: "#14171c",
            color: "#e6e8eb",
            fontSize: 15,
          }}
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          style={{
            padding: "12px 18px",
            borderRadius: 8,
            border: "none",
            background: loading ? "#2a2f36" : "#3b82f6",
            color: "#fff",
            fontSize: 15,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "…" : "Ask"}
        </button>
      </form>

      {err && (
        <p style={{ color: "#f87171", marginTop: 20 }}>Error: {err}</p>
      )}

      {res && (
        <section style={{ marginTop: 28 }}>
          <div
            style={{
              whiteSpace: "pre-wrap",
              lineHeight: 1.6,
              fontSize: 15.5,
              padding: 16,
              borderRadius: 10,
              background: res.no_context ? "#1c1206" : "#14171c",
              border: `1px solid ${res.no_context ? "#5a3a12" : "#2a2f36"}`,
            }}
          >
            {res.answer}
          </div>

          {res.sources.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h2 style={{ fontSize: 13, color: "#9aa4ad", fontWeight: 600 }}>
                SOURCES ({res.sources.length})
              </h2>
              {res.sources.map((s, i) => (
                <details
                  key={s.id}
                  style={{
                    marginTop: 8,
                    borderRadius: 8,
                    border: "1px solid #2a2f36",
                    background: "#101318",
                    padding: "10px 12px",
                  }}
                >
                  <summary style={{ cursor: "pointer", fontSize: 14 }}>
                    <span style={{ color: "#3b82f6" }}>[{i + 1}]</span>{" "}
                    {s.source} · {s.section}{" "}
                    <span style={{ color: "#9aa4ad" }}>
                      (score {s.score.toFixed(3)})
                    </span>
                  </summary>
                  <p
                    style={{
                      whiteSpace: "pre-wrap",
                      color: "#c4cbd2",
                      fontSize: 13.5,
                      marginTop: 8,
                      lineHeight: 1.55,
                    }}
                  >
                    {s.text}
                  </p>
                </details>
              ))}
            </div>
          )}

          <p style={{ color: "#6b7280", fontSize: 11.5, marginTop: 16 }}>
            trace {res.trace_id}
          </p>
        </section>
      )}
    </main>
  );
}
