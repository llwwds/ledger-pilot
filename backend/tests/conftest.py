from __future__ import annotations

import csv
import io
import zipfile
from html import escape
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


def _column_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def make_xlsx(rows: list[list[object]]) -> bytes:
    xml_rows = []
    for row_index, row in enumerate(rows, start=1):
        cells = []
        for column_index, value in enumerate(row, start=1):
            reference = f"{_column_name(column_index)}{row_index}"
            if isinstance(value, (int, float)):
                cells.append(f'<c r="{reference}"><v>{value}</v></c>')
            else:
                cells.append(f'<c r="{reference}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
        xml_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(xml_rows)}</sheetData></worksheet>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    return buffer.getvalue()


def make_wechat_xlsx() -> bytes:
    headers = [
        "交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)",
        "支付方式", "当前状态", "交易单号", "商户单号", "备注",
    ]
    return make_xlsx([
        ["微信支付账单"],
        headers,
        [46234.97545, "商户消费", "美团", "午餐", "支出", 4, "零钱", "支付成功", "wx-1", "m-1", "/"],
        [46234.5, "福建乐行网络科技有限公司-退款", "乐行", "退款", "收入", 6, "/", "已退款(¥6.00)", "wx-2", "/", "/"],
    ])


def make_alipay_csv() -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(["支付宝交易明细"])
    writer.writerow([
        "交易时间", "交易分类", "交易对方", "对方账号", "商品说明", "收/支", "金额",
        "收/付款方式", "交易状态", "交易订单号", "商家订单号", "备注",
    ])
    writer.writerow([
        "2026-07-15 12:00:00", "交通出行", "滴滴出行", "***", "打车", "支出", "10.00",
        "招商银行储蓄卡(5605)", "交易成功", "ali-1", "ali-m-1", "",
    ])
    return buffer.getvalue().encode("gb18030")


def make_statement_zip(filename: str, content: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(filename, content)
    return buffer.getvalue()


@pytest.fixture()
def client(tmp_path: Path):
    database_path = tmp_path / "test.db"
    application = create_app(
        database_url=f"sqlite:///{database_path}",
        data_root=tmp_path / "data",
    )
    with TestClient(application) as test_client:
        yield test_client
