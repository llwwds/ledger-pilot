from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = BACKEND_ROOT / "config.default.json"
LOCAL_CONFIG_PATH = BACKEND_ROOT / "config.local.json"
ALLOWED_KEYS = {"data_dir", "database_url", "cors_origins"}


@dataclass(frozen=True)
class LocalSettings:
    data_dir: Path
    database_url: str
    cors_origins: tuple[str, ...]


def _read_object(path: Path, *, allow_empty: bool = False) -> dict[str, object]:
    content = path.read_text(encoding="utf-8")
    if allow_empty and not content.strip():
        return {}
    try:
        value = json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"配置文件不是有效 JSON: {path}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"配置文件顶层必须是对象: {path}")
    unknown = set(value) - ALLOWED_KEYS
    if unknown:
        raise RuntimeError(f"配置文件包含未知字段: {', '.join(sorted(unknown))}")
    return value


def ensure_local_config(path: Path = LOCAL_CONFIG_PATH) -> Path:
    """Create safe local defaults only when the whole user config is absent."""
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    defaults = DEFAULT_CONFIG_PATH.read_text(encoding="utf-8")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(defaults)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary_path, path)
        except FileExistsError:
            pass
    finally:
        temporary_path.unlink(missing_ok=True)
    return path


def load_local_settings(
    path: Path | None = None,
    *,
    data_dir: str | Path | None = None,
    database_url: str | None = None,
    cors_origins: list[str] | tuple[str, ...] | None = None,
) -> LocalSettings:
    configured_path = path or Path(os.getenv("LEDGER_PILOT_CONFIG_FILE") or LOCAL_CONFIG_PATH).expanduser()
    if not configured_path.is_absolute():
        configured_path = Path.cwd() / configured_path
    config_path = ensure_local_config(configured_path)
    defaults = _read_object(DEFAULT_CONFIG_PATH)
    user = _read_object(config_path, allow_empty=True)
    merged = {**defaults, **user}

    if data_dir is not None:
        merged["data_dir"] = str(data_dir)
    if database_url is not None:
        merged["database_url"] = database_url
    if cors_origins is not None:
        merged["cors_origins"] = list(cors_origins)

    data_dir_value = merged.get("data_dir")
    database_url = merged.get("database_url")
    cors_origins = merged.get("cors_origins")
    if not isinstance(data_dir_value, str) or not data_dir_value.strip():
        raise RuntimeError("data_dir 必须是非空字符串")
    if not isinstance(database_url, str):
        raise RuntimeError("database_url 必须是字符串；留空表示使用 data_dir 下的 SQLite")
    if not isinstance(cors_origins, list) or not all(isinstance(item, str) and item.strip() for item in cors_origins):
        raise RuntimeError("cors_origins 必须是字符串数组")

    data_dir = Path(data_dir_value).expanduser()
    if not data_dir.is_absolute():
        data_dir = BACKEND_ROOT / data_dir
    return LocalSettings(
        data_dir=data_dir.resolve(),
        database_url=database_url.strip(),
        cors_origins=tuple(item.strip() for item in cors_origins),
    )
