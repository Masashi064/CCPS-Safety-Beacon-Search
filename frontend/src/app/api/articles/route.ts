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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const q = (searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 20), 1), 50);

  // ✅ kw は ?kw=AAA でも ?kw=AAA,BBB でもOK（今回は「どれか一致」で絞り込み）
  const kwList = searchParams
    .getAll("kw")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  // まず記事テーブルへのクエリを組む
  let query = supabase
    .from("ccps_chaser_articles")
    .select(
      "id,title,content,created_at,published_year,published_month,source_page_url,source_pdf_url,pdf_bucket,pdf_path"
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  // ✅ タグで絞り込み（kw がある場合）
  if (kwList.length) {
    // 1) kw名 -> keyword_id
    const { data: kwRows, error: kwErr } = await supabase
      .from("ccps_keywords")
      .select("id,name")
      .in("name", kwList);

    if (kwErr) {
      return NextResponse.json({ error: kwErr.message }, { status: 500 });
    }

    const kwIds = (kwRows ?? []).map((r: any) => r.id);
    if (!kwIds.length) {
      return NextResponse.json({ items: [] });
    }

    // 2) join から article_id を集める（OR条件）
    const { data: joinRows, error: joinErr } = await supabase
      .from("ccps_article_keywords")
      .select("article_id")
      .in("keyword_id", kwIds);


    if (joinErr) {
      return NextResponse.json({ error: joinErr.message }, { status: 500 });
    }

    const articleIds = Array.from(new Set((joinRows ?? []).map((r: any) => r.article_id)));
    if (!articleIds.length) {
      return NextResponse.json({ items: [] });
    }

    query = query.in("id", articleIds);
  }

  // ✅ 全文検索（fts）
  if (q) {
    query = query.textSearch("fts", q, { type: "websearch", config: "english" });
  }

  const { data, error } = await query;
  // ✅ 取得した記事IDに紐づくタグ名（keywords）をまとめて取る
  const articleIds = (data ?? []).map((a: any) => a.id);
  const keywordsByArticle: Record<number, string[]> = {};

  if (articleIds.length) {
    const { data: linkRows, error: linkErr } = await supabase
      .from("ccps_article_keywords")
      .select("article_id,keyword_id")
      .in("article_id", articleIds);

    if (linkErr) return NextResponse.json({ error: linkErr.message }, { status: 500 });

    const keywordIds = Array.from(new Set((linkRows ?? []).map((r: any) => r.keyword_id)));

    if (keywordIds.length) {
      const { data: kwRows, error: kwErr2 } = await supabase
        .from("ccps_keywords")
        .select("id,name")
        .in("id", keywordIds);

      if (kwErr2) return NextResponse.json({ error: kwErr2.message }, { status: 500 });

      const nameById = new Map((kwRows ?? []).map((k: any) => [k.id, k.name]));

      for (const r of linkRows ?? []) {
        const name = nameById.get(r.keyword_id);
        if (!name) continue;
        (keywordsByArticle[r.article_id] ??= []).push(name);
      }

      // 重複排除 + 並びを安定化
      for (const key of Object.keys(keywordsByArticle)) {
        const id = Number(key);
        keywordsByArticle[id] = Array.from(new Set(keywordsByArticle[id])).sort();
      }
    }
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = (data ?? []).map((a: any) => {
    const pdf_public_url = getPublicPdfUrl(a.pdf_bucket, a.pdf_path);

    return {
      id: a.id,
      title: a.title,
      created_at: a.created_at,
      published_year: a.published_year ?? null,
      published_month: a.published_month ?? null,
      source_page_url: a.source_page_url ?? null,
      source_pdf_url: a.source_pdf_url ?? null,
      pdf_bucket: a.pdf_bucket ?? null,
      pdf_path: a.pdf_path ?? null,
      pdf_public_url,
      excerpt: buildExcerpt(a.content ?? "", q, 180),
      has_pdf: Boolean(pdf_public_url),
      keywords: keywordsByArticle[a.id] ?? [],
    };
  });

  return NextResponse.json({ items });
}
