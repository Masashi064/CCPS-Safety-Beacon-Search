"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type Article = {
  id: number;
  title: string;
  created_at: string;
  excerpt: string;

  published_year: number | null;
  published_month: string | null;
  keywords: string[];
};

function formatPublished(y: number | null, m: string | null) {
  if (!y && !m) return null;
  if (y && m) return `${y} / ${m}`;
  if (y) return String(y);
  return String(m);
}

function monthToNumber(m: unknown) {
  if (m == null) return 0;

  // number の場合（1〜12想定）
  if (typeof m === "number") {
    const n = Math.floor(m);
    return n >= 1 && n <= 12 ? n : 0;
  }

  // string の場合（"december" / "12" / "Dec" など）
  const s = String(m).trim().toLowerCase();
  if (!s) return 0;

  const asNum = Number(s);
  if (Number.isFinite(asNum)) {
    const n = Math.floor(asNum);
    return n >= 1 && n <= 12 ? n : 0;
  }

  const map: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };

  return map[s] ?? 0;
}

function publishedKey(y: number | null, m: string | null) {
  const yy = y ?? 0;
  const mm = monthToNumber(m);
  return yy * 100 + mm; // 例: 202512
}


function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHighlightTerms(q: string) {
  // 例: "hazard -training" -> ["hazard", "training"]（否定記号は外す）
  return q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[-+]+/, ""))
    .filter(Boolean);
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const terms = useMemo(() => getHighlightTerms(query), [query]);

  if (!terms.length) return <>{text}</>;

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((p, i) => {
        const hit = terms.some((t) => p.toLowerCase() === t.toLowerCase());
        return hit ? (
          <mark key={i} className="rounded px-1">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </>
  );
}

export default function HomePage() {
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 300);

  // ✅ タグ（keyword）フィルタ
  const [keyword, setKeyword] = useState<string>(""); // 選択中
  const [allKeywords, setAllKeywords] = useState<string[]>([]); // 候補

  const [items, setItems] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 日本語IME変換中に無駄な検索を走らせない
  const composingRef = useRef(false);

  // ✅ キーワード一覧を取得（初回だけ）
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/keywords");
        const text = await res.text();
        console.log("keywords raw:", text);
        const json = JSON.parse(text);
        if (!res.ok) throw new Error(json?.error ?? "Failed to load keywords");
        setAllKeywords(json.keywords ?? []);
      } catch (e) {
        // 取得できなくても一覧表示自体は動かす
        console.error(e);
      }
    })();
  }, []);

  async function load(query: string, kw: string, signal?: AbortSignal) {
    setLoading(true);
    setError(null);

    try {
      const trimmed = query.trim();
      const params = new URLSearchParams();
      if (trimmed) params.set("q", trimmed);
      if (kw) params.set("kw", kw);

      const url = params.toString() ? `/api/articles?${params.toString()}` : `/api/articles`;

      const res = await fetch(url, { signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Fetch failed");
      setItems(json.items ?? []);
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e?.message ?? "Unknown error");
      }
    } finally {
      setLoading(false);
    }
  }

  // 入力途中でも検索（debounce + abort） + タグ変更でも検索
  useEffect(() => {
    if (composingRef.current) return;

    const controller = new AbortController();
    load(debouncedQ, keyword, controller.signal);

    return () => controller.abort();
  }, [debouncedQ, keyword]);

  const qTrim = q.trim();

  return (
    <main className="max-w-4xl mx-auto p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">CCPS Safety Beacon Search</h1>
        <p className="text-sm opacity-80">Live search + highlight (title + content) + tag filter</p>
      </header>

      <div className="space-y-2">
        {/* 検索 */}
        <div className="flex gap-2">
          <input
            className="flex-1 border rounded px-3 py-2"
            placeholder='Type to search (e.g. "explosion", "vapor cloud", hazard -training)'
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onCompositionStart={() => (composingRef.current = true)}
            onCompositionEnd={() => (composingRef.current = false)}
          />

          <button
            className="border rounded px-4 py-2"
            onClick={() => load(q, keyword)}
            disabled={loading}
            title="Manual search (optional)"
          >
            Search
          </button>

          <button
            className="border rounded px-4 py-2"
            onClick={() => {
              setQ("");
              setKeyword("");
            }}
            disabled={loading}
          >
            Reset
          </button>
        </div>

        {/* ✅ タグフィルタ */}
        <div className="flex items-center gap-2">
          <label className="text-sm text-zinc-300">Tag:</label>
          <select
            className="border border-white/20 bg-zinc-950 text-zinc-100 rounded px-3 py-2 text-sm
                      focus:outline-none focus:ring-2 focus:ring-white/20"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          >
            <option value="" className="bg-zinc-950 text-zinc-100">
              (All)
            </option>

            {allKeywords.map((k) => (
              <option key={k} value={k} className="bg-zinc-950 text-zinc-100">
                {k}
              </option>
            ))}
          </select>


          {keyword && (
            <button
              className="border rounded px-3 py-2 text-sm"
              onClick={() => setKeyword("")}
              disabled={loading}
              title="Clear tag filter"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {loading && <p>Loading...</p>}
      {error && <p className="text-red-600">Error: {error}</p>}

      <ul className="space-y-3">
        {[...items]
          .sort((a, b) => {
            const kb = publishedKey(b.published_year ?? null, b.published_month ?? null);
            const ka = publishedKey(a.published_year ?? null, a.published_month ?? null);

            // 発行年月が同じ場合は created_at で安定ソート
            if (kb !== ka) return kb - ka; // 古い→新しい
            return b.id - a.id;
          })
          .map((a) => {
            const publishedText = formatPublished(
              a.published_year ?? null,
              a.published_month ?? null
            );

            const href = q
              ? `/articles/${a.id}?q=${encodeURIComponent(q)}`
              : `/articles/${a.id}`;

            return (
              <li key={a.id} className="border rounded p-4 space-y-2">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="font-semibold">
                    <Link
                      className="underline decoration-transparent hover:decoration-inherit"
                      href={href}
                    >
                      <HighlightedText text={a.title} query={q} />
                    </Link>
                  </h2>
                  <span className="text-xs opacity-70">
                    {new Date(a.created_at).toLocaleString()}
                  </span>
                </div>

                {publishedText && (
                  <div className="text-xs opacity-70">Published: {publishedText}</div>
                )}

                <p className="text-sm opacity-90 whitespace-pre-wrap">
                  <HighlightedText
                    text={a.excerpt + (a.excerpt?.length >= 280 ? "…" : "")}
                    query={q}
                  />
                </p>

                {a.keywords?.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {a.keywords.map((kw) => (
                      <span
                        key={kw}
                        className="text-xs border rounded-full px-2 py-1 opacity-80"
                      >
                        {kw}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
      </ul>
    </main>
  );
}
