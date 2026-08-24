import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  createDimension, createLabel, createRule, deleteDimension, deleteLabel, deleteRule,
  getAnnotation, getDashboard, getLabelCatalog, getRules, getTransactions, importStatements,
  saveAnnotation, updateDimension, updateLabel, updateRule,
} from './api'
import type { AnnotationData, DashboardData, DistributionItem, LabelDimension, LabelNode, MerchantRule, Transaction } from './types'

const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' })
const compactMoney = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const PIE_COLORS = ['#213640', '#5e7c88', '#94a9ad', '#d29a66', '#c75d50', '#7f6f8d']
type View = 'dashboard' | 'labels' | 'rules'

function currentMonth() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` }
function shiftMonth(value: string, offset: number) { const [year, month] = value.split('-').map(Number); const date = new Date(year, month - 1 + offset, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` }
function monthName(value: string) { const [year, month] = value.split('-'); return `${year} 年 ${Number(month)} 月` }

function App() {
  const [view, setView] = useState<View>('dashboard')
  const [month, setMonth] = useState(currentMonth)
  const [data, setData] = useState<DashboardData | null>(null)
  const [catalog, setCatalog] = useState<LabelDimension[]>([])
  const [rules, setRules] = useState<MerchantRule[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [annotationIndex, setAnnotationIndex] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingArchives, setPendingArchives] = useState<File[]>([])
  const [showAll, setShowAll] = useState(false)
  const [category, setCategory] = useState('')
  const [channel, setChannel] = useState('')
  const [query, setQuery] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const report = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : '操作未完成'), [])
  const loadCatalog = useCallback(async () => setCatalog(await getLabelCatalog()), [])
  const loadRules = useCallback(async () => setRules(await getRules()), [])
  const loadDashboard = useCallback(async () => {
    setLoading(true); setError('')
    try { const result = await getDashboard(month); setData(result); setTransactions(result.recent ?? []) }
    catch (reason) { report(reason); setData(null); setTransactions([]) }
    finally { setLoading(false) }
  }, [month, report])

  useEffect(() => { void Promise.all([loadDashboard(), loadCatalog(), loadRules()]).catch(report) }, [loadDashboard, loadCatalog, loadRules, report])
  useEffect(() => {
    if (!showAll || !data) return
    const timer = window.setTimeout(() => { void getTransactions({ month, category, channel, query }).then(setTransactions).catch(report) }, 200)
    return () => window.clearTimeout(timer)
  }, [showAll, data, month, category, channel, query, report])

  async function handleImport(files: File[], archivePassword?: string) {
    if (!files.length) return
    setBusy(true); setError(''); setNotice('')
    try { const result = await importStatements(files, archivePassword); setNotice(`读取 ${result.imported} 条，新增 ${result.merged} 条，重复 ${result.skipped} 条已留存审计。`); await loadDashboard() }
    catch (reason) { report(reason) }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }

  const refreshAfterAnnotation = async () => {
    await loadDashboard()
    if (showAll) setTransactions(await getTransactions({ month, category, channel, query }))
  }

  return <main>
    <header className="masthead">
      <button className="brand" onClick={() => setView('dashboard')} aria-label="Ledger Pilot 首页"><span className="brand-mark">LP</span><span><b>Ledger Pilot</b><small>本地账本工作台</small></span></button>
      <nav className="main-nav" aria-label="主导航">
        <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>月度看板</button>
        <button className={view === 'labels' ? 'active' : ''} onClick={() => setView('labels')}>标签管理</button>
        <button className={view === 'rules' ? 'active' : ''} onClick={() => setView('rules')}>预填规则</button>
      </nav>
      <div className="header-note"><span />数据仅存本机</div>
    </header>

    {(notice || error) && <div className={error ? 'status error' : 'status success'} role={error ? 'alert' : 'status'}><span>{error ? '!' : '✓'}</span>{error || notice}<button onClick={() => { setError(''); setNotice('') }}>关闭</button></div>}

    <input ref={fileRef} className="sr-only" type="file" multiple accept=".csv,.xlsx,.zip" onChange={(event) => { const files = [...(event.target.files ?? [])]; if (files.some((file) => file.name.toLowerCase().endsWith('.zip'))) setPendingArchives(files); else void handleImport(files) }} />
    {view === 'dashboard' && <Dashboard
      month={month} setMonth={setMonth} data={data} loading={loading} transactions={transactions}
      showAll={showAll} setShowAll={setShowAll} category={category} setCategory={setCategory}
      channel={channel} setChannel={setChannel} query={query} setQuery={setQuery}
      busy={busy} onPickFiles={() => fileRef.current?.click()} onAnnotate={(id) => setAnnotationIndex(transactions.findIndex((item) => item.id === id))}
    />}
    {view === 'labels' && <LabelManager catalog={catalog} reload={loadCatalog} report={report} announce={setNotice} />}
    {view === 'rules' && <RulesManager catalog={catalog} rules={rules} reload={loadRules} report={report} announce={setNotice} />}

    {annotationIndex !== null && transactions[annotationIndex] && <AnnotationDialog
      transaction={transactions[annotationIndex]} catalog={catalog}
      hasPrevious={annotationIndex > 0} hasNext={annotationIndex < transactions.length - 1}
      onPrevious={() => setAnnotationIndex((value) => value === null ? null : Math.max(0, value - 1))}
      onNext={() => setAnnotationIndex((value) => value === null ? null : Math.min(transactions.length - 1, value + 1))}
      onClose={() => setAnnotationIndex(null)} onSaved={refreshAfterAnnotation} report={report}
    />}
    {pendingArchives.length > 0 && <ArchivePasswordDialog
      fileCount={pendingArchives.length}
      onClose={() => { setPendingArchives([]); if (fileRef.current) fileRef.current.value = '' }}
      onSubmit={(password) => { const files = pendingArchives; setPendingArchives([]); void handleImport(files, password) }}
    />}
    <footer><span>LEDGER PILOT / V1.0.0</span><p>规则给建议，最终选择由你确认；原始流水永不被标注修改。</p></footer>
  </main>
}

function ArchivePasswordDialog({ fileCount, onClose, onSubmit }: { fileCount: number; onClose: () => void; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('')
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-title" onSubmit={(event) => { event.preventDefault(); onSubmit(password) }}><header><div><p className="eyebrow">ENCRYPTED ARCHIVE</p><h2 id="password-title">输入账单解压密码</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="关闭">×</button></header><div className="password-body"><p>已选择 {fileCount} 个文件。密码只用于本次本地解密，不会保存；多份压缩包的密码可换行填写，也可直接粘贴“平台：密码”。</p><label>解压密码（多份可换行）<textarea autoFocus required autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label></div><footer className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary">解密并导入</button></footer></form></div>
}

function Dashboard(props: {
  month: string; setMonth: (value: string) => void; data: DashboardData | null; loading: boolean; transactions: Transaction[]
  showAll: boolean; setShowAll: (value: boolean) => void; category: string; setCategory: (value: string) => void
  channel: string; setChannel: (value: string) => void; query: string; setQuery: (value: string) => void
  busy: boolean; onPickFiles: () => void; onAnnotate: (id: number) => void
}) {
  const { month, data, transactions } = props
  const months = useMemo(() => [-2, -1, 0, 1, 2].map((offset) => shiftMonth(month, offset)), [month])
  const summary = data?.summary ?? { income: 0, expense: 0, net: 0 }
  return <>
    <section className="month-rail" aria-label="账期选择"><button className="rail-arrow" onClick={() => props.setMonth(shiftMonth(month, -1))} aria-label="上一个月">←</button><div className="month-track">{months.map((item) => <button key={item} className={item === month ? 'month-tick active' : 'month-tick'} onClick={() => props.setMonth(item)}><span>{item.slice(0, 4)}</span><b>{Number(item.slice(5))}月</b></button>)}</div><button className="rail-arrow" onClick={() => props.setMonth(shiftMonth(month, 1))} aria-label="下一个月">→</button></section>
    <section className="page-heading"><div><p className="eyebrow">MONTHLY REVIEW / {month.replace('-', '.')}</p><h1>{monthName(month)}，逐笔把钱说清楚</h1><p>规则先填建议，你在流水里确认；看板始终标明结论来自人工还是规则。</p></div><div className="actions"><button className="button primary" onClick={props.onPickFiles} disabled={props.busy}>{props.busy ? '正在合并…' : '导入账单'}</button></div></section>
    {props.loading ? <DashboardSkeleton /> : data ? <>
      <section className="summary-strip"><article className="hero-amount"><p>本月支出</p><strong>{money.format(summary.expense)}</strong><span>共计流出</span></article><article><p>本月收入</p><strong>{money.format(summary.income)}</strong><span>已入账</span></article><article><p>收支净额</p><strong className={summary.net < 0 ? 'negative' : ''}>{summary.net >= 0 ? '+' : ''}{money.format(summary.net)}</strong><span>{summary.net >= 0 ? '本月有结余' : '支出高于收入'}</span></article></section>
      <section className="analysis-grid"><article className="panel trend-panel"><PanelHeading index="A" title="日收支轨迹" meta={`${data.trend.length} 个记账日`} />{data.trend.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data.trend} margin={{ top: 10, right: 4, left: -20, bottom: 0 }}><CartesianGrid stroke="#d5dde0" strokeDasharray="2 5" vertical={false} /><XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={(value: string) => value.slice(-2)} /><YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10 }} tickFormatter={(value: number) => compactMoney.format(value)} /><Tooltip formatter={(value) => money.format(Number(value))} /><Area type="monotone" dataKey="expense" name="支出" stroke="#c75d50" fill="#c75d5022" /><Area type="monotone" dataKey="income" name="收入" stroke="#526d7b" fill="transparent" /></AreaChart></ResponsiveContainer></div> : <EmptyState text="这个月还没有收支轨迹" />}</article><DistributionPanel index="B" title="支出分类" items={data.categories} /><DistributionPanel index="C" title="支付渠道" items={data.channels} /></section>
      <section className="ledger-section"><div className="ledger-heading"><PanelHeading index="D" title="流水标注" meta={`${transactions.length} 条`} /><button className="text-button" onClick={() => props.setShowAll(!props.showAll)}>{props.showAll ? '收起筛选' : '查看并筛选全部'} ↗</button></div>{props.showAll && <div className="filters"><label><span>搜索</span><input value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="商户、商品或备注" /></label><label><span>分类</span><select value={props.category} onChange={(event) => props.setCategory(event.target.value)}><option value="">全部分类</option>{data.categories.map((item) => <option key={item.name}>{item.name}</option>)}</select></label><label><span>渠道</span><select value={props.channel} onChange={(event) => props.setChannel(event.target.value)}><option value="">全部渠道</option>{data.channels.map((item) => <option key={item.name}>{item.name}</option>)}</select></label></div>}<TransactionTable items={transactions} onAnnotate={props.onAnnotate} /></section>
    </> : <EmptyState text="账本暂时没有这个月的数据，请先导入账单" />}
  </>
}

function TransactionTable({ items, onAnnotate }: { items: Transaction[]; onAnnotate: (id: number) => void }) {
  if (!items.length) return <EmptyState text="没有符合条件的流水" />
  return <div className="table-wrap"><table><thead><tr><th>日期</th><th>交易摘要</th><th>分类</th><th>支付渠道</th><th>金额</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id} onDoubleClick={() => onAnnotate(item.id)}><td>{item.date.slice(0, 16)}</td><td><strong>{item.merchant}</strong>{item.itemDescription && <small>{item.itemDescription}</small>}</td><td><span className="tag">{item.category}<i className={item.categorySource}>{item.categorySource === 'manual' ? '人工' : item.categorySource === 'rule' ? '规则' : '未确认'}</i></span></td><td>{item.channel}</td><td className={item.direction === 'expense' ? 'amount expense' : 'amount income'}>{item.direction === 'expense' ? '−' : '+'}{money.format(Math.abs(item.amount))}</td><td><button className="row-action" onClick={() => onAnnotate(item.id)}>标注</button></td></tr>)}</tbody></table></div>
}

function AnnotationDialog({ transaction, catalog, hasPrevious, hasNext, onPrevious, onNext, onClose, onSaved, report }: {
  transaction: Transaction; catalog: LabelDimension[]; hasPrevious: boolean; hasNext: boolean; onPrevious: () => void; onNext: () => void; onClose: () => void; onSaved: () => Promise<void>; report: (reason: unknown) => void
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
  async function save(next: boolean) { setSaving(true); try { await saveAnnotation(transaction.id, selected); await onSaved(); if (next && hasNext) onNext(); else if (!next) onClose() } catch (reason) { report(reason) } finally { setSaving(false) } }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="annotation-dialog" role="dialog" aria-modal="true" aria-labelledby="annotation-title"><header><div><p className="eyebrow">人工确认 / {transaction.sourcePlatform}</p><h2 id="annotation-title">{transaction.merchant}</h2><p>{transaction.date.slice(0, 16)} · {money.format(transaction.amount)} · {transaction.direction === 'expense' ? '支出' : '收入'}</p></div><button className="close-button" onClick={onClose} aria-label="关闭">×</button></header><div className="fact-strip"><span>商品<b>{transaction.itemDescription || '—'}</b></span><span>支付原值<b>{transaction.paymentMethod || '—'}</b></span><span>平台分类<b>{transaction.sourceCategory || transaction.transactionType || '—'}</b></span></div>{!annotation ? <DashboardSkeleton /> : <div className="annotation-fields">{visibleDimensions.map((dimension) => <fieldset key={dimension.id}><legend>{dimension.name}<small>{dimension.selectionMode === 'multiple' ? '可多选' : '单选'}</small></legend>{dimension.selectionMode === 'single' ? <select value={dimension.labels.find((label) => selected.includes(label.id))?.id ?? ''} onChange={(event) => choose(dimension, Number(event.target.value))}><option value="">未选择</option>{treeOptions(dimension.labels).filter(({ label }) => label.enabled).map(({ label, depth }) => <option value={label.id} key={label.id}>{'— '.repeat(depth)}{label.name}</option>)}</select> : <div className="checkbox-grid">{treeOptions(dimension.labels).filter(({ label }) => label.enabled).map(({ label, depth }) => <label key={label.id} style={{ paddingLeft: depth * 14 }}><input type="checkbox" checked={selected.includes(label.id)} onChange={(event) => choose(dimension, label.id, event.target.checked)} />{label.name}</label>)}</div>}</fieldset>)}</div>}<div className="suggestion-note"><b>当前默认：</b>{annotation?.assignments.rule.map((item) => item.name).join('、') || '没有规则建议'}。保存后以人工结果为准，刷新规则也不会覆盖。</div><footer className="dialog-actions"><button className="button secondary" disabled={!hasPrevious || saving} onClick={onPrevious}>上一条</button><button className="button ghost" disabled={!hasNext || saving} onClick={onNext}>跳过</button><button className="button secondary" disabled={saving} onClick={() => void save(false)}>保存</button><button className="button primary" disabled={saving} onClick={() => void save(true)}>{saving ? '保存中…' : '保存并下一条'}</button></footer></section></div>
}

function treeOptions(labels: LabelNode[]) {
  const result: { label: LabelNode; depth: number }[] = []
  const visit = (parentId: number | null, depth: number) => labels.filter((label) => label.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).forEach((label) => { result.push({ label, depth }); visit(label.id, depth + 1) })
  visit(null, 0); return result
}

function LabelManager({ catalog, reload, report, announce }: { catalog: LabelDimension[]; reload: () => Promise<void>; report: (reason: unknown) => void; announce: (value: string) => void }) {
  const [dimensionId, setDimensionId] = useState('')
  const [labelId, setLabelId] = useState<number | null>(null)
  const [newDimension, setNewDimension] = useState({ key: '', name: '', notes: '', selection_mode: 'single' })
  const dimension = catalog.find((item) => item.id === dimensionId) ?? catalog[0]
  const selected = dimension?.labels.find((label) => label.id === labelId) ?? null
  useEffect(() => { if (!dimensionId && catalog[0]) setDimensionId(catalog[0].id) }, [catalog, dimensionId])
  async function run(action: () => Promise<unknown>, message: string) { try { await action(); await reload(); announce(message) } catch (reason) { report(reason) } }
  async function addLabel(parentId: number | null) { const name = window.prompt(parentId ? '新标签名称' : '新根标签名称'); if (!name || !dimension) return; await run(() => createLabel({ dimension_id: dimension.id, parent_id: parentId, name, sort_order: dimension.labels.length }), '标签已创建') }
  return <section className="workspace-page"><div className="workspace-heading"><p className="eyebrow">LABEL ARCHITECTURE</p><h1>把分类体系搭成一棵可维护的树</h1><p>每个层级都能增删、备注、排序和停用。被流水引用的标签删除时只会停用。</p></div><div className="label-workbench"><aside className="dimension-pane"><h2>维度</h2>{catalog.map((item) => <button key={item.id} className={item.id === dimension?.id ? 'active' : ''} onClick={() => { setDimensionId(item.id); setLabelId(null) }}><span>{item.name}</span><small>{item.labels.length} 个标签</small></button>)}<form onSubmit={(event) => { event.preventDefault(); void run(() => createDimension(newDimension), '维度已创建'); setNewDimension({ key: '', name: '', notes: '', selection_mode: 'single' }) }}><h3>新增维度</h3><input required placeholder="机器标识，如 project" value={newDimension.key} onChange={(e) => setNewDimension({ ...newDimension, key: e.target.value })} /><input required placeholder="显示名称" value={newDimension.name} onChange={(e) => setNewDimension({ ...newDimension, name: e.target.value })} /><select value={newDimension.selection_mode} onChange={(e) => setNewDimension({ ...newDimension, selection_mode: e.target.value })}><option value="single">单选</option><option value="multiple">多选</option></select><button className="button secondary">创建维度</button></form></aside><section className="tree-pane"><div className="pane-heading"><div><h2>{dimension?.name ?? '标签树'}</h2><p>{dimension?.notes || '从根标签开始建立层级'}</p></div><button className="button secondary" onClick={() => void addLabel(null)}>＋ 根标签</button></div>{dimension && treeOptions(dimension.labels).map(({ label, depth }) => <button key={label.id} className={`tree-row ${label.id === selected?.id ? 'active' : ''} ${label.enabled ? '' : 'disabled'}`} style={{ paddingLeft: 18 + depth * 24 }} onClick={() => setLabelId(label.id)}><span>{depth ? '↳' : '◆'} {label.name}</span><small>{label.usageCount} 次引用</small></button>)}</section><section className="editor-pane">{selected && dimension ? <LabelEditor label={selected} dimension={dimension} run={run} addLabel={addLabel} onDeleted={() => setLabelId(null)} /> : dimension ? <><p className="eyebrow">DIMENSION</p><h2>{dimension.name}</h2><label>说明<textarea defaultValue={dimension.notes ?? ''} onBlur={(event) => void run(() => updateDimension(dimension.id, { notes: event.target.value }), '维度说明已保存')} /></label><label className="toggle"><input type="checkbox" checked={dimension.enabled} onChange={(event) => void run(() => updateDimension(dimension.id, { enabled: event.target.checked }), '维度状态已更新')} />启用此维度</label><button className="danger-link" onClick={() => { if (window.confirm('删除此维度？存在流水引用时将改为停用。')) void run(() => deleteDimension(dimension.id), '维度已安全处理') }}>删除维度</button></> : <EmptyState text="先创建一个标签维度" />}</section></div></section>
}

function LabelEditor({ label, dimension, run, addLabel, onDeleted }: { label: LabelNode; dimension: LabelDimension; run: (action: () => Promise<unknown>, message: string) => Promise<void>; addLabel: (parentId: number | null) => Promise<void>; onDeleted: () => void }) {
  const [draft, setDraft] = useState(label)
  useEffect(() => setDraft(label), [label])
  return <><p className="eyebrow">LABEL / {label.id}</p><h2>{label.name}</h2><label>名称<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>备注<textarea value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label><label>父标签<select value={draft.parentId ?? ''} onChange={(e) => setDraft({ ...draft, parentId: e.target.value ? Number(e.target.value) : null })}><option value="">根级</option>{treeOptions(dimension.labels).filter(({ label: item }) => item.id !== label.id).map(({ label: item, depth }) => <option key={item.id} value={item.id}>{'— '.repeat(depth)}{item.name}</option>)}</select></label><label>排序<input type="number" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })} /></label><label className="toggle"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />启用标签</label><div className="editor-actions"><button className="button primary" onClick={() => void run(() => updateLabel(label.id, { name: draft.name, notes: draft.notes, parent_id: draft.parentId, sort_order: draft.sortOrder, enabled: draft.enabled }), '标签已保存')}>保存修改</button><button className="button secondary" onClick={() => void addLabel(label.id)}>新增子级</button><button className="button secondary" onClick={() => void addLabel(label.parentId)}>新增同级</button></div><button className="danger-link" onClick={() => { if (window.confirm('删除此标签？有子级或流水引用时将改为停用。')) void run(() => deleteLabel(label.id), '标签已安全处理').then(onDeleted) }}>删除标签</button></>
}

function RulesManager({ catalog, rules, reload, report, announce }: { catalog: LabelDimension[]; rules: MerchantRule[]; reload: () => Promise<void>; report: (reason: unknown) => void; announce: (value: string) => void }) {
  const [draft, setDraft] = useState({ name: '', source_platform: '', counterparty_exact: '', label_ids: [] as number[], notes: '' })
  async function run(action: () => Promise<unknown>, message: string) { try { await action(); await reload(); announce(message) } catch (reason) { report(reason) } }
  const toggle = (id: number) => setDraft((value) => ({ ...value, label_ids: value.label_ids.includes(id) ? value.label_ids.filter((item) => item !== id) : [...value.label_ids, id] }))
  return <section className="workspace-page"><div className="workspace-heading"><p className="eyebrow">EXACT MATCH RULES</p><h1>让重复出现的商户自动填好建议</h1><p>只匹配交易对方完整名称；不扫描关键词，不读取商品说明。人工确认永远优先。</p></div><div className="rules-grid"><form className="rule-form" onSubmit={(event) => { event.preventDefault(); void run(() => createRule(draft), '预填规则已创建'); setDraft({ name: '', source_platform: '', counterparty_exact: '', label_ids: [], notes: '' }) }}><h2>新建精确规则</h2><label>规则名称<input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>平台<select value={draft.source_platform} onChange={(e) => setDraft({ ...draft, source_platform: e.target.value })}><option value="">不限平台</option><option>微信</option><option>支付宝</option></select></label><label>交易对方完整名称<input required value={draft.counterparty_exact} onChange={(e) => setDraft({ ...draft, counterparty_exact: e.target.value })} placeholder="必须与账单原值完全一致" /></label><label>备注<textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label><div className="rule-labels">{catalog.filter((d) => d.enabled).map((dimension) => <fieldset key={dimension.id}><legend>{dimension.name}</legend>{dimension.labels.filter((label) => label.enabled).map((label) => <label key={label.id}><input type="checkbox" checked={draft.label_ids.includes(label.id)} onChange={() => toggle(label.id)} />{label.name}</label>)}</fieldset>)}</div><button className="button primary">创建规则</button></form><section className="rule-list"><h2>现有规则 <small>{rules.length}</small></h2>{rules.length ? rules.map((rule) => <article key={rule.id}><div><span className={rule.enabled ? 'rule-state' : 'rule-state off'}>{rule.enabled ? '启用' : '停用'}</span><h3>{rule.name}</h3><p>{rule.sourcePlatform || '全平台'} · “{rule.counterpartyExact}”</p><small>{rule.labelIds.map((id) => catalog.flatMap((d) => d.labels).find((label) => label.id === id)?.name).filter(Boolean).join('、') || '未配置标签'}</small></div><div><button className="text-button" onClick={() => void run(() => updateRule(rule.id, { enabled: !rule.enabled }), '规则状态已更新')}>{rule.enabled ? '停用' : '启用'}</button><button className="danger-link" onClick={() => { if (window.confirm('删除这条规则？')) void run(() => deleteRule(rule.id), '规则已删除') }}>删除</button></div></article>) : <EmptyState text="还没有商户精确规则" />}</section></div></section>
}

function PanelHeading({ index, title, meta }: { index: string; title: string; meta: string }) { return <div className="panel-heading"><div><span>{index}</span><h2>{title}</h2></div><small>{meta}</small></div> }
function DistributionPanel({ index, title, items }: { index: string; title: string; items: DistributionItem[] }) { const total = items.reduce((sum, item) => sum + item.value, 0); return <article className="panel distribution-panel"><PanelHeading index={index} title={title} meta={`${items.length} 项`} />{items.length ? <div className="distribution-body"><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={items} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="92%" stroke="none">{items.map((item, i) => <Cell key={item.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}</Pie><Tooltip formatter={(value) => money.format(Number(value))} /></PieChart></ResponsiveContainer><div><strong>{money.format(total)}</strong><span>总计</span></div></div><ol className="rank-list">{items.slice(0, 5).map((item, i) => <li key={item.name}><i style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} /><span>{item.name}</span><b>{total ? Math.round(item.value / total * 100) : 0}%</b><small>{money.format(item.value)}</small></li>)}</ol></div> : <EmptyState text={`暂无${title}数据`} />}</article> }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>⌁</span><p>{text}</p></div> }
function DashboardSkeleton() { return <div className="skeleton" aria-label="正在读取"><div /><div /><div /><span>正在读取账本…</span></div> }

export default App
