import type { AnnotationData, DashboardData, DashboardGranularity, DashboardRange, HeatmapData, ImportResult, LabelDimension, LabelNode, ManualTransactionInput, MerchantRule, Transaction, TransactionPage } from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init)
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    try { const body = (await response.json()) as { detail?: string; message?: string }; message = body.detail ?? body.message ?? message } catch { /* keep status */ }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}
function json(method: string, body?: unknown): RequestInit { return { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) } }

export async function importStatements(files: File[], archivePassword?: string): Promise<ImportResult> { const body = new FormData(); files.forEach((file) => body.append('files', file)); if (archivePassword) body.append('archive_password', archivePassword); return request('/api/import', { method: 'POST', body }) }
export function getDashboard(range: DashboardRange, trendGranularity: DashboardGranularity) {
  const query = new URLSearchParams({ trend_granularity: trendGranularity })
  if (range.mode === 'month') query.set('month', range.month)
  else if (range.mode === 'year') query.set('year', String(range.year))
  else { query.set('start_date', range.startDate); query.set('end_date', range.endDate) }
  return request<DashboardData>(`/api/dashboard?${query}`)
}
export const getHeatmaps = (year: number) => request<HeatmapData>(`/api/heatmaps?year=${year}`)
export async function getTransactions(params: { month: string; category?: string; channel?: string; query?: string; annotationStatus?: 'pending' | 'completed' }): Promise<TransactionPage> {
  const query = new URLSearchParams({ month: params.month, page_size: '500' }); if (params.category) query.set('category', params.category); if (params.channel) query.set('channel', params.channel); if (params.query) query.set('query', params.query)
  if (params.annotationStatus) query.set('annotation_status', params.annotationStatus)
  return request<TransactionPage>(`/api/transactions?${query}`)
}
export const getLabelCatalog = () => request<LabelDimension[]>('/api/label-catalog')
export const createDimension = (body: object) => request<LabelDimension>('/api/label-dimensions', json('POST', body))
export const updateDimension = (id: string, body: object) => request<LabelDimension>(`/api/label-dimensions/${id}`, json('PATCH', body))
export const deleteDimension = (id: string) => request<{ disposition: string; references: number }>(`/api/label-dimensions/${id}`, { method: 'DELETE' })
export const createLabel = (body: object) => request<LabelNode>('/api/labels', json('POST', body))
export const updateLabel = (id: number, body: object) => request<LabelNode>(`/api/labels/${id}`, json('PATCH', body))
export const deleteLabel = (id: number) => request<{ disposition: string; references: number; children: number }>(`/api/labels/${id}`, { method: 'DELETE' })
export const getAnnotation = (id: number) => request<AnnotationData>(`/api/transactions/${id}/annotation`)
export const saveAnnotation = (id: number, labelIds: number[]) => request<AnnotationData>(`/api/transactions/${id}/annotation`, json('PUT', { label_ids: labelIds }))
export const saveBatchAnnotations = (transactionIds: number[], labelIds: number[]) => request<{ updated: number }>('/api/annotations/batch', json('PUT', { transaction_ids: transactionIds, label_ids: labelIds }))
export const createManualTransaction = (body: ManualTransactionInput) => request<Transaction>('/api/transactions/manual', json('POST', body))
export const getRules = () => request<MerchantRule[]>('/api/rules')
export const createRule = (body: object) => request<MerchantRule>('/api/rules', json('POST', body))
export const updateRule = (id: number, body: object) => request<MerchantRule>(`/api/rules/${id}`, json('PATCH', body))
export const deleteRule = (id: number) => request<{ disposition: string }>(`/api/rules/${id}`, { method: 'DELETE' })
