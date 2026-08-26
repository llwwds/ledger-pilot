from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest
from fastapi.middleware.cors import CORSMiddleware

from app.main import create_app
from app.settings import DEFAULT_CONFIG_PATH, ensure_local_config, load_local_settings


def test_missing_local_config_is_created_from_safe_defaults(tmp_path: Path) -> None:
    local = tmp_path / "config.local.json"

    assert ensure_local_config(local) == local
    assert json.loads(local.read_text(encoding="utf-8")) == json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    assert stat.S_IMODE(local.stat().st_mode) == 0o600


def test_existing_empty_config_is_preserved_and_uses_memory_defaults(tmp_path: Path) -> None:
    local = tmp_path / "config.local.json"
    local.write_text("", encoding="utf-8")

    settings = load_local_settings(local)

    assert local.read_text(encoding="utf-8") == ""
    assert settings.data_dir.name == "data"
    assert settings.database_url == ""
    assert "http://localhost:5173" in settings.cors_origins


def test_partial_user_config_is_not_backfilled_on_disk(tmp_path: Path) -> None:
    local = tmp_path / "config.local.json"
    original = '{"cors_origins": ["http://127.0.0.1:9000"]}\n'
    local.write_text(original, encoding="utf-8")

    settings = load_local_settings(local)

    assert local.read_text(encoding="utf-8") == original
    assert settings.database_url == ""
    assert settings.cors_origins == ("http://127.0.0.1:9000",)


def test_unknown_config_field_fails_loudly(tmp_path: Path) -> None:
    local = tmp_path / "config.local.json"
    local.write_text('{"private_path": "unexpected"}', encoding="utf-8")

    with pytest.raises(RuntimeError, match="未知字段"):
        load_local_settings(local)


def test_explicit_values_override_invalid_local_fields(tmp_path: Path) -> None:
    local = tmp_path / "config.local.json"
    original = '{"data_dir": null, "database_url": 7, "cors_origins": "invalid"}'
    local.write_text(original, encoding="utf-8")

    settings = load_local_settings(
        local,
        data_dir=tmp_path / "runtime",
        database_url="sqlite:///override.db",
        cors_origins=(),
    )

    assert local.read_text(encoding="utf-8") == original
    assert settings.data_dir == (tmp_path / "runtime").resolve()
    assert settings.database_url == "sqlite:///override.db"
    assert settings.cors_origins == ()


def test_relative_data_dir_uses_backend_root_for_every_source(tmp_path: Path) -> None:
    local = tmp_path / "config.local.json"
    local.write_text("{}", encoding="utf-8")

    settings = load_local_settings(local, data_dir="runtime-data")

    assert settings.data_dir.name == "runtime-data"
    assert settings.data_dir.parent == DEFAULT_CONFIG_PATH.parent


def test_create_app_environment_overrides_local_and_empty_database_uses_data_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    local = tmp_path / "config.local.json"
    local.write_text(json.dumps({
        "data_dir": "local-data",
        "database_url": "sqlite:///must-not-be-used.db",
        "cors_origins": ["http://local.invalid"],
    }), encoding="utf-8")
    runtime = tmp_path / "environment-data"
    monkeypatch.setenv("LEDGER_PILOT_CONFIG_FILE", str(local))
    monkeypatch.setenv("LEDGER_PILOT_DATA_DIR", str(runtime))
    monkeypatch.setenv("LEDGER_PILOT_DATABASE_URL", "")
    monkeypatch.setenv("LEDGER_PILOT_CORS_ORIGINS", "")

    application = create_app()

    assert application.state.data_root == runtime.resolve()
    assert str(application.state.engine.url) == f"sqlite:///{runtime.resolve() / 'bookkeeping.db'}"
    cors = next(item for item in application.user_middleware if item.cls is CORSMiddleware)
    assert cors.kwargs["allow_origins"] == []
    application.state.engine.dispose()
