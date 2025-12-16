#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import os
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv


def chunked(lst: list[Any], n: int) -> list[list[Any]]:
    return [lst[i : i + n] for i in range(0, len(lst), n)]


def require_env(name: str) -> str:
    v = os.getenv(name, "").strip()
    if not v:
        raise SystemExit(f"Missing env: {name}")
    return v


def rest_headers(api_key: str) -> dict[str, str]:
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        # upsert の返り値を受け取る
        "Prefer": "resolution=merge-duplicates,return=representation",
    }


def rest_get(base: str, api_key: str, path: str, params: dict[str, str]) -> list[dict[str, Any]]:
    url = f"{base}/rest/v1/{path}"
    r = requests.get(url, headers=rest_headers(api_key), params=params, timeout=60)
    r.raise_for_status()
    return r.json()


def rest_post(base: str, api_key: str, path: str, params: dict[str, str], payload: Any) -> list[dict[str, Any]]:
    url = f"{base}/rest/v1/{path}"
    r = requests.post(url, headers=rest_headers(api_key), params=params, json=payload, timeout=60)
    r.raise_for_status()
    # return=representation なので配列が返る
    return r.json()


def load_all_articles(base: str, api_key: str) -> dict[str, int]:
    """
    source_page_url -> article_id を全部取る（シンプル優先）
    """
    out: dict[str, int] = {}
    limit = 1000
    offset = 0
    while True:
        rows = rest_get(
            base,
            api_key,
            "ccps_chaser_articles",
            params={"select": "id,source_page_url", "limit": str(limit), "offset": str(offset)},
        )
        if not rows:
            break
        for r in rows:
            u = (r.get("source_page_url") or "").rstrip("/")
            if u:
                out[u] = int(r["id"])
        offset += limit
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default="tools/ccps_keyword_map.json", help="issue2keywords json")
    ap.add_argument("--dry-run", action="store_true", help="no DB write")
    ap.add_argument("--limit-issues", type=int, default=0, help="for testing; 0=all")
    args = ap.parse_args()

    # .env はこのスクリプトの1つ上（プロジェクトルート）想定でも、同階層でもOKにする
    load_dotenv(dotenv_path=Path("tools/.env"))
    load_dotenv(dotenv_path=Path(".env"))

    supabase_url = require_env("SUPABASE_URL").rstrip("/")
    # service role 推奨（なければ anon でも一応動く可能性はある）
    api_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip() or require_env("SUPABASE_ANON_KEY")

    p = Path(args.map)
    obj = json.loads(p.read_text(encoding="utf-8"))
    issue2keywords: dict[str, list[str]] = obj.get("issue2keywords", {})
    if not issue2keywords:
        raise SystemExit(f"No issue2keywords in {p}")

    issues = sorted(issue2keywords.keys())
    if args.limit_issues and args.limit_issues > 0:
        issues = issues[: args.limit_issues]

    # 1) 全キーワードをユニーク化して upsert
    keyword_names = sorted({k for isu in issues for k in issue2keywords.get(isu, [])})
    print(f"[INFO] issues={len(issues)} unique_keywords={len(keyword_names)}")

    if args.dry_run:
        print("[DRY] skip DB writes")
        return

    # upsert keywords
    keyword_rows = [{"name": n} for n in keyword_names]
    _ = rest_post(
        supabase_url,
        api_key,
        "ccps_keywords",
        params={"on_conflict": "name", "select": "id,name"},
        payload=keyword_rows,
    )

    # keyword name -> id を取得（確実化のためselectで引き直す）
    name2id: dict[str, int] = {}
    for batch in chunked(keyword_names, 100):
        # PostgREST: name=in.(a,b,c) 形式
        in_list = ",".join(batch)
        rows = rest_get(
            supabase_url,
            api_key,
            "ccps_keywords",
            params={"select": "id,name", "name": f"in.({in_list})"},
        )
        for r in rows:
            name2id[r["name"]] = int(r["id"])

    # 2) 記事URL -> article_id を取得
    url2id = load_all_articles(supabase_url, api_key)
    print(f"[INFO] loaded articles={len(url2id)}")

    # 3) join rows を作って upsert
    join_rows: list[dict[str, Any]] = []
    missing_articles = 0

    for isu in issues:
        isu_norm = isu.rstrip("/")
        article_id = url2id.get(isu_norm)
        if not article_id:
            missing_articles += 1
            continue

        for k in issue2keywords.get(isu, []):
            kid = name2id.get(k)
            if not kid:
                continue
            join_rows.append({"article_id": article_id, "keyword_id": kid})

    if not join_rows:
        print("[WARN] no join rows to insert")
        return

    # bulk upsert（PKが(article_id, keyword_id)なので重複も安全）
    for batch in chunked(join_rows, 1000):
        rest_post(
            supabase_url,
            api_key,
            "ccps_article_keywords",
            params={"on_conflict": "article_id,keyword_id"},
            payload=batch,
        )

    print(f"[OK] inserted/merged joins={len(join_rows)} missing_articles={missing_articles}")


if __name__ == "__main__":
    main()
