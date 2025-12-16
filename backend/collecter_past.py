#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import os
import re
import json
import time
import logging
import argparse
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qs

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from PyPDF2 import PdfReader

from supabase import create_client, Client


ARCHIVES_ROOT = "https://ccps.aiche.org/resources/process-safety-beacon/archives"

MONTHS = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = PROJECT_ROOT / "downloads"
LOG_DIR = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

STATE_PATH = PROJECT_ROOT / "state.json"
LOG_PATH = LOG_DIR / "collector.log"
SKIPPED_LOG_PATH = LOG_DIR / "skipped.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("collector")


def load_env():
    # backend/.env → project root/.env → project root/.env.local の順で読む
    for p in [BACKEND_DIR / ".env", PROJECT_ROOT / ".env", PROJECT_ROOT / ".env.local"]:
        if p.exists():
            load_dotenv(p)


def get_supabase() -> Client:
    url = os.getenv("SUPABASE_URL", "").strip()
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY", "") or os.getenv("SUPABASE_ANON_KEY", "")).strip()
    if not url or not key:
        raise RuntimeError("SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY(推奨) または SUPABASE_ANON_KEY が必要です。")
    return create_client(url, key)


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"processed_english_pages": []}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def append_skipped(item: dict) -> None:
    arr = []
    if SKIPPED_LOG_PATH.exists():
        try:
            arr = json.loads(SKIPPED_LOG_PATH.read_text(encoding="utf-8"))
        except Exception:
            arr = []
    arr.append(item)
    SKIPPED_LOG_PATH.write_text(json.dumps(arr, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch(session: requests.Session, url: str) -> str:
    r = session.get(url, timeout=60)
    r.raise_for_status()
    return r.text


def parse_last_page_num(html: str) -> int:
    soup = BeautifulSoup(html, "html.parser")
    max_page = 0
    for a in soup.find_all("a", href=True):
        full = urljoin(ARCHIVES_ROOT, a["href"])
        qs = parse_qs(urlparse(full).query)
        if "page" in qs:
            try:
                p = int(qs["page"][0])
                max_page = max(max_page, p)
            except Exception:
                pass
    return max_page


def extract_english_links_from_archive_page(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for a in soup.find_all("a", href=True):
        full = urljoin(ARCHIVES_ROOT, a["href"])
        if re.search(r"/archives/\d{4}/[a-z]+/english/?$", full):
            out.append(full.rstrip("/"))
    return out


def parse_year_month_from_english_url(url: str) -> tuple[int, int] | None:
    m = re.search(r"/archives/(\d{4})/([a-z]+)/english/?$", url)
    if not m:
        return None
    year = int(m.group(1))
    month = MONTHS.get(m.group(2).lower())
    if not month:
        return None
    return year, month


def discover_english_pages(session: requests.Session, min_year: int = 2001, max_pages: int | None = None) -> list[str]:
    first_html = fetch(session, ARCHIVES_ROOT)
    last_page = parse_last_page_num(first_html)
    if max_pages is not None:
        last_page = min(last_page, max_pages - 1)

    pages: set[str] = set()
    logger.info(f"Archives pagination detected. last_page_index={last_page}")

    for page in range(0, last_page + 1):
        url = ARCHIVES_ROOT if page == 0 else f"{ARCHIVES_ROOT}?page={page}"
        html = fetch(session, url)
        links = extract_english_links_from_archive_page(html)
        if not links:
            logger.warning(f"No english links found at page={page} ({url}). stopping.")
            break

        years_in_page = []
        kept = 0
        for u in links:
            ym = parse_year_month_from_english_url(u)
            if not ym:
                continue
            y, _m = ym
            years_in_page.append(y)
            if y >= min_year:
                pages.add(u)
                kept += 1

        logger.info(f"page={page} english_links={len(links)} kept={kept}")

        if years_in_page and max(years_in_page) < min_year:
            logger.info(f"Reached pages older than min_year={min_year}. stopping at page={page}.")
            break

        time.sleep(0.2)

    def sort_key(u: str):
        ym = parse_year_month_from_english_url(u)
        return ym if ym else (0, 0)

    return sorted(pages, key=sort_key, reverse=True)


def extract_title_from_english_page(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.find("h1")
    title = h1.get_text(" ", strip=True) if h1 else ""
    title = re.sub(r"\s*-\s*English\s*$", "", title, flags=re.IGNORECASE).strip()
    return title


def extract_pdf_url_from_english_page(html: str, base_url: str) -> str:
    soup = BeautifulSoup(html, "html.parser")

    # 1) "click here to download" っぽいリンク優先
    for a in soup.find_all("a", href=True):
        txt = (a.get_text() or "").strip().lower()
        if "download" in txt and "click" in txt:
            return urljoin(base_url + "/", a["href"])

    # 2) .pdf を含むリンク
    candidates = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.lower().endswith(".pdf") or ".pdf" in href.lower():
            candidates.append(urljoin(base_url + "/", href))

    return candidates[0] if candidates else ""


def download_pdf(session: requests.Session, pdf_url: str, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    r = session.get(pdf_url, timeout=120)
    r.raise_for_status()
    out_path.write_bytes(r.content)


def extract_pdf_text(pdf_path: Path) -> str:
    try:
        reader = PdfReader(str(pdf_path))
        parts = []
        for p in reader.pages:
            parts.append(p.extract_text() or "")
        text = "\n".join(parts).strip()
        # 軽く整形
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text
    except Exception as e:
        logger.warning(f"PDF text extraction failed: {pdf_path.name} ({e})")
        return ""


def upload_pdf_to_storage(sb: Client, bucket: str, object_path: str, local_path: Path) -> None:
    data = local_path.read_bytes()
    sb.storage.from_(bucket).upload(
        path=object_path,
        file=data,
        file_options={"content-type": "application/pdf", "upsert": "true"},
    )


def upsert_article(sb: Client, table: str, payload: dict) -> None:
    # source_page_url に unique index がある前提
    sb.table(table).upsert(payload, on_conflict="source_page_url").execute()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-year", type=int, default=2001)
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--table", type=str, default="ccps_chaser_articles")
    parser.add_argument("--bucket", type=str, default="ccps-pdfs")
    parser.add_argument("--force", action="store_true", help="state.json を無視して再処理する")
    parser.add_argument("--limit", type=int, default=None, help="process only N newest items (dry run for small test)")
    args = parser.parse_args()

    load_env()

    logger.info(f"PROJECT_ROOT: {PROJECT_ROOT}")
    logger.info(f"DOWNLOAD_DIR: {DOWNLOAD_DIR}")
    logger.info(f"STATE_PATH  : {STATE_PATH}")
    logger.info(f"LOG_PATH    : {LOG_PATH}")

    sb = get_supabase()

    state = load_state()
    processed = set(state.get("processed_english_pages", []))

    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)

    logger.info("Discovering english pages...")
    english_pages = discover_english_pages(session, min_year=args.min_year, max_pages=args.max_pages)
    logger.info(f"Found english pages: {len(english_pages)}")

    done = 0
    limit = args.limit
    skipped = 0

    for english_url in english_pages:
        if (not args.force) and (english_url in processed):
            continue

        ym = parse_year_month_from_english_url(english_url)
        if not ym:
            skipped += 1
            append_skipped({"url": english_url, "reason": "bad_ym"})
            continue

        year, month = ym

        try:
            html = fetch(session, english_url)
            title = extract_title_from_english_page(html) or f"Process Safety Beacon {year}-{month:02d}"
            pdf_url = extract_pdf_url_from_english_page(html, english_url)

            if not pdf_url:
                skipped += 1
                append_skipped({"url": english_url, "reason": "no_pdf_url"})
                processed.add(english_url)
                state["processed_english_pages"] = sorted(processed)
                save_state(state)
                continue

            # local pdf name
            pdf_filename = f"{year}-{month:02d}-Beacon-English.pdf"
            local_pdf = DOWNLOAD_DIR / pdf_filename

            download_pdf(session, pdf_url, local_pdf)

            # Extract full text
            content = extract_pdf_text(local_pdf)
            logger.info(f"Extracted text length={len(content)} for {pdf_filename}")

            # Upload to storage
            object_path = f"beacon/{year}/{month:02d}/{pdf_filename}"
            upload_pdf_to_storage(sb, args.bucket, object_path, local_pdf)

            # Upsert DB (全項目入れる)
            payload = {
                "title": title,
                "content": content if content else None,
                "source_page_url": english_url,
                "source_pdf_url": pdf_url,
                "published_year": year,
                "published_month": month,
                "pdf_bucket": args.bucket,
                "pdf_path": object_path,
            }
            upsert_article(sb, args.table, payload)

            processed.add(english_url)
            state["processed_english_pages"] = sorted(processed)
            save_state(state)

            done += 1
            if limit is not None and done >= limit:
                logger.info(f"Reached limit={limit}. stopping.")
                break

            logger.info(f"OK: {year}-{month:02d} title='{title}'")

        except Exception as e:
            skipped += 1
            append_skipped({"url": english_url, "reason": "exception", "error": str(e)})
            logger.exception(f"FAILED: {english_url}")

        time.sleep(0.2)
    
    logger.info(f"DONE. processed={done} skipped={skipped}")
    logger.info(f"Skipped log: {SKIPPED_LOG_PATH}")


if __name__ == "__main__":
    main()
