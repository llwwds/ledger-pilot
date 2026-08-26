export interface Summary { income: number; expense: number; net: number }
export type DashboardGranularity = 'day' | 'week' | 'month'
export type DashboardRange =
  | { mode: 'month'; month: string }
  | { mode: 'year'; year: number }
  | { mode: 'custom'; startDate: string; endDate: string }
export interface TrendPoint { date: string; income: number; expense: number }
export interface DistributionItem { name: string; value: number }
export interface DashboardDistribution { dimensionId: string; key: string; name: string; items: DistributionItem[] }
export interface AssignedLabel { id: number; name: string; dimensionId: string; dimensionKey: string; parentId?: number | null; source: 'manual' | 'rule' }
export interface Transaction {
  id: number; date: string; merchant: string; counterparty?: string; itemDescription?: string; note?: string
  amount: number; direction: 'income' | 'expense'; category: string; categorySource: 'manual' | 'rule' | 'unassigned'
  channel: string; channelSource: 'manual' | 'rule' | 'unassigned'; labelSource: 'manual' | 'rule' | 'unassigned'
  effectiveLabels: AssignedLabel[]; sourcePlatform: string; transactionId: string; transactionType?: string
  sourceCategory?: string; paymentMethod?: string; status: string; statusCategory?: string
  transactionStatus?: string; merchantOrderId?: string; counterpartyAccount?: string; cleanedPaymentChannel?: string
}
export interface DashboardData { summary: Summary; trend: TrendPoint[]; categories: DistributionItem[]; channels: DistributionItem[]; distributions?: DashboardDistribution[]; recent: Transaction[] }
export interface TransactionPage { items: Transaction[]; total: number; page: number; pageSize: number }
export type NormalizedField = 'source_platform' | 'transaction_time' | 'direction' | 'amount' | 'counterparty' | 'item_description' | 'payment_method' | 'payment_channel' | 'transaction_status' | 'status_category' | 'transaction_id' | 'merchant_order_id' | 'transaction_type' | 'source_category' | 'counterparty_account' | 'note'
export type FilterMode = 'include' | 'exclude'
export type FilterOperator = 'equals' | 'contains' | 'range' | 'is_empty'
export interface TransactionFilter { field: NormalizedField; mode: FilterMode; operator: FilterOperator; value?: string; min?: string; max?: string }
export interface TransactionSearchRequest {
  month?: string; query?: { text: string; mode: FilterMode }; filters: TransactionFilter[]
  category?: string; channel?: string; annotation_status?: 'pending' | 'completed'; page: number; page_size: number
}
export interface HeatmapPoint { date: string; value: number; count: number }
export interface HeatmapData { year: number; expense: HeatmapPoint[]; income: HeatmapPoint[] }
export interface ImportResult { imported: number; merged: number; skipped: number }
export interface LabelNode { id: number; dimensionId: string; parentId: number | null; name: string; notes?: string; sortOrder: number; enabled: boolean; usageCount: number }
export interface LabelDimension { id: string; key: string; name: string; notes?: string; selectionMode: 'single' | 'multiple'; sortOrder: number; enabled: boolean; labels: LabelNode[] }
export interface AssignmentSet { manual: AssignedLabel[]; rule: AssignedLabel[]; effective: AssignedLabel[]; matchedRuleId?: number | null; confirmedDimensionIds: string[] }
export interface AnnotationData { transaction: Transaction; assignments: AssignmentSet }
export interface MerchantRule { id: number; name: string; sourcePlatform?: string; counterpartyExact: string; labelIds: number[]; notes?: string; enabled: boolean }
export interface ManualTransactionInput {
  transaction_time: string; direction: '收入' | '支出'; amount: string; counterparty?: string
  summary: string; category?: string; payment_channel?: string; payment_method?: string
  counterparty_account?: string; reference_id?: string; note?: string; label_ids: number[]
}
