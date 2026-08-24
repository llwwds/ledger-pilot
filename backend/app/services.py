from __future__ import annotations

import hashlib
import shutil
import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .importers import parse_upload
from .annotations import audit
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
