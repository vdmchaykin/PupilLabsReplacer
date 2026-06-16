# PupilLabsReplacer

A desktop application for processing and analysing eye-tracking recordings from Pupil Labs devices. Built with Tauri 2 (Rust), React + TypeScript (Vite), and a Python FastAPI backend.

## Architecture

| Layer | Stack | Dev port |
|---|---|---|
| Desktop shell | Tauri 2 (Rust) | — |
| Frontend | React 19 + TypeScript + Tailwind | 1420 |
| Backend API | Python FastAPI + Uvicorn | 8765 |

---

## Prerequisites

| Tool | Minimum version | Install |
|---|---|---|
| Node.js | 18 | https://nodejs.org |
| Rust + Cargo | 1.70 | https://rustup.rs |
| Python | 3.11+ | https://python.org |

On Linux, Tauri also requires a few system libraries:

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

---

## Setup (first time only)

### 1. Install frontend dependencies

```bash
npm install
```

### 2. Set up the Python backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

---

## Running in development

You need **two terminals** running at the same time.

### Terminal 1 — Backend

```bash
cd backend
source venv/bin/activate        # Windows: venv\Scripts\activate
uvicorn app.main:app --port 8765 --reload
```

The API will be available at `http://localhost:8765`.  
Interactive docs: `http://localhost:8765/docs`

### Terminal 2 — Desktop app (Tauri)

```bash
npm run tauri dev
```

This compiles the Rust shell and opens the desktop window.  
The first build takes a few minutes; subsequent builds are fast.

> **Note:** Start the backend before the Tauri app, otherwise API calls will fail on startup.

---

## Building for production

```bash
# Make sure the venv is activated and dependencies are installed
npm run tauri build
```

The installer / binary is placed in `src-tauri/target/release/bundle/`.

---

## Project structure

```
PupilLabsReplacer/
├── src/                  # React frontend (TypeScript)
│   ├── pages/            # Page components (Projects, Gaze, Events, AoI, …)
│   ├── components/       # Shared UI components
│   └── lib/api.ts        # API client (base URL: http://localhost:8765)
├── src-tauri/            # Tauri / Rust shell
├── backend/
│   ├── app/
│   │   ├── main.py       # FastAPI entry point
│   │   ├── api/routes/   # REST endpoints
│   │   ├── services/     # Business logic
│   │   └── database.py   # SQLite via aiosqlite
│   ├── requirements.txt
│   └── venv/             # Python virtual environment (not committed)
└── data/
    └── recordings/       # Imported recording folders
```

---

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with the following extensions:

- [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
- [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) — point the interpreter to `backend/venv`
