#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

source "$ROOT/.venv/bin/activate"

mkdir -p "$ROOT/logs"

# 1) 情報収集（stdoutを拾って新規件数を取得）
NEW_COUNT=$(
  python3 backend/collecter_past.py 2>&1 | tee -a "$ROOT/logs/run_all.log" \
  | awk 'match($0,/DONE\. processed=([0-9]+)/,m){n=m[1]} END{print n+0}'
)

echo "[INFO] new articles processed: $NEW_COUNT" | tee -a "$ROOT/logs/run_all.log"

# 2) Keyword map（新規があった時 or 初回で map が無い時だけ）
if [ "$NEW_COUNT" -gt 0 ] || [ ! -f "$ROOT/tools/ccps_keyword_map.json" ]; then
  python3 tools/fetch_ccps_keyword_map.py --out tools/ccps_keyword_map.json
else
  echo "[INFO] skip fetch_ccps_keyword_map.py (no new articles)" | tee -a "$ROOT/logs/run_all.log"
fi

# 3) 紐付け（mapがある前提。apply はデフォルトで tools/ccps_keyword_map.json を読む）:contentReference[oaicite:2]{index=2}
python3 tools/apply_ccps_keyword_map.py

