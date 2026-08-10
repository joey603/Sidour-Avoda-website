"""Aggregate director sites API router."""

from fastapi import APIRouter

from . import availability
from . import week_plans
from . import messages
from . import events
from . import sites_crud
from . import workers
from . import auto_planning
from . import linked_sites
from . import ai_generate

router = APIRouter(prefix="/director/sites", tags=["sites"])

# Order matters: static paths (settings, all-workers) before /{site_id} where needed.
router.include_router(auto_planning.router)
router.include_router(availability.router)
router.include_router(week_plans.router)
router.include_router(messages.router)
router.include_router(events.router)
router.include_router(sites_crud.router)
router.include_router(workers.router)
router.include_router(linked_sites.router)
router.include_router(ai_generate.router)
