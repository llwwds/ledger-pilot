import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  applyRule, createDimension, createLabel, createManualTransaction, createRule, deleteDimension, deleteLabel, deleteRule,
  getAnnotation, getDashboard, getHeatmaps, getLabelCatalog, getRules, importStatements, searchTransactions,
  saveAnnotation, saveBatchAnnotations, updateDimension, updateLabel, updateRule,
} from './api'
import type { AnnotationData, DashboardData, DashboardGranularity, DashboardRange, DistributionItem, FilterMode, HeatmapData, HeatmapPoint, LabelDimension, LabelNode, ManualTransactionInput, MerchantRule, Transaction, TransactionFilter } from './types'
import { defaultOperator, emptyFilter, filterDescription, filterField, NORMALIZED_FILTER_FIELDS, serializeFilter } from './transactionFilters'

const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })
const compactMoney = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
type View = 'dashboard' | 'annotations' | 'labels' | 'rules'
type Theme = 'ledger' | 'glass'
type DashboardMode = DashboardRange['mode']
const THEME_STORAGE_KEY = 'ledger-pilot-theme'
const THEME_CHARTS: Record<Theme, { pie: string[]; grid: string; expense: string; expenseFill: string; income: string }> = {
  ledger: { pie: ['#213640', '#5e7c88', '#94a9ad', '#d29a66', '#c75d50', '#7f6f8d'], grid: '#d5dde0', expense: '#c75d50', expenseFill: '#c75d5022', income: '#526d7b' },
  glass: { pie: ['#f0c97a', '#82aee8', '#8ed7bd', '#c19ae8', '#ef8e88', '#8d9ebd'], grid: 'rgba(183, 205, 238, .18)', expense: '#f2c879', expenseFill: 'rgba(242, 200, 121, .18)', income: '#8ed7bd' },
}

function currentMonth() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` }
function localDate(value = new Date()) { const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 10) }
function monthStart(value: string) { return `${value}-01` }
function shiftMonth(value: string, offset: number) { const [year, month] = value.split('-').map(Number); const date = new Date(year, month - 1 + offset, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` }
function monthName(value: string) { const [year, month] = value.split('-'); return `${year} 年 ${Number(month)} 月` }
function localDateTime() { const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 19) }

function App() {
  const [view, setView] = useState<View>('dashboard')
  const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem(THEME_STORAGE_KEY) === 'glass' ? 'glass' : 'ledger')
  const [month, setMonth] = useState(currentMonth)
  const [dashboardMode, setDashboardMode] = useState<DashboardMode>('month')
  const [dashboardYear, setDashboardYear] = useState(new Date().getFullYear())
  const [customStart, setCustomStart] = useState(monthStart(currentMonth()))
  const [customEnd, setCustomEnd] = useState(localDate)
  const [rangeGranularity, setRangeGranularity] = useState<DashboardGranularity>('day')
  const [trendGranularity, setTrendGranularity] = useState<DashboardGranularity>('day')
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear())
  const [data, setData] = useState<DashboardData | null>(null)
  const [heatmaps, setHeatmaps] = useState<HeatmapData | null>(null)
  const [heatmapLoading, setHeatmapLoading] = useState(true)
  const [heatmapError, setHeatmapError] = useState('')
  const [catalog, setCatalog] = useState<LabelDimension[]>([])
  const [rules, setRules] = useState<MerchantRule[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [transactionTotal, setTransactionTotal] = useState(0)
  const [annotationLoading, setAnnotationLoading] = useState(false)
  const [annotationCriteriaVersion, setAnnotationCriteriaVersion] = useState(0)
  const [annotationIndex, setAnnotationIndex] = useState<number | null>(null)
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<number[]>([])
  const [batchEditorOpen, setBatchEditorOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingArchives, setPendingArchives] = useState<File[]>([])
  const [manualEntryOpen, setManualEntryOpen] = useState(false)
  const [category, setCategory] = useState('')
  const [channel, setChannel] = useState('')
  const [query, setQuery] = useState('')
  const [queryMode, setQueryMode] = useState<FilterMode>('include')
  const [transactionFilters, setTransactionFilters] = useState<TransactionFilter[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const heatmapRequestId = useRef(0)
  const dashboardRequestId = useRef(0)
  const annotationRequestId = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const report = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : '操作未完成'), [])
  const loadCatalog = useCallback(async () => setCatalog(await getLabelCatalog()), [])
  const loadRules = useCallback(async () => setRules(await getRules()), [])
  const dashboardRange = useMemo<DashboardRange>(() => dashboardMode === 'month'
    ? { mode: 'month', month }
    : dashboardMode === 'year'
      ? { mode: 'year', year: dashboardYear }
      : { mode: 'custom', startDate: customStart, endDate: customEnd }, [customEnd, customStart, dashboardMode, dashboardYear, month])
  const heatmapYear = dashboardMode === 'month' ? Number(month.slice(0, 4)) : dashboardMode === 'year' ? dashboardYear : Number(customStart.slice(0, 4))
  const loadHeatmaps = useCallback(async () => {
    const requestId = ++heatmapRequestId.current
    setHeatmapLoading(true)
    setHeatmapError('')
    try {
      const result = await getHeatmaps(heatmapYear)
      if (requestId === heatmapRequestId.current) setHeatmaps(result)
    } catch (reason) {
      if (requestId === heatmapRequestId.current) {
        setHeatmaps(null)
        setHeatmapError(reason instanceof Error ? reason.message : '热力图读取失败')
      }
    } finally {
      if (requestId === heatmapRequestId.current) setHeatmapLoading(false)
    }
  }, [heatmapYear])
  const loadDashboard = useCallback(async () => {
    const requestId = ++dashboardRequestId.current
    setLoading(true); setError('')
    try { const result = await getDashboard(dashboardRange, trendGranularity); if (requestId === dashboardRequestId.current) setData(result) }
    catch (reason) { if (requestId === dashboardRequestId.current) { report(reason); setData(null) } }
    finally { if (requestId === dashboardRequestId.current) setLoading(false) }
  }, [dashboardRange, report, trendGranularity])

  const loadAnnotationQueue = useCallback(async () => {
    const requestId = ++annotationRequestId.current
    setAnnotationLoading(true); setError('')
    try {
      const result = await searchTransactions({
        ...(transactionFilters.some((item) => item.field === 'transaction_time') ? {} : { month }),
        ...(query.trim() ? { query: { text: query.trim(), mode: queryMode } } : {}),
        filters: transactionFilters.map(serializeFilter), ...(category ? { category } : {}), ...(channel ? { channel } : {}),
        annotation_status: 'pending', page: 1, page_size: 500,
      })
      if (requestId !== annotationRequestId.current) return []
      setTransactions(result.items)
      setTransactionTotal(result.total)
      setSelectedTransactionIds((current) => current.filter((id) => result.items.some((item) => item.id === id)))
      return result.items
    } catch (reason) {
      if (requestId === annotationRequestId.current) { report(reason); setTransactions([]); setTransactionTotal(0); setSelectedTransactionIds([]) }
      return []
    } finally { if (requestId === annotationRequestId.current) setAnnotationLoading(false) }
  }, [month, category, channel, query, queryMode, report, transactionFilters])

  const invalidateAnnotationQueue = useCallback(() => {
    annotationRequestId.current += 1
    setAnnotationCriteriaVersion((value) => value + 1)
    setAnnotationLoading(true)
    setSelectedTransactionIds([])
    setBatchEditorOpen(false)
    setAnnotationIndex(null)
  }, [])

  useEffect(() => { void Promise.all([loadDashboard(), loadHeatmaps(), loadCatalog(), loadRules()]).catch(report) }, [loadDashboard, loadHeatmaps, loadCatalog, loadRules, report])
  useEffect(() => {
    if (view !== 'annotations') return
    const timer = window.setTimeout(() => { void loadAnnotationQueue() }, 160)
    return () => window.clearTimeout(timer)
  }, [view, loadAnnotationQueue, annotationCriteriaVersion])

  async function handleImport(files: File[], archivePassword?: string) {
    if (!files.length) return
    setBusy(true); setError(''); setNotice('')
    try { const result = await importStatements(files, archivePassword); setNotice(`读取 ${result.imported} 条，新增 ${result.merged} 条，重复 ${result.skipped} 条已留存审计。`); await Promise.all([loadDashboard(), loadHeatmaps()]) }
    catch (reason) { report(reason) }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }

  const refreshAfterAnnotation = async (next: boolean) => {
    const currentIndex = annotationIndex ?? 0
    const [, pending] = await Promise.all([loadDashboard(), loadAnnotationQueue()])
    setNotice('标注已保存，这笔流水已移出待标注队列。')
    setAnnotationIndex(next && pending.length ? Math.min(currentIndex, pending.length - 1) : null)
  }

  const refreshAfterBatchAnnotation = async (updated: number) => {
    setBatchEditorOpen(false)
    setSelectedTransactionIds([])
    setNotice(`已统一标注 ${updated} 笔流水，并移出待标注队列。`)
    await Promise.all([loadDashboard(), loadAnnotationQueue()])
  }

  async function handleManualSaved(transaction: Transaction) {
    setManualEntryOpen(false)
    setNotice('手动流水已记录，并保留原始快照与审计日志。')
    const savedMonth = transaction.date.slice(0, 7)
    if (dashboardMode !== 'month' || savedMonth === month) await Promise.all([loadDashboard(), loadHeatmaps()]); else setMonth(savedMonth)
  }

  return <main>
    <header className="masthead">
      <button className="brand" onClick={() => setView('dashboard')} aria-label="Ledger Pilot 首页"><span className="brand-mark">LP</span><span><b>Ledger Pilot</b><small>本地账本工作台</small></span></button>
      <nav className="main-nav" aria-label="主导航">
        <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>总看板</button>
        <button className={view === 'annotations' ? 'active' : ''} onClick={() => setView('annotations')}>流水标注</button>
        <button className={view === 'labels' ? 'active' : ''} onClick={() => setView('labels')}>标签管理</button>
        <button className={view === 'rules' ? 'active' : ''} onClick={() => setView('rules')}>预填规则</button>
      </nav>
      <div className="theme-switch" role="group" aria-label="选择皮肤">
        <button type="button" aria-pressed={theme === 'ledger'} onClick={() => setTheme('ledger')}>雾蓝账页</button>
        <button type="button" aria-pressed={theme === 'glass'} onClick={() => setTheme('glass')}>流光雾镜</button>
      </div>
      <div className="header-note"><span />数据仅存本机</div>
    </header>

    {(notice || error) && <div className={error ? 'status error' : 'status success'} role={error ? 'alert' : 'status'}><span>{error ? '!' : '✓'}</span>{error || notice}<button onClick={() => { setError(''); setNotice('') }}>关闭</button></div>}

    <input ref={fileRef} className="sr-only" type="file" multiple accept=".csv,.xlsx,.zip" onChange={(event) => { const files = [...(event.target.files ?? [])]; if (files.some((file) => file.name.toLowerCase().endsWith('.zip'))) setPendingArchives(files); else void handleImport(files) }} />
    {view === 'dashboard' && <Dashboard
      theme={theme} month={month} setMonth={setMonth} mode={dashboardMode} setMode={setDashboardMode}
      year={dashboardYear} setYear={setDashboardYear} customStart={customStart} setCustomStart={setCustomStart}
      customEnd={customEnd} setCustomEnd={setCustomEnd} rangeGranularity={rangeGranularity} setRangeGranularity={setRangeGranularity}
      trendGranularity={trendGranularity} setTrendGranularity={setTrendGranularity} calendarYear={calendarYear} setCalendarYear={setCalendarYear}
      data={data} heatmaps={heatmaps} heatmapLoading={heatmapLoading} heatmapError={heatmapError} loading={loading}
      busy={busy} onPickFiles={() => fileRef.current?.click()} onManualEntry={() => setManualEntryOpen(true)}
    />}
    {view === 'annotations' && <AnnotationQueuePage
      month={month} setMonth={(value) => { invalidateAnnotationQueue(); setMonth(value) }} data={data}
      transactions={transactions} total={transactionTotal} loading={annotationLoading}
      category={category} setCategory={(value) => { invalidateAnnotationQueue(); setCategory(value) }}
      channel={channel} setChannel={(value) => { invalidateAnnotationQueue(); setChannel(value) }}
      query={query} setQuery={(value) => { invalidateAnnotationQueue(); setQuery(value) }}
      queryMode={queryMode} setQueryMode={(value) => { invalidateAnnotationQueue(); setQueryMode(value) }}
      filters={transactionFilters} setFilters={(value) => { invalidateAnnotationQueue(); setTransactionFilters(value) }}
      selectedIds={selectedTransactionIds} setSelectedIds={setSelectedTransactionIds}
      onAnnotate={(id) => setAnnotationIndex(transactions.findIndex((item) => item.id === id))}
      onBatchAnnotate={() => setBatchEditorOpen(true)}
    />}
    {view === 'labels' && <LabelManager catalog={catalog} reload={loadCatalog} report={report} announce={setNotice} />}
    {view === 'rules' && <RulesManager catalog={catalog} rules={rules} reload={loadRules} report={report} announce={setNotice} />}

    {annotationIndex !== null && transactions[annotationIndex] && <AnnotationDialog
      transaction={transactions[annotationIndex]} catalog={catalog}
      hasPrevious={annotationIndex > 0} hasNext={transactions.length > 1}
      onPrevious={() => setAnnotationIndex((value) => value === null ? null : Math.max(0, value - 1))}
      onNext={() => setAnnotationIndex((value) => value === null ? null : (value + 1) % transactions.length)}
      onClose={() => setAnnotationIndex(null)} onSaved={refreshAfterAnnotation} report={report}
    />}
    {batchEditorOpen && selectedTransactionIds.length > 0 && <BatchAnnotationDialog
      transactions={transactions.filter((item) => selectedTransactionIds.includes(item.id))}
      catalog={catalog} onClose={() => setBatchEditorOpen(false)} onSaved={refreshAfterBatchAnnotation} report={report}
    />}
    {pendingArchives.length > 0 && <ArchivePasswordDialog
      fileCount={pendingArchives.length}
      onClose={() => { setPendingArchives([]); if (fileRef.current) fileRef.current.value = '' }}
      onSubmit={(password) => { const files = pendingArchives; setPendingArchives([]); void handleImport(files, password) }}
    />}
    {manualEntryOpen && <ManualEntryDialog catalog={catalog} onClose={() => setManualEntryOpen(false)} onSaved={handleManualSaved} report={report} />}
    <footer><span>LEDGER PILOT / V1.7.1</span><p>规则给建议，最终选择由你确认；原始流水永不被标注修改。</p></footer>
  </main>
}

function ManualEntryDialog({ catalog, onClose, onSaved, report }: { catalog: LabelDimension[]; onClose: () => void; onSaved: (transaction: Transaction) => Promise<void>; report: (reason: unknown) => void }) {
  const [draft, setDraft] = useState<ManualTransactionInput>({ transaction_time: localDateTime(), direction: '支出', amount: '', counterparty: '', summary: '', category: '', payment_channel: '', reference_id: '', note: '', label_ids: [] })
  const [saving, setSaving] = useState(false)
  const categoryDimension = catalog.find((item) => item.key === (draft.direction === '收入' ? 'income_category' : 'expense_category'))
  const channelDimension = catalog.find((item) => item.key === 'payment_channel')
  const categoryLabels = categoryDimension?.labels.filter((item) => item.enabled) ?? []
  const channelLabels = channelDimension?.labels.filter((item) => item.enabled) ?? []
  function selectLabel(kind: 'category' | 'payment_channel', value: string) {
    const dimension = kind === 'category' ? categoryDimension : channelDimension
    const dimensionIds = new Set(dimension?.labels.map((item) => item.id) ?? [])
    const selected = dimension?.labels.find((item) => item.name === value)
    setDraft((current) => ({ ...current, [kind]: value, label_ids: [...current.label_ids.filter((id) => !dimensionIds.has(id)), ...(selected ? [selected.id] : [])] }))
  }
  async function submit() {
    setSaving(true)
    try { await onSaved(await createManualTransaction(draft)) } catch (reason) { report(reason) } finally { setSaving(false) }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="manual-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-title" onSubmit={(event) => { event.preventDefault(); void submit() }}><header><div><p className="eyebrow">MANUAL LEDGER</p><h2 id="manual-title">手动记一笔</h2><p>适合现金、银行卡直入或暂未出现在平台账单里的例外流水。</p></div><button type="button" className="close-button" onClick={onClose} aria-label="关闭">×</button></header><div className="manual-fields"><label>交易时间<input required step="1" type="datetime-local" value={draft.transaction_time} onChange={(event) => setDraft({ ...draft, transaction_time: event.target.value })} /></label><label>收支方向<select value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value as '收入' | '支出', category: '', label_ids: draft.label_ids.filter((id) => !categoryDimension?.labels.some((item) => item.id === id)) })}><option>支出</option><option>收入</option></select></label><label>金额<input required min="0.01" step="0.01" inputMode="decimal" type="number" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></label><label>交易对方<input value={draft.counterparty} onChange={(event) => setDraft({ ...draft, counterparty: event.target.value })} /></label><label className="wide">交易摘要<input required value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="例如：工资、午餐、现金报销" /></label><label>分类<select value={draft.category} onChange={(event) => selectLabel('category', event.target.value)}><option value="">未分类</option>{categoryLabels.map((item) => <option key={item.id}>{item.name}</option>)}</select></label><label>支付渠道<select value={draft.payment_channel} onChange={(event) => selectLabel('payment_channel', event.target.value)}><option value="">未识别</option>{channelLabels.map((item) => <option key={item.id}>{item.name}</option>)}</select></label><label className="wide">流水号（可选，用于防重复）<input value={draft.reference_id} onChange={(event) => setDraft({ ...draft, reference_id: event.target.value })} /></label><label className="wide">备注<textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label></div><footer className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? '保存中…' : '记录流水'}</button></footer></form></div>
}

function ArchivePasswordDialog({ fileCount, onClose, onSubmit }: { fileCount: number; onClose: () => void; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('')
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-title" onSubmit={(event) => { event.preventDefault(); onSubmit(password) }}><header><div><p className="eyebrow">ENCRYPTED ARCHIVE</p><h2 id="password-title">输入账单解压密码</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="关闭">×</button></header><div className="password-body"><p>已选择 {fileCount} 个文件。密码只用于本次本地解密，不会保存；多份压缩包的密码可换行填写，也可直接粘贴“平台：密码”。</p><label>解压密码（多份可换行）<textarea autoFocus required autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label></div><footer className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary">解密并导入</button></footer></form></div>
}

function Dashboard(props: {
  theme: Theme
  month: string; setMonth: (value: string) => void; mode: DashboardMode; setMode: (value: DashboardMode) => void
  year: number; setYear: (value: number) => void; customStart: string; setCustomStart: (value: string) => void; customEnd: string; setCustomEnd: (value: string) => void
  rangeGranularity: DashboardGranularity; setRangeGranularity: (value: DashboardGranularity) => void
  trendGranularity: DashboardGranularity; setTrendGranularity: (value: DashboardGranularity) => void
  calendarYear: number; setCalendarYear: (value: number) => void
  data: DashboardData | null; heatmaps: HeatmapData | null; heatmapLoading: boolean; heatmapError: string; loading: boolean
  busy: boolean; onPickFiles: () => void; onManualEntry: () => void
}) {
  const { month, data, theme, mode } = props
  const chartColors = THEME_CHARTS[theme]
  const summary = data?.summary ?? { income: 0, expense: 0, net: 0 }
  const rangeTitle = mode === 'month' ? monthName(month) : mode === 'year' ? `${props.year} 年` : `${props.customStart} 至 ${props.customEnd}`
  const rangeMeta = mode === 'month' ? month.replace('-', '.') : mode === 'year' ? String(props.year) : `${props.customStart.replaceAll('-', '.')}—${props.customEnd.replaceAll('-', '.')}`
  const heatmapYear = mode === 'month' ? Number(month.slice(0, 4)) : mode === 'year' ? props.year : Number(props.customStart.slice(0, 4))
  const crossYear = mode === 'custom' && props.customStart.slice(0, 4) !== props.customEnd.slice(0, 4)
  const granularityName = { day: '日', week: '周', month: '月' }[props.trendGranularity]
  const distributions = data?.distributions ?? (data ? [
    { dimensionId: 'legacy-expense-category', key: 'expense_category', name: '支出分类', items: data.categories },
    { dimensionId: 'legacy-payment-channel', key: 'payment_channel', name: '支付渠道', items: data.channels },
  ] : [])
  return <>
    <DashboardRangeNav mode={mode} setMode={props.setMode} />
    {mode === 'month' && <MonthRail month={month} setMonth={props.setMonth} />}
    {mode === 'year' && <YearRail year={props.year} setYear={props.setYear} />}
    {mode === 'custom' && <CustomRangePanel {...props} />}
    <section className="page-heading"><div><p className="eyebrow">LEDGER REVIEW / {rangeMeta}</p><h1>{rangeTitle}，逐笔把钱说清楚</h1><p>看板范围与曲线颗粒度彼此独立；规则给出建议，最终结果仍由你确认。</p></div><div className="actions"><button className="button secondary" onClick={props.onManualEntry}>手动记账</button><button className="button primary" onClick={props.onPickFiles} disabled={props.busy}>{props.busy ? '正在合并…' : '导入账单'}</button></div></section>
    {props.loading ? <DashboardSkeleton /> : data ? <>
      <section className="summary-strip"><article className="hero-amount"><p>范围支出</p><strong>{money.format(summary.expense)}</strong><span>共计流出</span></article><article><p>范围收入</p><strong>{money.format(summary.income)}</strong><span>已入账</span></article><article><p>收支净额</p><strong className={summary.net < 0 ? 'negative' : ''}>{summary.net >= 0 ? '+' : ''}{money.format(summary.net)}</strong><span>{summary.net >= 0 ? '范围内有结余' : '支出高于收入'}</span></article></section>
      <section className="analysis-stack"><article className="panel trend-panel"><div className="trend-heading"><PanelHeading index="A" title={`${granularityName}收支轨迹`} meta={`${data.trend.length} 个数据点`} /><GranularitySwitch value={props.trendGranularity} onChange={props.setTrendGranularity} label="曲线颗粒度" /></div>{data.trend.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data.trend} margin={{ top: 10, right: 4, left: -20, bottom: 0 }}><CartesianGrid stroke={chartColors.grid} strokeDasharray="2 5" vertical={false} /><XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={(value: string) => crossYear ? (props.trendGranularity === 'month' ? value.slice(0, 7) : value) : value.slice(5)} /><YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10 }} tickFormatter={(value: number) => compactMoney.format(value)} /><Tooltip formatter={(value) => money.format(Number(value))} /><Area type="monotone" dataKey="expense" name="支出" stroke={chartColors.expense} fill={chartColors.expenseFill} /><Area type="monotone" dataKey="income" name="收入" stroke={chartColors.income} fill="transparent" /></AreaChart></ResponsiveContainer></div> : <EmptyState text="当前范围还没有收支轨迹" />}</article><div className="distribution-grid">{distributions.map((distribution, index) => <DistributionPanel key={distribution.dimensionId} index={panelIndex(index + 1)} title={distribution.name} items={distribution.items} colors={chartColors.pie} />)}</div></section>
      <AnnualHeatmaps data={props.heatmaps} year={heatmapYear} loading={props.heatmapLoading} error={props.heatmapError} />
    </> : <EmptyState text="账本暂时没有当前范围的数据，请先导入账单" />}
  </>
}

function DashboardRangeNav({ mode, setMode }: { mode: DashboardMode; setMode: (value: DashboardMode) => void }) {
  return <section className="dashboard-range-nav" aria-label="看板时间范围">{([['year', '年度'], ['month', '月度'], ['custom', '自定义']] as const).map(([value, label]) => <button key={value} className={mode === value ? 'active' : ''} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}</section>
}

function YearRail({ year, setYear }: { year: number; setYear: (value: number) => void }) {
  return <section className="year-rail" aria-label="年度选择"><button className="rail-arrow" onClick={() => setYear(year - 1)} aria-label="上一年">←</button><div><span>ANNUAL REVIEW</span><strong>{year}</strong></div><button className="rail-arrow" onClick={() => setYear(year + 1)} aria-label="下一年">→</button></section>
}

function GranularitySwitch({ value, onChange, label }: { value: DashboardGranularity; onChange: (value: DashboardGranularity) => void; label: string }) {
  return <div className="granularity-switch" role="group" aria-label={label}>{([['day', '日'], ['week', '周'], ['month', '月']] as const).map(([item, text]) => <button key={item} type="button" aria-pressed={value === item} onClick={() => onChange(item)}>{text}</button>)}</div>
}

function CustomRangePanel(props: {
  customStart: string; setCustomStart: (value: string) => void; customEnd: string; setCustomEnd: (value: string) => void
  rangeGranularity: DashboardGranularity; setRangeGranularity: (value: DashboardGranularity) => void
  calendarYear: number; setCalendarYear: (value: number) => void
}) {
  const updateStart = (value: string) => { const [start, unitEnd] = snapDate(value, props.rangeGranularity); props.setCustomStart(start); props.setCustomEnd(unitEnd > props.customEnd ? unitEnd : props.customEnd); props.setCalendarYear(Number(start.slice(0, 4))) }
  const updateEnd = (value: string) => { const [unitStart, end] = snapDate(value, props.rangeGranularity); props.setCustomEnd(end); props.setCustomStart(unitStart < props.customStart ? unitStart : props.customStart); props.setCalendarYear(Number(unitStart.slice(0, 4))) }
  const updateGranularity = (value: DashboardGranularity) => { const [start] = snapDate(props.customStart, value); const [, end] = snapDate(props.customEnd, value); props.setRangeGranularity(value); props.setCustomStart(start); props.setCustomEnd(end) }
  return <section className="custom-range-panel"><header><div><p className="eyebrow">CUSTOM RANGE</p><h2>选择要复盘的时间边界</h2><p>可以直接输入日期，也可以在下方日历点选开始与结束；选择周或月时会自动吸附完整周期。</p></div><GranularitySwitch value={props.rangeGranularity} onChange={updateGranularity} label="范围选择颗粒度" /></header><div className="custom-range-inputs"><label>开始日期<input type="date" min="1900-01-01" max={props.customEnd} value={props.customStart} onChange={(event) => updateStart(event.target.value)} /></label><span>→</span><label>结束日期<input type="date" min={props.customStart} max="2100-12-31" value={props.customEnd} onChange={(event) => updateEnd(event.target.value)} /></label></div><DateRangeCalendar {...props} /></section>
}

function dateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
function parseDate(value: string) { return new Date(`${value}T12:00:00`) }
function snapDate(value: string, granularity: DashboardGranularity): [string, string] {
  const date = parseDate(value)
  if (granularity === 'week') {
    const offset = (date.getDay() + 6) % 7
    const start = new Date(date); start.setDate(start.getDate() - offset)
    const end = new Date(start); end.setDate(end.getDate() + 6)
    return [dateKey(start), dateKey(end)]
  }
  if (granularity === 'month') return [`${value.slice(0, 7)}-01`, dateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0))]
  return [value, value]
}

function DateRangeCalendar(props: {
  customStart: string; setCustomStart: (value: string) => void; customEnd: string; setCustomEnd: (value: string) => void
  rangeGranularity: DashboardGranularity; calendarYear: number; setCalendarYear: (value: number) => void
}) {
  const [anchor, setAnchor] = useState<string | null>(null)
  const first = new Date(props.calendarYear, 0, 1)
  const blanks = Array.from({ length: (first.getDay() + 6) % 7 }, (_, index) => index)
  const days: string[] = []
  for (const date = new Date(first); date.getFullYear() === props.calendarYear; date.setDate(date.getDate() + 1)) days.push(dateKey(date))
  function choose(value: string) {
    const [unitStart, unitEnd] = snapDate(value, props.rangeGranularity)
    if (!anchor) {
      props.setCustomStart(unitStart); props.setCustomEnd(unitEnd); setAnchor(unitStart); return
    }
    const [anchorStart, anchorEnd] = snapDate(anchor, props.rangeGranularity)
    props.setCustomStart(anchorStart < unitStart ? anchorStart : unitStart)
    props.setCustomEnd(anchorEnd > unitEnd ? anchorEnd : unitEnd)
    setAnchor(null)
  }
  return <div className="range-calendar"><div className="range-calendar-head"><button type="button" onClick={() => props.setCalendarYear(props.calendarYear - 1)} aria-label="查看上一年">←</button><strong>{props.calendarYear} 年日历</strong><button type="button" onClick={() => props.setCalendarYear(props.calendarYear + 1)} aria-label="查看下一年">→</button></div><div className="range-month-labels">{Array.from({ length: 12 }, (_, index) => <span key={index}>{index + 1}月</span>)}</div><div className="range-calendar-layout"><div className="weekday-labels"><span>一</span><span>三</span><span>五</span><span>日</span></div><div className="range-calendar-cells">{blanks.map((item) => <i key={`blank-${item}`} />)}{days.map((day) => <button type="button" key={day} aria-label={`选择 ${day}`} title={day} className={`${day >= props.customStart && day <= props.customEnd ? 'in-range ' : ''}${day === props.customStart || day === props.customEnd ? 'boundary' : ''}`} onClick={() => choose(day)} />)}</div></div><p>{anchor ? '请选择结束周期' : '点击任意日期开始新范围，再点击一次确定结束范围'}</p></div>
}

function MonthRail({ month, setMonth }: { month: string; setMonth: (value: string) => void }) {
  const months = useMemo(() => [-2, -1, 0, 1, 2].map((offset) => shiftMonth(month, offset)), [month])
  return <section className="month-rail" aria-label="账期选择"><button className="rail-arrow" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="上一个月">←</button><div className="month-track">{months.map((item) => <button key={item} className={item === month ? 'month-tick active' : 'month-tick'} onClick={() => setMonth(item)}><span>{item.slice(0, 4)}</span><b>{Number(item.slice(5))}月</b></button>)}</div><button className="rail-arrow" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="下一个月">→</button></section>
}

function AnnualHeatmaps({ data, year, loading, error }: { data: HeatmapData | null; year: number; loading: boolean; error: string }) {
  const current = data?.year === year ? data : null
  return <section className="heatmap-section"><PanelHeading index="+" title="年度资金热力" meta={`${year} · 每日强度`} />{loading || !current ? <div className={`heatmap-state${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{error ? `热力图读取失败：${error}` : `正在生成 ${year} 年热力图…`}</div> : <div className="heatmap-pair"><HeatmapCard title="花钱的热力图" tone="expense" points={current.expense} year={current.year} /><HeatmapCard title="赚钱的热力图" tone="income" points={current.income} year={current.year} /></div>}</section>
}

function HeatmapCard({ title, tone, points, year }: { title: string; tone: 'expense' | 'income'; points: HeatmapPoint[]; year: number }) {
  const values = new Map(points.map((point) => [point.date, point]))
  const max = Math.max(0, ...points.map((point) => point.value))
  const total = points.reduce((sum, point) => sum + point.value, 0)
  const start = new Date(year, 0, 1)
  const offset = (start.getDay() + 6) % 7
  const cells: Array<{ date: string; point?: HeatmapPoint } | null> = Array.from({ length: offset }, () => null)
  for (let date = new Date(year, 0, 1); date.getFullYear() === year; date.setDate(date.getDate() + 1)) {
    const key = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    cells.push({ date: key, point: values.get(key) })
  }
  const level = (value: number) => value <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil(Math.log1p(value) / Math.log1p(max) * 4))
  return <article className={`heatmap-card ${tone}`}><header><div><p>{title}</p><strong>{money.format(total)}</strong></div><span>{points.length} 个活跃日</span></header>{points.length ? <><div className="heatmap-scroll"><div className="month-labels">{Array.from({ length: 12 }, (_, index) => <span key={index}>{index + 1}月</span>)}</div><div className="heatmap-layout"><div className="weekday-labels"><span>一</span><span>三</span><span>五</span><span>日</span></div><div className="heatmap-cells">{cells.map((cell, index) => cell ? <i key={cell.date} className={`level-${level(cell.point?.value ?? 0)}`} title={`${cell.date} · ${money.format(cell.point?.value ?? 0)} · ${cell.point?.count ?? 0} 笔`} aria-label={`${cell.date}，${money.format(cell.point?.value ?? 0)}，${cell.point?.count ?? 0} 笔`} /> : <i key={`blank-${index}`} className="blank" />)}</div></div></div><footer><span>少</span>{[0, 1, 2, 3, 4].map((item) => <i key={item} className={`level-${item}`} />)}<span>多</span><small>按金额对数分级</small></footer></> : <div className="heatmap-empty">{year} 年没有{tone === 'expense' ? '支出' : '收入'}流水</div>}</article>
}

function AnnotationQueuePage(props: {
  month: string; setMonth: (value: string) => void; data: DashboardData | null
  transactions: Transaction[]; total: number; loading: boolean
  category: string; setCategory: (value: string) => void; channel: string; setChannel: (value: string) => void
  query: string; setQuery: (value: string) => void; queryMode: FilterMode; setQueryMode: (value: FilterMode) => void
  filters: TransactionFilter[]; setFilters: (value: TransactionFilter[]) => void; selectedIds: number[]; setSelectedIds: (value: number[]) => void
  onAnnotate: (id: number) => void; onBatchAnnotate: () => void
}) {
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [draftFilters, setDraftFilters] = useState<TransactionFilter[]>(props.filters)
  const allSelected = props.transactions.length > 0 && props.transactions.every((item) => props.selectedIds.includes(item.id))
  const categoryOptions = [...new Set([...(props.data?.categories.map((item) => item.name) ?? []), ...props.transactions.map((item) => item.category)])].filter((item) => item !== '未分类')
  const channelOptions = [...new Set([...(props.data?.channels.map((item) => item.name) ?? []), ...props.transactions.map((item) => item.channel)])].filter((item) => item !== '未识别')
  function toggleAll() {
    props.setSelectedIds(allSelected ? [] : props.transactions.map((item) => item.id))
  }
  function toggleOne(id: number) {
    props.setSelectedIds(props.selectedIds.includes(id) ? props.selectedIds.filter((item) => item !== id) : [...props.selectedIds, id])
  }
  const filtered = Boolean(props.query || props.category || props.channel || props.filters.length)
  const dateRangeActive = props.filters.some((item) => item.field === 'transaction_time')
  const clearFilters = () => { props.setQuery(''); props.setQueryMode('include'); props.setCategory(''); props.setChannel(''); props.setFilters([]) }
  const openFilters = () => { setDraftFilters(props.filters); setFilterPanelOpen(true) }
  return <>
    {dateRangeActive ? <section className="date-filter-rail" aria-label="日期高级筛选范围"><div><span>CUSTOM RANGE</span><strong>日期条件已接管月份范围</strong></div><button className="button secondary" onClick={() => props.setFilters(props.filters.filter((item) => item.field !== 'transaction_time'))}>恢复月份快捷范围</button></section> : <MonthRail month={props.month} setMonth={props.setMonth} />}
    <section className="annotation-page-heading"><div><p className="eyebrow">REVIEW QUEUE / {dateRangeActive ? 'CUSTOM RANGE' : props.month.replace('-', '.')}</p><h1>先筛出一类，再一次标完</h1><p>模糊搜索、字段包含或排除、日期和金额范围彼此独立；组合后只处理真正匹配的流水。</p></div><div className="queue-count"><span>{filtered ? '当前匹配' : '当前待办'}</span><strong>{props.total}</strong><small>笔流水</small></div></section>
    <section className="annotation-workspace" aria-label="待标注流水">
      <div className="annotation-toolbar">
        <label className="search-field"><span>全字段模糊搜索</span><div className="search-composer"><select aria-label="模糊搜索模式" value={props.queryMode} onChange={(event) => props.setQueryMode(event.target.value as FilterMode)}><option value="include">包含</option><option value="exclude">排除</option></select><input aria-label="搜索待标注流水" value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="搜索全部清洗字段" /></div></label>
        <label><span>有效分类</span><select value={props.category} onChange={(event) => props.setCategory(event.target.value)}><option value="">全部分类</option>{categoryOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>有效渠道</span><select value={props.channel} onChange={(event) => props.setChannel(event.target.value)}><option value="">全部渠道</option>{channelOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <button className="button secondary advanced-filter-trigger" onClick={openFilters}>高级筛选{props.filters.length ? ` (${props.filters.length})` : ''}</button>
      </div>
      {(props.filters.length > 0 || filtered) && <div className="active-filter-row"><div>{props.filters.map((item, index) => <button key={`${item.field}-${index}`} onClick={() => props.setFilters(props.filters.filter((_, itemIndex) => itemIndex !== index))}>{filterDescription(item)} <span>×</span></button>)}{dateRangeActive && <small>日期条件已接管月份快捷范围</small>}</div><button className="clear-filters" onClick={clearFilters}>清除全部筛选</button></div>}
      <div className={`selection-dock ${props.selectedIds.length ? 'active' : ''}`} role="status">
        <div><b>{props.selectedIds.length ? `已选 ${props.selectedIds.length} 笔` : '先搜索，再选择相似流水'}</b><span>{props.selectedIds.length ? '将为这些流水保存完全相同的人工标注' : '可逐笔处理，也可全选当前搜索结果'}</span></div>
        {props.selectedIds.length > 0 && <div><button className="button ghost" onClick={() => props.setSelectedIds([])}>取消选择</button><button className="button primary" onClick={props.onBatchAnnotate}>统一标注 {props.selectedIds.length} 笔</button></div>}
      </div>
      {props.total > props.transactions.length && <p className="queue-limit">当前加载前 {props.transactions.length} 笔，共匹配 {props.total} 笔；可继续收紧搜索后分批处理。</p>}
      {props.loading ? <DashboardSkeleton /> : props.transactions.length ? <div className="table-wrap annotation-table"><table><thead><tr><th className="select-cell"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="全选当前搜索结果" /></th><th>日期</th><th>交易摘要</th><th>分类</th><th>支付渠道</th><th>金额</th><th /></tr></thead><tbody>{props.transactions.map((item) => <tr key={item.id} className={props.selectedIds.includes(item.id) ? 'selected' : ''} onDoubleClick={() => props.onAnnotate(item.id)}><td className="select-cell"><input type="checkbox" checked={props.selectedIds.includes(item.id)} onChange={() => toggleOne(item.id)} aria-label={`选择 ${item.merchant} ${item.date.slice(0, 10)}`} /></td><td>{item.date.slice(0, 16)}</td><td><strong>{item.merchant}</strong>{item.itemDescription && <small>{item.itemDescription}</small>}</td><td><span className="tag">{item.category}<i className={item.categorySource}>{item.categorySource === 'rule' ? '规则' : '未确认'}</i></span></td><td>{item.channel}</td><td className={item.direction === 'expense' ? 'amount expense' : 'amount income'}>{item.direction === 'expense' ? '−' : '+'}{money.format(Math.abs(item.amount))}</td><td><button className="row-action" onClick={() => props.onAnnotate(item.id)}>标注此笔</button></td></tr>)}</tbody></table></div> : <div className="queue-empty"><span>✓</span><h2>{filtered ? '没有符合当前条件的待标注流水' : '这个月的待标注队列已清空'}</h2><p>{filtered ? '调整搜索词或清除筛选，继续处理其他流水。' : '人工确认过的流水不会再次出现；新导入的流水会自动进入这里。'}</p></div>}
    </section>
    {filterPanelOpen && <AdvancedFilterPanel filters={draftFilters} setFilters={setDraftFilters} onClose={() => setFilterPanelOpen(false)} onApply={() => { props.setFilters(draftFilters); setFilterPanelOpen(false) }} />}
  </>
}

function validTransactionFilter(filter: TransactionFilter) { return filter.operator === 'is_empty' || (filter.operator === 'range' ? Boolean(filter.min || filter.max) : Boolean(filter.value?.trim())) }

function AdvancedFilterPanel({ filters, setFilters, onClose, onApply }: { filters: TransactionFilter[]; setFilters: (value: TransactionFilter[]) => void; onClose: () => void; onApply: () => void }) {
  const update = (index: number, patch: Partial<TransactionFilter>) => setFilters(filters.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  return <div className="advanced-filter-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="advanced-filter-panel" role="dialog" aria-modal="true" aria-labelledby="advanced-filter-title"><header><div><p className="eyebrow">NORMALIZED LEDGER FILTERS</p><h2 id="advanced-filter-title">高级筛选</h2><p>每条条件可独立包含或排除；同字段多个包含值取任一命中，跨字段需要同时满足。</p></div><button className="close-button" onClick={onClose} aria-label="关闭高级筛选">×</button></header><div className="advanced-filter-body">{filters.length ? filters.map((filter, index) => {
    const definition = filterField(filter.field)
    const textOperators: Array<[TransactionFilter['operator'], string]> = definition.type === 'enum' ? [['equals', '精确匹配'], ['is_empty', '为空']] : [['contains', '模糊匹配'], ['equals', '精确匹配'], ['is_empty', '为空']]
    return <article className="advanced-filter-condition" key={`${filter.field}-${index}`}><label>字段<select value={filter.field} onChange={(event) => { const field = event.target.value as TransactionFilter['field']; update(index, { field, operator: defaultOperator(field), value: '', min: '', max: '' }) }}>{NORMALIZED_FILTER_FIELDS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label>方向<select value={filter.mode} onChange={(event) => update(index, { mode: event.target.value as FilterMode })}><option value="include">包含</option><option value="exclude">排除</option></select></label><label>匹配方式<select value={filter.operator} onChange={(event) => update(index, { operator: event.target.value as TransactionFilter['operator'], value: '', min: '', max: '' })}>{definition.type === 'date' || definition.type === 'amount' ? <><option value="range">范围</option><option value="is_empty">为空</option></> : textOperators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{filter.operator === 'range' ? <div className="filter-range-inputs"><label>下限<input aria-label={`${definition.label}下限`} type={definition.type === 'date' ? 'date' : 'number'} step={definition.type === 'amount' ? '0.01' : undefined} value={filter.min ?? ''} onChange={(event) => update(index, { min: event.target.value })} /></label><span>至</span><label>上限<input aria-label={`${definition.label}上限`} type={definition.type === 'date' ? 'date' : 'number'} step={definition.type === 'amount' ? '0.01' : undefined} value={filter.max ?? ''} onChange={(event) => update(index, { max: event.target.value })} /></label></div> : filter.operator !== 'is_empty' && <label className="filter-value">值{definition.options ? <select aria-label={`${definition.label}筛选值`} value={filter.value ?? ''} onChange={(event) => update(index, { value: event.target.value })}><option value="">请选择</option>{definition.options.map((item) => <option key={item}>{item}</option>)}</select> : <input aria-label={`${definition.label}筛选值`} value={filter.value ?? ''} onChange={(event) => update(index, { value: event.target.value })} placeholder="输入筛选值" />}</label>}<button className="remove-filter" onClick={() => setFilters(filters.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除 ${definition.label} 条件`}>删除</button></article>
  }) : <div className="advanced-filter-empty"><span>＋</span><p>还没有字段条件。模糊搜索仍可独立使用。</p></div>}</div><footer className="advanced-filter-actions"><button className="button secondary" onClick={() => setFilters([...filters, emptyFilter()])}>添加字段条件</button><div><button className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={filters.some((item) => !validTransactionFilter(item))} onClick={onApply}>应用 {filters.length} 条筛选</button></div></footer></section></div>
}

function AnnotationDialog({ transaction, catalog, hasPrevious, hasNext, onPrevious, onNext, onClose, onSaved, report }: {
  transaction: Transaction; catalog: LabelDimension[]; hasPrevious: boolean; hasNext: boolean; onPrevious: () => void; onNext: () => void; onClose: () => void; onSaved: (next: boolean) => Promise<void>; report: (reason: unknown) => void
}) {
  const [annotation, setAnnotation] = useState<AnnotationData | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => { setAnnotation(null); void getAnnotation(transaction.id).then((result) => { setAnnotation(result); setSelected((result.assignments.confirmedDimensionIds.length ? result.assignments.manual : result.assignments.rule).map((item) => item.id)) }).catch(report) }, [transaction.id, report])
  const visibleDimensions = catalog.filter((dimension) => dimension.enabled && dimension.key !== (transaction.direction === 'income' ? 'expense_category' : 'income_category'))
  function choose(dimension: LabelDimension, labelId: number, checked = true) {
    const dimensionIds = new Set(dimension.labels.map((label) => label.id))
    if (dimension.selectionMode === 'single') setSelected((current) => [...current.filter((id) => !dimensionIds.has(id)), ...(labelId ? [labelId] : [])])
    else setSelected((current) => checked ? [...new Set([...current, labelId])] : current.filter((id) => id !== labelId))
  }
  async function save(next: boolean) { setSaving(true); try { await saveAnnotation(transaction.id, selected); await onSaved(next) } catch (reason) { report(reason) } finally { setSaving(false) } }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="annotation-dialog" role="dialog" aria-modal="true" aria-labelledby="annotation-title"><header><div><p className="eyebrow">人工确认 / {transaction.sourcePlatform}</p><h2 id="annotation-title">{transaction.merchant}</h2><p>{transaction.date.slice(0, 16)} · {money.format(transaction.amount)} · {transaction.direction === 'expense' ? '支出' : '收入'}</p></div><button className="close-button" onClick={onClose} aria-label="关闭">×</button></header><div className="fact-strip"><span>商品<b>{transaction.itemDescription || '—'}</b></span><span>支付原值<b>{transaction.paymentMethod || '—'}</b></span><span>平台分类<b>{transaction.sourceCategory || transaction.transactionType || '—'}</b></span></div>{!annotation ? <DashboardSkeleton /> : <div className="annotation-fields">{visibleDimensions.map((dimension) => <fieldset key={dimension.id}><legend>{dimension.name}<small>{dimension.selectionMode === 'multiple' ? '可多选' : '单选'}</small></legend>{dimension.selectionMode === 'single' ? <select value={dimension.labels.find((label) => selected.includes(label.id))?.id ?? ''} onChange={(event) => choose(dimension, Number(event.target.value))}><option value="">未选择</option>{treeOptions(dimension.labels).filter(({ label }) => label.enabled).map(({ label, depth }) => <option value={label.id} key={label.id}>{'— '.repeat(depth)}{label.name}</option>)}</select> : <div className="checkbox-grid">{treeOptions(dimension.labels).filter(({ label }) => label.enabled).map(({ label, depth }) => <label key={label.id} style={{ paddingLeft: depth * 14 }}><input type="checkbox" checked={selected.includes(label.id)} onChange={(event) => choose(dimension, label.id, event.target.checked)} />{label.name}</label>)}</div>}</fieldset>)}</div>}<div className="suggestion-note"><b>当前默认：</b>{annotation?.assignments.rule.map((item) => item.name).join('、') || '没有规则建议'}。保存后以人工结果为准，刷新规则也不会覆盖。</div><footer className="dialog-actions"><button className="button secondary" disabled={!hasPrevious || saving} onClick={onPrevious}>上一条</button><button className="button ghost" disabled={!hasNext || saving} onClick={onNext}>跳过</button><button className="button secondary" disabled={saving} onClick={() => void save(false)}>保存</button><button className="button primary" disabled={saving} onClick={() => void save(true)}>{saving ? '保存中…' : hasNext ? '保存并下一条' : '保存并完成'}</button></footer></section></div>
}

function BatchAnnotationDialog({ transactions, catalog, onClose, onSaved, report }: {
  transactions: Transaction[]; catalog: LabelDimension[]; onClose: () => void; onSaved: (updated: number) => Promise<void>; report: (reason: unknown) => void
}) {
  const [selected, setSelected] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const directions = new Set(transactions.map((item) => item.direction))
  const mixedDirections = directions.size > 1
  const visibleDimensions = catalog.filter((dimension) => {
    if (!dimension.enabled) return false
    if (dimension.key === 'income_category') return directions.size === 1 && directions.has('income')
    if (dimension.key === 'expense_category') return directions.size === 1 && directions.has('expense')
    return true
  })
  function choose(dimension: LabelDimension, labelId: number, checked = true) {
    const dimensionIds = new Set(dimension.labels.map((label) => label.id))
    if (dimension.selectionMode === 'single') setSelected((current) => [...current.filter((id) => !dimensionIds.has(id)), ...(labelId ? [labelId] : [])])
    else setSelected((current) => checked ? [...new Set([...current, labelId])] : current.filter((id) => id !== labelId))
  }
  async function save() {
    setSaving(true)
    try {
      const result = await saveBatchAnnotations(transactions.map((item) => item.id), selected)
      await onSaved(result.updated)
    } catch (reason) { report(reason) } finally { setSaving(false) }
  }
  const total = transactions.reduce((sum, item) => sum + Math.abs(item.amount), 0)
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="annotation-dialog batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-annotation-title"><header><div><p className="eyebrow">BATCH CONFIRMATION</p><h2 id="batch-annotation-title">统一标注 {transactions.length} 笔流水</h2><p>本次选择会完整应用到每一笔，保存后它们将一起离开待标注队列。</p></div><button className="close-button" onClick={onClose} aria-label="关闭">×</button></header><div className="fact-strip"><span>流水数量<b>{transactions.length} 笔</b></span><span>收支范围<b>{mixedDirections ? '收入与支出混合' : directions.has('income') ? '全部收入' : '全部支出'}</b></span><span>合计金额<b>{money.format(total)}</b></span></div>{mixedDirections && <div className="batch-direction-note">混合选择时只显示收入、支出通用维度；如需统一分类，请先按收支方向分开选择。</div>}<div className="annotation-fields">{visibleDimensions.map((dimension) => <fieldset key={dimension.id}><legend>{dimension.name}<small>{dimension.selectionMode === 'multiple' ? '可多选' : '单选'}</small></legend>{dimension.selectionMode === 'single' ? <select value={dimension.labels.find((label) => selected.includes(label.id))?.id ?? ''} onChange={(event) => choose(dimension, Number(event.target.value))}><option value="">未选择</option>{treeOptions(dimension.labels).filter(({ label }) => label.enabled).map(({ label, depth }) => <option value={label.id} key={label.id}>{'— '.repeat(depth)}{label.name}</option>)}</select> : <div className="checkbox-grid">{treeOptions(dimension.labels).filter(({ label }) => label.enabled).map(({ label, depth }) => <label key={label.id} style={{ paddingLeft: depth * 14 }}><input type="checkbox" checked={selected.includes(label.id)} onChange={(event) => choose(dimension, label.id, event.target.checked)} />{label.name}</label>)}</div>}</fieldset>)}</div><div className="suggestion-note"><b>统一结果：</b>{selected.length ? `${selected.length} 个标签会覆盖每笔流水各自的规则建议。` : '尚未选择标签；继续保存会把这些流水确认为“无需标签”。'}</div><footer className="dialog-actions"><button className="button secondary" disabled={saving} onClick={onClose}>返回选择</button><button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? '统一保存中…' : selected.length ? `统一保存并移出 ${transactions.length} 笔` : `确认无标注并移出 ${transactions.length} 笔`}</button></footer></section></div>
}

function treeOptions(labels: LabelNode[]) {
  const result: { label: LabelNode; depth: number }[] = []
  const visit = (parentId: number | null, depth: number) => labels.filter((label) => label.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).forEach((label) => { result.push({ label, depth }); visit(label.id, depth + 1) })
  visit(null, 0); return result
}

function panelIndex(index: number) {
  let value = index + 1
  let result = ''
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26) }
  return result
}

type LabelCreateTarget = {
  parentId: number | null
  relationship: 'root' | 'child' | 'sibling'
  referenceName?: string
}

type LabelDeleteTarget =
  | { kind: 'dimension'; id: string; name: string }
  | { kind: 'label'; id: number; name: string }

function LabelManager({ catalog, reload, report, announce }: { catalog: LabelDimension[]; reload: () => Promise<void>; report: (reason: unknown) => void; announce: (value: string) => void }) {
  const [dimensionId, setDimensionId] = useState('')
  const [labelId, setLabelId] = useState<number | null>(null)
  const [newDimension, setNewDimension] = useState({ key: '', name: '', notes: '', selection_mode: 'single' })
  const [createTarget, setCreateTarget] = useState<LabelCreateTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LabelDeleteTarget | null>(null)
  const [mutationError, setMutationError] = useState('')
  const dimension = catalog.find((item) => item.id === dimensionId) ?? catalog[0]
  const selected = dimension?.labels.find((label) => label.id === labelId) ?? null
  useEffect(() => { if (!dimensionId && catalog[0]) setDimensionId(catalog[0].id) }, [catalog, dimensionId])
  async function run(action: () => Promise<unknown>, message: string) {
    try {
      setMutationError('')
      const result = await action()
      await reload()
      announce(message)
      return result
    } catch (reason) {
      setMutationError(reason instanceof Error ? reason.message : '操作未完成')
      report(reason)
      return undefined
    }
  }
  async function createRequestedLabel(name: string, notes: string) {
    if (!dimension || !createTarget) return false
    const created = await run(() => createLabel({
      dimension_id: dimension.id,
      parent_id: createTarget.parentId,
      name,
      notes: notes || undefined,
      sort_order: dimension.labels.filter((label) => label.parentId === createTarget.parentId).length,
    }), '标签已创建') as LabelNode | undefined
    if (!created) return false
    setLabelId(created.id)
    setCreateTarget(null)
    return true
  }
  async function deleteRequestedItem() {
    if (!deleteTarget) return false
    const result = deleteTarget.kind === 'dimension'
      ? await run(() => deleteDimension(deleteTarget.id), '维度已安全处理')
      : await run(() => deleteLabel(deleteTarget.id), '标签已安全处理')
    if (!result) return false
    if (deleteTarget.kind === 'label') setLabelId(null)
    setDeleteTarget(null)
    return true
  }
  return <>
    <section className="workspace-page">
      <div className="workspace-heading"><p className="eyebrow">LABEL ARCHITECTURE</p><h1>把分类体系搭成一棵可维护的树</h1><p>每个层级都能增删、备注、排序和停用。被流水引用的标签删除时只会停用。</p></div>
      <div className="label-workbench">
        <aside className="dimension-pane">
          <h2>维度</h2>
          {catalog.map((item) => <button type="button" key={item.id} className={item.id === dimension?.id ? 'active' : ''} onClick={() => { setDimensionId(item.id); setLabelId(null) }}><span>{item.name}</span><small>{item.labels.length} 个标签</small></button>)}
          <form onSubmit={(event) => { event.preventDefault(); void run(() => createDimension(newDimension), '维度已创建'); setNewDimension({ key: '', name: '', notes: '', selection_mode: 'single' }) }}><h3>新增维度</h3><input required placeholder="机器标识，如 project" value={newDimension.key} onChange={(e) => setNewDimension({ ...newDimension, key: e.target.value })} /><input required placeholder="显示名称" value={newDimension.name} onChange={(e) => setNewDimension({ ...newDimension, name: e.target.value })} /><select value={newDimension.selection_mode} onChange={(e) => setNewDimension({ ...newDimension, selection_mode: e.target.value })}><option value="single">单选</option><option value="multiple">多选</option></select><button className="button secondary">创建维度</button></form>
        </aside>
        <section className="tree-pane">
          <div className="pane-heading"><div><h2>{dimension?.name ?? '标签树'}</h2><p>{dimension?.notes || '从根标签开始建立层级'}</p></div><button type="button" className="button secondary" onClick={() => { setMutationError(''); setCreateTarget({ parentId: null, relationship: 'root' }) }}>＋ 根标签</button></div>
          {dimension && treeOptions(dimension.labels).map(({ label, depth }) => <button type="button" key={label.id} className={`tree-row ${label.id === selected?.id ? 'active' : ''} ${label.enabled ? '' : 'disabled'}`} style={{ paddingLeft: 18 + depth * 24 }} onClick={() => setLabelId(label.id)}><span>{depth ? '↳' : '◆'} {label.name}</span><small>{label.usageCount} 次引用</small></button>)}
        </section>
        <section className="editor-pane">
          {selected && dimension ? <LabelEditor
            label={selected} dimension={dimension} run={run}
            requestLabel={(target) => { setMutationError(''); setCreateTarget(target) }}
            requestDelete={() => { setMutationError(''); setDeleteTarget({ kind: 'label', id: selected.id, name: selected.name }) }}
          /> : dimension ? <><p className="eyebrow">DIMENSION</p><h2>{dimension.name}</h2><label>说明<textarea defaultValue={dimension.notes ?? ''} onBlur={(event) => void run(() => updateDimension(dimension.id, { notes: event.target.value }), '维度说明已保存')} /></label><label className="toggle"><input type="checkbox" checked={dimension.enabled} onChange={(event) => void run(() => updateDimension(dimension.id, { enabled: event.target.checked }), '维度状态已更新')} />启用此维度</label><button type="button" className="danger-link" onClick={() => { setMutationError(''); setDeleteTarget({ kind: 'dimension', id: dimension.id, name: dimension.name }) }}>删除维度</button></> : <EmptyState text="先创建一个标签维度" />}
        </section>
      </div>
    </section>
    {createTarget && dimension && <LabelCreateDialog dimension={dimension} target={createTarget} error={mutationError} onClose={() => setCreateTarget(null)} onCreate={createRequestedLabel} />}
    {deleteTarget && <LabelDeleteDialog target={deleteTarget} error={mutationError} onClose={() => setDeleteTarget(null)} onConfirm={deleteRequestedItem} />}
  </>
}

function LabelEditor({ label, dimension, run, requestLabel, requestDelete }: {
  label: LabelNode
  dimension: LabelDimension
  run: (action: () => Promise<unknown>, message: string) => Promise<unknown>
  requestLabel: (target: LabelCreateTarget) => void
  requestDelete: () => void
}) {
  const [draft, setDraft] = useState(label)
  useEffect(() => setDraft(label), [label])
  return <><p className="eyebrow">LABEL / {label.id}</p><h2>{label.name}</h2><label>名称<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>备注<textarea value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label><label>父标签<select value={draft.parentId ?? ''} onChange={(e) => setDraft({ ...draft, parentId: e.target.value ? Number(e.target.value) : null })}><option value="">根级</option>{treeOptions(dimension.labels).filter(({ label: item }) => item.id !== label.id).map(({ label: item, depth }) => <option key={item.id} value={item.id}>{'— '.repeat(depth)}{item.name}</option>)}</select></label><label>排序<input type="number" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })} /></label><label className="toggle"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />启用标签</label><div className="editor-actions"><button type="button" className="button primary" onClick={() => void run(() => updateLabel(label.id, { name: draft.name, notes: draft.notes, parent_id: draft.parentId, sort_order: draft.sortOrder, enabled: draft.enabled }), '标签已保存')}>保存修改</button><button type="button" className="button secondary" onClick={() => requestLabel({ parentId: label.id, relationship: 'child', referenceName: label.name })}>新增子级</button><button type="button" className="button secondary" onClick={() => requestLabel({ parentId: label.parentId, relationship: 'sibling', referenceName: label.name })}>新增同级</button></div><button type="button" className="danger-link" onClick={requestDelete}>删除标签</button></>
}

function LabelCreateDialog({ dimension, target, error, onClose, onCreate }: {
  dimension: LabelDimension
  target: LabelCreateTarget
  error: string
  onClose: () => void
  onCreate: (name: string, notes: string) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const title = target.relationship === 'root' ? '新增根标签' : target.relationship === 'child' ? `新增“${target.referenceName}”的子级` : `新增“${target.referenceName}”的同级`
  async function submit() {
    setSaving(true)
    try { await onCreate(name.trim(), notes.trim()) } finally { setSaving(false) }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <form className="label-dialog" role="dialog" aria-modal="true" aria-labelledby="label-create-title" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <header><div><p className="eyebrow">{dimension.name} / NEW LABEL</p><h2 id="label-create-title">{title}</h2><p>{target.parentId === null ? '创建在当前维度的根级。' : '父级关系会随标签一起保存。'}</p></div><button type="button" className="close-button" disabled={saving} onClick={onClose} aria-label="关闭">×</button></header>
      <div className="label-dialog-body">{error && <p className="dialog-inline-error" role="alert">{error}</p>}<label>标签名称<input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></label><label>备注（可选）<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label></div>
      <footer className="dialog-actions"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? '创建中…' : '创建标签'}</button></footer>
    </form>
  </div>
}

function LabelDeleteDialog({ target, error, onClose, onConfirm }: {
  target: LabelDeleteTarget
  error: string
  onClose: () => void
  onConfirm: () => Promise<boolean>
}) {
  const [saving, setSaving] = useState(false)
  async function confirm() {
    setSaving(true)
    try { await onConfirm() } finally { setSaving(false) }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <section className="label-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="label-delete-title">
      <header><div><p className="eyebrow">SAFE DELETE</p><h2 id="label-delete-title">安全处理“{target.name}”</h2><p>{target.kind === 'dimension' ? '将处理整个维度及其标签。' : '将处理当前标签。'}</p></div><button type="button" className="close-button" disabled={saving} onClick={onClose} aria-label="关闭">×</button></header>
      <div className="label-dialog-body">{error && <p className="dialog-inline-error" role="alert">{error}</p>}<p>没有引用时会直接删除；存在流水、规则引用或子标签时只会停用，历史数据不会丢失。</p></div>
      <footer className="dialog-actions"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={saving} onClick={() => void confirm()}>{saving ? '处理中…' : '确认安全处理'}</button></footer>
    </section>
  </div>
}

function RulesManager({ catalog, rules, reload, report, announce }: { catalog: LabelDimension[]; rules: MerchantRule[]; reload: () => Promise<void>; report: (reason: unknown) => void; announce: (value: string) => void }) {
  const [draft, setDraft] = useState({ name: '', source_platform: '', counterparty_exact: '', label_ids: [] as number[], notes: '' })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [applyingId, setApplyingId] = useState<number | null>(null)
  async function run(action: () => Promise<unknown>, message: string) { try { await action(); await reload(); announce(message) } catch (reason) { report(reason) } }
  const toggle = (id: number) => setDraft((value) => {
    const dimension = catalog.find((item) => item.labels.some((label) => label.id === id))
    if (!dimension) return value
    if (dimension.selectionMode === 'single') {
      const dimensionIds = new Set(dimension.labels.map((label) => label.id))
      const already = value.label_ids.includes(id)
      return { ...value, label_ids: [...value.label_ids.filter((item) => !dimensionIds.has(item)), ...(already ? [] : [id])] }
    }
    return { ...value, label_ids: value.label_ids.includes(id) ? value.label_ids.filter((item) => item !== id) : [...value.label_ids, id] }
  })
  const labelNameById = new Map(catalog.flatMap((item) => item.labels).map((label) => [label.id, label.name]))
  const selectedNames = draft.label_ids.map((id) => labelNameById.get(id)).filter(Boolean).join('、')
  const stateOf = (rule: MerchantRule) => !rule.appliedAt
    ? { text: '待应用', className: 'rule-state pending', hint: '尚未应用到任何流水，不会产生建议' }
    : rule.enabled
      ? { text: '生效中', className: 'rule-state', hint: '' }
      : { text: '已停用', className: 'rule-state off', hint: '' }
  async function applyOnce(rule: MerchantRule) {
    setApplyingId(rule.id)
    try {
      const result = await applyRule(rule.id)
      await reload()
      announce(`规则已应用到 ${result.matched} 笔已有流水，并保持生效。`)
    } catch (reason) { report(reason) } finally { setApplyingId(null) }
  }
  return <section className="workspace-page"><div className="workspace-heading"><p className="eyebrow">EXACT MATCH RULES</p><h1>让重复出现的商户自动填好建议</h1><p>只匹配交易对方完整名称；不扫描关键词，不读取商品说明。新规则先待应用，点击一次“应用到已有流水”后才生效。人工确认永远优先。</p></div><div className="rules-grid"><form className="rule-form" onSubmit={(event) => { event.preventDefault(); void run(() => createRule(draft), '预填规则已创建，尚未应用到已有流水'); setDraft({ name: '', source_platform: '', counterparty_exact: '', label_ids: [], notes: '' }) }}><h2>新建精确规则</h2><label>规则名称<input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>平台<select value={draft.source_platform} onChange={(e) => setDraft({ ...draft, source_platform: e.target.value })}><option value="">不限平台</option><option>微信</option><option>支付宝</option></select></label><label>交易对方完整名称<input required value={draft.counterparty_exact} onChange={(e) => setDraft({ ...draft, counterparty_exact: e.target.value })} placeholder="必须与账单原值完全一致" /></label><label>备注<textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label><button type="button" className="rule-label-trigger" onClick={() => setPickerOpen(true)}><span className="rule-trigger-head"><span>预填标签</span><b>{draft.label_ids.length ? `已选 ${draft.label_ids.length} 个` : '未选择'}</b></span><small>{selectedNames || '打开整面标签面板选择；可留空，命中时只确认商户'}</small></button><p className="rule-form-note">创建后规则保持“待应用”，不会影响已有流水；在右侧对它点击一次“应用到已有流水”，才会对所有匹配数据生效一次并转入生效中。</p><button className="button primary">创建规则</button></form><section className="rule-list"><h2>现有规则 <small>{rules.length}</small></h2>{rules.length ? rules.map((rule) => { const state = stateOf(rule); return <article key={rule.id}><div><span className={state.className} title={state.hint}>{state.text}</span><h3>{rule.name}</h3><p>{rule.sourcePlatform || '全平台'} · “{rule.counterpartyExact}”</p><small>{rule.labelIds.map((id) => labelNameById.get(id)).filter(Boolean).join('、') || '未配置标签'}</small></div><div>{!rule.appliedAt && <button className="text-button" disabled={applyingId === rule.id} onClick={() => void applyOnce(rule)}>{applyingId === rule.id ? '应用中…' : '应用到已有流水'}</button>}<button className="text-button" onClick={() => void run(() => updateRule(rule.id, { enabled: !rule.enabled }), '规则状态已更新')}>{rule.enabled ? '停用' : '启用'}</button><button className="danger-link" onClick={() => { if (window.confirm('删除这条规则？')) void run(() => deleteRule(rule.id), '规则已删除') }}>删除</button></div></article> }) : <EmptyState text="还没有商户精确规则" />}</section></div>{pickerOpen && <RuleLabelPicker catalog={catalog} selected={draft.label_ids} onToggle={toggle} onClear={() => setDraft((value) => ({ ...value, label_ids: [] }))} onClose={() => setPickerOpen(false)} />}</section>
}

function RuleLabelPicker({ catalog, selected, onToggle, onClear, onClose }: {
  catalog: LabelDimension[]; selected: number[]
  onToggle: (id: number) => void; onClear: () => void; onClose: () => void
}) {
  const dimensions = catalog.filter((item) => item.enabled)
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="rule-label-picker" role="dialog" aria-modal="true" aria-labelledby="rule-picker-title"><header><div><p className="eyebrow">RULE LABELS</p><h2 id="rule-picker-title">选择规则要预填的标签</h2><p>全部维度一次完整展开，不做内嵌滚动；单选维度一次只保留一个标签。</p></div><button className="close-button" onClick={onClose} aria-label="关闭标签面板">×</button></header><div className="rule-picker-grid">{dimensions.map((dimension) => <fieldset key={dimension.id}><legend>{dimension.name}<small>{dimension.selectionMode === 'multiple' ? '可多选' : '单选'}</small></legend>{treeOptions(dimension.labels).filter(({ label }) => label.enabled).map(({ label, depth }) => <label key={label.id} className={selected.includes(label.id) ? 'picked' : ''} style={{ marginLeft: depth * 14 }}><input type="checkbox" checked={selected.includes(label.id)} onChange={() => onToggle(label.id)} />{label.name}</label>)}{!dimension.labels.some((label) => label.enabled) && <p className="rule-picker-empty">该维度暂无可用标签</p>}</fieldset>)}</div><footer className="dialog-actions"><button type="button" className="button ghost" onClick={onClear} disabled={!selected.length}>清除已选</button><button type="button" className="button primary" onClick={onClose}>完成（已选 {selected.length} 个标签）</button></footer></section></div>
}

function PanelHeading({ index, title, meta }: { index: string; title: string; meta: string }) { return <div className="panel-heading"><div><span>{index}</span><h2>{title}</h2></div><small>{meta}</small></div> }
function DistributionPanel({ index, title, items, colors }: { index: string; title: string; items: DistributionItem[]; colors: string[] }) { const total = items.reduce((sum, item) => sum + item.value, 0); return <article className="panel distribution-panel"><PanelHeading index={index} title={title} meta={`${items.length} 项`} />{items.length ? <div className="distribution-body"><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={items} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="92%" stroke="none">{items.map((item, i) => <Cell key={item.name} fill={colors[i % colors.length]} />)}</Pie><Tooltip formatter={(value) => money.format(Number(value))} /></PieChart></ResponsiveContainer><div><strong>{money.format(total)}</strong><span>总计</span></div></div><ol className="rank-list">{items.slice(0, 5).map((item, i) => <li key={item.name}><i style={{ background: colors[i % colors.length] }} /><span>{item.name}</span><b>{total ? Math.round(item.value / total * 100) : 0}%</b><small>{money.format(item.value)}</small></li>)}</ol></div> : <EmptyState text={`暂无${title}数据`} />}</article> }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>⌁</span><p>{text}</p></div> }
function DashboardSkeleton() { return <div className="skeleton" aria-label="正在读取"><div /><div /><div /><span>正在读取账本…</span></div> }

export default App
