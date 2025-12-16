from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from PyPDF2 import PdfReader

ARCHIVES_ROOT = "https://ccps.aiche.org/resources/process-safety-beacon/archives/"
UA = "ccps-chaser/1.0 (+https://example.local)"  # 何でもOK、礼儀として付ける

# --- 保存先（この main.py がある場所を基準にするので、実行ディレクトリに依存しない） ---
BASE_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
STATE_PATH = BASE_DIR / "state.json"
LOG_DIR = BASE_DIR / "logs"
LOG_PATH = LOG_DIR / "run.log"


@dataclass(frozen=True)
class Item:
    english_page_url: str
    pdf_url: str


def process_article(year, month):
    # Construct the URL for the article
    article_url = f"{ARCHIVES_ROOT}{year}/{month:02d}/english"
    
    logging.info(f"Processing article for {year}-{month:02d}...")
    
    # Fetch the English page
    session = get_session()
    pdf_url = extract_pdf_url_from_english_page(session, article_url)
    
    if pdf_url:
        logging.info(f"Found PDF: {pdf_url}")
        # Proceed with downloading and processing the PDF
        pdf_name = safe_filename_from_pdf_url(pdf_url)
        pdf_path = DOWNLOAD_DIR / pdf_name
        json_path = DOWNLOAD_DIR / (pdf_name.replace(".pdf", ".json"))
        
        if download_file(session, pdf_url, pdf_path):
            text = extract_pdf_text(pdf_path)
            write_json(text, json_path, meta={"english_page_url": article_url, "pdf_url": pdf_url})
    else:
        logging.warning(f"No PDF found for {year}-{month:02d}")



def setup_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(LOG_PATH, encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )


def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {"processed_pdf_urls": []}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def get_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    return s


def fetch_html(session: requests.Session, url: str) -> str:
    try:
        r = session.get(url, timeout=30)
        r.raise_for_status()  # HTTPエラーがあれば例外を投げる
    except requests.exceptions.HTTPError as e:
        # 404エラーの場合はスキップ
        if r.status_code == 404:
            logging.warning(f"SKIP (404 not found): {url}")
        else:
            logging.error(f"HTTPError occurred for {url}: {e}")
        return ""  # 空文字列を返す
    return r.text

# 月番号を英語の月名に変換する関数
def month_to_name(month: int) -> str:
    month_names = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december"
    ]
    return month_names[month - 1]

def process_article(year, month):
    # 英語の月名に変換
    month_name = month_to_name(month)
    
    # Construct the URL for the article
    article_url = f"{ARCHIVES_ROOT}{year}/{month_name}/english"
    
    logging.info(f"Processing article for {year}-{month_name}...")
    
    # Fetch the English page
    session = get_session()
    pdf_url = extract_pdf_url_from_english_page(session, article_url)
    
    if pdf_url:
        logging.info(f"Found PDF: {pdf_url}")
        # Proceed with downloading and processing the PDF
        pdf_name = safe_filename_from_pdf_url(pdf_url)
        pdf_path = DOWNLOAD_DIR / pdf_name
        json_path = DOWNLOAD_DIR / (pdf_name.replace(".pdf", ".json"))
        
        if download_file(session, pdf_url, pdf_path):
            text = extract_pdf_text(pdf_path)
            write_json(text, json_path, meta={"english_page_url": article_url, "pdf_url": pdf_url})
    else:
        logging.warning(f"No PDF found for {year}-{month_name}")



def discover_english_pages(session: requests.Session) -> list[str]:
    """
    archives 直下から、/YYYY/<month>/english のページURLを全部集める。
    （将来 HTML 構造が多少変わっても、リンクがある限り拾える）
    """
    html = fetch_html(session, ARCHIVES_ROOT)
    soup = BeautifulSoup(html, "html.parser")

    pages = set()
    for a in soup.select("a[href]"):
        href = a.get("href", "")
        full = urljoin(ARCHIVES_ROOT, href)

        # 例: .../archives/2025/december/english
        if re.search(r"/resources/process-safety-beacon/archives/\d{4}/[^/]+/english/?$", full):
            pages.add(full.rstrip("/"))

    # もし直下に全部無い場合に備えて、年ページも辿る（保険）
    year_pages = set()
    for a in soup.select("a[href]"):
        full = urljoin(ARCHIVES_ROOT, a.get("href", ""))
        if re.search(r"/resources/process-safety-beacon/archives/\d{4}/?$", full):
            year_pages.add(full.rstrip("/"))

    for yp in sorted(year_pages):
        try:
            yhtml = fetch_html(session, yp)
        except Exception as e:
            logging.warning(f"Year page fetch failed: {yp} ({e})")
            continue
        ysoup = BeautifulSoup(yhtml, "html.parser")
        for a in ysoup.select("a[href]"):
            full = urljoin(yp + "/", a.get("href", ""))
            if re.search(r"/resources/process-safety-beacon/archives/\d{4}/[^/]+/english/?$", full):
                pages.add(full.rstrip("/"))

    return sorted(pages)


def extract_pdf_url_from_english_page(session: requests.Session, english_page_url: str) -> str | None:
    """
    “Click here to download” のリンクを最優先で探す。
    見つからない場合は .pdf リンクを総当たりで拾う（保険）。
    """
    html = fetch_html(session, english_page_url)
    soup = BeautifulSoup(html, "html.parser")

    # 1) 文字列マッチ（最優先）
    for a in soup.select("a[href]"):
        text = (a.get_text() or "").strip().lower()
        if "click here to download" in text or ("download" in text and "click" in text):
            return urljoin(english_page_url + "/", a["href"])

    # 2) それっぽいPDFを拾う（保険：将来文言が変わっても対応しやすい）
    pdf_candidates = []
    for a in soup.select("a[href]"):
        href = a.get("href", "")
        if href.lower().endswith(".pdf"):
            pdf_candidates.append(urljoin(english_page_url + "/", href))

    # なるべく “beacon” “english” っぽいものを優先
    for u in pdf_candidates:
        lu = u.lower()
        if "beacon" in lu and "english" in lu:
            return u
    return pdf_candidates[0] if pdf_candidates else None


def safe_filename_from_pdf_url(pdf_url: str) -> str:
    # URL末尾のファイル名を使う
    name = pdf_url.split("/")[-1]
    # 念のため変な文字を除去
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
    return name


def download_file(session: requests.Session, url: str, path: Path) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)

    r = session.get(url, stream=True, timeout=60)
    if r.status_code != 200:
        logging.info(f"SKIP (not found) url={url} status={r.status_code}")
        return False

    with open(path, "wb") as f:
        for chunk in r.iter_content(chunk_size=1024 * 256):
            if chunk:
                f.write(chunk)

    logging.info(f"DOWNLOADED {path.name}")
    return True


def extract_pdf_text(pdf_path: Path) -> str:
    reader = PdfReader(str(pdf_path))
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)


def write_json(text: str, out_path: Path, meta: dict) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": meta,
        "content": text,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

# 過去の記事を処理（例：2001年1月～2025年12月分）
def process_past_articles(start_year, start_month, end_year, end_month):
    current_year = start_year
    current_month = start_month

    # 現在の年と月に基づいてループを開始
    while (current_year < end_year) or (current_year == end_year and current_month <= end_month):
        process_article(current_year, current_month)

        # 月を進める
        if current_month == 12:
            current_month = 1
            current_year += 1
        else:
            current_month += 1

# 2001年1月から2025年12月までを処理
process_past_articles(2001, 1, 2025, 12)

def run_backfill_and_update() -> None:
    setup_logging()
    state = load_state()
    processed = set(state.get("processed_pdf_urls", []))

    session = get_session()

    logging.info("Discovering english pages...")
    english_pages = discover_english_pages(session)
    logging.info(f"Found english pages: {len(english_pages)}")

    skipped_pages = []

    for idx, ep in enumerate(english_pages, start=1):
        logging.info(f"[{idx}/{len(english_pages)}] page={ep}")

        try:
            pdf_url = extract_pdf_url_from_english_page(session, ep)
        except Exception as e:
            logging.warning(f"SKIP (page fetch/parse failed): {ep} ({e})")
            skipped_pages.append({"english_page": ep, "reason": "page_fetch_or_parse_failed"})
            continue

        if not pdf_url:
            logging.info(f"SKIP (no pdf link found): {ep}")
            skipped_pages.append({"english_page": ep, "reason": "no_pdf_link"})
            continue

        if pdf_url in processed:
            logging.info(f"SKIP (already processed): {pdf_url}")
            continue

        pdf_name = safe_filename_from_pdf_url(pdf_url)
        pdf_path = DOWNLOAD_DIR / pdf_name
        json_path = DOWNLOAD_DIR / (pdf_name.replace(".pdf", ".json"))

        ok = download_file(session, pdf_url, pdf_path)
        if not ok:
            skipped_pages.append({"english_page": ep, "pdf_url": pdf_url, "reason": "pdf_not_found"})
            continue

        try:
            text = extract_pdf_text(pdf_path)
        except Exception as e:
            logging.warning(f"SKIP (pdf text extract failed): {pdf_path.name} ({e})")
            skipped_pages.append({"english_page": ep, "pdf_url": pdf_url, "reason": "pdf_extract_failed"})
            continue

        write_json(
            text=text,
            out_path=json_path,
            meta={"english_page_url": ep, "pdf_url": pdf_url},
        )

        processed.add(pdf_url)
        state["processed_pdf_urls"] = sorted(processed)
        save_state(state)

        # サーバーに優しく（負荷軽減）
        time.sleep(1.0)

    # スキップ一覧を最後にまとめて保存（「いつ」が後で追える）
    skip_log_path = LOG_DIR / "skipped.json"
    skip_log_path.write_text(json.dumps(skipped_pages, indent=2), encoding="utf-8")
    logging.info(f"Skipped pages: {len(skipped_pages)} -> {skip_log_path}")
    logging.info("DONE")


if __name__ == "__main__":
    run_backfill_and_update()