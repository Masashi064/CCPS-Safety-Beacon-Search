"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";

type Props = {
  fileUrl: string; // e.g. /api/articles/123/pdf
};

export default function PdfPreview({ fileUrl }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapW, setWrapW] = useState(900);

  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);

  // PDF binary (stable; avoids range/stream issues)
  const [fileData, setFileData] = useState<ArrayBuffer | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(false);

  // ✅ Worker (keep it; your path exists)
  useEffect(() => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
  }, []);

  // ✅ Observe container width
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(() => {
      const w = wrapRef.current?.clientWidth ?? 900;
      setWrapW(w);
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const pageWidth = useMemo(() => Math.min(wrapW - 16, 900), [wrapW]);

  // ✅ Fetch PDF as ArrayBuffer (most reliable)
  useEffect(() => {
    const controller = new AbortController();

    async function run() {
      setLoadingPdf(true);
      setLoadErr(null);
      setFileData(null);

      try {
        const res = await fetch(fileUrl, { signal: controller.signal });

        // If API returns JSON error, show it clearly
        const ct = res.headers.get("content-type") ?? "";
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`PDF fetch failed: HTTP ${res.status} ${res.statusText} - ${body.slice(0, 200)}`);
        }
        if (!ct.includes("application/pdf")) {
          const body = await res.text();
          throw new Error(
            `PDF endpoint did not return application/pdf (got: ${ct || "unknown"}). ` +
              `Body: ${body.slice(0, 200)}`
          );
        }

        const buf = await res.arrayBuffer();
        setFileData(buf);
        setPage(1);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setLoadErr(e?.message ?? "Failed to load PDF preview.");
      } finally {
        setLoadingPdf(false);
      }
    }

    void run();
    return () => {
      if (!controller.signal.aborted) controller.abort();
    };
  }, [fileUrl]);

  return (
    <div ref={wrapRef} className="w-full">
      {/* Status */}
      {loadingPdf && <div className="p-3 text-sm opacity-80">Loading PDF…</div>}

      {loadErr && (
        <div className="p-3 text-sm text-red-600">
          {loadErr}
          <div className="pt-2">
            <a className="underline" href={fileUrl} target="_blank" rel="noreferrer">
              Open PDF in a new tab
            </a>
          </div>
        </div>
      )}

      {/* Viewer */}
      {!loadErr && fileData && (
        <Document
          file={fileData}
          onLoadSuccess={(p) => {
            setNumPages(p.numPages);
          }}
          onLoadError={(e) => setLoadErr((e as any)?.message ?? "Failed to load PDF preview.")}
          loading={<div className="p-3 text-sm opacity-80">Preparing viewer…</div>}
        >
          <Page
            pageNumber={page}
            width={pageWidth}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={<div className="p-3 text-sm opacity-80">Rendering…</div>}
          />
        </Document>
      )}

      {/* Pager */}
      {!loadErr && numPages > 1 && (
        <div className="flex items-center gap-2 pt-2">
          <button
            className="border rounded px-2 py-1 text-sm disabled:opacity-50"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            type="button"
          >
            Prev
          </button>
          <span className="text-sm opacity-80">
            Page {page} / {numPages}
          </span>
          <button
            className="border rounded px-2 py-1 text-sm disabled:opacity-50"
            disabled={page >= numPages}
            onClick={() => setPage((p) => p + 1)}
            type="button"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
