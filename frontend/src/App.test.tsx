import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { NORMALIZED_FILTER_FIELDS } from './transactionFilters'

beforeEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
    ok: true,
    json: async () => input.includes('label-catalog') || input.endsWith('/api/rules') ? [] : input.includes('/api/heatmaps') ? ({ year: 2026, expense: [{ date: '2026-01-01', value: 180.32, count: 8 }], income: [{ date: '2026-01-01', value: 2079.96, count: 21 }] }) : ({
      summary: { income: 12000, expense: 3600, net: 8400 }, trend: [], categories: [], channels: [], distributions: [
        { dimensionId: 'payment', key: 'payment_channel', name: '支付渠道', items: [{ name: '银行卡', value: 12000 }] },
        { dimensionId: 'business', key: 'business_type', name: '业务类型', items: [{ name: '转账', value: 12000 }] },
        { dimensionId: 'income', key: 'income_category', name: '收入分类', items: [{ name: '工资', value: 12000 }] },
        { dimensionId: 'expense', key: 'expense_category', name: '支出分类', items: [{ name: '餐饮', value: 3600 }] },
        { dimensionId: 'special', key: 'special_tag', name: '特殊标签', items: [] },
      ], recent: [],
    }),
  })))
})
afterEach(() => { cleanup(); window.localStorage.clear(); delete document.documentElement.dataset.theme })

describe('App', () => {
  it('高级筛选字段注册表完整覆盖清洗后总表 16 个字段', () => {
    expect(NORMALIZED_FILTER_FIELDS.map((item) => item.key)).toEqual([
      'source_platform', 'transaction_time', 'direction', 'amount', 'counterparty', 'item_description',
      'payment_method', 'payment_channel', 'transaction_status', 'status_category', 'transaction_id',
      'merchant_order_id', 'transaction_type', 'source_category', 'counterparty_account', 'note',
    ])
  })
  it('展示核心审阅入口和月度数据', async () => {
    render(<App />)
    expect(screen.getByRole('button', { name: '导入账单' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '手动记账' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'AI 自动标注' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '标签管理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '预填规则' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '流水标注' })).toBeInTheDocument()
    expect((await screen.findAllByText('¥12,000.00')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: '先搜出一类，再一次标完' })).not.toBeInTheDocument()
    expect(screen.getByText('日收支轨迹')).toBeInTheDocument()
    for (const title of ['支付渠道', '业务类型', '收入分类', '支出分类', '特殊标签']) expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.getByText('花钱的热力图')).toBeInTheDocument()
    expect(screen.getByText('赚钱的热力图')).toBeInTheDocument()
    expect(screen.getByLabelText('2026-01-01，¥180.32，8 笔')).toHaveClass('level-4')
    expect(screen.getByLabelText('2026-01-01，¥2,079.96，21 笔')).toHaveClass('level-4')
  })

  it('按年度、月度和自定义范围读取总看板，曲线粒度保持正交', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input); requests.push(url)
      if (url.includes('/api/label-catalog') || url.endsWith('/api/rules')) return response([])
      if (url.includes('/api/heatmaps')) return response({ year: 2026, expense: [], income: [] })
      return response({ summary: { income: 0, expense: 0, net: 0 }, trend: [], categories: [], channels: [], distributions: [], recent: [] })
    }))

    render(<App />)
    await waitFor(() => expect(requests.some((url) => url.includes('/api/dashboard?') && url.includes('month=') && url.includes('trend_granularity=day'))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: '年度' }))
    await waitFor(() => expect(requests.some((url) => url.includes('year=2026') && url.includes('trend_granularity=day'))).toBe(true))
    fireEvent.click(within(screen.getByRole('group', { name: '曲线颗粒度' })).getByRole('button', { name: '月' }))
    await waitFor(() => expect(requests.some((url) => url.includes('year=2026') && url.includes('trend_granularity=month'))).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: '自定义' }))
    const rangeGroup = screen.getByRole('group', { name: '范围选择颗粒度' })
    fireEvent.click(within(rangeGroup).getByRole('button', { name: '周' }))
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-02-04' } })
    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-02-02')
    fireEvent.click(screen.getByRole('button', { name: '选择 2026-03-04' }))
    fireEvent.click(screen.getByRole('button', { name: '选择 2026-03-10' }))

    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-03-02')
    expect(screen.getByLabelText('结束日期')).toHaveValue('2026-03-15')
    await waitFor(() => expect(requests.some((url) => url.includes('start_date=2026-03-02') && url.includes('end_date=2026-03-15') && url.includes('trend_granularity=month'))).toBe(true))
  })

  it('打开手动记账弹窗并展示防重复流水号', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '手动记账' }))
    expect(await screen.findByRole('dialog', { name: '手动记一笔' })).toBeInTheDocument()
    expect(screen.getByLabelText('流水号（可选，用于防重复）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '记录流水' })).toBeInTheDocument()
  })

  it('切换皮肤并把选择保存在本机', async () => {
    render(<App />)
    const ledger = screen.getByRole('button', { name: '雾蓝账页' })
    const glass = screen.getByRole('button', { name: '流光雾镜' })
    expect(ledger).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement).toHaveAttribute('data-theme', 'ledger')
    fireEvent.click(glass)
    expect(glass).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement).toHaveAttribute('data-theme', 'glass')
    expect(window.localStorage.getItem('ledger-pilot-theme')).toBe('glass')
  })

  it('启动时恢复上次选择的流光雾镜', () => {
    window.localStorage.setItem('ledger-pilot-theme', 'glass')
    render(<App />)
    expect(screen.getByRole('button', { name: '流光雾镜' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement).toHaveAttribute('data-theme', 'glass')
  })

  it('选择压缩包时要求输入只用于本次解密的密码', async () => {
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['zip'], 'statement.zip', { type: 'application/zip' })] } })
    expect(await screen.findByRole('dialog', { name: '输入账单解压密码' })).toBeInTheDocument()
    expect(screen.getByText(/密码只用于本次本地解密，不会保存/)).toBeInTheDocument()
    expect(screen.getByLabelText('解压密码（多份可换行）')).toBeInTheDocument()
  })

  it('在应用内弹窗新增根标签，不依赖浏览器 prompt', async () => {
    let catalog = [labelDimension()]
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes('/api/label-catalog')) return response(catalog)
      if (url.endsWith('/api/labels') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const created = { id: 2, dimensionId: 'expense', parentId: body.parent_id, name: body.name, notes: body.notes, sortOrder: body.sort_order, enabled: true, usageCount: 0 }
        catalog = [{ ...catalog[0], labels: [...catalog[0].labels, created] }]
        return response(created)
      }
      if (url.endsWith('/api/rules')) return response([])
      if (url.includes('/api/heatmaps')) return response({ year: 2026, expense: [], income: [] })
      return response({ summary: { income: 0, expense: 0, net: 0 }, trend: [], categories: [], channels: [], distributions: [], recent: [] })
    }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '标签管理' }))
    fireEvent.click(await screen.findByRole('button', { name: '＋ 根标签' }))
    expect(screen.getByRole('dialog', { name: '新增根标签' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('标签名称'), { target: { value: '学习成长' } })
    fireEvent.change(screen.getByLabelText('备注（可选）'), { target: { value: '长期能力投入' } })
    fireEvent.click(screen.getByRole('button', { name: '创建标签' }))

    expect(await screen.findByText('标签已创建')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '新增根标签' })).not.toBeInTheDocument()
    const createRequest = requests.find((item) => item.url.endsWith('/api/labels') && item.init?.method === 'POST')
    expect(JSON.parse(String(createRequest?.init?.body))).toEqual({
      dimension_id: 'expense', parent_id: null, name: '学习成长', notes: '长期能力投入', sort_order: 1,
    })
  })

  it('在独立标注页搜索、多选并统一移出已标注流水', async () => {
    let pending = [
      transaction(11, '星巴克咖啡', '午间咖啡'),
      transaction(12, '瑞幸咖啡', '早餐咖啡'),
      transaction(13, '滴滴出行', '通勤'),
    ]
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes('/api/label-catalog') || url.endsWith('/api/rules')) return response([])
      if (url.includes('/api/heatmaps')) return response({ year: 2026, expense: [], income: [] })
      if (url.includes('/api/annotations/batch')) {
        const body = JSON.parse(String(init?.body)) as { transaction_ids: number[] }
        pending = pending.filter((item) => !body.transaction_ids.includes(item.id))
        return response({ updated: body.transaction_ids.length })
      }
      if (url.includes('/api/transactions/search')) {
        const body = JSON.parse(String(init?.body)) as { query?: { text: string } }
        const search = body.query?.text.toLocaleLowerCase() ?? ''
        const items = pending.filter((item) => `${item.merchant} ${item.itemDescription}`.toLocaleLowerCase().includes(search))
        return response({ items, total: items.length, page: 1, pageSize: 500 })
      }
      return response({
        summary: { income: 0, expense: 90, net: -90 }, trend: [], categories: [], channels: [], distributions: [], recent: [],
      })
    }))

    render(<App />)
    expect(screen.queryByLabelText('待标注流水')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '流水标注' }))
    expect(await screen.findByRole('heading', { name: '先筛出一类，再一次标完' })).toBeInTheDocument()
    expect(await screen.findByText('滴滴出行')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('搜索待标注流水'), { target: { value: '咖啡' } })
    expect(await screen.findByText('星巴克咖啡')).toBeInTheDocument()
    expect(screen.queryByText('滴滴出行')).not.toBeInTheDocument()
    expect(screen.getByText('瑞幸咖啡')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('全选当前搜索结果'))
    fireEvent.click(screen.getByRole('button', { name: '统一标注 2 笔' }))
    expect(await screen.findByRole('dialog', { name: '统一标注 2 笔流水' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认无标注并移出 2 笔' }))

    expect(await screen.findByText('已统一标注 2 笔流水，并移出待标注队列。')).toBeInTheDocument()
    expect(screen.queryByText('星巴克咖啡')).not.toBeInTheDocument()
    expect(screen.queryByText('瑞幸咖啡')).not.toBeInTheDocument()
    const batchRequest = requests.find((item) => item.url.includes('/api/annotations/batch'))
    expect(JSON.parse(String(batchRequest?.init?.body))).toEqual({ transaction_ids: [11, 12], label_ids: [] })
  })

  it('组合模糊搜索、包含排除、日期和金额范围发送结构化请求', async () => {
    const searchBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/label-catalog') || url.endsWith('/api/rules')) return response([])
      if (url.includes('/api/heatmaps')) return response({ year: 2026, expense: [], income: [] })
      if (url.includes('/api/transactions/search')) {
        searchBodies.push(JSON.parse(String(init?.body)))
        return response({ items: [], total: 0, page: 1, pageSize: 500 })
      }
      return response({ summary: { income: 0, expense: 0, net: 0 }, trend: [], categories: [], channels: [], distributions: [], recent: [] })
    }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '流水标注' }))
    fireEvent.change(screen.getByLabelText('搜索待标注流水'), { target: { value: '咖啡' } })
    fireEvent.change(screen.getByLabelText('模糊搜索模式'), { target: { value: 'exclude' } })
    fireEvent.click(screen.getByRole('button', { name: '高级筛选' }))
    const dialog = screen.getByRole('dialog', { name: '高级筛选' })

    fireEvent.click(within(dialog).getByRole('button', { name: '添加字段条件' }))
    fireEvent.change(within(dialog).getByLabelText('交易对方筛选值'), { target: { value: '星巴克' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '添加字段条件' }))
    fireEvent.change(within(dialog).getAllByLabelText('字段')[1], { target: { value: 'amount' } })
    fireEvent.change(within(dialog).getAllByLabelText('方向')[1], { target: { value: 'exclude' } })
    fireEvent.change(within(dialog).getByLabelText('绝对金额下限'), { target: { value: '10.00' } })
    fireEvent.change(within(dialog).getByLabelText('绝对金额上限'), { target: { value: '100.00' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '添加字段条件' }))
    fireEvent.change(within(dialog).getAllByLabelText('字段')[2], { target: { value: 'transaction_time' } })
    fireEvent.change(within(dialog).getByLabelText('交易时间下限'), { target: { value: '2026-07-15' } })
    fireEvent.change(within(dialog).getByLabelText('交易时间上限'), { target: { value: '2026-08-20' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '应用 3 条筛选' }))

    await waitFor(() => expect(searchBodies.some((body) => Array.isArray(body.filters) && body.filters.length === 3)).toBe(true))
    const body = [...searchBodies].reverse().find((item) => Array.isArray(item.filters) && item.filters.length === 3)
    expect(body).toMatchObject({
      query: { text: '咖啡', mode: 'exclude' }, annotation_status: 'pending', page: 1, page_size: 500,
      filters: [
        { field: 'counterparty', mode: 'include', operator: 'contains', value: '星巴克' },
        { field: 'amount', mode: 'exclude', operator: 'range', min: '10.00', max: '100.00' },
        { field: 'transaction_time', mode: 'include', operator: 'range', min: '2026-07-15', max: '2026-08-20' },
      ],
    })
    expect(body).not.toHaveProperty('month')
    expect(screen.getByText('日期条件已接管月份快捷范围')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复月份快捷范围' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复月份快捷范围' }))
    await waitFor(() => expect(searchBodies.some((item) => item.month === '2026-08' && Array.isArray(item.filters) && item.filters.length === 2)).toBe(true))
  })

  it('筛选变化立即清空选择并拒绝 debounce 窗口内的旧响应', async () => {
    let searchCall = 0
    let resolveStale: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input)
      if (url.includes('/api/label-catalog') || url.endsWith('/api/rules')) return response([])
      if (url.includes('/api/heatmaps')) return response({ year: 2026, expense: [], income: [] })
      if (url.includes('/api/transactions/search')) {
        searchCall += 1
        if (searchCall === 1) return response({ items: [transaction(31, '初始流水', '等待筛选')], total: 1, page: 1, pageSize: 500 })
        if (searchCall === 2) return new Promise((resolve) => { resolveStale = resolve })
        return response({ items: [], total: 0, page: 1, pageSize: 500 })
      }
      return response({ summary: { income: 0, expense: 0, net: 0 }, trend: [], categories: [], channels: [], distributions: [], recent: [] })
    }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '流水标注' }))
    expect(await screen.findByText('初始流水')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('选择 初始流水 2026-08-25'))
    expect(screen.getByRole('button', { name: '统一标注 1 笔' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('搜索待标注流水'), { target: { value: '第一条件' } })
    expect(screen.queryByRole('button', { name: '统一标注 1 笔' })).not.toBeInTheDocument()
    await waitFor(() => expect(searchCall).toBe(2))

    fireEvent.change(screen.getByLabelText('搜索待标注流水'), { target: { value: '第二条件' } })
    resolveStale?.(await response({ items: [transaction(32, '旧请求结果', '不应落地')], total: 1, page: 1, pageSize: 500 }))
    await Promise.resolve()
    expect(screen.queryByText('旧请求结果')).not.toBeInTheDocument()
  })

  it('重复应用同值月份和空筛选仍会完成刷新', async () => {
    let searches = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      const url = String(input)
      if (url.includes('/api/label-catalog') || url.endsWith('/api/rules')) return response([])
      if (url.includes('/api/heatmaps')) return response({ year: 2026, expense: [], income: [] })
      if (url.includes('/api/transactions/search')) {
        searches += 1
        return response({ items: [transaction(41, '稳定流水', '同值刷新')], total: 1, page: 1, pageSize: 500 })
      }
      return response({ summary: { income: 0, expense: 0, net: 0 }, trend: [], categories: [], channels: [], distributions: [], recent: [] })
    }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '流水标注' }))
    expect(await screen.findByText('稳定流水')).toBeInTheDocument()
    fireEvent.click(document.querySelector('.month-tick.active') as HTMLElement)
    await waitFor(() => expect(searches).toBe(2))
    expect(await screen.findByText('稳定流水')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '高级筛选' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '高级筛选' })).getByRole('button', { name: '应用 0 条筛选' }))
    await waitFor(() => expect(searches).toBe(3))
    expect(await screen.findByText('稳定流水')).toBeInTheDocument()
    expect(screen.queryByLabelText('正在读取')).not.toBeInTheDocument()
  })

  it('预填规则在整面标签面板选择，创建后待应用并可手动应用一次', async () => {
    const dimension = labelDimension()
    let savedRules: Array<Record<string, unknown>> = []
    const applyCalls: string[] = []
    const ruleBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = String(input)
      const method = String(init?.method ?? 'GET')
      if (url.includes('/api/label-catalog')) return response([dimension])
      if (url.endsWith('/api/rules') && method === 'GET') return response(savedRules)
      if (url.endsWith('/api/rules') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { name: string; label_ids: number[]; amount_min?: string; amount_max?: string; amount_scope?: string }
        ruleBodies.push(JSON.parse(String(init?.body)))
        const created = {
          id: 7, name: body.name, counterpartyExact: '米村拌饭', labelIds: body.label_ids, enabled: true, appliedAt: null,
          amountMin: body.amount_min ? Number(body.amount_min) : null, amountMax: body.amount_max ? Number(body.amount_max) : null,
          amountScope: body.amount_scope ?? 'inside',
        }
        savedRules = [created]
        return response(created)
      }
      if (url.endsWith('/api/rules/7/apply')) {
        applyCalls.push(url)
        savedRules = [{ ...savedRules[0], appliedAt: '2026-08-27T10:00:00' }]
        return response({ rule: savedRules[0], matched: 3 })
      }
      if (url.includes('/api/heatmaps')) return response({ year: 2026, expense: [], income: [] })
      return response({ summary: { income: 0, expense: 0, net: 0 }, trend: [], categories: [], channels: [], distributions: [], recent: [] })
    }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '预填规则' }))
    expect(await screen.findByRole('heading', { name: '新建精确规则' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /预填标签/ }))
    const picker = screen.getByRole('dialog', { name: '选择规则要预填的标签' })
    fireEvent.click(within(picker).getByRole('checkbox', { name: '餐饮' }))
    expect(within(picker).getByRole('checkbox', { name: '餐饮' })).toBeChecked()
    fireEvent.click(within(picker).getByRole('button', { name: '完成（已选 1 个标签）' }))

    fireEvent.change(screen.getByLabelText('金额下限'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('金额上限'), { target: { value: '50' } })
    fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '米村拌饭' } })
    fireEvent.change(screen.getByLabelText('交易对方完整名称'), { target: { value: '米村拌饭' } })
    fireEvent.click(screen.getByRole('button', { name: '创建规则' }))

    expect(await screen.findByText('待应用')).toBeInTheDocument()
    expect(ruleBodies[0]).toMatchObject({ name: '米村拌饭', label_ids: [1], amount_min: '20', amount_max: '50', amount_scope: 'inside' })
    expect(screen.getByText('金额限 20–50 元')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用到已有流水' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '应用到已有流水' }))

    expect(await screen.findByText('规则已应用到 3 笔已有流水，并保持生效。')).toBeInTheDocument()
    expect(screen.getByText('生效中')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '应用到已有流水' })).not.toBeInTheDocument()
    expect(applyCalls).toHaveLength(1)
  })

  it('金额范围包括或不包括方式都能随规则提交', async () => {
    const ruleBodies: Array<Record<string, unknown>> = []
    let savedRules: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      const url = String(input)
      const method = String(init?.method ?? 'GET')
      if (url.includes('/api/label-catalog')) return response([labelDimension()])
      if (url.endsWith('/api/rules') && method === 'GET') return response(savedRules)
      if (url.endsWith('/api/rules') && method === 'POST') {
        ruleBodies.push(JSON.parse(String(init?.body)))
        const body = JSON.parse(String(init?.body)) as { name: string; amount_min?: string; amount_max?: string; amount_scope?: string }
        savedRules = [{
          id: 9, name: body.name, counterpartyExact: '瑞幸', labelIds: [1], enabled: true, appliedAt: null,
          amountMin: body.amount_min ? Number(body.amount_min) : null, amountMax: body.amount_max ? Number(body.amount_max) : null,
          amountScope: body.amount_scope ?? 'inside',
        }]
        return response(savedRules[0])
      }
      if (url.includes('/api/heatmaps')) return response({ year: 2026, expense: [], income: [] })
      return response({ summary: { income: 0, expense: 0, net: 0 }, trend: [], categories: [], channels: [], distributions: [], recent: [] })
    }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '预填规则' }))
    await screen.findByRole('heading', { name: '新建精确规则' })

    fireEvent.change(screen.getByLabelText('金额下限'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('金额上限'), { target: { value: '15' } })
    fireEvent.change(screen.getByLabelText('金额范围方式'), { target: { value: 'outside' } })
    fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '小额排除' } })
    fireEvent.change(screen.getByLabelText('交易对方完整名称'), { target: { value: '瑞幸' } })
    fireEvent.click(screen.getByRole('button', { name: '创建规则' }))

    expect(await screen.findByText('待应用')).toBeInTheDocument()
    expect(ruleBodies[0]).toMatchObject({ amount_min: '5', amount_max: '15', amount_scope: 'outside' })
    expect(screen.getByText('金额不在 5–15 元内')).toBeInTheDocument()
  })
})

function response(payload: unknown) {
  return Promise.resolve({ ok: true, json: async () => payload })
}

function transaction(id: number, merchant: string, itemDescription: string) {
  return {
    id, date: '2026-08-25 12:00:00', merchant, itemDescription, amount: 30, direction: 'expense',
    category: '未分类', categorySource: 'unassigned', channel: '未识别', channelSource: 'unassigned',
    labelSource: 'unassigned', effectiveLabels: [], sourcePlatform: '微信', transactionId: `tx-${id}`,
    status: '成功',
  }
}

function labelDimension() {
  return {
    id: 'expense', key: 'expense_category', name: '支出分类', notes: '支出去向', selectionMode: 'single' as const,
    sortOrder: 0, enabled: true, labels: [
      { id: 1, dimensionId: 'expense', parentId: null, name: '餐饮', notes: '', sortOrder: 0, enabled: true, usageCount: 0 },
    ],
  }
}
