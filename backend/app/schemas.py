from pydantic import BaseModel, Field, field_validator
from typing import Literal, Any


class UserBase(BaseModel):
    email: str | None = None
    full_name: str
    role: Literal["worker", "director"]
    phone: str | None = None


class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=72)


class UserOut(BaseModel):
    id: int
    email: str | None = None
    full_name: str
    role: Literal["worker", "director"]
    phone: str | None = None
    director_code: str | None = None

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: str | None = None
    password: str
    phone: str | None = None


class WorkerLoginRequest(BaseModel):
    code: str
    phone: str
    invite_token: str | None = None


class WorkerInviteLinkOut(BaseModel):
    token: str
    invite_path: str


class WorkerInviteValidationOut(BaseModel):
    site_id: int
    site_name: str
    director_name: str
    director_code: str


class WorkerInviteRegistrationPayload(BaseModel):
    token: str
    full_name: str = Field(min_length=2, max_length=255)
    phone: str = Field(min_length=5, max_length=32)


class WorkerInviteRegistrationOut(BaseModel):
    ok: bool = True
    already_exists: bool = False
    site_id: int
    site_name: str
    director_code: str
    phone: str


class WorkerInviteClaimPayload(BaseModel):
    token: str


class WorkerInviteClaimOut(BaseModel):
    ok: bool = True
    created: bool = False
    site_id: int
    site_name: str


class SiteCreate(BaseModel):
    name: str
    config: dict | None = None


class NextWeekSavedPlanStatus(BaseModel):
    exists: bool = False
    week_iso: str | None = None
    complete: bool | None = None
    assigned_count: int = 0
    required_count: int = 0
    pulls_count: int = 0
    scope: Literal["auto", "director", "shared"] | None = None
    requires_manual_save: bool = False


class SiteOut(BaseModel):
    id: int
    name: str
    workers_count: int
    pending_workers_count: int = 0
    config: dict | None = None
    next_week_saved_plan_status: NextWeekSavedPlanStatus | None = None
    linked_site_ids: list[int] = Field(
        default_factory=list,
        description="Même groupe multi-sites (≥2 sites) : ids triés ; vide si site seul.",
    )
    # epoch ms si site soft-deleted ; None = site actif
    deleted_at: int | None = None

class SiteUpdate(BaseModel):
    name: str | None = None
    config: dict | None = None


class WorkerBase(BaseModel):
    name: str
    max_shifts: int = 5
    roles: list[str] = []
    availability: dict[str, list[str]] = {}
    answers: dict[str, Any] = {}
    phone: str | None = None


class WorkerCreate(WorkerBase):
    week_iso: str | None = None


class WorkerUpdate(BaseModel):
    name: str
    max_shifts: int = 5
    roles: list[str] = []
    availability: dict[str, list[str]] | None = None
    answers: dict[str, Any] | None = None
    phone: str | None = None
    week_iso: str | None = None
    weekly_availability: dict[str, list[str]] | None = None
    propagate_linked_availability: bool = False


class WorkerOut(WorkerBase):
    id: int
    site_id: int
    created_at: int | None = None
    linked_site_ids: list[int] = []
    linked_site_names: list[str] = []
    pending_approval: bool = False
    site_name: str | None = None
    site_deleted: bool = False
    removed_from_week_iso: str | None = None
    removed_by_planning: bool = False


class WorkerContextQuestion(BaseModel):
    id: str
    label: str
    type: Literal["text", "dropdown", "yesno", "slider"]
    perDay: bool = False
    options: list[str] = []
    slider: dict[str, Any] | None = None
    source_site_id: int
    source_site_name: str
    original_id: str


class WorkerContextOut(BaseModel):
    worker_name: str
    sites: list[dict[str, Any]] = []
    shifts: list[str] = []
    questions: list[WorkerContextQuestion] = []
    availability: dict[str, list[str]] = {}
    answers: dict[str, Any] = {}
    max_shifts: int = 5


class WorkerContextUpdatePayload(BaseModel):
    max_shifts: int = 5
    availability: dict[str, list[str]] = {}
    answers: dict[str, Any] = {}


class CreateWorkerUserRequest(BaseModel):
    name: str
    phone: str


class WeeklyAvailabilityPayload(BaseModel):
    # YYYY-MM-DD (week start)
    week_iso: str = Field(min_length=10, max_length=10, description="YYYY-MM-DD (week start)")
    # { workerName: { sun: [...], mon: [...], ... } }
    availability: dict[str, dict[str, list[str]]] = {}


class AutoPlanningConfigPayload(BaseModel):
    enabled: bool = False
    day_of_week: int = Field(default=0, ge=0, le=6)
    hour: int = Field(default=9, ge=0, le=23)
    minute: int = Field(default=0, ge=0, le=59)
    auto_pulls_enabled: bool = False
    auto_save_mode: Literal["manual", "director", "shared"] = "manual"
    # Même limite pour tous les sites, ou dict par id de site (clés string). Max 30 משיכות.
    pulls_limit: int | None = Field(default=None, ge=1, le=30)
    pulls_limits_by_site: dict[str, int | None] | None = None

    @field_validator("pulls_limits_by_site", mode="before")
    @classmethod
    def cap_pulls_limits_by_site(cls, v: object) -> dict[str, int] | None:
        if v is None or not isinstance(v, dict):
            return None
        out: dict[str, int] = {}
        for k, raw in v.items():
            if raw is None:
                continue
            try:
                n = int(raw)
            except (TypeError, ValueError):
                continue
            out[str(k)] = max(1, min(30, n))
        return out or None


class AutoPlanningConfigOut(AutoPlanningConfigPayload):
    last_run_week_iso: str | None = None
    last_run_at: int | None = None
    last_error: str | None = None
    next_run_at: int | None = None
    target_week_iso: str | None = None


class WeekPlanPayload(BaseModel):
    # YYYY-MM-DD (week start)
    week_iso: str = Field(min_length=10, max_length=10, description="YYYY-MM-DD (week start)")
    scope: Literal["auto", "director", "shared"] = "director"
    # Payload JSON (même structure que le localStorage historique)
    data: dict | None = None


class AIPlanningRequest(BaseModel):
    week_iso: str | None = None
    time_limit_seconds: int | None = 10
    max_nights_per_worker: int | None = 3
    num_alternatives: int | None = 20
    auto_pulls_enabled: bool = False
    pulls_limit: int | None = Field(default=None, ge=1)
    pulls_limits_by_site: dict[str, int | None] | None = None
    # Optional map of fixed assignments: assignments[day][shift][station_index] -> list[str]
    fixed_assignments: dict[str, dict[str, list[list[str]]]] | None = None
    # Optional: exclude specific day keys from planning (e.g., past days of the current week)
    exclude_days: list[str] | None = None
    # Optional: per-week availability overrides by worker name
    weekly_availability: dict[str, dict[str, list[str]]] | None = None


class AIPlanningCell(BaseModel):
    # liste de noms de travailleurs affectés à cette station pour ce day/shift
    names: list[str] = []


class AIPlanningResponse(BaseModel):
    days: list[str]
    shifts: list[str]
    stations: list[str]
    # assignments[day][shift][station_index] -> list[str]
    assignments: dict[str, dict[str, list[list[str]]]]
    alternatives: list[dict[str, dict[str, list[list[str]]]]] | None = None
    pulls: dict | None = None
    alternative_pulls: list[dict] | None = None
    status: str
    objective: float


class SiteMessageBase(BaseModel):
    text: str
    scope: Literal["global", "week"]
    week_iso: str = Field(min_length=10, max_length=10, description="YYYY-MM-DD (week start)")


class SiteMessageCreate(SiteMessageBase):
    pass


class SiteMessageUpdate(BaseModel):
    text: str | None = None
    scope: Literal["global", "week"] | None = None
    week_iso: str = Field(min_length=10, max_length=10, description="YYYY-MM-DD (week start)")


class SiteMessageOut(BaseModel):
    id: int
    site_id: int
    text: str
    scope: Literal["global", "week"]
    created_week_iso: str
    stopped_week_iso: str | None = None
    origin_id: int | None = None
    created_at: int
    updated_at: int

    class Config:
        from_attributes = True

