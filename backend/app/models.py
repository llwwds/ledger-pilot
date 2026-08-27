from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utc_now() -> datetime:
    """Store UTC consistently while keeping SQLite's v1 columns timezone-naive."""
    return datetime.now(UTC).replace(tzinfo=None)


class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source_platform: Mapped[str] = mapped_column(String(16), index=True)
    original_filename: Mapped[str] = mapped_column(Text)
    original_path: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    row_count: Mapped[int] = mapped_column(default=0)
    inserted_count: Mapped[int] = mapped_column(default=0)
    duplicate_count: Mapped[int] = mapped_column(default=0)

    records: Mapped[list["ImportRecord"]] = relationship(
        back_populates="batch", cascade="all, delete-orphan"
    )


class NormalizedFields:
    source_platform: Mapped[str] = mapped_column(String(16), index=True)
    transaction_time: Mapped[datetime] = mapped_column(DateTime, index=True)
    direction: Mapped[str] = mapped_column(String(16), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    counterparty: Mapped[str | None] = mapped_column(Text)
    item_description: Mapped[str | None] = mapped_column(Text)
    payment_method: Mapped[str | None] = mapped_column(Text)
    payment_channel: Mapped[str | None] = mapped_column(String(32), index=True)
    transaction_status: Mapped[str | None] = mapped_column(Text)
    status_category: Mapped[str] = mapped_column(String(16), index=True)
    transaction_id: Mapped[str] = mapped_column(Text)
    merchant_order_id: Mapped[str | None] = mapped_column(Text)
    transaction_type: Mapped[str | None] = mapped_column(Text)
    source_category: Mapped[str | None] = mapped_column(Text)
    counterparty_account: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)


class ImportRecord(NormalizedFields, Base):
    """Immutable normalized snapshot for one row in one import batch."""

    __tablename__ = "import_records"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    batch_id: Mapped[str] = mapped_column(ForeignKey("import_batches.id"), index=True)
    was_duplicate: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    batch: Mapped[ImportBatch] = relationship(back_populates="records")


class Transaction(NormalizedFields, Base):
    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint("source_platform", "transaction_id", name="uq_transaction_platform_id"),
        Index("ix_transaction_time_platform", "transaction_time", "source_platform"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    first_import_batch_id: Mapped[str] = mapped_column(ForeignKey("import_batches.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    primary_category: Mapped[str | None] = mapped_column(String(64), index=True)
    secondary_category: Mapped[str | None] = mapped_column(String(64), index=True)
    special_tags_json: Mapped[str | None] = mapped_column(Text)
    label_confidence: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    label_provider: Mapped[str | None] = mapped_column(String(64))
    label_model: Mapped[str | None] = mapped_column(String(128))
    label_prompt_version: Mapped[str | None] = mapped_column(String(64))
    labeled_at: Mapped[datetime | None] = mapped_column(DateTime)


class LabelDimension(Base):
    __tablename__ = "label_dimensions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64))
    notes: Mapped[str | None] = mapped_column(Text)
    selection_mode: Mapped[str] = mapped_column(String(16), default="single")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    labels: Mapped[list["Label"]] = relationship(
        back_populates="dimension", cascade="all, delete-orphan"
    )


class Label(Base):
    __tablename__ = "labels"
    __table_args__ = (
        UniqueConstraint("dimension_id", "parent_id", "name", name="uq_label_sibling_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    dimension_id: Mapped[str] = mapped_column(ForeignKey("label_dimensions.id"), index=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("labels.id"), index=True)
    name: Mapped[str] = mapped_column(String(96))
    notes: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    dimension: Mapped[LabelDimension] = relationship(back_populates="labels")
    parent: Mapped["Label | None"] = relationship(remote_side=[id], back_populates="children")
    children: Mapped[list["Label"]] = relationship(back_populates="parent")


class MerchantRule(Base):
    __tablename__ = "merchant_rules"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(96))
    source_platform: Mapped[str | None] = mapped_column(String(16), index=True)
    counterparty_exact: Mapped[str] = mapped_column(Text)
    counterparty_normalized: Mapped[str] = mapped_column(Text, index=True)
    label_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    notes: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    # NULL 表示规则尚未应用到任何数据，不会产生建议；应用一次后记录时间并保持生效。
    applied_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)


class TransactionLabelAssignment(Base):
    __tablename__ = "transaction_label_assignments"
    __table_args__ = (
        UniqueConstraint("transaction_id", "label_id", "source", name="uq_transaction_label_source"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"), index=True)
    label_id: Mapped[int] = mapped_column(ForeignKey("labels.id"), index=True)
    source: Mapped[str] = mapped_column(String(16), index=True)
    rule_id: Mapped[int | None] = mapped_column(ForeignKey("merchant_rules.id"), index=True)
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    label: Mapped[Label] = relationship()


class ManualDimensionConfirmation(Base):
    """Records an explicit human decision, including 'leave this dimension empty'."""

    __tablename__ = "manual_dimension_confirmations"
    __table_args__ = (
        UniqueConstraint("transaction_id", "dimension_id", name="uq_manual_transaction_dimension"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"), index=True)
    dimension_id: Mapped[str] = mapped_column(ForeignKey("label_dimensions.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    entity_type: Mapped[str] = mapped_column(String(32), index=True)
    entity_id: Mapped[str | None] = mapped_column(String(64), index=True)
    details_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, index=True)
