#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import re
import time
from collections import defaultdict
from urllib.parse import urljoin, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

ARCHIVES_URL = "https://ccps.aiche.org/resources/process-safety-beacon/archives"
ENGLISH_LANGUAGE_ID = "9306"  # archives の Language: English がこれ :contentReference[oaicite:5]{index=5}


def fetch(url: str, session: requests.Session, timeout: int = 30) -> str:
    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    return r.text


def extract_keyword_links(html: str) -> dict[str, str]:
    """
    archives ページから keywords フィルタのリンクを拾う。
    return: {keyword_id: keyword_name}
    """
    soup = BeautifulSoup(html, "html.parser")
    out: dict[str, str] = {}

    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(" ", strip=True)
        if not text:
            continue

        # keywords クエリが付くリンクだけ拾う
        if "keywords=" not in href:
            continue

        # 相対URLにも対応
        full = href if href.startswith("http") else urljoin(ARCHIVES_URL, href)
        q = parse_qs(urlparse(full).query)
        kid = q.get("keywords", [None])[0]
        if kid and kid.isdigit():
            out[kid] = text

    return out


def extract_issue_english_urls(html: str) -> set[str]:
    """
    絞り込み結果ページから英語記事URL（/archives/YYYY/month/english）を抜く。
    """
    soup = BeautifulSoup(html, "html.parser")
    urls = set()

    for a in soup.find_all("a", href=True):
        href = a["href"]
        full = href if href.startswith("http") else urljoin(ARCHIVES_URL, href)

        if re.search(r"/resources/process-safety-beacon/archives/\d{4}/[^/]+/english/?$", full):
            urls.add(full.rstrip("/"))

    return urls


def has_next_page(html: str) -> bool:
    """
    Drupal系のページャに "next" があるかをゆるく判定
    """
    soup = BeautifulSoup(html, "html.parser")
    # よくある next の class / rel を雑に拾う
    if soup.select_one('a[rel="next"]'):
        return True
    if soup.select_one(".pager__item--next a"):
        return True
    # “next” テキストでも拾う
    for a in soup.find_all("a", href=True):
        if a.get_text(" ", strip=True).lower() == "next":
            return True
    return False


def build_keyword_to_issues(session: requests.Session, keyword_ids: list[str], sleep_sec: float) -> dict[str, set[str]]:
    """
    return: {keyword_id: set(issue_url)}
    """
    kid2issues: dict[str, set[str]] = {}
    for kid in keyword_ids:
        issues = set()
        page = 0

        while True:
            url = f"{ARCHIVES_URL}?keywords={kid}&language={ENGLISH_LANGUAGE_ID}&page={page}"
            html = fetch(url, session)
            issues |= extract_issue_english_urls(html)

            # 次ページが無さそうなら抜ける
            if not has_next_page(html):
                break

            page += 1
            if page > 50:  # 念のため上限
                break

            time.sleep(sleep_sec)

        kid2issues[kid] = issues
        time.sleep(sleep_sec)

    return kid2issues


def invert_to_issue_keywords(keyword_map: dict[str, str], kid2issues: dict[str, set[str]]) -> dict[str, list[str]]:
    """
    issue_url -> [keyword_name, ...]
    """
    issue2keywords: dict[str, set[str]] = defaultdict(set)
    for kid, issues in kid2issues.items():
        kname = keyword_map.get(kid, f"keyword_{kid}")
        for isu in issues:
            issue2keywords[isu].add(kname)

    # set -> sorted list
    return {isu: sorted(list(kws)) for isu, kws in issue2keywords.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output json path (e.g. tools/ccps_keyword_map.json)")
    ap.add_argument("--sleep", type=float, default=0.4, help="sleep seconds between requests")
    args = ap.parse_args()

    with requests.Session() as s:
        s.headers.update({"User-Agent": "ccps-chaser/1.0 (personal project)"})

        base_html = fetch(ARCHIVES_URL, s)
        keyword_map = extract_keyword_links(base_html)

        # keyword_id を安定順に
        keyword_ids = sorted(keyword_map.keys(), key=lambda x: int(x))

        kid2issues = build_keyword_to_issues(s, keyword_ids, args.sleep)
        issue2keywords = invert_to_issue_keywords(keyword_map, kid2issues)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(
            {
                "archives_url": ARCHIVES_URL,
                "language_id": ENGLISH_LANGUAGE_ID,
                "issue2keywords": issue2keywords,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"[OK] wrote: {args.out}")
    print(f"[OK] issues with at least 1 keyword: {len(issue2keywords)}")
    print(f"[OK] keywords detected: {len(keyword_map)}")


if __name__ == "__main__":
    main()
