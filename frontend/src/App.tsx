import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  createDimension, createLabel, createManualTransaction, createRule, deleteDimension, deleteLabel, deleteRule,
  getAnnotation, getDashboard, getHeatmaps, getLabelCatalog, getRules, getTransactions, importStatements,
  saveAnnotation, saveBatchAnnotations, updateDimension, updateLabel, updateRule,
} from './api'
import type { AnnotationData, DashboardData, DistributionItem, HeatmapData, HeatmapPoint, LabelDimension, LabelNode, ManualTransactionInput, MerchantRule, Transaction } from './types'

const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })
const compactMoney = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
type View = 'dashboard' | 'annotations' | 'labels' | 'rules'
type Theme = 'ledger' | 'glass'
const THEME_STORAGE_KEY = 'ledger-pilot-theme'
const THEME_CHARTS: Record<Theme, { pie: string[]; grid: string; expense: string; expenseFill: string; income: string }> = {
  ledger: { pie: ['#213640', '#5e7c88', '#94a9ad', '#d29a66', '#c75d50', '#7f6f8d'], grid: '#d5dde0', expense: '#c75d50', expenseFill: '#c75d5022', income: '#526d7b' },
  glass: { pie: ['#f0c97a', '#82aee8', '#8ed7bd', '#c19ae8', '#ef8e88', '#8d9ebd'], grid: 'rgba(183, 205, 238, .18)', expense: '#f2c879', expenseFill: 'rgba(242, 200, 121, .18)', income: '#8ed7bd' },
}

function currentMonth() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` }
function shiftMonth(value: string, offset: number) { const [year, month] = value.split('-').map(Number); const date = new Date(year, month - 1 + offset, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` }
function monthName(value: string) { const [year, month] = value.split('-'); return `${year} 年 ${Number(month)} 月` }
function localDateTime() { const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 19) }

function App() {
  const [view, setView] = useState<View>('dashboard')
  const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem(THEME_STORAGE_KEY) === 'glass' ? 'glass' : 'ledger')
  const [month, setMonth] = useState(currentMonth)
  const [data, setData] = useState<DashboardData | null>(null)
  const [heatmaps, setHeatmaps] = useState<HeatmapData | null>(null)
  const [heatmapLoading, setHeatmapLoading] = useState(true)
  const [heatmapError, setHeatmapError] = useState('')
  const [catalog, setCatalog] = useState<LabelDimension[]>([])
  const [rules, setRules] = useState<MerchantRule[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [transactionTotal, setTransactionTotal] = useState(0)
  const [annotationLoading, setAnnotationLoading] = useState(false)
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
  const fileRef = useRef<HTMLInputElement>(null)
  const heatmapRequestId = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const report = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : '操作未完成'), [])
  const loadCatalog = useCallback(async () => setCatalog(await getLabelCatalog()), [])
  const loadRules = useCallback(async () => setRules(await getRules()), [])
  const heatmapYear = Number(month.slice(0, 4))
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
    setLoading(true); setError('')
    try { setData(await getDashboard(month)) }
    catch (reason) { report(reason); setData(null) }
    finally { setLoading(false) }
  }, [month, report])

  const loadAnnotationQueue = useCallback(async () => {
    setAnnotationLoading(true); setError('')
    try {
      const result = await getTransactions({ month, category, channel, query, annotationStatus: 'pending' })
      setTransactions(result.items)
      setTransactionTotal(result.total)
      setSelectedTransactionIds((current) => current.filter((id) => result.items.some((item) => item.id === id)))
      return result.items
    } catch (reason) {
      report(reason); setTransactions([]); setTransactionTotal(0); setSelectedTransactionIds([])
      return []
    } finally { setAnnotationLoading(false) }
  }, [month, category, channel, query, report])

  useEffect(() => { void Promise.all([loadDashboard(), loadHeatmaps(), loadCatalog(), loadRules()]).catch(report) }, [loadDashboard, loadHeatmaps, loadCatalog, loadRules, report])
  useEffect(() => {
    if (view !== 'annotations') return
    const timer = window.setTimeout(() => { void loadAnnotationQueue() }, 160)
    return () => window.clearTimeout(timer)
  }, [view, loadAnnotationQueue])

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
    if (savedMonth === month) await Promise.all([loadDashboard(), loadHeatmaps()]); else setMonth(savedMonth)
  }

  return <main>
    <header className="masthead">
      <button className="brand" onClick={() => setView('dashboard')} aria-label="Ledger Pilot 首页"><span className="brand-mark">LP</span><span><b>Ledger Pilot</b><small>本地账本工作台</small></span></button>
      <nav className="main-nav" aria-label="主导航">
        <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>月度看板</button>
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
      theme={theme} month={month} setMonth={setMonth} data={data} heatmaps={heatmaps} heatmapLoading={heatmapLoading} heatmapError={heatmapError} loading={loading}
      busy={busy} onPickFiles={() => fileRef.current?.click()} onManualEntry={() => setManualEntryOpen(true)}
    />}
    {view === 'annotations' && <AnnotationQueuePage
      month={month} setMonth={setMonth} data={data}
      transactions={transactions} total={transactionTotal} loading={annotationLoading}
      category={category} setCategory={setCategory} channel={channel} setChannel={setChannel}
      query={query} setQuery={setQuery} selectedIds={selectedTransactionIds} setSelectedIds={setSelectedTransactionIds}
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
    <footer><span>LEDGER PILOT / V1.4.1</span><p>规则给建议，最终选择由你确认；原始流水永不被标注修改。</p></footer>
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
  month: string; setMonth: (value: string) => void; data: DashboardData | null; heatmaps: HeatmapData | null; heatmapLoading: boolean; heatmapError: string; loading: boolean
  busy: boolean; onPickFiles: () => void; onManualEntry: () => void
}) {
  const { month, data, theme } = props
  const chartColors = THEME_CHARTS[theme]
  const summary = data?.summary ?? { income: 0, expense: 0, net: 0 }
  const distributions = data?.distributions ?? (data ? [
    { dimensionId: 'legacy-expense-category', key: 'expense_category', name: '支出分类', items: data.categories },
    { dimensionId: 'legacy-payment-channel', key: 'payment_channel', name: '支付渠道', items: data.channels },
  ] : [])
  return <>
    <MonthRail month={month} setMonth={props.setMonth} />
    <section className="page-heading"><div><p className="eyebrow">MONTHLY REVIEW / {month.replace('-', '.')}</p><h1>{monthName(month)}，逐笔把钱说清楚</h1><p>规则先填建议，你在流水里确认；看板始终标明结论来自人工还是规则。</p></div><div className="actions"><button className="button secondary" onClick={props.onManualEntry}>手动记账</button><button className="button primary" onClick={props.onPickFiles} disabled={props.busy}>{props.busy ? '正在合并…' : '导入账单'}</button></div></section>
    {props.loading ? <DashboardSkeleton /> : data ? <>
      <section className="summary-strip"><article className="hero-amount"><p>本月支出</p><strong>{money.format(summary.expense)}</strong><span>共计流出</span></article><article><p>本月收入</p><strong>{money.format(summary.income)}</strong><span>已入账</span></article><article><p>收支净额</p><strong className={summary.net < 0 ? 'negative' : ''}>{summary.net >= 0 ? '+' : ''}{money.format(summary.net)}</strong><span>{summary.net >= 0 ? '本月有结余' : '支出高于收入'}</span></article></section>
      <section className="analysis-stack"><article className="panel trend-panel"><PanelHeading index="A" title="日收支轨迹" meta={`${data.trend.length} 个记账日`} />{data.trend.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data.trend} margin={{ top: 10, right: 4, left: -20, bottom: 0 }}><CartesianGrid stroke={chartColors.grid} strokeDasharray="2 5" vertical={false} /><XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={(value: string) => value.slice(-2)} /><YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10 }} tickFormatter={(value: number) => compactMoney.format(value)} /><Tooltip formatter={(value) => money.format(Number(value))} /><Area type="monotone" dataKey="expense" name="支出" stroke={chartColors.expense} fill={chartColors.expenseFill} /><Area type="monotone" dataKey="income" name="收入" stroke={chartColors.income} fill="transparent" /></AreaChart></ResponsiveContainer></div> : <EmptyState text="这个月还没有收支轨迹" />}</article><div className="distribution-grid">{distributions.map((distribution, index) => <DistributionPanel key={distribution.dimensionId} index={panelIndex(index + 1)} title={distribution.name} items={distribution.items} colors={chartColors.pie} />)}</div></section>
      <AnnualHeatmaps data={props.heatmaps} year={Number(month.slice(0, 4))} loading={props.heatmapLoading} error={props.heatmapError} />
    </> : <EmptyState text="账本暂时没有这个月的数据，请先导入账单" />}
  </>
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
  query: string; setQuery: (value: string) => void; selectedIds: number[]; setSelectedIds: (value: number[]) => void
  onAnnotate: (id: number) => void; onBatchAnnotate: () => void
}) {
  const allSelected = props.transactions.length > 0 && props.transactions.every((item) => props.selectedIds.includes(item.id))
  const categoryOptions = [...new Set([...(props.data?.categories.map((item) => item.name) ?? []), ...props.transactions.map((item) => item.category)])].filter((item) => item !== '未分类')
  const channelOptions = [...new Set([...(props.data?.channels.map((item) => item.name) ?? []), ...props.transactions.map((item) => item.channel)])].filter((item) => item !== '未识别')
  function toggleAll() {
    props.setSelectedIds(allSelected ? [] : props.transactions.map((item) => item.id))
  }
  function toggleOne(id: number) {
    props.setSelectedIds(props.selectedIds.includes(id) ? props.selectedIds.filter((item) => item !== id) : [...props.selectedIds, id])
  }
  const filtered = Boolean(props.query || props.category || props.channel)
  return <>
    <MonthRail month={props.month} setMonth={props.setMonth} />
    <section className="annotation-page-heading"><div><p className="eyebrow">REVIEW QUEUE / {props.month.replace('-', '.')}</p><h1>先搜出一类，再一次标完</h1><p>列表只保留尚未人工确认的流水。搜索相似交易，多选后统一标注，保存即从队列移除。</p></div><div className="queue-count"><span>{filtered ? '当前匹配' : '当前待办'}</span><strong>{props.total}</strong><small>笔流水</small></div></section>
    <section className="annotation-workspace" aria-label="待标注流水">
      <div className="annotation-toolbar">
        <label className="search-field"><span>搜索待标注流水</span><input value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="商户、商品或备注" /></label>
        <label><span>分类</span><select value={props.category} onChange={(event) => props.setCategory(event.target.value)}><option value="">全部分类</option>{categoryOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>渠道</span><select value={props.channel} onChange={(event) => props.setChannel(event.target.value)}><option value="">全部渠道</option>{channelOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        {filtered && <button className="clear-filters" onClick={() => { props.setQuery(''); props.setCategory(''); props.setChannel('') }}>清除筛选</button>}
      </div>
      <div className={`selection-dock ${props.selectedIds.length ? 'active' : ''}`} role="status">
        <div><b>{props.selectedIds.length ? `已选 ${props.selectedIds.length} 笔` : '先搜索，再选择相似流水'}</b><span>{props.selectedIds.length ? '将为这些流水保存完全相同的人工标注' : '可逐笔处理，也可全选当前搜索结果'}</span></div>
        {props.selectedIds.length > 0 && <div><button className="button ghost" onClick={() => props.setSelectedIds([])}>取消选择</button><button className="button primary" onClick={props.onBatchAnnotate}>统一标注 {props.selectedIds.length} 笔</button></div>}
      </div>
      {props.total > props.transactions.length && <p className="queue-limit">当前加载前 {props.transactions.length} 笔，共匹配 {props.total} 笔；可继续收紧搜索后分批处理。</p>}
      {props.loading ? <DashboardSkeleton /> : props.transactions.length ? <div className="table-wrap annotation-table"><table><thead><tr><th className="select-cell"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="全选当前搜索结果" /></th><th>日期</th><th>交易摘要</th><th>分类</th><th>支付渠道</th><th>金额</th><th /></tr></thead><tbody>{props.transactions.map((item) => <tr key={item.id} className={props.selectedIds.includes(item.id) ? 'selected' : ''} onDoubleClick={() => props.onAnnotate(item.id)}><td className="select-cell"><input type="checkbox" checked={props.selectedIds.includes(item.id)} onChange={() => toggleOne(item.id)} aria-label={`选择 ${item.merchant} ${item.date.slice(0, 10)}`} /></td><td>{item.date.slice(0, 16)}</td><td><strong>{item.merchant}</strong>{item.itemDescription && <small>{item.itemDescription}</small>}</td><td><span className="tag">{item.category}<i className={item.categorySource}>{item.categorySource === 'rule' ? '规则' : '未确认'}</i></span></td><td>{item.channel}</td><td className={item.direction === 'expense' ? 'amount expense' : 'amount income'}>{item.direction === 'expense' ? '−' : '+'}{money.format(Math.abs(item.amount))}</td><td><button className="row-action" onClick={() => props.onAnnotate(item.id)}>标注此笔</button></td></tr>)}</tbody></table></div> : <div className="queue-empty"><span>✓</span><h2>{filtered ? '没有符合当前条件的待标注流水' : '这个月的待标注队列已清空'}</h2><p>{filtered ? '调整搜索词或清除筛选，继续处理其他流水。' : '人工确认过的流水不会再次出现；新导入的流水会自动进入这里。'}</p></div>}
    </section>
  </>
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
  async function run(action: () => Promise<unknown>, message: string) { try { await action(); await reload(); announce(message) } catch (reason) { report(reason) } }
  const toggle = (id: number) => setDraft((value) => ({ ...value, label_ids: value.label_ids.includes(id) ? value.label_ids.filter((item) => item !== id) : [...value.label_ids, id] }))
  return <section className="workspace-page"><div className="workspace-heading"><p className="eyebrow">EXACT MATCH RULES</p><h1>让重复出现的商户自动填好建议</h1><p>只匹配交易对方完整名称；不扫描关键词，不读取商品说明。人工确认永远优先。</p></div><div className="rules-grid"><form className="rule-form" onSubmit={(event) => { event.preventDefault(); void run(() => createRule(draft), '预填规则已创建'); setDraft({ name: '', source_platform: '', counterparty_exact: '', label_ids: [], notes: '' }) }}><h2>新建精确规则</h2><label>规则名称<input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>平台<select value={draft.source_platform} onChange={(e) => setDraft({ ...draft, source_platform: e.target.value })}><option value="">不限平台</option><option>微信</option><option>支付宝</option></select></label><label>交易对方完整名称<input required value={draft.counterparty_exact} onChange={(e) => setDraft({ ...draft, counterparty_exact: e.target.value })} placeholder="必须与账单原值完全一致" /></label><label>备注<textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label><div className="rule-labels">{catalog.filter((d) => d.enabled).map((dimension) => <fieldset key={dimension.id}><legend>{dimension.name}</legend>{dimension.labels.filter((label) => label.enabled).map((label) => <label key={label.id}><input type="checkbox" checked={draft.label_ids.includes(label.id)} onChange={() => toggle(label.id)} />{label.name}</label>)}</fieldset>)}</div><button className="button primary">创建规则</button></form><section className="rule-list"><h2>现有规则 <small>{rules.length}</small></h2>{rules.length ? rules.map((rule) => <article key={rule.id}><div><span className={rule.enabled ? 'rule-state' : 'rule-state off'}>{rule.enabled ? '启用' : '停用'}</span><h3>{rule.name}</h3><p>{rule.sourcePlatform || '全平台'} · “{rule.counterpartyExact}”</p><small>{rule.labelIds.map((id) => catalog.flatMap((d) => d.labels).find((label) => label.id === id)?.name).filter(Boolean).join('、') || '未配置标签'}</small></div><div><button className="text-button" onClick={() => void run(() => updateRule(rule.id, { enabled: !rule.enabled }), '规则状态已更新')}>{rule.enabled ? '停用' : '启用'}</button><button className="danger-link" onClick={() => { if (window.confirm('删除这条规则？')) void run(() => deleteRule(rule.id), '规则已删除') }}>删除</button></div></article>) : <EmptyState text="还没有商户精确规则" />}</section></div></section>
}

function PanelHeading({ index, title, meta }: { index: string; title: string; meta: string }) { return <div className="panel-heading"><div><span>{index}</span><h2>{title}</h2></div><small>{meta}</small></div> }
function DistributionPanel({ index, title, items, colors }: { index: string; title: string; items: DistributionItem[]; colors: string[] }) { const total = items.reduce((sum, item) => sum + item.value, 0); return <article className="panel distribution-panel"><PanelHeading index={index} title={title} meta={`${items.length} 项`} />{items.length ? <div className="distribution-body"><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={items} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="92%" stroke="none">{items.map((item, i) => <Cell key={item.name} fill={colors[i % colors.length]} />)}</Pie><Tooltip formatter={(value) => money.format(Number(value))} /></PieChart></ResponsiveContainer><div><strong>{money.format(total)}</strong><span>总计</span></div></div><ol className="rank-list">{items.slice(0, 5).map((item, i) => <li key={item.name}><i style={{ background: colors[i % colors.length] }} /><span>{item.name}</span><b>{total ? Math.round(item.value / total * 100) : 0}%</b><small>{money.format(item.value)}</small></li>)}</ol></div> : <EmptyState text={`暂无${title}数据`} />}</article> }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>⌁</span><p>{text}</p></div> }
function DashboardSkeleton() { return <div className="skeleton" aria-label="正在读取"><div /><div /><div /><span>正在读取账本…</span></div> }

export default App
