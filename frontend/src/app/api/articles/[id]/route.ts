import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase-server";

function getTerms(q: string) {
  return q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[-+]+/, ""))
    .filter(Boolean);
}

function buildExcerpt(content: string, q: string, radius = 180) {
  const text = content ?? "";
  const terms = getTerms(q);
  if (!terms.length) return text.slice(0, 280);

  const lower = text.toLowerCase();
  let hitIndex = -1;

  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (hitIndex === -1 || idx < hitIndex)) hitIndex = idx;
  }

  if (hitIndex === -1) return text.slice(0, 280);

  const start = Math.max(0, hitIndex - radius);
  const end = Math.min(text.length, hitIndex + radius);

  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";

  return prefix + text.slice(start, end) + suffix;
}

function getPublicPdfUrl(bucket?: string | null, path?: string | null) {
  if (!bucket || !path) return null;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  if (!base) return null;
  return `${base}/storage/v1/object/public/${bucket}/${encodeURI(path)}`;
}


export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const articleId = Number(id);

  if (!Number.isFinite(articleId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();

  const selectCols =
    "id,title,content,created_at,published_year,published_month,source_page_url,source_pdf_url,pdf_bucket,pdf_path";

  // 1) 記事取得（qがある場合は検索結果に含まれる記事だけ通す）
  let base = supabase
    .from("ccps_chaser_articles")
    .select(selectCols)
    .eq("id", articleId)
    .single();

  if (q) {
    base = supabase
      .from("ccps_chaser_articles")
      .select(selectCols)
      .eq("id", articleId)
      .textSearch("fts", q, { type: "websearch", config: "english" })
      .single();
  }

  const { data: a, error } = await base;

  if (error || !a) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  const pdf_public_url = getPublicPdfUrl((a as any).pdf_bucket, (a as any).pdf_path);

  // 2) 次/前（一覧と同じ並び：created_at desc, id desc）
  const createdAt = (a as any).created_at;
  const idNum = (a as any).id;

  let newerQuery = supabase
    .from("ccps_chaser_articles")
    .select("id,created_at")
    .or(`created_at.gt.${createdAt},and(created_at.eq.${createdAt},id.gt.${idNum})`)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);

  let olderQuery = supabase
    .from("ccps_chaser_articles")
    .select("id,created_at")
    .or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${idNum})`)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);

  if (q) {
    newerQuery = newerQuery.textSearch("fts", q, { type: "websearch", config: "english" });
    olderQuery = olderQuery.textSearch("fts", q, { type: "websearch", config: "english" });
  }

  const [{ data: newer }, { data: older }] = await Promise.all([newerQuery, olderQuery]);

  // 3) Keywords（JOIN）
  async function fetchKeywords(supabase: any, articleId: number): Promise<string[]> {
    const { data: joins, error: joinErr } = await supabase
      .from("ccps_article_keywords")
      .select("keyword_id")
      .eq("article_id", articleId);

    if (joinErr) console.error("joinErr", joinErr);
    if (!joins?.length) return [];

    const ids = Array.from(new Set(joins.map((r: any) => r.keyword_id).filter(Boolean)));
    if (!ids.length) return [];

    const { data: kws, error: kwErr } = await supabase
      .from("ccps_keywords")
      .select("id,name")
      .in("id", ids);

    if (kwErr) console.error("kwErr", kwErr);
    if (!kws?.length) return [];

    return kws
      .map((k: any) => String(k.name ?? "").trim())
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b));
  }


  const keywords = await fetchKeywords(supabase, articleId);

  return NextResponse.json({
    
    article: {
      id: (a as any).id,
      title: (a as any).title,
      created_at: (a as any).created_at,
      content: (a as any).content ?? "",
      excerpt: buildExcerpt((a as any).content ?? "", q, 180),

      published_year: (a as any).published_year ?? null,
      published_month: (a as any).published_month ?? null,
      source_page_url: (a as any).source_page_url ?? null,
      source_pdf_url: (a as any).source_pdf_url ?? null,

      pdf_bucket: (a as any).pdf_bucket ?? null,
      pdf_path: (a as any).pdf_path ?? null,
      pdf_public_url,
      has_pdf: Boolean(pdf_public_url),
      keywords,
    },
    nav: {
      newerId: newer?.[0]?.id ?? null,
      olderId: older?.[0]?.id ?? null,
    },
  });
}
