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
  try {
    const { searchParams } = new URL(req.url);

    const q = (searchParams.get("q") ?? "").trim();

    const pageRaw = Number(searchParams.get("page") ?? 1);
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;

    const limitRaw = Number(searchParams.get("limit") ?? 20);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20, 1), 50);

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // ✅ kw は ?kw=AAA でも ?kw=AAA,BBB でもOK（今回は「どれか一致」で絞り込み）
    const kwList = searchParams
      .getAll("kw")
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter(Boolean);

    // ---- base query (count付き) ----
    let query = supabase
      .from("ccps_chaser_articles")
      .select(
        "id,title,content,created_at,published_year,published_month,source_page_url,source_pdf_url,pdf_bucket,pdf_path",
        { count: "exact" }
      )
      .order("published_year", { ascending: false, nullsFirst: false })
      .order("published_month", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false });

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

      const keywordIds = (kwRows ?? []).map((r: any) => r.id);
      if (!keywordIds.length) {
        return NextResponse.json({ items: [], total: 0, page, limit, totalPages: 1 });
      }

      // 2) keyword_id -> article_id
      const { data: linkRows, error: linkErr } = await supabase
        .from("ccps_article_keywords")
        .select("article_id")
        .in("keyword_id", keywordIds);

      if (linkErr) {
        return NextResponse.json({ error: linkErr.message }, { status: 500 });
      }

      const articleIds = Array.from(new Set((linkRows ?? []).map((r: any) => r.article_id)));
      if (!articleIds.length) {
        return NextResponse.json({ items: [], total: 0, page, limit, totalPages: 1 });
      }

      query = query.in("id", articleIds);
    }

    // ✅ 全文検索（fts）
    if (q) {
      query = query.textSearch("fts", q, { type: "websearch", config: "english" });
    }

    // ✅ pagination
    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // ✅ 取得した記事IDに紐づくタグ名（keywords）をまとめて取る
    const articleIds = (data ?? []).map((a: any) => a.id);
    const keywordsByArticle: Record<number, string[]> = {};

    if (articleIds.length) {
      const { data: linkRows2, error: linkErr2 } = await supabase
        .from("ccps_article_keywords")
        .select("article_id,keyword_id")
        .in("article_id", articleIds);

      if (linkErr2) return NextResponse.json({ error: linkErr2.message }, { status: 500 });

      const keywordIds2 = Array.from(new Set((linkRows2 ?? []).map((r: any) => r.keyword_id)));

      if (keywordIds2.length) {
        const { data: kwRows2, error: kwErr2 } = await supabase
          .from("ccps_keywords")
          .select("id,name")
          .in("id", keywordIds2);

        if (kwErr2) return NextResponse.json({ error: kwErr2.message }, { status: 500 });

        const idToName = new Map<number, string>((kwRows2 ?? []).map((r: any) => [r.id, r.name]));

        for (const lr of linkRows2 ?? []) {
          const aid = lr.article_id as number;
          const kid = lr.keyword_id as number;
          const name = idToName.get(kid);
          if (!name) continue;
          (keywordsByArticle[aid] ||= []).push(name);
        }

        // 重複排除
        for (const aid of Object.keys(keywordsByArticle)) {
          keywordsByArticle[Number(aid)] = Array.from(new Set(keywordsByArticle[Number(aid)]));
        }
      }
    }

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

    const total = count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json({
      items,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
