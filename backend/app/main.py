from __future__ import annotations

import json
import os
import uuid
from collections import defaultdict
from collections.abc import AsyncIterator, Generator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import and_, delete, func, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.inspection import inspect
from sqlalchemy.orm import Session, sessionmaker

from .annotations import (
    audit, effective_by_key, label_catalog, normalize_exact, rule_conditions_match,
    save_manual_annotation, seed_label_catalog, sync_rule_suggestions, transaction_assignments,
)
from .database import Base, build_engine, build_session_factory
from .importers import ExpandedUpload, ImportFormatError, NormalizedTransaction, expand_upload, parse_upload
from .models import (
    AuditLog, Label, LabelDimension, MerchantRule, Transaction,
    TransactionLabelAssignment, utc_now,
)
from .services import persist_import, persist_manual_transaction
from .settings import load_local_settings


NORMALIZED_FIELD_NAMES = (
    "source_platform", "transaction_time", "direction", "amount", "counterparty",
    "item_description", "payment_method", "payment_channel", "transaction_status",
    "status_category", "transaction_id", "merchant_order_id", "transaction_type",
    "source_category", "counterparty_account", "note",
)
NormalizedFieldName = Literal[
    "source_platform", "transaction_time", "direction", "amount", "counterparty",
    "item_description", "payment_method", "payment_channel", "transaction_status",
    "status_category", "transaction_id", "merchant_order_id", "transaction_type",
    "source_category", "counterparty_account", "note",
]


class TransactionSearchQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=200)
    mode: Literal["include", "exclude"] = "include"


class TransactionSearchFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: NormalizedFieldName
    mode: Literal["include", "exclude"]
    operator: Literal["equals", "contains", "range", "is_empty"]
    value: str | None = None
    min: str | None = None
    max: str | None = None

    @model_validator(mode="after")
    def validate_operator_and_values(self) -> "TransactionSearchFilter":
        is_range_field = self.field in {"transaction_time", "amount"}
        allowed = {"range", "is_empty"} if is_range_field else {"equals", "contains", "is_empty"}
        if self.operator not in allowed:
            raise ValueError(f"{self.field} 不支持 {self.operator} 操作")
        if self.operator in {"equals", "contains"}:
            if self.value is None or not self.value.strip():
                raise ValueError(f"{self.operator} 必须提供非空 value")
            if self.min is not None or self.max is not None:
                raise ValueError(f"{self.operator} 不能提供 min 或 max")
        elif self.operator == "range":
            if self.value is not None or (self.min is None and self.max is None):
                raise ValueError("range 必须提供 min 或 max，且不能提供 value")
            try:
                lower = _search_bound(self.field, self.min) if self.min is not None else None
                upper = _search_bound(self.field, self.max, upper=True) if self.max is not None else None
            except (ValueError, OverflowError, InvalidOperation) as exc:
                raise ValueError(f"{self.field} 范围值无效") from exc
            empty_date_interval = (
                self.field == "transaction_time" and self.max is not None
                and _date_only(self.max) and lower is not None and lower >= upper
            )
            if lower is not None and upper is not None and (lower > upper or empty_date_interval):
                raise ValueError("range 的 min 不能大于 max")
        elif self.value is not None or self.min is not None or self.max is not None:
            raise ValueError("is_empty 不能提供 value、min 或 max")
        return self


class TransactionSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    month: str | None = None
    query: TransactionSearchQuery | None = None
    filters: list[TransactionSearchFilter] = Field(default_factory=list, max_length=32)
    category: str | None = None
    channel: str | None = None
    annotation_status: Literal["pending", "completed"] | None = None
    page: int = Field(1, ge=1)
    page_size: int = Field(100, ge=1, le=500)


def _date_only(value: str) -> bool:
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d") == value
    except ValueError:
        return False


def _search_bound(field: str, value: str, *, upper: bool = False) -> datetime | Decimal:
    if field == "transaction_time":
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is not None:
            raise ValueError("transaction_time 必须是不带时区的本地时间")
        return parsed + timedelta(days=1) if upper and _date_only(value) else parsed
    parsed_decimal = Decimal(value)
    if not parsed_decimal.is_finite():
        raise ValueError("amount 必须是有限数值")
    return parsed_decimal


class DimensionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    name: str = Field(min_length=1, max_length=64)
    notes: str | None = None
    selection_mode: str = Field("single", pattern=r"^(single|multiple)$")
    sort_order: int = 0


class DimensionPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=1, max_length=64)
    notes: str | None = None
    selection_mode: str | None = Field(None, pattern=r"^(single|multiple)$")
    sort_order: int | None = None
    enabled: bool | None = None


class LabelCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dimension_id: str
    parent_id: int | None = None
    name: str = Field(min_length=1, max_length=96)
    notes: str | None = None
    sort_order: int = 0


class LabelPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_id: int | None = None
    name: str | None = Field(None, min_length=1, max_length=96)
    notes: str | None = None
    sort_order: int | None = None
    enabled: bool | None = None


class RuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=96)
    source_platform: str | None = None
    counterparty_exact: str = Field(min_length=1)
    label_ids: list[int] = []
    notes: str | None = None
    enabled: bool = True


class RulePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=1, max_length=96)
    source_platform: str | None = None
    counterparty_exact: str | None = Field(None, min_length=1)
    label_ids: list[int] | None = None
    notes: str | None = None
    enabled: bool | None = None


class AnnotationSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label_ids: list[int] = []


class BatchAnnotationSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transaction_ids: list[int] = Field(min_length=1, max_length=500)
    label_ids: list[int] = []


class ManualTransactionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transaction_time: datetime
    direction: Literal["收入", "支出"]
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    counterparty: str | None = Field(None, max_length=256)
    summary: str = Field(min_length=1, max_length=256)
    category: str | None = Field(None, max_length=96)
    payment_channel: str | None = Field(None, max_length=64)
    payment_method: str | None = Field(None, max_length=256)
    counterparty_account: str | None = Field(None, max_length=256)
    reference_id: str | None = Field(None, min_length=1, max_length=128)
    note: str | None = Field(None, max_length=1000)
    label_ids: list[int] = []


def _migrate_sqlite_schema(engine: Engine) -> None:
    """轻量补列迁移：create_all 不会为已存在的表新增列。"""
    inspector = inspect(engine)
    if not inspector.has_table("merchant_rules"):
        return
    columns = {column["name"] for column in inspector.get_columns("merchant_rules")}
    additions: dict[str, str] = {}
    if "applied_at" not in columns:
        additions["applied_at"] = (
            "DATETIME",
            "UPDATE merchant_rules SET applied_at = CURRENT_TIMESTAMP WHERE applied_at IS NULL",
        )
    with engine.begin() as connection:
        for name, (ddl, backfill) in additions.items():
            connection.execute(text(f"ALTER TABLE merchant_rules ADD COLUMN {name} {ddl}"))
            if backfill:
                connection.execute(text(backfill))


def _money(value: Decimal | int | float | None) -> float:
    return round(float(value or 0), 2)


def _direction(value: str) -> str:
    return "income" if value == "收入" else "expense"


def _month_bounds(month: str | None) -> tuple[datetime | None, datetime | None]:
    if not month:
        return None, None
    try:
        start = datetime.strptime(month, "%Y-%m")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="month 必须是 YYYY-MM") from exc
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end


def _dashboard_bounds(
    month: str | None,
    year: int | None,
    start_date: str | None,
    end_date: str | None,
) -> tuple[datetime | None, datetime | None]:
    custom_range_requested = start_date is not None or end_date is not None
    selected_ranges = sum((month is not None, year is not None, custom_range_requested))
    if selected_ranges > 1:
        raise HTTPException(status_code=422, detail="month、year 和自定义日期范围只能选择一种")
    if custom_range_requested:
        if start_date is None or end_date is None:
            raise HTTPException(status_code=422, detail="start_date 和 end_date 必须同时提供")
        try:
            start = datetime.strptime(start_date, "%Y-%m-%d")
            inclusive_end = datetime.strptime(end_date, "%Y-%m-%d")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="start_date 和 end_date 必须是 YYYY-MM-DD") from exc
        if start.year < 1900 or inclusive_end.year > 2100:
            raise HTTPException(status_code=422, detail="自定义日期范围必须在 1900-01-01 到 2100-12-31 之间")
        if start > inclusive_end:
            raise HTTPException(status_code=422, detail="start_date 不能晚于 end_date")
        return start, inclusive_end + timedelta(days=1)
    if year is not None:
        if year < 1900 or year > 2100:
            raise HTTPException(status_code=422, detail="year 必须在 1900 到 2100 之间")
        return datetime(year, 1, 1), datetime(year + 1, 1, 1)
    return _month_bounds(month)


def _trend_bucket(value: datetime, granularity: Literal["day", "week", "month"]) -> str:
    if granularity == "week":
        return (value.date() - timedelta(days=value.weekday())).isoformat()
    if granularity == "month":
        return value.date().replace(day=1).isoformat()
    return value.date().isoformat()


def _label_name(effective: dict[str, list[dict]], key: str, fallback: str) -> tuple[str, str]:
    labels = effective.get(key, [])
    return (" / ".join(item["name"] for item in labels), labels[0]["source"]) if labels else (fallback, "unassigned")


def _transaction_item(session: Session, transaction: Transaction) -> dict[str, object]:
    assignments = transaction_assignments(session, transaction)
    effective = effective_by_key(assignments)
    category_key = "income_category" if transaction.direction == "收入" else "expense_category"
    category, category_source = _label_name(effective, category_key, transaction.source_category or "未分类")
    channel, channel_source = _label_name(effective, "payment_channel", transaction.payment_channel or "未识别")
    return {
        "id": transaction.id, "date": transaction.transaction_time.isoformat(sep=" "),
        "merchant": transaction.counterparty or transaction.item_description or "未知交易",
        "counterparty": transaction.counterparty, "itemDescription": transaction.item_description,
        "note": transaction.note, "amount": _money(transaction.amount),
        "direction": _direction(transaction.direction), "category": category,
        "categorySource": category_source, "channel": channel, "channelSource": channel_source,
        "labelSource": "manual" if assignments["confirmedDimensionIds"] else "rule" if assignments["rule"] else "unassigned",
        "effectiveLabels": assignments["effective"], "sourcePlatform": transaction.source_platform,
        "transactionId": transaction.transaction_id, "transactionType": transaction.transaction_type,
        "sourceCategory": transaction.source_category, "paymentMethod": transaction.payment_method,
        "status": transaction.status_category, "transactionStatus": transaction.transaction_status,
        "statusCategory": transaction.status_category, "merchantOrderId": transaction.merchant_order_id,
        "counterpartyAccount": transaction.counterparty_account,
        "cleanedPaymentChannel": transaction.payment_channel,
    }


def _normalized_string(value: object | None) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    return str(value)


def _search_filter_matches(transaction: Transaction, condition: TransactionSearchFilter) -> bool:
    value = getattr(transaction, condition.field)
    if condition.operator == "is_empty":
        return value is None or (isinstance(value, str) and value == "")
    if condition.operator == "equals":
        return value == condition.value
    if condition.operator == "contains":
        return condition.value.casefold() in _normalized_string(value).casefold()
    if value is None:
        return False
    lower = _search_bound(condition.field, condition.min) if condition.min is not None else None
    upper = _search_bound(condition.field, condition.max, upper=True) if condition.max is not None else None
    upper_matches = upper is None or (
        value < upper
        if condition.field == "transaction_time" and condition.max is not None and _date_only(condition.max)
        else value <= upper
    )
    return (lower is None or value >= lower) and upper_matches


def _matches_normalized_filters(
    transaction: Transaction,
    filters: list[TransactionSearchFilter],
) -> bool:
    by_field: dict[str, list[TransactionSearchFilter]] = defaultdict(list)
    for condition in filters:
        by_field[condition.field].append(condition)
    for conditions in by_field.values():
        included = [condition for condition in conditions if condition.mode == "include"]
        excluded = [condition for condition in conditions if condition.mode == "exclude"]
        if included and not any(_search_filter_matches(transaction, condition) for condition in included):
            return False
        if any(_search_filter_matches(transaction, condition) for condition in excluded):
            return False
    return True


def _matches_global_query(transaction: Transaction, query: TransactionSearchQuery | None) -> bool:
    if query is None:
        return True
    needle = query.text.casefold()
    matched = any(
        needle in _normalized_string(getattr(transaction, field)).casefold()
        for field in NORMALIZED_FIELD_NAMES
    )
    return matched if query.mode == "include" else not matched


def _rule_item(rule: MerchantRule) -> dict:
    return {
        "id": rule.id, "name": rule.name, "sourcePlatform": rule.source_platform,
        "counterpartyExact": rule.counterparty_exact,
        "labelIds": json.loads(rule.label_ids_json or "[]"), "notes": rule.notes,
        "enabled": rule.enabled,
        "appliedAt": rule.applied_at.isoformat() if rule.applied_at else None,
    }


def _validate_rule_labels(session: Session, label_ids: list[int]) -> list[int]:
    unique_ids = list(dict.fromkeys(label_ids))
    rows = session.execute(
        select(Label.id, LabelDimension.id, LabelDimension.name, LabelDimension.selection_mode)
        .join(LabelDimension).where(Label.id.in_(unique_ids))
    ).all() if unique_ids else []
    if len(rows) != len(unique_ids):
        raise HTTPException(status_code=422, detail="规则包含不存在的标签")
    counts: dict[str, int] = defaultdict(int)
    for _, dimension_id, dimension_name, selection_mode in rows:
        counts[dimension_id] += 1
        if selection_mode == "single" and counts[dimension_id] > 1:
            raise HTTPException(status_code=422, detail=f"{dimension_name}在一条规则中只能选择一个标签")
    return unique_ids


def _rule_reference_count(session: Session, label_ids: list[int]) -> int:
    targets = set(label_ids)
    if not targets:
        return 0
    return sum(
        1 for value in session.scalars(select(MerchantRule.label_ids_json))
        if targets.intersection(int(item) for item in json.loads(value or "[]"))
    )


def create_app(*, database_url: str | None = None, data_root: str | Path | None = None) -> FastAPI:
    cors_env = os.getenv("LEDGER_PILOT_CORS_ORIGINS")
    database_env = os.getenv("LEDGER_PILOT_DATABASE_URL")
    settings = load_local_settings(
        data_dir=data_root if data_root is not None else (os.getenv("LEDGER_PILOT_DATA_DIR") or None),
        database_url=database_url if database_url is not None else database_env,
        cors_origins=tuple(item.strip() for item in cors_env.split(",") if item.strip()) if cors_env is not None else None,
    )
    resolved_data_root = settings.data_dir
    resolved_database_url = settings.database_url
    if not resolved_database_url:
        resolved_database_url = f"sqlite:///{resolved_data_root / 'bookkeeping.db'}"
    engine: Engine = build_engine(resolved_database_url)
    session_factory: sessionmaker[Session] = build_session_factory(engine)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        resolved_data_root.mkdir(parents=True, exist_ok=True)
        Base.metadata.create_all(engine)
        _migrate_sqlite_schema(engine)
        with session_factory() as session:
            seed_label_catalog(session)
        yield
        engine.dispose()

    application = FastAPI(title="Ledger Pilot API", version="1.7.1", lifespan=lifespan)
    application.state.engine = engine
    application.state.data_root = resolved_data_root
    origins = list(settings.cors_origins)
    application.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"], allow_headers=["*"],
    )

    def session_dependency() -> Generator[Session, None, None]:
        with session_factory() as session:
            yield session

    @application.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.post("/api/import")
    async def import_transactions(
        files: list[UploadFile] = File(...), source_platform: str | None = Form(None),
        archive_password: str | None = Form(None),
        session: Session = Depends(session_dependency),
    ) -> dict[str, object]:
        uploads: list[tuple[str, bytes]] = []
        for upload in files:
            content = await upload.read()
            if not content:
                raise HTTPException(status_code=422, detail=f"上传文件为空: {upload.filename or 'upload'}")
            uploads.append((upload.filename or "upload", content))
        expanded_uploads: list[ExpandedUpload] = []
        try:
            for filename, content in uploads:
                expanded_uploads.extend(expand_upload(filename, content, archive_password))
            for upload in expanded_uploads:
                parse_upload(upload.filename, upload.content, source_platform)
        except ImportFormatError as exc:
            audit(session, "import_failed", "upload", None, {"filename": filename, "error": str(exc)})
            session.commit()
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        batches = []
        imported = merged = skipped = 0
        for upload in expanded_uploads:
            batch, inserted, duplicates = persist_import(
                session, filename=upload.filename, content=upload.content, source_platform=source_platform,
                data_root=resolved_data_root,
                original_filename=upload.original_filename, original_content=upload.original_content,
            )
            imported += batch.row_count; merged += inserted; skipped += duplicates
            batches.append({"batchId": batch.id, "sourcePlatform": batch.source_platform, "filename": batch.original_filename})
        return {"batchId": batches[0]["batchId"] if len(batches) == 1 else None, "batches": batches,
                "imported": imported, "merged": merged, "skipped": skipped}

    @application.get("/api/label-catalog")
    def get_label_catalog(session: Session = Depends(session_dependency)) -> list[dict]:
        return label_catalog(session)

    @application.post("/api/label-dimensions", status_code=201)
    def create_dimension(body: DimensionCreate, session: Session = Depends(session_dependency)) -> dict:
        dimension = LabelDimension(
            id=str(uuid.uuid4()), key=body.key, name=body.name, notes=body.notes,
            selection_mode=body.selection_mode, sort_order=body.sort_order,
        )
        session.add(dimension); audit(session, "dimension_created", "label_dimension", dimension.id, body.model_dump())
        try:
            session.commit()
        except IntegrityError as exc:
            session.rollback(); raise HTTPException(status_code=409, detail="维度标识已存在") from exc
        return next(item for item in label_catalog(session) if item["id"] == dimension.id)

    @application.patch("/api/label-dimensions/{dimension_id}")
    def update_dimension(dimension_id: str, body: DimensionPatch, session: Session = Depends(session_dependency)) -> dict:
        dimension = session.get(LabelDimension, dimension_id)
        if dimension is None: raise HTTPException(status_code=404, detail="标签维度不存在")
        changes = body.model_dump(exclude_unset=True)
        for key, value in changes.items(): setattr(dimension, key, value)
        dimension.updated_at = utc_now(); audit(session, "dimension_updated", "label_dimension", dimension.id, changes)
        session.commit()
        return next(item for item in label_catalog(session) if item["id"] == dimension.id)

    @application.delete("/api/label-dimensions/{dimension_id}")
    def delete_dimension(dimension_id: str, session: Session = Depends(session_dependency)) -> dict:
        dimension = session.get(LabelDimension, dimension_id)
        if dimension is None: raise HTTPException(status_code=404, detail="标签维度不存在")
        label_ids = list(session.scalars(select(Label.id).where(Label.dimension_id == dimension_id)))
        references = session.scalar(select(func.count(TransactionLabelAssignment.id)).where(
            TransactionLabelAssignment.label_id.in_(label_ids))) if label_ids else 0
        rule_references = _rule_reference_count(session, label_ids)
        if references or rule_references:
            dimension.enabled = False
            for label in session.scalars(select(Label).where(Label.dimension_id == dimension_id)): label.enabled = False
            disposition = "disabled"
        else:
            session.delete(dimension); disposition = "deleted"
        audit(session, "dimension_deleted", "label_dimension", dimension_id, {"disposition": disposition, "references": references, "ruleReferences": rule_references})
        session.commit(); return {"disposition": disposition, "references": references, "ruleReferences": rule_references}

    @application.post("/api/labels", status_code=201)
    def create_label(body: LabelCreate, session: Session = Depends(session_dependency)) -> dict:
        if session.get(LabelDimension, body.dimension_id) is None: raise HTTPException(status_code=404, detail="标签维度不存在")
        if body.parent_id is not None:
            parent = session.get(Label, body.parent_id)
            if parent is None or parent.dimension_id != body.dimension_id: raise HTTPException(status_code=422, detail="父标签必须属于同一维度")
        label = Label(dimension_id=body.dimension_id, parent_id=body.parent_id, name=body.name,
                      notes=body.notes, sort_order=body.sort_order)
        session.add(label)
        try:
            session.flush(); audit(session, "label_created", "label", label.id, body.model_dump()); session.commit()
        except IntegrityError as exc:
            session.rollback(); raise HTTPException(status_code=409, detail="同级标签名称已存在") from exc
        return next(x for d in label_catalog(session) for x in d["labels"] if x["id"] == label.id)

    @application.patch("/api/labels/{label_id}")
    def update_label(label_id: int, body: LabelPatch, session: Session = Depends(session_dependency)) -> dict:
        label = session.get(Label, label_id)
        if label is None: raise HTTPException(status_code=404, detail="标签不存在")
        changes = body.model_dump(exclude_unset=True)
        if "parent_id" in changes and changes["parent_id"] is not None:
            parent = session.get(Label, changes["parent_id"])
            if parent is None or parent.dimension_id != label.dimension_id or parent.id == label.id: raise HTTPException(status_code=422, detail="父标签无效")
            ancestor = parent
            while ancestor is not None:
                if ancestor.id == label.id: raise HTTPException(status_code=422, detail="不能把标签移动到自己的子树中")
                ancestor = session.get(Label, ancestor.parent_id) if ancestor.parent_id else None
        for key, value in changes.items(): setattr(label, key, value)
        label.updated_at = utc_now(); audit(session, "label_updated", "label", label.id, changes)
        try: session.commit()
        except IntegrityError as exc:
            session.rollback(); raise HTTPException(status_code=409, detail="同级标签名称已存在") from exc
        return next(x for d in label_catalog(session) for x in d["labels"] if x["id"] == label.id)

    @application.delete("/api/labels/{label_id}")
    def delete_label(label_id: int, session: Session = Depends(session_dependency)) -> dict:
        label = session.get(Label, label_id)
        if label is None: raise HTTPException(status_code=404, detail="标签不存在")
        references = session.scalar(select(func.count(TransactionLabelAssignment.id)).where(TransactionLabelAssignment.label_id == label_id)) or 0
        children = session.scalar(select(func.count(Label.id)).where(Label.parent_id == label_id)) or 0
        rule_references = _rule_reference_count(session, [label_id])
        if references or children or rule_references: label.enabled = False; disposition = "disabled"
        else: session.delete(label); disposition = "deleted"
        audit(session, "label_deleted", "label", label_id, {"disposition": disposition, "references": references, "children": children, "ruleReferences": rule_references})
        session.commit(); return {"disposition": disposition, "references": references, "children": children, "ruleReferences": rule_references}

    @application.get("/api/rules")
    def get_rules(session: Session = Depends(session_dependency)) -> list[dict]:
        return [_rule_item(rule) for rule in session.scalars(select(MerchantRule).order_by(MerchantRule.id))]

    @application.post("/api/rules", status_code=201)
    def create_rule(body: RuleCreate, session: Session = Depends(session_dependency)) -> dict:
        ids = _validate_rule_labels(session, body.label_ids)
        rule = MerchantRule(name=body.name, source_platform=body.source_platform,
            counterparty_exact=body.counterparty_exact, counterparty_normalized=normalize_exact(body.counterparty_exact),
            label_ids_json=json.dumps(ids), notes=body.notes, enabled=body.enabled)
        session.add(rule); session.flush(); audit(session, "rule_created", "merchant_rule", rule.id, _rule_item(rule)); session.commit()
        return _rule_item(rule)

    @application.post("/api/rules/{rule_id}/apply")
    def apply_rule(rule_id: int, session: Session = Depends(session_dependency)) -> dict:
        """把规则建议一次性应用到全部已有流水，并让规则保持生效。"""
        rule = session.get(MerchantRule, rule_id)
        if rule is None:
            raise HTTPException(status_code=404, detail="规则不存在")
        matched = 0
        for transaction in session.scalars(select(Transaction)).all():
            if normalize_exact(transaction.counterparty or "") != rule.counterparty_normalized:
                continue
            if not rule_conditions_match(rule, transaction):
                continue
            sync_rule_suggestions(session, transaction)
            matched += 1
        rule.applied_at = utc_now()
        audit(session, "rule_applied", "merchant_rule", rule.id, {"matched": matched})
        session.commit()
        return {"rule": _rule_item(rule), "matched": matched}

    @application.patch("/api/rules/{rule_id}")
    def update_rule(rule_id: int, body: RulePatch, session: Session = Depends(session_dependency)) -> dict:
        rule = session.get(MerchantRule, rule_id)
        if rule is None: raise HTTPException(status_code=404, detail="规则不存在")
        changes = body.model_dump(exclude_unset=True)
        if "label_ids" in changes: rule.label_ids_json = json.dumps(_validate_rule_labels(session, changes.pop("label_ids")))
        if "counterparty_exact" in changes:
            rule.counterparty_exact = changes.pop("counterparty_exact"); rule.counterparty_normalized = normalize_exact(rule.counterparty_exact)
        for key, value in changes.items(): setattr(rule, key, value)
        rule.updated_at = utc_now(); session.execute(delete(TransactionLabelAssignment).where(TransactionLabelAssignment.source == "rule"))
        audit(session, "rule_updated", "merchant_rule", rule.id, _rule_item(rule)); session.commit(); return _rule_item(rule)

    @application.delete("/api/rules/{rule_id}")
    def delete_rule(rule_id: int, session: Session = Depends(session_dependency)) -> dict:
        rule = session.get(MerchantRule, rule_id)
        if rule is None: raise HTTPException(status_code=404, detail="规则不存在")
        session.execute(delete(TransactionLabelAssignment).where(TransactionLabelAssignment.rule_id == rule_id))
        audit(session, "rule_deleted", "merchant_rule", rule_id, _rule_item(rule)); session.delete(rule); session.commit()
        return {"disposition": "deleted"}

    @application.get("/api/transactions/{transaction_id}/annotation")
    def get_annotation(transaction_id: int, session: Session = Depends(session_dependency)) -> dict:
        transaction = session.get(Transaction, transaction_id)
        if transaction is None: raise HTTPException(status_code=404, detail="流水不存在")
        assignments = transaction_assignments(session, transaction); session.commit()
        return {"transaction": _transaction_item(session, transaction), "assignments": assignments}

    @application.put("/api/transactions/{transaction_id}/annotation")
    def put_annotation(transaction_id: int, body: AnnotationSave, session: Session = Depends(session_dependency)) -> dict:
        transaction = session.get(Transaction, transaction_id)
        if transaction is None: raise HTTPException(status_code=404, detail="流水不存在")
        try: assignments = save_manual_annotation(session, transaction, list(dict.fromkeys(body.label_ids)))
        except ValueError as exc:
            session.rollback(); raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"transaction": _transaction_item(session, transaction), "assignments": assignments}

    @application.put("/api/annotations/batch")
    def put_batch_annotations(body: BatchAnnotationSave, session: Session = Depends(session_dependency)) -> dict[str, int]:
        transaction_ids = list(dict.fromkeys(body.transaction_ids))
        label_ids = list(dict.fromkeys(body.label_ids))
        transactions = list(session.scalars(
            select(Transaction).where(Transaction.id.in_(transaction_ids))
        ))
        if len(transactions) != len(transaction_ids):
            raise HTTPException(status_code=404, detail="批量标注中包含不存在的流水")
        by_id = {transaction.id: transaction for transaction in transactions}
        try:
            for transaction_id in transaction_ids:
                save_manual_annotation(
                    session,
                    by_id[transaction_id],
                    label_ids,
                    commit=False,
                )
            session.commit()
        except ValueError as exc:
            session.rollback(); raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"updated": len(transaction_ids)}

    @application.post("/api/transactions/manual", status_code=201)
    def create_manual_transaction(
        body: ManualTransactionCreate,
        session: Session = Depends(session_dependency),
    ) -> dict[str, object]:
        reference_id = (body.reference_id or f"manual-{uuid.uuid4()}").strip()
        normalized = NormalizedTransaction(
            source_platform="手动",
            transaction_time=body.transaction_time.replace(tzinfo=None),
            direction=body.direction,
            amount=body.amount.quantize(Decimal("0.01")),
            counterparty=body.counterparty.strip() if body.counterparty else None,
            item_description=body.summary.strip(),
            payment_method=body.payment_method.strip() if body.payment_method else None,
            payment_channel=body.payment_channel.strip() if body.payment_channel else None,
            transaction_status="手动记录",
            status_category="成功",
            transaction_id=reference_id,
            merchant_order_id=None,
            transaction_type=body.summary.strip(),
            source_category=body.category.strip() if body.category else None,
            counterparty_account=body.counterparty_account.strip() if body.counterparty_account else None,
            note=body.note.strip() if body.note else None,
        )
        try:
            transaction = persist_manual_transaction(
                session,
                normalized=normalized,
                evidence={**body.model_dump(mode="json", exclude={"label_ids"}), "transaction_id": reference_id},
                label_ids=list(dict.fromkeys(body.label_ids)),
                data_root=resolved_data_root,
            )
        except ValueError as exc:
            status = 409 if "已经记录" in str(exc) else 422
            raise HTTPException(status_code=status, detail=str(exc)) from exc
        return _transaction_item(session, transaction)

    def filtered_transactions(month: str | None, session: Session) -> list[Transaction]:
        start, end = _month_bounds(month)
        statement = select(Transaction).order_by(Transaction.transaction_time.desc(), Transaction.id.desc())
        if start and end: statement = statement.where(and_(Transaction.transaction_time >= start, Transaction.transaction_time < end))
        return list(session.scalars(statement))

    def dashboard_payload(
        start: datetime | None,
        end: datetime | None,
        trend_granularity: Literal["day", "week", "month"],
        session: Session,
    ) -> dict[str, object]:
        statement = select(Transaction).order_by(Transaction.transaction_time.desc(), Transaction.id.desc())
        if start is not None and end is not None:
            statement = statement.where(and_(Transaction.transaction_time >= start, Transaction.transaction_time < end))
        rows = list(session.scalars(statement))
        dimensions = list(session.scalars(
            select(LabelDimension).where(LabelDimension.enabled.is_(True))
            .order_by(LabelDimension.sort_order, LabelDimension.name)
        ))
        income = sum(_money(row.amount) for row in rows if row.direction == "收入")
        expense = sum(_money(row.amount) for row in rows if row.direction == "支出")
        trend: dict[str, dict[str, float]] = defaultdict(lambda: {"income": 0, "expense": 0})
        categories: dict[str, float] = defaultdict(float); channels: dict[str, float] = defaultdict(float); items = []
        dimension_values: dict[str, dict[str, float]] = {
            dimension.id: defaultdict(float) for dimension in dimensions
        }
        for row in rows:
            item = _transaction_item(session, row); items.append(item)
            amount = _money(row.amount)
            trend[_trend_bucket(row.transaction_time, trend_granularity)][_direction(row.direction)] += amount
            if row.direction == "支出":
                categories[str(item["category"])] += amount; channels[str(item["channel"])] += amount
            effective_labels = item["effectiveLabels"]
            for dimension in dimensions:
                if dimension.key == "income_category" and row.direction != "收入":
                    continue
                if dimension.key == "expense_category" and row.direction != "支出":
                    continue
                names = [
                    str(label["name"]) for label in effective_labels
                    if label["dimensionId"] == dimension.id
                ]
                if not names and dimension.key in {"income_category", "expense_category"}:
                    names = [str(item["category"])]
                elif not names and dimension.key == "payment_channel":
                    names = [str(item["channel"])]
                for name in names:
                    dimension_values[dimension.id][name] += amount
        session.commit()
        return {
            "summary": {"income": round(income, 2), "expense": round(expense, 2), "net": round(income - expense, 2)},
            "trend": [{"date": day, **values} for day, values in sorted(trend.items())],
            "categories": [{"name": name, "value": round(value, 2)} for name, value in sorted(categories.items(), key=lambda item: -item[1])],
            "channels": [{"name": name, "value": round(value, 2)} for name, value in sorted(channels.items(), key=lambda item: -item[1])],
            "distributions": [{
                "dimensionId": dimension.id,
                "key": dimension.key,
                "name": dimension.name,
                "items": [{"name": name, "value": round(value, 2)} for name, value in sorted(
                    dimension_values[dimension.id].items(), key=lambda item: -item[1]
                )],
            } for dimension in dimensions],
            "recent": items[:10],
        }

    @application.get("/api/dashboard")
    def dashboard(
        month: str | None = None,
        year: int | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        trend_granularity: Literal["day", "week", "month"] = "day",
        session: Session = Depends(session_dependency),
    ) -> dict[str, object]:
        start, end = _dashboard_bounds(month, year, start_date, end_date)
        return dashboard_payload(start, end, trend_granularity, session)

    @application.get("/api/heatmaps")
    def heatmaps(
        year: int = Query(..., ge=1900, le=2100),
        session: Session = Depends(session_dependency),
    ) -> dict[str, object]:
        start = datetime(year, 1, 1)
        end = datetime(year + 1, 1, 1)
        rows = session.execute(
            select(Transaction.transaction_time, Transaction.direction, Transaction.amount)
            .where(and_(Transaction.transaction_time >= start, Transaction.transaction_time < end))
            .order_by(Transaction.transaction_time)
        ).all()
        values: dict[str, dict[str, dict[str, float | int]]] = {
            "收入": defaultdict(lambda: {"value": 0.0, "count": 0}),
            "支出": defaultdict(lambda: {"value": 0.0, "count": 0}),
        }
        for transaction_time, direction, amount in rows:
            if direction not in values:
                continue
            day = transaction_time.date().isoformat()
            values[direction][day]["value"] = round(float(values[direction][day]["value"]) + _money(amount), 2)
            values[direction][day]["count"] = int(values[direction][day]["count"]) + 1
        def points(direction: str) -> list[dict[str, object]]:
            return [{"date": day, "value": item["value"], "count": item["count"]} for day, item in sorted(values[direction].items())]
        return {"year": year, "expense": points("支出"), "income": points("收入")}

    @application.get("/api/transactions")
    def transactions(month: str | None = None, category: str | None = None, channel: str | None = None,
        query: str | None = None, source_platform: str | None = None, direction: str | None = None,
        annotation_status: Literal["pending", "completed"] | None = None,
        page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=500), session: Session = Depends(session_dependency)) -> dict[str, object]:
        rows = filtered_transactions(month, session)
        if annotation_status == "pending":
            rows = [row for row in rows if row.labeled_at is None]
        elif annotation_status == "completed":
            rows = [row for row in rows if row.labeled_at is not None]
        items = [_transaction_item(session, row) for row in rows]
        normalized_query = (query or "").casefold()
        items = [item for item in items if (
            (not category or item["category"] == category) and (not channel or item["channel"] == channel)
            and (not source_platform or item["sourcePlatform"] == source_platform)
            and (not direction or item["direction"] == direction)
            and (not normalized_query or normalized_query in f"{item['merchant']} {item.get('note') or ''} {item.get('itemDescription') or ''}".casefold()))]
        total = len(items); start = (page - 1) * page_size; session.commit()
        return {"items": items[start:start + page_size], "total": total, "page": page, "pageSize": page_size}

    @application.post("/api/transactions/search")
    def search_transactions(
        body: TransactionSearchRequest,
        session: Session = Depends(session_dependency),
    ) -> dict[str, object]:
        rows = filtered_transactions(body.month, session)
        if body.annotation_status == "pending":
            rows = [row for row in rows if row.labeled_at is None]
        elif body.annotation_status == "completed":
            rows = [row for row in rows if row.labeled_at is not None]
        rows = [
            row for row in rows
            if _matches_normalized_filters(row, body.filters) and _matches_global_query(row, body.query)
        ]
        items = [_transaction_item(session, row) for row in rows]
        items = [
            item for item in items
            if (not body.category or item["category"] == body.category)
            and (not body.channel or item["channel"] == body.channel)
        ]
        total = len(items)
        start = (body.page - 1) * body.page_size
        session.commit()
        return {
            "items": items[start:start + body.page_size],
            "total": total,
            "page": body.page,
            "pageSize": body.page_size,
        }

    @application.get("/api/audit-logs")
    def audit_logs(limit: int = Query(100, ge=1, le=500), session: Session = Depends(session_dependency)) -> list[dict]:
        rows = session.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit))
        return [{"id": row.id, "eventType": row.event_type, "entityType": row.entity_type,
                 "entityId": row.entity_id, "details": json.loads(row.details_json),
                 "createdAt": row.created_at.isoformat()} for row in rows]

    return application


app = create_app()
