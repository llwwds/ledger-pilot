from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
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


def _manual_transaction(
    client: TestClient,
    transaction_time: str,
    direction: str,
    amount: str,
    reference_id: str,
) -> None:
    response = client.post("/api/transactions/manual", json={
        "transaction_time": transaction_time,
        "direction": direction,
        "amount": amount,
        "counterparty": f"范围测试-{reference_id}",
        "summary": f"范围测试-{reference_id}",
        "category": "测试分类",
        "payment_channel": "测试渠道",
        "reference_id": reference_id,
    })
    assert response.status_code == 201, response.text


def _search(client: TestClient, **body: object) -> dict:
    response = client.post("/api/transactions/search", json=body)
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
    assert rule.json()["appliedAt"] is None

    all_transactions = client.get("/api/transactions", params={"month": "2026-07"}).json()["items"]
    meituan = next(item for item in all_transactions if item["merchant"] == "美团")
    # 新建规则不会立刻生效：已有流水拿不到它的建议。
    dormant = client.get(f"/api/transactions/{meituan['id']}/annotation").json()
    assert food["id"] not in [item["id"] for item in dormant["assignments"]["rule"]]

    # 手动应用一次后，规则对全部已有流水生效并保持启用。
    applied = client.post(f"/api/rules/{rule.json()['id']}/apply")
    assert applied.status_code == 200, applied.text
    assert applied.json()["matched"] == 1
    assert applied.json()["rule"]["appliedAt"] is not None
    suggestion = client.get(f"/api/transactions/{meituan['id']}/annotation").json()
    assert food["id"] in [item["id"] for item in suggestion["assignments"]["rule"]]
    pending_with_rule = client.get("/api/transactions", params={
        "month": "2026-07", "annotation_status": "pending",
    }).json()
    assert meituan["id"] in [item["id"] for item in pending_with_rule["items"]]

    saved = client.put(f"/api/transactions/{meituan['id']}/annotation", json={"label_ids": [transport["id"]]})
    assert saved.status_code == 200, saved.text
    assert saved.json()["transaction"]["category"] == "交通"
    assert saved.json()["transaction"]["categorySource"] == "manual"
    pending_after_save = client.get("/api/transactions", params={
        "month": "2026-07", "annotation_status": "pending",
    }).json()
    assert meituan["id"] not in [item["id"] for item in pending_after_save["items"]]

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
    distributions = {item["key"]: item for item in payload["distributions"]}
    assert list(distributions) == ["payment_channel", "business_type", "income_category", "expense_category", "special_tag"]
    assert {item["name"] for item in distributions["expense_category"]["items"]} >= {"交通"}
    assert sum(item["value"] for item in distributions["income_category"]["items"]) == 6.0
    assert distributions["special_tag"]["items"] == []
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


def test_batch_annotation_is_atomic_and_removes_completed_items_from_pending_queue(client: TestClient) -> None:
    _import_wechat(client)
    catalog = client.get("/api/label-catalog").json()
    business = next(dimension for dimension in catalog if dimension["key"] == "business_type")
    consumption = next(label for label in business["labels"] if label["name"] == "消费")
    expense = next(dimension for dimension in catalog if dimension["key"] == "expense_category")
    food = next(label for label in expense["labels"] if label["name"] == "餐饮")
    pending = client.get("/api/transactions", params={
        "month": "2026-07", "annotation_status": "pending",
    }).json()
    assert pending["total"] == 2
    expense_item = next(item for item in pending["items"] if item["direction"] == "expense")
    income_item = next(item for item in pending["items"] if item["direction"] == "income")

    rejected = client.put("/api/annotations/batch", json={
        "transaction_ids": [expense_item["id"], income_item["id"]],
        "label_ids": [food["id"]],
    })
    assert rejected.status_code == 422
    assert client.get("/api/transactions", params={
        "month": "2026-07", "annotation_status": "pending",
    }).json()["total"] == 2
    assert "annotation_saved" not in [item["eventType"] for item in client.get("/api/audit-logs").json()]

    saved = client.put("/api/annotations/batch", json={
        "transaction_ids": [expense_item["id"], expense_item["id"], income_item["id"]],
        "label_ids": [consumption["id"]],
    })
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"updated": 2}
    assert client.get("/api/transactions", params={
        "month": "2026-07", "annotation_status": "pending",
    }).json()["total"] == 0
    completed = client.get("/api/transactions", params={
        "month": "2026-07", "annotation_status": "completed",
    }).json()
    assert completed["total"] == 2
    assert all(item["labelSource"] == "manual" for item in completed["items"])
    events = [item["eventType"] for item in client.get("/api/audit-logs").json()]
    assert events.count("annotation_saved") == 2


def test_arbitrary_label_tree_crud_and_safe_delete(client: TestClient) -> None:
    dimension = client.post("/api/label-dimensions", json={
        "key": "project", "name": "项目", "notes": "项目归因", "selection_mode": "multiple",
    })
    assert dimension.status_code == 201, dimension.text
    dimension_id = dimension.json()["id"]
    dashboard_dimensions = client.get("/api/dashboard", params={"month": "2026-07"}).json()["distributions"]
    assert any(item["key"] == "project" and item["items"] == [] for item in dashboard_dimensions)
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


def test_old_database_gets_applied_at_column_backfilled(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "CREATE TABLE merchant_rules ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(96), source_platform VARCHAR(16), "
            "counterparty_exact TEXT, counterparty_normalized TEXT, label_ids_json TEXT, "
            "notes TEXT, enabled BOOLEAN, created_at DATETIME, updated_at DATETIME)"
        )
        connection.execute(
            "INSERT INTO merchant_rules (name, counterparty_exact, counterparty_normalized, "
            "label_ids_json, enabled) VALUES ('旧规则', '美团', '美团', '[]', 1)"
        )

    application = create_app(database_url=f"sqlite:///{database_path}", data_root=tmp_path / "data")
    with TestClient(application) as client:
        rules = client.get("/api/rules").json()
        assert len(rules) == 1
        assert rules[0]["appliedAt"] is not None


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


def test_dashboard_supports_month_year_and_inclusive_custom_ranges(client: TestClient) -> None:
    transactions = [
        ("2025-12-31T12:00:00", "收入", "100.00", "range-2025"),
        ("2026-01-01T12:00:00", "收入", "10.00", "range-jan-1"),
        ("2026-01-04T12:00:00", "支出", "4.00", "range-jan-4"),
        ("2026-01-05T12:00:00", "支出", "5.00", "range-jan-5"),
        ("2026-02-01T12:00:00", "收入", "20.00", "range-feb-1"),
        ("2027-01-01T12:00:00", "支出", "7.00", "range-2027"),
    ]
    for transaction in transactions:
        _manual_transaction(client, *transaction)

    monthly = client.get("/api/dashboard", params={"month": "2026-01"})
    assert monthly.status_code == 200, monthly.text
    monthly_payload = monthly.json()
    assert monthly_payload["summary"] == {"income": 10.0, "expense": 9.0, "net": 1.0}
    assert [item["date"] for item in monthly_payload["trend"]] == ["2026-01-01", "2026-01-04", "2026-01-05"]
    assert len(monthly_payload["recent"]) == 3
    assert sum(item["value"] for item in monthly_payload["channels"]) == 9.0

    annual = client.get("/api/dashboard", params={"year": 2026, "trend_granularity": "month"})
    assert annual.status_code == 200, annual.text
    annual_payload = annual.json()
    assert annual_payload["summary"] == {"income": 30.0, "expense": 9.0, "net": 21.0}
    assert annual_payload["trend"] == [
        {"date": "2026-01-01", "income": 10.0, "expense": 9.0},
        {"date": "2026-02-01", "income": 20.0, "expense": 0},
    ]
    income_distribution = next(item for item in annual_payload["distributions"] if item["key"] == "income_category")
    assert sum(item["value"] for item in income_distribution["items"]) == 30.0
    assert len(annual_payload["recent"]) == 4

    custom = client.get("/api/dashboard", params={
        "start_date": "2026-01-04", "end_date": "2026-02-01", "trend_granularity": "week",
    })
    assert custom.status_code == 200, custom.text
    custom_payload = custom.json()
    assert custom_payload["summary"] == {"income": 20.0, "expense": 9.0, "net": 11.0}
    assert custom_payload["trend"] == [
        {"date": "2025-12-29", "income": 0, "expense": 4.0},
        {"date": "2026-01-05", "income": 0, "expense": 5.0},
        {"date": "2026-01-26", "income": 20.0, "expense": 0},
    ]
    assert {item["date"][:10] for item in custom_payload["recent"]} == {
        "2026-01-04", "2026-01-05", "2026-02-01",
    }


def test_dashboard_rejects_conflicting_or_invalid_ranges_and_granularity(client: TestClient) -> None:
    invalid_params = [
        {"month": "2026-01", "year": 2026},
        {"year": 2026, "start_date": "2026-01-01", "end_date": "2026-01-31"},
        {"start_date": "2026-01-01"},
        {"end_date": "2026-01-31"},
        {"start_date": "2026/01/01", "end_date": "2026-01-31"},
        {"start_date": "2026-02-01", "end_date": "2026-01-31"},
        {"start_date": "9999-12-31", "end_date": "9999-12-31"},
        {"start_date": "1899-12-31", "end_date": "1900-01-01"},
        {"month": "2026-13"},
        {"year": 1899},
        {"trend_granularity": "quarter"},
    ]
    for params in invalid_params:
        response = client.get("/api/dashboard", params=params)
        assert response.status_code == 422, (params, response.text)


NORMALIZED_SEARCH_FIELDS = {
    "source_platform", "transaction_time", "direction", "amount", "counterparty",
    "item_description", "payment_method", "payment_channel", "transaction_status",
    "status_category", "transaction_id", "merchant_order_id", "transaction_type",
    "source_category", "counterparty_account", "note",
}


def _prepare_search_records(client: TestClient) -> None:
    _import_wechat(client)
    response = client.post(
        "/api/import",
        files={"files": ("alipay.csv", make_alipay_csv(), "text/csv")},
    )
    assert response.status_code == 200, response.text
    response = client.post("/api/transactions/manual", json={
        "transaction_time": "2026-08-10T10:04:11",
        "direction": "收入",
        "amount": "5252.20",
        "counterparty": "示例公司",
        "summary": "工资",
        "category": "工资",
        "payment_channel": "银行卡",
        "payment_method": "招商银行",
        "counterparty_account": "manual-account",
        "reference_id": "manual-search-1",
        "note": "例外补录",
    })
    assert response.status_code == 201, response.text


def test_transaction_search_registers_all_normalized_fields_and_returns_raw_fields(
    client: TestClient,
) -> None:
    field_schema = client.app.openapi()["components"]["schemas"]["TransactionSearchFilter"]["properties"]["field"]
    assert set(field_schema["enum"]) == NORMALIZED_SEARCH_FIELDS
    _import_wechat(client)

    result = _search(client, filters=[{
        "field": "transaction_id", "mode": "include", "operator": "equals", "value": "wx-1",
    }])

    assert result["total"] == 1
    item = result["items"][0]
    assert item["transactionStatus"] == "支付成功"
    assert item["statusCategory"] == "成功"
    assert item["merchantOrderId"] == "m-1"
    assert item["counterpartyAccount"] is None
    assert item["cleanedPaymentChannel"] == "微信零钱"
    assert item["status"] == item["statusCategory"]


@pytest.mark.parametrize(("field", "operator", "payload", "transaction_id"), [
    ("source_platform", "equals", {"value": "支付宝"}, "ali-1"),
    ("transaction_time", "range", {"min": "2026-07-31T23:24:39", "max": "2026-07-31T23:24:39"}, "wx-1"),
    ("direction", "equals", {"value": "支出"}, "wx-1"),
    ("amount", "range", {"min": "4.00", "max": "4.00"}, "wx-1"),
    ("counterparty", "equals", {"value": "美团"}, "wx-1"),
    ("item_description", "contains", {"value": "午餐"}, "wx-1"),
    ("payment_method", "contains", {"value": "零钱"}, "wx-1"),
    ("payment_channel", "equals", {"value": "微信零钱"}, "wx-1"),
    ("transaction_status", "equals", {"value": "支付成功"}, "wx-1"),
    ("status_category", "equals", {"value": "退款"}, "wx-2"),
    ("transaction_id", "equals", {"value": "wx-1"}, "wx-1"),
    ("merchant_order_id", "equals", {"value": "m-1"}, "wx-1"),
    ("transaction_type", "contains", {"value": "商户"}, "wx-1"),
    ("source_category", "equals", {"value": "交通出行"}, "ali-1"),
    ("counterparty_account", "equals", {"value": "***"}, "ali-1"),
    ("note", "equals", {"value": "例外补录"}, "manual-search-1"),
])
def test_transaction_search_filters_representative_values_for_every_normalized_field(
    client: TestClient,
    field: str,
    operator: str,
    payload: dict[str, str],
    transaction_id: str,
) -> None:
    _prepare_search_records(client)

    result = _search(client, filters=[{
        "field": field, "mode": "include", "operator": operator, **payload,
    }])

    assert transaction_id in {item["transactionId"] for item in result["items"]}


def test_transaction_search_combines_same_field_or_cross_field_and_and_exclusion(
    client: TestClient,
) -> None:
    _prepare_search_records(client)
    filters = [
        {"field": "counterparty", "mode": "include", "operator": "equals", "value": "美团"},
        {"field": "counterparty", "mode": "include", "operator": "equals", "value": "滴滴出行"},
        {"field": "direction", "mode": "include", "operator": "equals", "value": "支出"},
    ]
    included = _search(client, filters=filters)
    assert {item["transactionId"] for item in included["items"]} == {"wx-1", "ali-1"}

    excluded = _search(client, filters=[
        *filters,
        {"field": "source_platform", "mode": "exclude", "operator": "equals", "value": "支付宝"},
    ])
    assert [item["transactionId"] for item in excluded["items"]] == ["wx-1"]


def test_transaction_search_keeps_global_query_and_inclusive_ranges_orthogonal(
    client: TestClient,
) -> None:
    _prepare_search_records(client)
    filters = [
        {"field": "transaction_time", "mode": "include", "operator": "range",
         "min": "2026-07-31T23:24:39", "max": "2026-07-31T23:24:39"},
        {"field": "amount", "mode": "include", "operator": "range", "min": "4.00", "max": "4.00"},
    ]

    included = _search(client, query={"text": "美团", "mode": "include"}, filters=filters)
    assert [item["transactionId"] for item in included["items"]] == ["wx-1"]
    excluded = _search(client, query={"text": "午餐", "mode": "exclude"}, filters=filters)
    assert excluded["total"] == 0


def test_transaction_search_date_only_max_includes_the_entire_day(client: TestClient) -> None:
    _manual_transaction(client, "2026-08-10T23:59:59", "支出", "8.00", "date-range-late")
    _manual_transaction(client, "2026-08-11T00:00:00", "支出", "9.00", "date-range-next-day")

    whole_day = _search(client, filters=[{
        "field": "transaction_time", "mode": "include", "operator": "range",
        "min": "2026-08-10", "max": "2026-08-10",
    }])
    assert [item["transactionId"] for item in whole_day["items"]] == ["date-range-late"]

    precise_max = _search(client, filters=[{
        "field": "transaction_time", "mode": "include", "operator": "range",
        "min": "2026-08-10T00:00:00", "max": "2026-08-10T23:59:58",
    }])
    assert precise_max["total"] == 0


def test_transaction_search_supports_empty_filters_category_channel_status_and_pagination(
    client: TestClient,
) -> None:
    _prepare_search_records(client)
    empty_source_category = _search(client, filters=[{
        "field": "source_category", "mode": "include", "operator": "is_empty",
    }])
    assert {item["transactionId"] for item in empty_source_category["items"]} >= {"wx-1", "wx-2"}
    assert "ali-1" not in {item["transactionId"] for item in empty_source_category["items"]}
    assert _search(client, filters=[{
        "field": "amount", "mode": "include", "operator": "is_empty",
    }])["total"] == 0
    filtered = _search(
        client, month="2026-07", category="未分类", channel="微信零钱",
        annotation_status="pending", page=1, page_size=1,
    )
    assert filtered["total"] == 1
    assert filtered["page"] == 1 and filtered["pageSize"] == 1
    assert filtered["items"][0]["transactionId"] == "wx-1"


@pytest.mark.parametrize("body", [
    {"unexpected": True},
    {"query": {"text": "x", "mode": "include", "unexpected": True}},
    {"query": {"text": "x" * 201, "mode": "include"}},
    {"page": 0},
    {"page_size": 501},
    {"filters": [{"field": "unknown", "mode": "include", "operator": "equals", "value": "x"}]},
    {"filters": [{"field": "amount", "mode": "include", "operator": "contains", "value": "1"}]},
    {"filters": [{"field": "counterparty", "mode": "include", "operator": "range", "min": "a"}]},
    {"filters": [{"field": "counterparty", "mode": "include", "operator": "equals"}]},
    {"filters": [{"field": "counterparty", "mode": "include", "operator": "is_empty", "value": "x"}]},
    {"filters": [{"field": "amount", "mode": "include", "operator": "range"}]},
    {"filters": [{"field": "amount", "mode": "include", "operator": "range", "min": "nan"}]},
    {"filters": [{"field": "amount", "mode": "include", "operator": "range", "min": "not-a-number"}]},
    {"filters": [{"field": "amount", "mode": "include", "operator": "range", "min": "2", "max": "1"}]},
    {"filters": [{"field": "transaction_time", "mode": "include", "operator": "range", "min": "not-a-date"}]},
    {"filters": [{"field": "transaction_time", "mode": "include", "operator": "range",
                  "min": "2026-08-11T00:00:00", "max": "2026-08-10"}]},
    {"filters": [{"field": "transaction_time", "mode": "include", "operator": "range",
                  "max": "9999-12-31"}]},
    {"filters": [
        {"field": "note", "mode": "include", "operator": "is_empty"} for _ in range(33)
    ]},
])
def test_transaction_search_rejects_invalid_requests(client: TestClient, body: dict) -> None:
    response = client.post("/api/transactions/search", json=body)
    assert response.status_code == 422, response.text


def test_legacy_transaction_get_semantics_remain_available(client: TestClient) -> None:
    _import_wechat(client)
    response = client.get("/api/transactions", params={
        "month": "2026-07", "source_platform": "微信", "direction": "expense", "query": "美团",
    })
    assert response.status_code == 200, response.text
    assert [item["transactionId"] for item in response.json()["items"]] == ["wx-1"]
