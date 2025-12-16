"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

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

type ApiResponse = {
  article: {
    id: number;
    title: string;
    created_at: string;
    content: string;
    excerpt: string;

    published_year: number | null;
    published_month: string | null;

    source_page_url: string | null;
    source_pdf_url: string | null;

    pdf_bucket: string | null;
    pdf_path: string | null;
    pdf_public_url: string | null;
    has_pdf: boolean;

    // ★追加
    keywords: string[];
  };
  nav: {
    newerId: number | null;
    olderId: number | null;
  };
};


function getIdFromPath(pathname: string) {
  const m = pathname.match(/^\/articles\/([^/]+)$/);
  return m?.[1] ?? null;
}

function formatPublished(y: number | null, m: string | null) {
  if (!y && !m) return null;
  if (y && m) return `${y} / ${m}`;
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

    const idSafe = id;
    const qSafe = q ?? "";

    const controller = new AbortController();

    async function run() {
      setLoading(true);
      setErr(null);

      try {
        const url = qSafe
          ? `/api/articles/${encodeURIComponent(idSafe)}?q=${encodeURIComponent(qSafe)}`
          : `/api/articles/${encodeURIComponent(idSafe)}`;

        const res = await fetch(url, { signal: controller.signal });

        const text = await res.text();
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}

        if (!res.ok) {
          const msg =
            json?.error ??
            `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200) || "(empty response)"}`;
          throw new Error(msg);
        }
        if (!json) throw new Error("API returned empty/non-JSON response.");

        setData(json);
      } catch (e: any) {
        // ✅ これが肝：abort は「正常動作」なので無視
        if (e?.name === "AbortError") return;
        setErr(e?.message ?? "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    void run();

    return () => {
      if (!controller.signal.aborted) controller.abort();
    };
  }, [id, q]);



  const backHref = q ? `/?q=${encodeURIComponent(q)}` : "/";

  const newerHref =
    data?.nav.newerId != null
      ? `/articles/${data.nav.newerId}${q ? `?q=${encodeURIComponent(q)}` : ""}`
      : null;

  const olderHref =
    data?.nav.olderId != null
      ? `/articles/${data.nav.olderId}${q ? `?q=${encodeURIComponent(q)}` : ""}`
      : null;

  const publishedText = data ? formatPublished(data.article.published_year, data.article.published_month) : null;
  const sourceUrl = data?.article.source_page_url ?? null;
  const pdfPublicUrl = data?.article.pdf_public_url ?? null;

  // PCで埋め込み表示する用（自サイトのAPI経由にする想定）
  const pdfEmbedUrl = data?.article.has_pdf ? `/api/articles/${data.article.id}/pdf` : null;

  return (
    <main className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link className="underline opacity-80 hover:opacity-100" href={backHref}>
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

      {loading && <p>Loading...</p>}
      {err && <p className="text-red-600">Error: {err}</p>}

      {data && (
        <div className="space-y-4">
          <h1 className="text-2xl font-bold">{data.article.title}</h1>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-70">
            <span>{new Date(data.article.created_at).toLocaleString()}</span>
            {publishedText && <span>Published: {publishedText}</span>}
            {data.article.has_pdf && <span>PDF: available</span>}
          </div>

          {data.article.source_page_url && (
            <div className="text-sm">
              Source page:{" "}
              <a
                className="underline opacity-80 hover:opacity-100"
                href={data.article.source_page_url}
                target="_blank"
                rel="noreferrer"
              >
                open
              </a>
            </div>
          )}

          {data.article.keywords?.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.article.keywords.map((kw) => (
                <span key={kw} className="text-xs border rounded-full px-2 py-1 opacity-80">
                  {kw}
                </span>
              ))}
            </div>
          )}
         
          {/* Attachments */}
          <section className="space-y-2 pt-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold opacity-80">Attachments</h2>

              {pdfEmbedUrl && (
                <button
                  type="button"
                  className="hidden md:inline-flex text-xs border rounded px-2 py-1 opacity-80 hover:opacity-100"
                  onClick={() => setShowPdf((v) => !v)}
                >
                  {showPdf ? "Hide preview" : "Show preview"}
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {sourceUrl && (
                <a className="border rounded px-3 py-2" href={sourceUrl} target="_blank" rel="noreferrer">
                  View source page
                </a>
              )}

              {/* PC convenience */}
              {pdfPublicUrl && (
                <a className="hidden md:inline-flex border rounded px-3 py-2" href={pdfPublicUrl} target="_blank" rel="noreferrer">
                  Open PDF
                </a>
              )}
            </div>
            
            {/* Desktop embed */}
            {pdfEmbedUrl && showPdf && (
              <div className="hidden md:block w-full aspect-[210/297] border rounded overflow-hidden bg-black/5">
                <iframe title="PDF Viewer" src={pdfEmbedUrl} className="w-full h-full" />
              </div>
            )}

          </section>

          <article className="prose prose-invert max-w-none">
            <pre className="whitespace-pre-wrap text-sm">{data.article.content}</pre>
          </article>
        </div>
      )}

    </main>
  );
}
