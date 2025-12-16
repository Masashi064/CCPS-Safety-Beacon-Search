# CCPS Safety Beacon Search (CCPS Chaser)

Full-text search + keyword tagging for **CCPS Process Safety Beacon** (English PDFs).  
This project collects monthly Beacon PDFs from the CCPS archive, extracts text, stores it in Supabase (Postgres + Storage), and provides a Next.js UI for searching and reading.

> Internal tool / personal project.

---

## Features

- **Collector (Python)**
  - Crawls CCPS Beacon archive pages (English)
  - Fetches PDF, extracts text
  - Saves article metadata + content to Supabase
  - Uploads PDF to **Supabase Storage** (public bucket supported)

- **Keyword mapping (Python tools)**
  - Builds a keyword → issue mapping from CCPS archive list
  - Applies mappings to Supabase tables (`ccps_keywords`, `ccps_article_keywords`)

- **Frontend (Next.js App Router)**
  - Full-text search (title + content)
  - Live search with highlighted matches
  - Tag filter (keywords)
  - Article detail page with PDF link/embed (via public Storage URL)

---

## Tech Stack

- Python 3 (requests, BeautifulSoup, pdf text extraction, etc.)
- Supabase (Postgres, Storage)
- Next.js (App Router) + TypeScript + TailwindCSS

---

## Project Structure

ccps-chaser/
backend/ # Python collector
tools/ # keyword mapping tools
frontend/ # Next.js app
downloads/ # (local) downloaded files (ignored by git)
logs/ # (local) logs (ignored by git)
state.json # (local) collector state (ignored by git)

yaml
Copy code

---

## Setup

### 1) Clone & install

```bash
git clone https://github.com/Masashi064/CCPS-Safety-Beacon-Search.git
cd CCPS-Safety-Beacon-Search
2) Python venv
bash
Copy code
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -U pip
# install required packages (add requirements.txt later if needed)
3) Supabase env
Create .env (or .env.local depending on script) and set:

SUPABASE_URL

SUPABASE_ANON_KEY

Example:

env
Copy code
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_ANON_KEY=your_anon_key
⚠️ Never commit real keys. Use .env locally and keep it ignored.

Run
Backend collector (example)
bash
Copy code
source .venv/bin/activate
python3 backend/collecter_past.py --max-pages 1 --limit 3 --force
Apply keyword mapping (example)
bash
Copy code
source .venv/bin/activate
python3 tools/apply_ccps_keyword_map.py --map tools/ccps_keyword_map.json --limit-issues 10
Frontend
bash
Copy code
cd frontend
npm install
npm run dev
Open: http://localhost:3000

Supabase Tables (overview)
ccps_chaser_articles

title, content, created_at

source urls, published year/month

pdf_bucket, pdf_path, pdf_public_url

ccps_keywords

ccps_article_keywords (join table)

Notes
PDFs are stored in Supabase Storage bucket (e.g. ccps-pdfs).

The collector supports “trial run” mode (--limit) to avoid processing everything at once.

License
Private / internal use for now.

yaml
Copy code

---

## 3) そのあと commit → push
```bash
git add README.md
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/Masashi064/CCPS-Safety-Beacon-Search.git 2>/dev/null || true
git push -u origin main