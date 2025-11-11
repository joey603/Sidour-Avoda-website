# 📅 Sidour Avoda - Workforce Scheduling System

A comprehensive web-based scheduling and workforce planning application designed for managing shift assignments across multiple sites and stations. The system features an AI-powered planning engine, role-based access control, and a modern Hebrew RTL interface.

![License](https://img.shields.io/badge/license-Proprietary-red)
![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)
![Next.js](https://img.shields.io/badge/Next.js-14+-black.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-green.svg)

---

## 🎯 Overview

**Sidour Avoda** is a full-stack scheduling application that enables directors to manage sites, workers, and generate optimal shift plans using AI-powered optimization. Workers can view their schedules, manage their availability, and track their assignment history.

### Key Features

- 🏢 **Multi-Site Management**: Create and manage multiple sites with custom station configurations
- 👥 **Worker Management**: Add, edit, and manage workers with role assignments and availability tracking
- 🤖 **AI-Powered Planning**: CP-SAT solver generates optimal shift assignments with multiple alternatives
- 📊 **Interactive Planning Grid**: Visual weekly planning interface with drag-and-drop support
- 🔐 **Role-Based Access**: Separate portals for directors and workers with secure authentication
- 📱 **Responsive Design**: Modern UI with Hebrew RTL support and dark mode
- 💾 **Local Storage**: Client-side persistence for weekly availability and saved plans
- 📈 **Real-Time Updates**: Server-Sent Events (SSE) for streaming AI generation progress

---

## 🏗️ Architecture

### Backend (`backend/`)

**Tech Stack:**
- **FastAPI** - Modern Python web framework
- **SQLAlchemy** - ORM for database operations
- **SQLite** - Default database (easily replaceable)
- **OR-Tools (CP-SAT)** - Constraint programming solver for optimization
- **JWT** - Token-based authentication
- **Pydantic** - Data validation and serialization

**Key Components:**
- `main.py` - Application entry point, CORS configuration, database migrations
- `auth.py` - Authentication endpoints (login, register, worker login)
- `sites.py` - Site and worker CRUD operations, AI planning endpoints
- `ai_solver.py` - CP-SAT solver implementation with streaming support
- `public_workers.py` - Public endpoints for worker availability management
- `models.py` - SQLAlchemy database models
- `schemas.py` - Pydantic request/response models

### Frontend (`frontend/web/`)

**Tech Stack:**
- **Next.js 14** - React framework with App Router
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS** - Utility-first CSS framework
- **React Hooks** - State management and lifecycle
- **Sonner** - Toast notifications

**Key Pages:**
- **Director Portal:**
  - Dashboard (`/director`)
  - Sites Management (`/director/sites`)
  - Workers Management (`/director/workers`)
  - Planning Grid (`/director/planning/[id]`)

- **Worker Portal:**
  - Home Dashboard (`/worker`) - View current and next week schedules
  - Availability Registration (`/worker/availability`)
  - Assignment History (`/worker/history`)

- **Authentication:**
  - Director Login/Register (`/login/director`, `/register/director`)
  - Worker Login/Register (`/login/worker`, `/register/worker`)

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.11+
- **Git**

### Installation

#### 1. Clone the Repository

```bash
git clone <repository-url>
cd "Sidour Avoda G1"
```

#### 2. Backend Setup

```bash
# Create virtual environment (recommended)
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
cd backend
pip install -r requirements.txt

# Set environment variables
export DATABASE_URL="sqlite:///./dev.db"
export JWT_SECRET="your-secret-key-here"

# Run the server
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`

#### 3. Frontend Setup

```bash
# Navigate to frontend directory
cd ../frontend/web

# Install dependencies
npm install

# Create environment file
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local

# Run development server
npm run dev
```

The application will be available at `http://localhost:3000`

---

## 📖 Usage Guide

### Director Workflow

1. **Create a Site**
   - Navigate to "רשימת אתרים" (Sites List)
   - Click "הוסף אתר" (Add Site)
   - Configure stations, shifts, and roles

2. **Add Workers**
   - Navigate to "רשימת עובדים" (Workers List)
   - Click "הוסף עובד" (Add Worker)
   - Enter worker name and phone number
   - Set roles and availability

3. **Generate Planning**
   - Open the planning page for a site
   - Adjust worker availability if needed
   - Click "יצירת תכנון" (Create Plan)
   - Review alternatives and save the best plan

4. **Manage Schedules**
   - View saved plans by week
   - Edit saved plans with manual adjustments
   - Delete outdated plans

### Worker Workflow

1. **Register Availability**
   - Navigate to "זמינות" (Availability)
   - Select site and week
   - Mark available shifts
   - Set maximum number of shifts desired
   - Save availability

2. **View Schedule**
   - Home page displays current and next week schedules
   - View all workers and assignments
   - See role assignments and station details

3. **Check History**
   - Navigate to "היסטוריה" (History)
   - Browse past assignments by week
   - View availability requests

---

## 🔧 Configuration

### Site Configuration

Each site can have multiple stations with:
- **Shifts**: Define shift names and hours (e.g., "06-14", "14-22", "22-06")
- **Roles**: Assign roles to stations or shifts (e.g., "מנהל", "עובד")
- **Per-Day Customization**: Override settings for specific days
- **Capacity**: Set required number of workers per shift

### Worker Configuration

- **Roles**: Assign capabilities to workers
- **Availability**: Set weekly availability per day/shift
- **Max Shifts**: Limit maximum shifts per week (1-6)
- **Phone Number**: Required for worker authentication

---

## 🧠 AI Planning Algorithm

The system uses **Google OR-Tools CP-SAT** solver to generate optimal shift assignments:

### Constraints

- ✅ **One shift per day**: Each worker can only be assigned to one shift per day
- ✅ **No adjacent shifts**: Workers cannot work consecutive shifts (including day boundaries)
- ✅ **Max night shifts**: Configurable limit on night shifts per worker (default: 3)
- ✅ **Weekly max shifts**: Respects worker's maximum shifts preference
- ✅ **Role matching**: Assigns workers to roles they can fulfill
- ✅ **Capacity requirements**: Meets minimum worker requirements per shift

### Objectives

- **Fairness**: Distributes shifts evenly among workers
- **Preference**: Prioritizes worker availability preferences
- **Efficiency**: Minimizes gaps and maximizes coverage

### Alternatives

The system generates multiple alternative plans, allowing directors to choose the best option based on their specific needs.

---

## 🔐 Authentication & Security

### Director Authentication
- Email/password or phone/password login
- JWT token-based sessions
- Role-based access control

### Worker Authentication
- Name and phone number login (no password required)
- Simplified authentication flow
- Site-specific access

### Security Features
- Password hashing with bcrypt
- JWT token expiration
- CORS protection
- SQL injection prevention (SQLAlchemy ORM)

---

## 📁 Project Structure

```
Sidour Avoda G1/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, migrations
│   │   ├── auth.py              # Authentication endpoints
│   │   ├── sites.py             # Site/worker CRUD, AI planning
│   │   ├── ai_solver.py         # CP-SAT solver implementation
│   │   ├── public_workers.py    # Public worker endpoints
│   │   ├── models.py            # Database models
│   │   ├── schemas.py           # Pydantic schemas
│   │   ├── deps.py              # Dependency injection
│   │   └── database.py          # Database connection
│   ├── requirements.txt         # Python dependencies
│   └── dev.db                   # SQLite database
│
├── frontend/web/
│   ├── src/
│   │   ├── app/
│   │   │   ├── director/        # Director portal pages
│   │   │   ├── worker/          # Worker portal pages
│   │   │   ├── login/           # Login pages
│   │   │   └── register/        # Registration pages
│   │   ├── components/          # React components
│   │   └── lib/                 # Utilities (API, auth)
│   ├── package.json
│   └── next.config.ts
│
└── README.md
```

---

## 🧪 Development

### Running Tests

```bash
# Backend tests
cd backend
pytest

# Frontend (if tests are added)
cd frontend/web
npm test
```

### Database Migrations

The application includes automatic SQLite migrations in `main.py`:
- Adds `config` column to `sites` table
- Adds `phone` column to `users` table
- Makes `email` nullable in `users` table

### Environment Variables

**Backend:**
- `DATABASE_URL` - Database connection string
- `JWT_SECRET` - Secret key for JWT tokens

**Frontend:**
- `NEXT_PUBLIC_API_URL` - Backend API URL

---

## 🐛 Troubleshooting

### Common Issues

**Backend won't start:**
- Check Python version (3.11+)
- Verify virtual environment is activated
- Ensure all dependencies are installed

**Frontend can't connect to API:**
- Verify `NEXT_PUBLIC_API_URL` in `.env.local`
- Check CORS settings in `backend/app/main.py`
- Ensure backend is running on port 8000

**Database errors:**
- Delete `dev.db` to reset database
- Check migration logs in console

---

## 📝 API Endpoints

### Authentication
- `POST /auth/register` - Register new user
- `POST /auth/login` - Director login
- `POST /auth/worker-login` - Worker login

### Sites
- `GET /director/sites` - List all sites
- `POST /director/sites` - Create site
- `GET /director/sites/{id}` - Get site details
- `PUT /director/sites/{id}` - Update site
- `DELETE /director/sites/{id}` - Delete site

### Workers
- `GET /director/sites/{site_id}/workers` - List workers
- `POST /director/sites/{site_id}/workers` - Add worker
- `PUT /director/sites/{site_id}/workers/{id}` - Update worker
- `DELETE /director/sites/{site_id}/workers/{id}` - Delete worker

### Planning
- `POST /director/sites/{site_id}/ai-generate` - Generate plan (full)
- `POST /director/sites/{site_id}/ai-generate/stream` - Generate plan (SSE)

### Public Worker Endpoints
- `GET /public/sites/worker-sites` - Get worker's sites
- `GET /public/sites/{site_id}/info` - Get site info
- `GET /public/sites/{site_id}/config` - Get site config
- `POST /public/sites/{site_id}/register` - Register/update availability

---

## 🤝 Contributing

This is a proprietary project. For contributions or questions, please contact the project maintainers.

---

## 📄 License

This project is proprietary software. All rights reserved.

---

## 👥 Authors

- Development Team

---

## 🙏 Acknowledgments

- **Google OR-Tools** for the CP-SAT solver
- **FastAPI** team for the excellent framework
- **Next.js** team for the React framework
- **Tailwind CSS** for the utility-first CSS framework

---

## 📞 Support

For support, please contact the development team or create an issue in the repository.

---

**Made with ❤️ for efficient workforce scheduling**
