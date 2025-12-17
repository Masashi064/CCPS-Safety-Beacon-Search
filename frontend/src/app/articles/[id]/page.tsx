"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// pdf.js viewer (client-only)
const PdfPreview = dynamic(() => import("../../../components/PdfPreview"), {
  ssr: false,
});

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

  if (!query || terms.length === 0) return <>{text}</>;

  const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "ig");
  const parts = text.split(re);

  return (
    <>
      {parts.map((p, i) => {
        const hit = terms.some((t) => p.toLowerCase() === t.toLowerCase());
        if (!hit) return <span key={i}>{p}</span>;
        return (
          <mark
            key={i}
            className="rounded px-1 py-0.5 bg-yellow-400/30 text-yellow-200"
          >
            {p}
          </mark>
        );
      })}
    </>
  );
}

type Article = {
  id: number;
  title: string;
  created_at: string;
  content: string | null;

  published_year: number | null;
  published_month: number | null;

  source_page_url: string | null;
  source_pdf_url: string | null;

  pdf_bucket: string | null;
  pdf_path: string | null;

  keywords: string[];
};

type ApiResponse = {
  article: Article;
  nav?: {
    newerId: number | null;
    olderId: number | null;
  };
};

function getIdFromPath(pathname: string) {
  const m = pathname.match(/^\/articles\/([^/]+)$/);
  return m?.[1] ?? null;
}

function formatPublished(y: number | null, m: number | null) {
  if (!y && !m) return null;
  if (y && m) return `${y} / ${String(m).padStart(2, "0")}`;
  if (y) return String(y);
  return String(m);
}

export default function ArticlePage() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const q = (searchParams.get("q") ?? "").trim();

  const id = useMemo(() => getIdFromPath(pathname), [pathname]);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPdf, setShowPdf] = useState(true);

  useEffect(() => {
    if (!id) {
      setErr("Invalid route: missing id");
      return;
    }

    const controller = new AbortController();

    async function run() {
      setLoading(true);
      setErr(null);

      try {
        const url = q
          ? `/api/articles/${encodeURIComponent(id)}?q=${encodeURIComponent(q)}`
          : `/api/articles/${encodeURIComponent(id)}`;

        const res = await fetch(url, { signal: controller.signal });

        const raw = await res.text();
        let json: any = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          // ignore
        }

        if (!res.ok) {
          const msg =
            json?.error ||
            json?.message ||
            raw ||
            `Request failed: ${res.status}`;
          throw new Error(msg);
        }

        setData(json as ApiResponse);
      } catch (e: any) {
        // ✅ AbortError は通常の挙動なのでエラー表示しない
        if (e?.name === "AbortError") return;
        setErr(e?.message ?? String(e));
        setData(null);
      } finally {
        setLoading(false);
      }
    }

    run();
    return () => controller.abort();
  }, [id, q]);

  const article = data?.article ?? null;

  const publishedText = useMemo(() => {
    if (!article) return null;
    return formatPublished(article.published_year, article.published_month);
  }, [article]);

  const pdfProxyUrl = useMemo(() => {
    if (!article?.id) return null;
    // pdf route will 404 if pdf is missing — that's fine.
    return `/api/articles/${article.id}/pdf`;
  }, [article?.id]);

  const newerHref = useMemo(() => {
    const newerId = data?.nav?.newerId ?? null;
    if (!newerId) return null;
    return q
      ? `/articles/${newerId}?q=${encodeURIComponent(q)}`
      : `/articles/${newerId}`;
  }, [data?.nav?.newerId, q]);

  const olderHref = useMemo(() => {
    const olderId = data?.nav?.olderId ?? null;
    if (!olderId) return null;
    return q
      ? `/articles/${olderId}?q=${encodeURIComponent(q)}`
      : `/articles/${olderId}`;
  }, [data?.nav?.olderId, q]);

  return (
    <main className="max-w-4xl mx-auto p-4 space-y-4">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <Link className="border rounded px-3 py-2" href={q ? `/?q=${encodeURIComponent(q)}` : "/"}>
          ← Back
        </Link>

        <div className="flex gap-2">
          {newerHref ? (
            <Link className="border rounded px-3 py-2" href={newerHref}>
              ← Newer
            </Link>
          ) : (
            <span className="border rounded px-3 py-2 opacity-50">← Newer</span>
          )}

          {olderHref ? (
            <Link className="border rounded px-3 py-2" href={olderHref}>
              Older →
            </Link>
          ) : (
            <span className="border rounded px-3 py-2 opacity-50">Older →</span>
          )}
        </div>
      </div>

      {loading && <p>Loading…</p>}
      {err && <p className="text-red-600">Error: {err}</p>}

      {article && (
        <div className="space-y-4">
          <header className="space-y-2">
            <h1 className="text-2xl font-bold">
              <HighlightedText text={article.title} query={q} />
            </h1>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-70">
              <span>Indexed: {new Date(article.created_at).toLocaleString()}</span>
              {publishedText && <span>Published: {publishedText}</span>}
            </div>

            {article.source_page_url && (
              <div className="text-sm">
                Source page:{" "}
                <a
                  className="underline opacity-80 hover:opacity-100"
                  href={article.source_page_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  open
                </a>
              </div>
            )}

            {article.keywords?.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {article.keywords.map((kw) => (
                  <span
                    key={kw}
                    className="text-xs border rounded-full px-2 py-1 opacity-80"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </header>

          {/* ✅ PDF first */}
          <section className="space-y-3 pt-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold opacity-80">PDF</h2>

              {pdfProxyUrl && (
                <button
                  type="button"
                  className="text-xs border rounded px-2 py-1 opacity-80 hover:opacity-100"
                  onClick={() => setShowPdf((v) => !v)}
                >
                  {showPdf ? "Hide preview" : "Show preview"}
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {article.source_page_url && (
                <a
                  className="border rounded px-3 py-2 text-sm"
                  href={article.source_page_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  View source page
                </a>
              )}

              {/* Use your stored source_pdf_url if available */}
              {article.source_pdf_url && (
                <a
                  className="border rounded px-3 py-2 text-sm"
                  href={article.source_pdf_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open PDF
                </a>
              )}
            </div>

            {pdfProxyUrl && showPdf ? (
              <div className="w-full border rounded overflow-hidden bg-black/5 p-2">
                <PdfPreview fileUrl={pdfProxyUrl} />
              </div>
            ) : (
              <div className="text-sm opacity-80">
                PDF preview is not available for this article.
              </div>
            )}
          </section>

          {/* ✅ Body after PDF */}
          <section className="space-y-2 pt-2">
            <h2 className="text-sm font-semibold opacity-80">Article</h2>

            <article className="prose prose-invert max-w-none">
              <pre className="whitespace-pre-wrap text-sm">
                <HighlightedText text={article.content ?? ""} query={q} />
              </pre>
            </article>
          </section>
        </div>
      )}
    </main>
  );
}
