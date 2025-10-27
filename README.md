Sidour Avoda – Scheduling Web App (Frontend + Backend)

Overview
Sidour Avoda is a scheduling and workforce planning application. It provides a Director portal to manage sites, stations, workers and generate weekly shift plans. The system includes:
- Backend: FastAPI + SQLAlchemy (SQLite by default), with authentication and AI planning endpoints.
- Frontend: Next.js (App Router) + React + Tailwind CSS, with RTL (Hebrew) UI and authenticated pages.

Key Features
- Sites management: create, edit, delete sites with per-station settings.
- Per-day customization: optionally tailor active days and shift requirements for each station.
- Worker management: add/edit/delete workers, role assignment, availability per day/shift, duplicate name protection per site.
- Planning grid: weekly per-station grids with required vs. assigned counts, colored worker “pills”, inactive-day graying, and sticky actions.
- AI planning: CP-SAT (OR-Tools) backend solver to compute base plan and stream alternatives via SSE.
- Alternatives navigation: base and multiple alternatives, progressively appended as the stream arrives.
- Auth handling: redirects to login on 401; navbar adapts to auth state.

Tech Stack
- Backend: Python 3.11+, FastAPI, SQLAlchemy, Pydantic, Uvicorn, OR-Tools
- Frontend: Next.js 14+, React 18, TypeScript, Tailwind CSS
- DB: SQLite for development (dev.db), easily replaceable

Repository Layout
- backend/: FastAPI application
  - app/
    - main.py (app entry, CORS)
    - auth.py, deps.py (auth/role deps)
    - models.py (SQLAlchemy models with unique constraints)
    - schemas.py (Pydantic models)
    - sites.py (site/worker CRUD + AI endpoints + SSE)
    - ai_solver.py (CP-SAT solver and streaming generator)
  - requirements.txt
  - dev.db (local dev database)
- frontend/web/: Next.js app
  - src/app/
    - director/ (dashboard, sites, planning pages)
    - login/, register/
    - layout.tsx (Toaster + TopNav)
  - src/lib/ (api/auth utils)
  - src/components/ (UI primitives, top nav)

Local Development
Prerequisites
- Node.js 18+ and npm
- Python 3.11+

Backend Setup
1) Create and activate virtualenv (optional but recommended)
   python3 -m venv .venv
   source .venv/bin/activate

2) Install dependencies
   pip install -r backend/requirements.txt

3) Run the API
   cd backend
   export DATABASE_URL="sqlite:///./dev.db"
   export JWT_SECRET="dev-secret"
   uvicorn app.main:app --host 0.0.0.0 --port 8000

Frontend Setup
1) Install deps
   cd frontend/web
   npm install

2) Configure API base URL (dev)
   Create .env.local with:
   NEXT_PUBLIC_API_URL=http://localhost:8000

3) Run dev server
   npm run dev
   App will be available on http://localhost:3000

Authentication
- JWT-based. On 401 responses, the frontend clears tokens and redirects to /login.
- Director role can access the Director dashboard, sites, and planning pages.

AI Planning
- Endpoint: POST /director/sites/{site_id}/ai-generate (full result)
- Streaming: POST or GET /director/sites/{site_id}/ai-generate/stream
  - Streams base plan then alternatives as SSE frames.
  - Query params supported: num_alternatives, time_limit_seconds, max_nights_per_worker

Notable Constraints & Rules
- Unique worker names per site (DB + API validation)
- Max 3 night shifts per worker (configurable)
- One shift per day per worker across stations
- No adjacent shifts (including day boundary)
- Weekly max shifts per worker; fairness objective favors balanced assignments

Build/Deploy Notes
- The backend is self-contained and runs with SQLite by default; switch DATABASE_URL for other DBs.
- The frontend expects NEXT_PUBLIC_API_URL to point to the FastAPI server with proper CORS.

License
This project is provided as-is for demonstration and internal use. Add a proper license if distributing.


