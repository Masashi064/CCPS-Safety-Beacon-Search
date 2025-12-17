"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type Article = {
  id: number;
  title: string;
  created_at: string;
  excerpt: string;

  published_year: number | null;
  published_month: number | null;
  keywords: string[];
};

function formatPublished(y: number | null, m: number | null) {
  if (!y && !m) return null;
  if (y && m) return `${y} / ${m}`;
  if (y) return String(y);
  return String(m);
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
          <mark key={i} className="rounded px-1 bg-yellow-200">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </>
  );
}

const PAGE_SIZE = 20;

export default function HomePage() {
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 300);

  // ✅ タグ（keyword）フィルタ
  const [keyword, setKeyword] = useState<string>("");
  const [allKeywords, setAllKeywords] = useState<string[]>([]);

  const [items, setItems] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ✅ ページネーション
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const totalPages = Math.max(1, Math.ceil((total || 0) / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = total === 0 ? 0 : Math.min(page * PAGE_SIZE, total);

  // 日本語IME変換中に無駄な検索を走らせない
  const composingRef = useRef(false);

  // ✅ キーワード一覧を取得（初回だけ）
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/keywords");
        const text = await res.text();
        const json = JSON.parse(text);
        if (!res.ok) throw new Error(json?.error ?? "Failed to load keywords");
        setAllKeywords(json.keywords ?? []);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);


  // ✅ 検索条件が変わったらページを1へ戻す
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, keyword]);

  async function load(query: string, kw: string, pageNum: number, signal?: AbortSignal) {
    setLoading(true);
    setError(null);

    try {
      const trimmed = query.trim();
      const params = new URLSearchParams();
      if (trimmed) params.set("q", trimmed);
      if (kw) params.set("kw", kw);
      params.set("page", String(pageNum));
      params.set("limit", String(PAGE_SIZE));

      const url = `/api/articles?${params.toString()}`;

      const res = await fetch(url, { signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Fetch failed");

      setItems(json.items ?? []);
      setTotal(Number.isFinite(json.total) ? json.total : (json.items?.length ?? 0));
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e?.message ?? "Unknown error");
      }
    } finally {
      setLoading(false);
    }
  }

  // 入力途中でも検索（debounce + abort） + タグ変更・ページ変更でも検索
  useEffect(() => {
    if (composingRef.current) return;

    const controller = new AbortController();
    load(debouncedQ, keyword, page, controller.signal);

    return () => controller.abort();
  }, [debouncedQ, keyword, page]);

  const PaginationBar = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-zinc-700">
        <span className="font-semibold">Total:</span> {total.toLocaleString()}
        {total > 0 && (
          <span className="text-zinc-600">（{from}–{to}）</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          className="border rounded px-3 py-2 text-sm bg-white hover:bg-zinc-50 disabled:opacity-50"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={loading || page <= 1}
        >
          Prev
        </button>

        <div className="text-sm text-zinc-700">
          Page <span className="font-semibold">{page}</span> / {totalPages}
        </div>

        <button
          className="border rounded px-3 py-2 text-sm bg-white hover:bg-zinc-50 disabled:opacity-50"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={loading || page >= totalPages}
        >
          Next
        </button>
      </div>
    </div>
  );

  return (
    <main
      className="min-h-screen bg-white text-zinc-900"
      style={{ colorScheme: "light" }} // ✅ ブラウザ/OSのダーク設定でもフォームをライト寄せ
    >
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold">CCPS Safety Beacon Search</h1>
          <p className="text-sm text-zinc-600">
            Live search + highlight (title + content) + tag filter
          </p>
        </header>

        <div className="space-y-2">
          {/* 検索 */}
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              className="flex-1 border border-zinc-300 rounded px-3 py-2 bg-white text-zinc-900 placeholder:text-zinc-400"
              placeholder='Type to search (e.g. "explosion", "vapor cloud", hazard -training)'
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onCompositionStart={() => (composingRef.current = true)}
              onCompositionEnd={() => (composingRef.current = false)}
            />

            <button
              className="border border-zinc-300 rounded px-4 py-2 bg-white hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => {
                setPage(1);
                load(q, keyword, 1);
              }}
              disabled={loading}
              title="Manual search (optional)"
            >
              Search
            </button>

            <button
              className="border border-zinc-300 rounded px-4 py-2 bg-white hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => {
                setQ("");
                setKeyword("");
                setPage(1);
              }}
              disabled={loading}
            >
              Reset
            </button>
          </div>

          {/* ✅ タグフィルタ */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <label className="text-sm text-zinc-700">Tag:</label>

            <select
              className="border border-zinc-300 bg-white text-zinc-900 rounded px-3 py-2 text-sm
                        focus:outline-none focus:ring-2 focus:ring-zinc-200"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            >
              <option value="">(All)</option>
              {allKeywords.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>

            {keyword && (
              <button
                className="border border-zinc-300 rounded px-3 py-2 text-sm bg-white hover:bg-zinc-50 disabled:opacity-50"
                onClick={() => setKeyword("")}
                disabled={loading}
                title="Clear tag filter"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* ✅ アイテム総数（カードの上） + ページ操作 */}
        {PaginationBar}

        {loading && <p className="text-zinc-700">Loading...</p>}
        {error && <p className="text-red-600">Error: {error}</p>}

        <ul className="space-y-3">
          {items.map((a) => {
            const publishedText = formatPublished(a.published_year ?? null, a.published_month ?? null);

            const href = q ? `/articles/${a.id}?q=${encodeURIComponent(q)}` : `/articles/${a.id}`;

            return (
              <li key={a.id} className="border border-zinc-200 rounded p-4 space-y-2 bg-white">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="font-semibold">
                    <Link className="underline decoration-transparent hover:decoration-inherit" href={href}>
                      <HighlightedText text={a.title} query={q} />
                    </Link>
                  </h2>
                  <span className="text-xs text-zinc-500">
                    {new Date(a.created_at).toLocaleString()}
                  </span>
                </div>

                {publishedText && <div className="text-xs text-zinc-500">Published: {publishedText}</div>}

                <p className="text-sm text-zinc-800 whitespace-pre-wrap">
                  <HighlightedText text={a.excerpt + (a.excerpt?.length >= 280 ? "…" : "")} query={q} />
                </p>

                {a.keywords?.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {a.keywords.map((kw) => (
                      <span key={kw} className="text-xs border border-zinc-200 rounded-full px-2 py-1 text-zinc-700">
                        {kw}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {/* 下にもあると便利 */}
        {PaginationBar}
      </div>
    </main>
  );
}
