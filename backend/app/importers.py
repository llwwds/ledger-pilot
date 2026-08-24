from __future__ import annotations

import csv
import io
import re
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET


SOURCE_WECHAT = "微信"
SOURCE_ALIPAY = "支付宝"
VALID_SOURCES = {SOURCE_WECHAT, SOURCE_ALIPAY}
SUPPORTED_UPLOAD_SUFFIXES = {".csv", ".xlsx"}
MAX_ARCHIVE_MEMBERS = 10
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024


class ImportFormatError(ValueError):
    pass


@dataclass(frozen=True)
class NormalizedTransaction:
    source_platform: str
    transaction_time: datetime
    direction: str
    amount: Decimal
    counterparty: str | None
    item_description: str | None
    payment_method: str | None
    payment_channel: str | None
    transaction_status: str | None
    status_category: str
    transaction_id: str
    merchant_order_id: str | None
    transaction_type: str | None
    source_category: str | None
    counterparty_account: str | None
    note: str | None

    def as_dict(self) -> dict[str, object]:
        return self.__dict__.copy()


@dataclass(frozen=True)
class ExpandedUpload:
    filename: str
    content: bytes
    original_filename: str
    original_content: bytes


def clean(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return None if text in {"", "/", "-"} else text


def derive_status(status: str | None, transaction_type: str | None) -> str:
    combined = f"{status or ''} {transaction_type or ''}"
    if "退款" in combined:
        return "退款"
    if any(marker in combined for marker in ("支付成功", "交易成功", "已转账", "已存入零钱", "对方已收钱")):
        return "成功"
    return "其他"


def derive_payment_channel(source: str, payment_method: str | None, direction: str) -> str | None:
    if not payment_method:
        return None
    if source == SOURCE_WECHAT:
        if "零钱" in payment_method:
            return "微信零钱"
        if "亲属卡" in payment_method:
            return "微信亲属卡"
        if "银行" in payment_method or "储蓄卡" in payment_method or "信用卡" in payment_method:
            return "微信银行卡"
    if source == SOURCE_ALIPAY:
        if "余额" in payment_method:
            return "支付宝余额"
        if "银行" in payment_method or "储蓄卡" in payment_method or "信用卡" in payment_method:
            return "支付宝银行卡"
    return "银行卡"


def parse_amount(value: object) -> Decimal:
    text = (clean(value) or "0").replace(",", "").replace("¥", "").replace("￥", "")
    try:
        return Decimal(text).quantize(Decimal("0.01"))
    except InvalidOperation as exc:
        raise ImportFormatError(f"无法解析金额: {value!r}") from exc


def parse_time(value: object, *, excel_serial: bool = False) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    text = clean(value)
    if text is None:
        raise ImportFormatError("交易时间为空")
    if excel_serial or re.fullmatch(r"\d+(?:\.\d+)?", text):
        # XLSX stores days as a float. Round to the nearest second so values
        # such as 46234.97545 match the exported display (23:24:39).
        return datetime(1899, 12, 30) + timedelta(seconds=round(float(text) * 86_400))
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise ImportFormatError(f"无法解析交易时间: {text!r}")


def _require(mapping: dict[str, object], key: str) -> object:
    if key not in mapping:
        raise ImportFormatError(f"缺少必需列: {key}")
    return mapping[key]


def normalize_row(source: str, row: dict[str, object]) -> NormalizedTransaction:
    if source == SOURCE_WECHAT:
        transaction_type = clean(row.get("交易类型"))
        category = None
        payment_method = clean(row.get("支付方式"))
        status = clean(row.get("当前状态"))
        transaction_id = clean(_require(row, "交易单号"))
        data = {
            "transaction_time": parse_time(_require(row, "交易时间"), excel_serial=True),
            "item_description": clean(row.get("商品")),
            "merchant_order_id": clean(row.get("商户单号")),
            "counterparty_account": None,
        }
    elif source == SOURCE_ALIPAY:
        transaction_type = None
        category = clean(row.get("交易分类"))
        payment_method = clean(row.get("收/付款方式"))
        status = clean(row.get("交易状态"))
        transaction_id = clean(_require(row, "交易订单号"))
        data = {
            "transaction_time": parse_time(_require(row, "交易时间")),
            "item_description": clean(row.get("商品说明")),
            "merchant_order_id": clean(row.get("商家订单号")),
            "counterparty_account": clean(row.get("对方账号")),
        }
    else:
        raise ImportFormatError(f"不支持的来源平台: {source}")
    if not transaction_id:
        raise ImportFormatError("交易单号为空")
    direction = clean(_require(row, "收/支")) or "不计收支"
    return NormalizedTransaction(
        source_platform=source,
        transaction_time=data["transaction_time"],
        direction=direction,
        amount=parse_amount(row.get("金额(元)") if source == SOURCE_WECHAT else row.get("金额")),
        counterparty=clean(row.get("交易对方")),
        item_description=data["item_description"],
        payment_method=payment_method,
        payment_channel=derive_payment_channel(source, payment_method, direction),
        transaction_status=status,
        status_category=derive_status(status, transaction_type),
        transaction_id=transaction_id,
        merchant_order_id=data["merchant_order_id"],
        transaction_type=transaction_type,
        source_category=category,
        counterparty_account=data["counterparty_account"],
        note=clean(row.get("备注")),
    )


def parse_alipay_csv(content: bytes) -> list[NormalizedTransaction]:
    decoded = None
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            decoded = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if decoded is None:
        raise ImportFormatError("支付宝 CSV 编码不是 UTF-8 或 GB18030")
    rows = list(csv.reader(io.StringIO(decoded)))
    header_index = next(
        (i for i, row in enumerate(rows) if row and row[0].strip() == "交易时间"), None
    )
    if header_index is None:
        raise ImportFormatError("支付宝 CSV 未找到交易时间表头")
    headers = [cell.strip() for cell in rows[header_index]]
    output: list[NormalizedTransaction] = []
    for values in rows[header_index + 1 :]:
        if not values or not any(value.strip() for value in values):
            continue
        padded = values + [""] * max(0, len(headers) - len(values))
        row = dict(zip(headers, padded, strict=False))
        if clean(row.get("交易时间")) is None:
            continue
        output.append(normalize_row(SOURCE_ALIPAY, row))
    if not output:
        raise ImportFormatError("支付宝 CSV 没有交易记录")
    return output


_XML_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _column_index(cell_reference: str) -> int:
    letters = re.match(r"[A-Z]+", cell_reference)
    if not letters:
        raise ImportFormatError(f"无效的 XLSX 单元格引用: {cell_reference}")
    value = 0
    for letter in letters.group(0):
        value = value * 26 + ord(letter) - ord("A") + 1
    return value - 1


def _read_xlsx_rows(content: bytes) -> list[list[str]]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.text or "" for node in item.iter(_XML_NS + "t")) for item in root.findall(_XML_NS + "si")]
        sheet_name = next((name for name in archive.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)), None)
        if sheet_name is None:
            raise ImportFormatError("XLSX 没有工作表")
        sheet = ET.fromstring(archive.read(sheet_name))
    except (zipfile.BadZipFile, ET.ParseError, KeyError) as exc:
        raise ImportFormatError("微信文件不是有效的 XLSX") from exc

    rows: list[list[str]] = []
    for row_node in sheet.iter(_XML_NS + "row"):
        cells: dict[int, str] = {}
        for cell in row_node.findall(_XML_NS + "c"):
            index = _column_index(cell.get("r", ""))
            kind = cell.get("t")
            value_node = cell.find(_XML_NS + "v")
            if kind == "inlineStr":
                inline = cell.find(_XML_NS + "is")
                value = "" if inline is None else "".join(n.text or "" for n in inline.iter(_XML_NS + "t"))
            elif value_node is None:
                value = ""
            elif kind == "s":
                value = shared[int(value_node.text or "0")]
            else:
                value = value_node.text or ""
            cells[index] = value
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return rows


def parse_wechat_xlsx(content: bytes) -> list[NormalizedTransaction]:
    rows = _read_xlsx_rows(content)
    header_index = next((i for i, row in enumerate(rows) if row and row[0].strip() == "交易时间"), None)
    if header_index is None:
        raise ImportFormatError("微信 XLSX 未找到交易时间表头")
    headers = [cell.strip() for cell in rows[header_index]]
    output: list[NormalizedTransaction] = []
    for values in rows[header_index + 1 :]:
        if not values or not any(value.strip() for value in values):
            continue
        padded = values + [""] * max(0, len(headers) - len(values))
        row = dict(zip(headers, padded, strict=False))
        if clean(row.get("交易时间")) is None:
            continue
        output.append(normalize_row(SOURCE_WECHAT, row))
    if not output:
        raise ImportFormatError("微信 XLSX 没有交易记录")
    return output


def infer_source(filename: str, requested_source: str | None = None) -> str:
    if requested_source:
        if requested_source not in VALID_SOURCES:
            raise ImportFormatError(f"不支持的来源平台: {requested_source}")
        return requested_source
    suffix = Path(filename).suffix.lower()
    if suffix == ".xlsx":
        return SOURCE_WECHAT
    if suffix == ".csv":
        return SOURCE_ALIPAY
    raise ImportFormatError("只能导入微信 .xlsx 或支付宝 .csv")


def archive_password_candidates(value: str | None) -> list[bytes]:
    if not value:
        return []
    texts: list[str] = []
    normalized = value.lstrip("\ufeff").strip()
    if normalized:
        texts.append(normalized)
    for line in normalized.splitlines():
        candidate = re.split(r"[:：]", line, maxsplit=1)[-1].strip()
        if candidate:
            texts.append(candidate)
    output: list[bytes] = []
    for text in texts:
        for encoding in ("utf-8", "gb18030"):
            encoded = text.encode(encoding)
            if encoded not in output:
                output.append(encoded)
    return output


def expand_upload(filename: str, content: bytes, archive_password: str | None = None) -> list[ExpandedUpload]:
    if Path(filename).suffix.lower() != ".zip":
        return [ExpandedUpload(filename, content, filename, content)]
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            members = [
                info for info in archive.infolist()
                if not info.is_dir() and Path(info.filename).suffix.lower() in SUPPORTED_UPLOAD_SUFFIXES
            ]
            if not members:
                raise ImportFormatError("压缩包中没有可导入的 .xlsx 或 .csv 账单")
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise ImportFormatError(f"一个压缩包最多包含 {MAX_ARCHIVE_MEMBERS} 个账单文件")
            if sum(info.file_size for info in members) > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                raise ImportFormatError("压缩包解压后的账单总大小不能超过 50 MB")
            passwords = archive_password_candidates(archive_password)
            expanded: list[ExpandedUpload] = []
            for info in members:
                if info.flag_bits & 0x1 and not passwords:
                    raise ImportFormatError("加密压缩包需要填写解压密码")
                if info.flag_bits & 0x1:
                    member_content = None
                    last_error: Exception | None = None
                    for password in passwords:
                        try:
                            member_content = archive.read(info, pwd=password)
                            break
                        except (RuntimeError, NotImplementedError) as exc:
                            last_error = exc
                    if member_content is None:
                        raise ImportFormatError("压缩包解压失败，请检查密码或压缩格式") from last_error
                else:
                    member_content = archive.read(info)
                expanded.append(ExpandedUpload(
                    filename=Path(info.filename).name,
                    content=member_content,
                    original_filename=filename,
                    original_content=content,
                ))
            return expanded
    except zipfile.BadZipFile as exc:
        raise ImportFormatError("上传文件不是有效的 ZIP 压缩包") from exc


def parse_upload(filename: str, content: bytes, requested_source: str | None = None) -> tuple[str, list[NormalizedTransaction]]:
    source = infer_source(filename, requested_source)
    suffix = Path(filename).suffix.lower()
    if source == SOURCE_WECHAT and suffix != ".xlsx":
        raise ImportFormatError("微信账单必须是 .xlsx")
    if source == SOURCE_ALIPAY and suffix != ".csv":
        raise ImportFormatError("支付宝账单必须是 .csv")
    parser = parse_wechat_xlsx if source == SOURCE_WECHAT else parse_alipay_csv
    return source, parser(content)
