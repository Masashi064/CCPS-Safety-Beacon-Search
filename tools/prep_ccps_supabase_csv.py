#!/usr/bin/env python3
import argparse
import json
import re
import csv
from pathlib import Path

MONTHS = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December"
]

# 改行(\n)とタブ(\t)以外の制御文字をスペースに置換（DB/JSONで事故りやすい）
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

def clean_text(s: str) -> str:
    if s is None:
        return ""
    s = str(s)

    # 改行を正規化
    s = s.replace("\r\n", "\n").replace("\r", "\n")

    # 実体のNULL文字はDBで事故るので除去
    s = s.replace("\x00", "")

    # JSONの中に「文字列としての \\u0000」が紛れてるケースも念のため除去
    s = re.sub(r"\\u0000", "", s, flags=re.IGNORECASE)

    # その他の制御文字をスペースへ（\n と \t は残す）
    s = CONTROL_RE.sub(" ", s)

    return s

def month_name(mm: int) -> str:
    return MONTHS[mm - 1] if 1 <= mm <= 12 else f"{mm:02d}"

def derive_title(path: Path, obj: dict) -> str:
    # 1) JSON内に title があれば最優先
    if isinstance(obj, dict) and isinstance(obj.get("title"), str) and obj["title"].strip():
        return obj["title"].strip()

    stem = path.stem  # 例: 2001-11-Beacon-English_0

    # 2) ファイル名先頭が YYYY-MM なら「Month YYYY」形式へ
    m = re.match(r"(?P<y>\d{4})-(?P<m>\d{2})", stem)
    if m:
        y = int(m.group("y"))
        mm = int(m.group("m"))
        return f"Process Safety Beacon (English) - {month_name(mm)} {y} [{stem}]"

    # 3) それ以外はファイル名をそのまま
    return stem

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_dir", default=str(Path.home() / "Downloads"))
    ap.add_argument("--out", dest="out_csv", default="ccps_chaser_articles.csv")
    args = ap.parse_args()

    in_dir = Path(args.in_dir).expanduser()
    files = sorted(in_dir.glob("*.json"))

    if not files:
        raise SystemExit(f"No .json files found in: {in_dir}")

    rows = []
    for p in files:
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))

            title = clean_text(derive_title(p, obj))

            content = obj.get("content", "")
            content = clean_text(content)

            # title/content 以外は出力しない（Supabase手動import用）
            rows.append({"title": title, "content": content})
        except Exception as e:
            print(f"[SKIP] {p.name}: {e}")

    out_path = Path(args.out_csv).expanduser()
    with out_path.open("w", encoding="utf-8", newline="") as f:
        # SupabaseのCSV importで壊れにくい設定：
        # - 全フィールドを必ず "..." で囲む
        # - ダブルクォートは "" にする（標準）
        w = csv.DictWriter(
            f,
            fieldnames=["title", "content"],
            extrasaction="ignore",
            quoting=csv.QUOTE_ALL,
            doublequote=True,
            lineterminator="\n",
        )
        w.writeheader()
        for r in rows:
            w.writerow({
                "title": r.get("title", ""),
                "content": r.get("content", ""),
            })

    print(f"OK: wrote {len(rows)} rows -> {out_path}")

if __name__ == "__main__":
    main()
