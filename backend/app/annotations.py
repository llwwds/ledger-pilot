from __future__ import annotations

import json
import unicodedata
import uuid
from collections import defaultdict

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .models import (
    AuditLog,
    Label,
    LabelDimension,
    MerchantRule,
    ManualDimensionConfirmation,
    Transaction,
    TransactionLabelAssignment,
    utc_now,
)


BUILTIN_DIMENSIONS = (
    ("payment_channel", "支付渠道", "single", "资金实际经过的渠道"),
    ("business_type", "业务类型", "single", "消费、退款、转账等业务语义"),
    ("income_category", "收入分类", "single", "仅用于收入流水"),
    ("expense_category", "支出分类", "single", "仅用于支出流水"),
    ("special_tag", "特殊标签", "multiple", "可同时选择多个的补充标签"),
)

BUILTIN_LABELS = {
    "payment_channel": ["微信零钱", "微信银行卡", "微信亲属卡", "支付宝余额", "支付宝银行卡", "银行卡", "未识别"],
    "business_type": ["消费", "退款", "转账"],
    "income_category": ["工资", "奖金", "退款", "转账收入", "其他收入"],
    "expense_category": ["餐饮", "交通", "购物", "居住", "教育", "医疗", "娱乐", "人情", "其他支出"],
    "special_tag": [],
}


def normalize_exact(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def seed_label_catalog(session: Session) -> None:
    changed = False
    for index, (key, name, selection_mode, notes) in enumerate(BUILTIN_DIMENSIONS):
        dimension = session.scalar(select(LabelDimension).where(LabelDimension.key == key))
        if dimension is None:
            dimension = LabelDimension(
                id=str(uuid.uuid4()), key=key, name=name, notes=notes,
                selection_mode=selection_mode, sort_order=index,
            )
            session.add(dimension)
            session.flush()
            changed = True
        existing_names = set(session.scalars(
            select(Label.name).where(Label.dimension_id == dimension.id)
        ))
        for label_index, label_name in enumerate(BUILTIN_LABELS[key]):
            if label_name not in existing_names:
                session.add(Label(
                    dimension_id=dimension.id, name=label_name, sort_order=label_index
                ))
                changed = True
    if changed:
        session.commit()


def audit(session: Session, event_type: str, entity_type: str, entity_id: object | None, details: dict) -> None:
    session.add(AuditLog(
        event_type=event_type,
        entity_type=entity_type,
        entity_id=None if entity_id is None else str(entity_id),
        details_json=json.dumps(details, ensure_ascii=False, default=str),
    ))


def label_catalog(session: Session) -> list[dict]:
    dimensions = list(session.scalars(select(LabelDimension).order_by(LabelDimension.sort_order, LabelDimension.name)))
    usage_rows = session.execute(
        select(TransactionLabelAssignment.label_id, func.count(TransactionLabelAssignment.id))
        .group_by(TransactionLabelAssignment.label_id)
    ).all()
    usage = dict(usage_rows)
    result = []
    for dimension in dimensions:
        labels = list(session.scalars(
            select(Label).where(Label.dimension_id == dimension.id)
            .order_by(Label.sort_order, Label.name)
        ))
        result.append({
            "id": dimension.id,
            "key": dimension.key,
            "name": dimension.name,
            "notes": dimension.notes,
            "selectionMode": dimension.selection_mode,
            "sortOrder": dimension.sort_order,
            "enabled": dimension.enabled,
            "labels": [{
                "id": label.id,
                "dimensionId": label.dimension_id,
                "parentId": label.parent_id,
                "name": label.name,
                "notes": label.notes,
                "sortOrder": label.sort_order,
                "enabled": label.enabled,
                "usageCount": usage.get(label.id, 0),
            } for label in labels],
        })
    return result


def rule_amount_in_range(rule: MerchantRule, transaction: Transaction) -> bool:
    amount = transaction.amount
    if rule.amount_min is not None and amount < rule.amount_min:
        return False
    if rule.amount_max is not None and amount > rule.amount_max:
        return False
    return True


def rule_conditions_match(rule: MerchantRule, transaction: Transaction) -> bool:
    """条件级匹配：平台限制与可选金额范围；交易对方名称由调用方先行精确比对。"""
    if rule.source_platform and rule.source_platform != transaction.source_platform:
        return False
    if rule.amount_min is None and rule.amount_max is None:
        return True
    in_range = rule_amount_in_range(rule, transaction)
    return in_range if (rule.amount_scope or "inside") == "inside" else not in_range


def _matched_rule(session: Session, transaction: Transaction) -> MerchantRule | None:
    normalized = normalize_exact(transaction.counterparty or "")
    if not normalized:
        return None
    rules = list(session.scalars(
        select(MerchantRule).where(
            MerchantRule.enabled.is_(True),
            MerchantRule.applied_at.is_not(None),
            MerchantRule.counterparty_normalized == normalized,
        ).order_by(MerchantRule.id)
    ))
    return next((rule for rule in rules if rule_conditions_match(rule, transaction)), None)


def _builtin_suggestions(session: Session, transaction: Transaction) -> list[int]:
    candidates: list[tuple[str, str | None]] = [("payment_channel", transaction.payment_channel)]
    if transaction.direction == "收入":
        candidates.append(("income_category", transaction.source_category))
    else:
        candidates.append(("expense_category", transaction.source_category))

    type_text = f"{transaction.transaction_type or ''} {transaction.status_category or ''}"
    business_type = "退款" if "退款" in type_text else "转账" if "转账" in type_text else "消费"
    candidates.append(("business_type", business_type))

    ids: list[int] = []
    for dimension_key, name in candidates:
        if not name:
            continue
        label_id = session.scalar(
            select(Label.id).join(LabelDimension).where(
                LabelDimension.key == dimension_key,
                Label.name == name,
                Label.enabled.is_(True),
                LabelDimension.enabled.is_(True),
            )
        )
        if label_id is not None:
            ids.append(label_id)
    return ids


def sync_rule_suggestions(session: Session, transaction: Transaction) -> tuple[list[int], int | None]:
    matched = _matched_rule(session, transaction)
    label_ids = _builtin_suggestions(session, transaction)
    if matched:
        raw_matched_ids = [int(value) for value in json.loads(matched.label_ids_json or "[]")]
        matched_rows = session.execute(
            select(Label.id, Label.dimension_id, LabelDimension.key)
            .join(LabelDimension).where(
                Label.id.in_(raw_matched_ids), Label.enabled.is_(True), LabelDimension.enabled.is_(True)
            )
        ).all() if raw_matched_ids else []
        matched_ids = [label_id for label_id, _, key in matched_rows if not (
            (key == "income_category" and transaction.direction != "收入")
            or (key == "expense_category" and transaction.direction != "支出")
        )]
        matched_dimensions = {dimension_id for label_id, dimension_id, _ in matched_rows if label_id in matched_ids}
        if matched_dimensions:
            builtin_dimensions = dict(session.execute(
                select(Label.id, Label.dimension_id).where(Label.id.in_(label_ids))
            ).all())
            label_ids = [label_id for label_id in label_ids if builtin_dimensions.get(label_id) not in matched_dimensions]
        label_ids.extend(matched_ids)
    label_ids = list(dict.fromkeys(int(value) for value in label_ids))

    session.execute(delete(TransactionLabelAssignment).where(
        TransactionLabelAssignment.transaction_id == transaction.id,
        TransactionLabelAssignment.source == "rule",
    ))
    valid_ids = set(session.scalars(select(Label.id).where(Label.id.in_(label_ids)))) if label_ids else set()
    for label_id in label_ids:
        if label_id in valid_ids:
            session.add(TransactionLabelAssignment(
                transaction_id=transaction.id,
                label_id=label_id,
                source="rule",
                rule_id=matched.id if matched else None,
                confirmed=False,
            ))
    session.flush()
    return label_ids, matched.id if matched else None


def transaction_assignments(session: Session, transaction: Transaction, *, sync_rules: bool = True) -> dict:
    matched_rule_id = None
    if sync_rules:
        _, matched_rule_id = sync_rule_suggestions(session, transaction)
    rows = session.execute(
        select(TransactionLabelAssignment, Label, LabelDimension)
        .join(Label, TransactionLabelAssignment.label_id == Label.id)
        .join(LabelDimension, Label.dimension_id == LabelDimension.id)
        .where(TransactionLabelAssignment.transaction_id == transaction.id)
        .order_by(LabelDimension.sort_order, Label.sort_order, Label.name)
    ).all()
    grouped: dict[str, dict[str, list[dict]]] = defaultdict(lambda: {"manual": [], "rule": []})
    for assignment, label, dimension in rows:
        grouped[dimension.key][assignment.source].append({
            "id": label.id, "name": label.name, "dimensionId": dimension.id,
            "dimensionKey": dimension.key, "parentId": label.parent_id,
        })
    confirmed_dimension_ids = set(session.scalars(
        select(ManualDimensionConfirmation.dimension_id).where(
            ManualDimensionConfirmation.transaction_id == transaction.id
        )
    ))
    effective = []
    for dimension_key, sources in grouped.items():
        dimension_id = (sources["manual"] or sources["rule"])[0]["dimensionId"]
        chosen = sources["manual"] if dimension_id in confirmed_dimension_ids else sources["rule"]
        source = "manual" if dimension_id in confirmed_dimension_ids else "rule"
        effective.extend([{**item, "source": source} for item in chosen])
    return {
        "manual": [item for sources in grouped.values() for item in sources["manual"]],
        "rule": [item for sources in grouped.values() for item in sources["rule"]],
        "effective": effective,
        "matchedRuleId": matched_rule_id,
        "confirmedDimensionIds": sorted(confirmed_dimension_ids),
    }


def save_manual_annotation(
    session: Session,
    transaction: Transaction,
    label_ids: list[int],
    *,
    commit: bool = True,
) -> dict:
    labels = list(session.scalars(
        select(Label).where(Label.id.in_(label_ids), Label.enabled.is_(True))
    )) if label_ids else []
    if len(labels) != len(set(label_ids)):
        raise ValueError("包含不存在或已停用的标签")
    dimensions = {dimension.id: dimension for dimension in session.scalars(select(LabelDimension))}
    grouped: dict[str, list[Label]] = defaultdict(list)
    for label in labels:
        grouped[label.dimension_id].append(label)
        dimension = dimensions[label.dimension_id]
        if dimension.selection_mode == "single" and len(grouped[label.dimension_id]) > 1:
            raise ValueError(f"{dimension.name}只能选择一个标签")
        if dimension.key == "income_category" and transaction.direction != "收入":
            raise ValueError("支出流水不能选择收入分类")
        if dimension.key == "expense_category" and transaction.direction != "支出":
            raise ValueError("收入流水不能选择支出分类")

    before = transaction_assignments(session, transaction)["manual"]
    session.execute(delete(TransactionLabelAssignment).where(
        TransactionLabelAssignment.transaction_id == transaction.id,
        TransactionLabelAssignment.source == "manual",
    ))
    for label in labels:
        session.add(TransactionLabelAssignment(
            transaction_id=transaction.id, label_id=label.id,
            source="manual", confirmed=True,
        ))
    session.execute(delete(ManualDimensionConfirmation).where(
        ManualDimensionConfirmation.transaction_id == transaction.id
    ))
    applicable_dimensions = list(session.scalars(select(LabelDimension).where(
        LabelDimension.enabled.is_(True)
    )))
    for dimension in applicable_dimensions:
        if dimension.key == "income_category" and transaction.direction != "收入":
            continue
        if dimension.key == "expense_category" and transaction.direction != "支出":
            continue
        session.add(ManualDimensionConfirmation(
            transaction_id=transaction.id, dimension_id=dimension.id
        ))
    transaction.updated_at = utc_now()
    transaction.labeled_at = utc_now()
    session.flush()
    after = transaction_assignments(session, transaction, sync_rules=False)["manual"]
    audit(session, "annotation_saved", "transaction", transaction.id, {"before": before, "after": after})
    if commit:
        session.commit()
    return transaction_assignments(session, transaction)


def effective_by_key(assignments: dict) -> dict[str, list[dict]]:
    result: dict[str, list[dict]] = defaultdict(list)
    for item in assignments["effective"]:
        result[item["dimensionKey"]].append(item)
    return result
