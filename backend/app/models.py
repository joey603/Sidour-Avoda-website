from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy import String, Enum, ForeignKey, Integer, JSON, UniqueConstraint
import enum

from .database import Base


class UserRole(str, enum.Enum):
    worker = "worker"
    director = "director"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), nullable=False)
    phone: Mapped[str] = mapped_column(String(20), unique=True, index=True, nullable=True)


class Site(Base):
    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    director_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    config: Mapped[dict] = mapped_column(JSON, nullable=True)


class SiteAssignment(Base):
    __tablename__ = "site_assignments"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), index=True)
    worker_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    hours_per_week: Mapped[int] = mapped_column(Integer, default=0)


class SiteWorker(Base):
    __tablename__ = "site_workers"
    __table_args__ = (
        UniqueConstraint("site_id", "name", name="uq_site_workers_site_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    max_shifts: Mapped[int] = mapped_column(Integer, default=5)
    roles: Mapped[dict] = mapped_column(JSON, default=list)  # list[str]
    availability: Mapped[dict] = mapped_column(JSON, default=dict)  # {dayKey: [shiftName]}
    answers: Mapped[dict] = mapped_column(JSON, default=dict)  # {questionId: answer}

