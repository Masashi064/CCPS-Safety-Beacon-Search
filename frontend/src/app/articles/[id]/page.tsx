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

    const idSafe = id;      // ← ここで string に確定
    const qSafe = q ?? "";  // ← 万一 string|null でも潰す（保険）

    const controller = new AbortController();

    async function run() {
      setLoading(true);
      setErr(null);
      try {
        const url = qSafe
          ? `/api/articles/${encodeURIComponent(idSafe)}?q=${encodeURIComponent(qSafe)}`
          : `/api/articles/${encodeURIComponent(idSafe)}`;

        const res = await fetch(url, { signal: controller.signal });
        // ...
      } finally {
        setLoading(false);
      }
    }

    run();
    return () => controller.abort();
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
        <article className="border rounded p-5 space-y-4">
          <header className="space-y-2">
            <h1 className="text-xl font-bold">
              <HighlightedText text={data.article.title} query={q} />
            </h1>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-70">
              <span>{new Date(data.article.created_at).toLocaleString()}</span>
              {publishedText && <span>Published: {publishedText}</span>}
              {data.article.has_pdf && <span>PDF: available</span>}
            </div>

            {data.article.source_page_url && (
              <p className="text-xs">
                Source page:{" "}
                <a
                  className="underline opacity-80 hover:opacity-100"
                  href={data.article.source_page_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  open
                </a>
              </p>
            )}

            {data.article.keywords?.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {data.article.keywords.map((kw) => (
                  <Link
                    key={kw}
                    href={`/?q=${encodeURIComponent(kw)}`}
                    className="text-xs border rounded-full px-2 py-1 opacity-80 hover:opacity-100"
                    title="Search this keyword"
                  >
                    {kw}
                  </Link>
                ))}
              </div>
            )}


            {q && (
              <p className="text-sm opacity-80">
                Query: <span className="font-mono">{q}</span>
              </p>
            )}
          </header>

          {data.article.pdf_public_url && showPdf && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold opacity-80">PDF</h2>

              <div className="w-full aspect-[210/297] border rounded overflow-hidden bg-black/5">
                <iframe
                  title="PDF Viewer"
                  src={`${data.article.pdf_public_url}#view=Fit`}
                  className="w-full h-full"
                />
              </div>
            </section>
          )}

          {q && (
            <div className="border rounded p-3 text-sm opacity-90 whitespace-pre-wrap">
              <HighlightedText text={data.article.excerpt} query={q} />
            </div>
          )}

          <div className="text-sm whitespace-pre-wrap leading-6">
            <HighlightedText text={data.article.content} query={q} />
          </div>
        </article>
      )}
    </main>
  );
}
