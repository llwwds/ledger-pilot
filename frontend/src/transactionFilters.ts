import type { FilterOperator, NormalizedField, TransactionFilter } from './types'

export interface FilterFieldDefinition {
  key: NormalizedField
  label: string
  type: 'text' | 'enum' | 'date' | 'amount'
  options?: string[]
}

export const NORMALIZED_FILTER_FIELDS: FilterFieldDefinition[] = [
  { key: 'source_platform', label: '来源平台', type: 'enum', options: ['微信', '支付宝', '手动'] },
  { key: 'transaction_time', label: '交易时间', type: 'date' },
  { key: 'direction', label: '收支方向', type: 'enum', options: ['收入', '支出', '不计收支'] },
  { key: 'amount', label: '绝对金额', type: 'amount' },
  { key: 'counterparty', label: '交易对方', type: 'text' },
  { key: 'item_description', label: '商品说明', type: 'text' },
  { key: 'payment_method', label: '原始支付方式', type: 'text' },
  { key: 'payment_channel', label: '清洗支付渠道', type: 'text' },
  { key: 'transaction_status', label: '原始交易状态', type: 'text' },
  { key: 'status_category', label: '状态归类', type: 'enum', options: ['成功', '退款', '其他'] },
  { key: 'transaction_id', label: '交易单号', type: 'text' },
  { key: 'merchant_order_id', label: '商户订单号', type: 'text' },
  { key: 'transaction_type', label: '交易类型', type: 'text' },
  { key: 'source_category', label: '平台分类', type: 'text' },
  { key: 'counterparty_account', label: '对方账号', type: 'text' },
  { key: 'note', label: '备注', type: 'text' },
]

export const filterField = (key: NormalizedField) => NORMALIZED_FILTER_FIELDS.find((item) => item.key === key) ?? NORMALIZED_FILTER_FIELDS[0]
export function defaultOperator(field: NormalizedField): FilterOperator { const type = filterField(field).type; return type === 'date' || type === 'amount' ? 'range' : type === 'enum' ? 'equals' : 'contains' }
export function emptyFilter(field: NormalizedField = 'counterparty'): TransactionFilter { return { field, mode: 'include', operator: defaultOperator(field), value: '' } }

export function serializeFilter(filter: TransactionFilter): TransactionFilter {
  const base = { field: filter.field, mode: filter.mode, operator: filter.operator }
  if (filter.operator === 'range') return { ...base, ...(filter.min ? { min: filter.min } : {}), ...(filter.max ? { max: filter.max } : {}) }
  if (filter.operator === 'is_empty') return base
  return { ...base, value: filter.value?.trim() }
}

export function filterDescription(filter: TransactionFilter) {
  const field = filterField(filter.field)
  const mode = filter.mode === 'include' ? '包含' : '排除'
  if (filter.operator === 'range') return `${mode} ${field.label}：${filter.min || '不限'} ～ ${filter.max || '不限'}`
  if (filter.operator === 'is_empty') return `${mode} ${field.label}：空值`
  return `${mode} ${field.label} ${filter.operator === 'contains' ? '模糊匹配' : '精确匹配'}“${filter.value ?? ''}”`
}
