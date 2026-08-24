from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ImportBatch, ImportRecord, Transaction
from app.main import create_app

from .conftest import make_alipay_csv, make_statement_zip, make_wechat_xlsx


def _import_wechat(client: TestClient) -> dict:
    response = client.post(
        "/api/import",
        files={"files": ("wechat.xlsx", make_wechat_xlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_import_preserves_each_batch_and_merges_idempotently(client: TestClient) -> None:
    first = _import_wechat(client)
    second = _import_wechat(client)

    assert first["imported"] == 2
    assert first["merged"] == 2
    assert first["skipped"] == 0
    assert second["imported"] == 2
    assert second["merged"] == 0
    assert second["skipped"] == 2

    with Session(client.app.state.engine) as session:
        assert session.scalar(select(func.count(ImportBatch.id))) == 2
        assert session.scalar(select(func.count(ImportRecord.id))) == 4
        assert session.scalar(select(func.count(Transaction.id))) == 2
        second_records = list(session.scalars(
            select(ImportRecord).where(ImportRecord.batch_id == second["batchId"])
        ))
        assert all(record.was_duplicate for record in second_records)
        batches = list(session.scalars(select(ImportBatch)))
        assert all(Path(batch.original_path).is_file() for batch in batches)


def test_rule_prefill_manual_override_dashboard_and_transactions(client: TestClient) -> None:
    _import_wechat(client)
    alipay = client.post(
        "/api/import",
        files={"files": ("alipay.csv", make_alipay_csv(), "text/csv")},
    )
    assert alipay.status_code == 200, alipay.text

    assert client.post("/api/labels/run").status_code == 405

    catalog = client.get("/api/label-catalog").json()
    expense = next(dimension for dimension in catalog if dimension["key"] == "expense_category")
    food = next(label for label in expense["labels"] if label["name"] == "餐饮")
    transport = next(label for label in expense["labels"] if label["name"] == "交通")
    rule = client.post("/api/rules", json={
        "name": "美团精确规则", "source_platform": "微信",
        "counterparty_exact": " 美团 ", "label_ids": [food["id"]],
    })
    assert rule.status_code == 201, rule.text

    all_transactions = client.get("/api/transactions", params={"month": "2026-07"}).json()["items"]
    meituan = next(item for item in all_transactions if item["merchant"] == "美团")
    suggestion = client.get(f"/api/transactions/{meituan['id']}/annotation").json()
    assert food["id"] in [item["id"] for item in suggestion["assignments"]["rule"]]

    saved = client.put(f"/api/transactions/{meituan['id']}/annotation", json={"label_ids": [transport["id"]]})
    assert saved.status_code == 200, saved.text
    assert saved.json()["transaction"]["category"] == "交通"
    assert saved.json()["transaction"]["categorySource"] == "manual"

    # Re-reading recomputes rules but never overwrites the manual result.
    reread = client.get(f"/api/transactions/{meituan['id']}/annotation").json()
    assert reread["transaction"]["category"] == "交通"
    assert food["id"] in [item["id"] for item in reread["assignments"]["rule"]]

    dashboard = client.get("/api/dashboard", params={"month": "2026-07"})
    assert dashboard.status_code == 200
    payload = dashboard.json()
    assert payload["summary"] == {"income": 6.0, "expense": 14.0, "net": -8.0}
    assert {item["name"] for item in payload["categories"]} >= {"交通"}
    assert sum(item["value"] for item in payload["channels"]) == 14.0
    assert len(payload["recent"]) == 3
    assert all("labelSource" in item for item in payload["recent"])

    filtered = client.get("/api/transactions", params={
        "month": "2026-07", "category": "交通", "channel": "微信零钱", "query": "美团"
    })
    assert filtered.status_code == 200
    result = filtered.json()
    assert result["total"] == 1
    assert result["items"][0]["direction"] == "expense"
    assert result["items"][0]["category"] == "交通"

    cleared = client.put(f"/api/transactions/{meituan['id']}/annotation", json={"label_ids": []})
    assert cleared.status_code == 200
    assert cleared.json()["transaction"]["category"] == "未分类"
    assert cleared.json()["transaction"]["labelSource"] == "manual"


def test_arbitrary_label_tree_crud_and_safe_delete(client: TestClient) -> None:
    dimension = client.post("/api/label-dimensions", json={
        "key": "project", "name": "项目", "notes": "项目归因", "selection_mode": "multiple",
    })
    assert dimension.status_code == 201, dimension.text
    dimension_id = dimension.json()["id"]
    parent = client.post("/api/labels", json={
        "dimension_id": dimension_id, "name": "学习", "notes": "能力建设",
    })
    child = client.post("/api/labels", json={
        "dimension_id": dimension_id, "parent_id": parent.json()["id"], "name": "深度学习",
    })
    assert child.status_code == 201, child.text
    updated = client.patch(f"/api/labels/{child.json()['id']}", json={
        "name": "机器学习", "notes": "已修改", "sort_order": 7, "enabled": False,
    })
    assert updated.status_code == 200
    assert updated.json()["notes"] == "已修改"
    guarded = client.delete(f"/api/labels/{parent.json()['id']}")
    assert guarded.json()["disposition"] == "disabled"
    deleted = client.delete(f"/api/labels/{child.json()['id']}")
    assert deleted.json()["disposition"] == "deleted"


def test_referenced_label_is_disabled_and_audited(client: TestClient) -> None:
    _import_wechat(client)
    catalog = client.get("/api/label-catalog").json()
    business = next(d for d in catalog if d["key"] == "business_type")
    consumption = next(label for label in business["labels"] if label["name"] == "消费")
    transaction = client.get("/api/transactions", params={"month": "2026-07"}).json()["items"][0]
    assert client.put(f"/api/transactions/{transaction['id']}/annotation", json={"label_ids": [consumption["id"]]}).status_code == 200
    response = client.delete(f"/api/labels/{consumption['id']}")
    assert response.json()["disposition"] == "disabled"
    assert response.json()["references"] >= 1
    events = [item["eventType"] for item in client.get("/api/audit-logs").json()]
    assert "annotation_saved" in events
    assert "label_deleted" in events


def test_label_used_only_by_rule_is_not_hard_deleted(client: TestClient) -> None:
    catalog = client.get("/api/label-catalog").json()
    expense = next(d for d in catalog if d["key"] == "expense_category")
    food = next(label for label in expense["labels"] if label["name"] == "餐饮")
    assert client.post("/api/rules", json={
        "name": "无流水规则", "counterparty_exact": "尚未导入的商户", "label_ids": [food["id"]],
    }).status_code == 201
    result = client.delete(f"/api/labels/{food['id']}").json()
    assert result["disposition"] == "disabled"
    assert result["ruleReferences"] == 1


def test_catalog_rules_and_manual_annotation_survive_restart(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'persistent.db'}"
    data_root = tmp_path / "data"
    app = create_app(database_url=database_url, data_root=data_root)
    with TestClient(app) as first:
        _import_wechat(first)
        catalog = first.get("/api/label-catalog").json()
        expense = next(d for d in catalog if d["key"] == "expense_category")
        food = next(label for label in expense["labels"] if label["name"] == "餐饮")
        transaction = next(item for item in first.get("/api/transactions", params={"month": "2026-07"}).json()["items"] if item["direction"] == "expense")
        assert first.post("/api/rules", json={
            "name": "持久化规则", "counterparty_exact": "美团", "label_ids": [food["id"]],
        }).status_code == 201
        assert first.put(f"/api/transactions/{transaction['id']}/annotation", json={"label_ids": [food["id"]]}).status_code == 200

    restarted = create_app(database_url=database_url, data_root=data_root)
    with TestClient(restarted) as second:
        assert len(second.get("/api/rules").json()) == 1
        items = second.get("/api/transactions", params={"month": "2026-07"}).json()["items"]
        persisted = next(item for item in items if item["direction"] == "expense")
        assert persisted["category"] == "餐饮"
        assert persisted["categorySource"] == "manual"


def test_invalid_month_is_rejected(client: TestClient) -> None:
    response = client.get("/api/dashboard", params={"month": "2026/07"})
    assert response.status_code == 422


def test_import_accepts_repeated_files_field(client: TestClient) -> None:
    response = client.post(
        "/api/import",
        files=[
            ("files", ("wechat.xlsx", make_wechat_xlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
            ("files", ("alipay.csv", make_alipay_csv(), "text/csv")),
        ],
    )

    assert response.status_code == 200, response.text
    assert response.json()["imported"] == 3
    assert response.json()["merged"] == 3
    assert response.json()["skipped"] == 0
    assert len(response.json()["batches"]) == 2


def test_zip_import_parses_member_but_preserves_archive(client: TestClient) -> None:
    archive = make_statement_zip("账单/wechat.xlsx", make_wechat_xlsx())
    response = client.post(
        "/api/import",
        files={"files": ("wechat.zip", archive, "application/zip")},
    )

    assert response.status_code == 200, response.text
    assert response.json()["imported"] == 2
    with Session(client.app.state.engine) as session:
        batch = session.scalar(select(ImportBatch))
        assert batch is not None
        assert batch.original_filename == "wechat.zip"
        assert Path(batch.original_path).read_bytes() == archive


def test_zip_without_supported_statement_is_rejected_before_import(client: TestClient) -> None:
    archive = make_statement_zip("readme.txt", b"not a statement")
    response = client.post(
        "/api/import",
        files={"files": ("empty.zip", archive, "application/zip")},
    )

    assert response.status_code == 422
    assert "没有可导入" in response.json()["detail"]
    with Session(client.app.state.engine) as session:
        assert session.scalar(select(func.count(ImportBatch.id))) == 0


def test_manual_transaction_is_audited_labeled_and_duplicate_safe(client: TestClient) -> None:
    catalog = client.get("/api/label-catalog").json()
    income = next(d for d in catalog if d["key"] == "income_category")
    channel = next(d for d in catalog if d["key"] == "payment_channel")
    salary = next(label for label in income["labels"] if label["name"] == "工资")
    bank = next(label for label in channel["labels"] if label["name"] == "银行卡")
    payload = {
        "transaction_time": "2026-08-10T10:04:11",
        "direction": "收入",
        "amount": "5252.20",
        "counterparty": "示例公司",
        "summary": "工资",
        "category": "工资",
        "payment_channel": "银行卡",
        "reference_id": "manual-payroll-1",
        "note": "例外补录",
        "label_ids": [salary["id"], bank["id"]],
    }

    response = client.post("/api/transactions/manual", json=payload)

    assert response.status_code == 201, response.text
    item = response.json()
    assert item["sourcePlatform"] == "手动"
    assert item["category"] == "工资"
    assert item["categorySource"] == "manual"
    assert item["channel"] == "银行卡"
    assert item["amount"] == 5252.2
    duplicate = client.post("/api/transactions/manual", json=payload)
    assert duplicate.status_code == 409
    dashboard = client.get("/api/dashboard", params={"month": "2026-08"}).json()
    assert dashboard["summary"] == {"income": 5252.2, "expense": 0.0, "net": 5252.2}

    with Session(client.app.state.engine) as session:
        batch = session.scalar(select(ImportBatch).where(ImportBatch.source_platform == "手动"))
        assert batch is not None
        assert Path(batch.original_path).read_text(encoding="utf-8")
        assert session.scalar(select(func.count(ImportRecord.id))) == 1
        assert session.scalar(select(func.count(Transaction.id))) == 1
    events = [item["eventType"] for item in client.get("/api/audit-logs").json()]
    assert "manual_transaction_created" in events
    assert "annotation_saved" in events


def test_annual_heatmaps_are_additive_and_direction_specific(client: TestClient) -> None:
    _import_wechat(client)
    response = client.get("/api/heatmaps", params={"year": 2026})

    assert response.status_code == 200
    payload = response.json()
    assert payload["year"] == 2026
    expense = {item["date"]: item for item in payload["expense"]}
    income = {item["date"]: item for item in payload["income"]}
    assert expense["2026-07-31"] == {"date": "2026-07-31", "value": 4.0, "count": 1}
    assert income["2026-07-31"] == {"date": "2026-07-31", "value": 6.0, "count": 1}
    assert client.get("/api/dashboard", params={"month": "2026-07"}).status_code == 200
    assert client.get("/api/heatmaps", params={"year": 1899}).status_code == 422
