import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase-server";

function getTerms(q: string) {
  return q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[-+]+/, ""))
    .filter(Boolean);
}

function monthToNumber(m: unknown) {
  if (m == null) return 0;
  if (typeof m === "number") return m >= 1 && m <= 12 ? m : 0;

  const s = String(m).trim().toLowerCase();
  if (!s) return 0;

  const n = Number(s);
  if (Number.isFinite(n)) return n >= 1 && n <= 12 ? Math.floor(n) : 0;

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

function publishedKey(y: unknown, m: unknown) {
  const yy = typeof y === "number" ? y : Number(y);
  const year = Number.isFinite(yy) ? yy : 0;
  return year * 100 + monthToNumber(m); // 例: 202512
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

  const fetchLimit = Math.min(limit * 10, 500);

  let query = supabase
    .from("ccps_chaser_articles")
    .select(
      "id,title,content,created_at,published_year,published_month,source_page_url,source_pdf_url,pdf_bucket,pdf_path"
    )
    .order("published_year",  { ascending: false, nullsFirst: false })
    .order("published_month", { ascending: false, nullsFirst: false })
    .order("id",              { ascending: false })
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

  items.sort((a: any, b: any) => {
    const ka = publishedKey(a.published_year, a.published_month);
    const kb = publishedKey(b.published_year, b.published_month);
    if (ka !== kb) return kb - ka; // ✅ 新しい順
    return (b.id ?? 0) - (a.id ?? 0);
  });

  return NextResponse.json({ items: items.slice(0, limit) });


  return NextResponse.json({ items });
}
