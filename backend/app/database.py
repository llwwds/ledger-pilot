from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def default_database_url() -> str:
    backend_root = Path(__file__).resolve().parents[1]
    database_path = backend_root / "data" / "bookkeeping.db"
    database_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{database_path}"


def build_engine(database_url: str | None = None) -> Engine:
    url = database_url or os.getenv("LEDGER_PILOT_DATABASE_URL") or default_database_url()
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args)


def build_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
