from __future__ import annotations

from app.importers import archive_password_candidates, parse_alipay_csv, parse_wechat_xlsx

from .conftest import make_alipay_csv, make_wechat_xlsx


def test_parse_wechat_xlsx_normalizes_and_derives_fields() -> None:
    rows = parse_wechat_xlsx(make_wechat_xlsx())

    assert len(rows) == 2
    assert rows[0].transaction_time.strftime("%Y-%m-%d %H:%M:%S") == "2026-07-31 23:24:39"
    assert str(rows[0].amount) == "4.00"
    assert rows[0].payment_channel == "微信零钱"
    assert rows[0].status_category == "成功"
    assert rows[0].note is None
    assert rows[1].status_category == "退款"
    assert rows[1].payment_channel is None


def test_parse_alipay_gb18030_and_source_specific_fields() -> None:
    rows = parse_alipay_csv(make_alipay_csv())

    assert len(rows) == 1
    assert rows[0].source_platform == "支付宝"
    assert rows[0].source_category == "交通出行"
    assert rows[0].counterparty_account == "***"
    assert rows[0].payment_channel == "支付宝银行卡"
    assert rows[0].status_category == "成功"


def test_archive_password_candidates_accepts_labeled_multiline_text() -> None:
    candidates = archive_password_candidates("微信：first\n支付宝：second")

    assert b"first" in candidates
    assert b"second" in candidates
    assert b"\xe5\xbe\xae\xe4\xbf\xa1\xef\xbc\x9afirst\n\xe6\x94\xaf\xe4\xbb\x98\xe5\xae\x9d\xef\xbc\x9asecond" in candidates
