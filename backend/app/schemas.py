from pydantic import BaseModel, EmailStr, Field
from typing import Literal


class UserBase(BaseModel):
    email: EmailStr
    full_name: str
    role: Literal["worker", "director"]


class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=72)


class UserOut(BaseModel):
    id: int
    email: EmailStr
    full_name: str
    role: Literal["worker", "director"]

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class SiteCreate(BaseModel):
    name: str
    config: dict | None = None


class SiteOut(BaseModel):
    id: int
    name: str
    workers_count: int
    config: dict | None = None

class SiteUpdate(BaseModel):
    name: str | None = None
    config: dict | None = None


class WorkerBase(BaseModel):
    name: str
    max_shifts: int = 5
    roles: list[str] = []
    availability: dict[str, list[str]] = {}


class WorkerCreate(WorkerBase):
    pass


class WorkerUpdate(WorkerBase):
    pass


class WorkerOut(WorkerBase):
    id: int
    site_id: int


class AIPlanningRequest(BaseModel):
    time_limit_seconds: int | None = 10
    max_nights_per_worker: int | None = 3
    num_alternatives: int | None = 20
    # Optional map of fixed assignments: assignments[day][shift][station_index] -> list[str]
    fixed_assignments: dict[str, dict[str, list[list[str]]]] | None = None


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
    status: str
    objective: float

