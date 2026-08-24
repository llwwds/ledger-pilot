from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .importers import NormalizedTransaction, parse_upload
from .annotations import audit, save_manual_annotation
from .models import ImportBatch, ImportRecord, Transaction


def safe_filename(filename: str) -> str:
    name = Path(filename).name.strip()
    return name or "upload"


def persist_import(
    session: Session,
    *,
    filename: str,
    content: bytes,
    source_platform: str | None,
    data_root: Path,
    original_filename: str | None = None,
    original_content: bytes | None = None,
) -> tuple[ImportBatch, int, int]:
    source, rows = parse_upload(filename, content, source_platform)
    evidence_filename = original_filename or filename
    evidence_content = original_content if original_content is not None else content
    batch_id = str(uuid.uuid4())
    batch_dir = data_root / "imports" / batch_id
    batch_dir.mkdir(parents=True, exist_ok=False)
    original_path = batch_dir / safe_filename(evidence_filename)
    original_path.write_bytes(evidence_content)
    batch = ImportBatch(
        id=batch_id,
        source_platform=source,
        original_filename=safe_filename(evidence_filename),
        original_path=str(original_path),
        sha256=hashlib.sha256(evidence_content).hexdigest(),
        row_count=len(rows),
    )
    session.add(batch)
    inserted = 0
    duplicates = 0
    try:
        session.flush()
        for normalized in rows:
            existing = session.scalar(select(Transaction.id).where(
                Transaction.source_platform == source,
                Transaction.transaction_id == normalized.transaction_id,
            ))
            was_duplicate = existing is not None
            session.add(ImportRecord(batch_id=batch_id, was_duplicate=was_duplicate, **normalized.as_dict()))
            if was_duplicate:
                duplicates += 1
                audit(session, "duplicate_import", "transaction", existing, {
                    "batchId": batch_id,
                    "sourcePlatform": source,
                    "transactionId": normalized.transaction_id,
                })
            else:
                session.add(Transaction(first_import_batch_id=batch_id, **normalized.as_dict()))
                session.flush()
                inserted += 1
        batch.inserted_count = inserted
        batch.duplicate_count = duplicates
        session.commit()
    except Exception:
        session.rollback()
        shutil.rmtree(batch_dir, ignore_errors=True)
        raise
    return batch, inserted, duplicates


def persist_manual_transaction(
    session: Session,
    *,
    normalized: NormalizedTransaction,
    evidence: dict[str, object],
    label_ids: list[int],
    data_root: Path,
) -> Transaction:
    existing = session.scalar(select(Transaction.id).where(
        Transaction.source_platform == normalized.source_platform,
        Transaction.transaction_id == normalized.transaction_id,
    ))
    if existing is not None:
        raise ValueError("这条手动流水已经记录过了")

    batch_id = str(uuid.uuid4())
    batch_dir = data_root / "manual" / batch_id
    batch_dir.mkdir(parents=True, exist_ok=False)
    evidence_content = json.dumps(evidence, ensure_ascii=False, sort_keys=True).encode("utf-8")
    original_path = batch_dir / "manual-entry.json"
    original_path.write_bytes(evidence_content)
    batch = ImportBatch(
        id=batch_id,
        source_platform=normalized.source_platform,
        original_filename="manual-entry.json",
        original_path=str(original_path),
        sha256=hashlib.sha256(evidence_content).hexdigest(),
        row_count=1,
        inserted_count=1,
    )
    transaction = Transaction(first_import_batch_id=batch_id, **normalized.as_dict())
    try:
        session.add(batch)
        session.flush()
        session.add(ImportRecord(batch_id=batch_id, was_duplicate=False, **normalized.as_dict()))
        session.add(transaction)
        session.flush()
        audit(session, "manual_transaction_created", "transaction", transaction.id, {
            "batchId": batch_id,
            "transactionTime": normalized.transaction_time.isoformat(sep=" "),
            "direction": normalized.direction,
            "amount": str(normalized.amount),
        })
        save_manual_annotation(session, transaction, label_ids)
    except Exception:
        session.rollback()
        shutil.rmtree(batch_dir, ignore_errors=True)
        raise
    return transaction
