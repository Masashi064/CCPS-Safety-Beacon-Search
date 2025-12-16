export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase-server";

function getPublicPdfUrl(bucket?: string | null, path?: string | null) {
  if (!bucket || !path) return null;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/storage/v1/object/public/${bucket}/${encodeURI(path)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> } // ✅ params is Promise in Next 16
) {
  const { id } = await params; // ✅ unwrap
  const idNum = Number(id);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "Invalid article id." }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const download = searchParams.get("download") === "1";

  const { data, error } = await supabase
    .from("ccps_chaser_articles")
    .select("id,pdf_bucket,pdf_path")
    .eq("id", idNum)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.pdf_bucket || !data?.pdf_path) {
    return NextResponse.json({ error: "PDF is not available." }, { status: 404 });
  }

  const upstreamUrl = getPublicPdfUrl(data.pdf_bucket, data.pdf_path);
  if (!upstreamUrl) {
    return NextResponse.json({ error: "PDF URL is not available." }, { status: 404 });
  }

  // Pass Range through (important for PDF viewers)
  const upstreamHeaders = new Headers();
  const range = req.headers.get("range");
  if (range) upstreamHeaders.set("range", range);

  const upstreamRes = await fetch(upstreamUrl, {
    headers: upstreamHeaders,
    cache: "no-store",
  });

  if (!upstreamRes.ok || !upstreamRes.body) {
    return NextResponse.json(
      { error: `Failed to fetch PDF (HTTP ${upstreamRes.status}).` },
      { status: 502 }
    );
  }

  const outHeaders = new Headers(upstreamRes.headers);
  outHeaders.set("content-type", "application/pdf");
  outHeaders.set(
    "content-disposition",
    `${download ? "attachment" : "inline"}; filename="ccps-${idNum}.pdf"`
  );

  // Remove headers that can interfere with iframe embedding
  outHeaders.delete("x-frame-options");
  outHeaders.delete("content-security-policy");

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: outHeaders,
  });
}
