import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

beforeEach(() => {
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
afterEach(() => cleanup())

describe('App', () => {
  it('展示核心审阅入口和月度数据', async () => {
    render(<App />)
    expect(screen.getByRole('button', { name: '导入账单' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '手动记账' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'AI 自动标注' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '标签管理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '预填规则' })).toBeInTheDocument()
    expect((await screen.findAllByText('¥12,000.00')).length).toBeGreaterThan(0)
    expect(screen.getByText('流水标注')).toBeInTheDocument()
    expect(screen.getByText('日收支轨迹')).toBeInTheDocument()
    for (const title of ['支付渠道', '业务类型', '收入分类', '支出分类', '特殊标签']) expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.getByText('花钱的热力图')).toBeInTheDocument()
    expect(screen.getByText('赚钱的热力图')).toBeInTheDocument()
    expect(screen.getByLabelText('2026-01-01，¥180.32，8 笔')).toHaveClass('level-4')
    expect(screen.getByLabelText('2026-01-01，¥2,079.96，21 笔')).toHaveClass('level-4')
  })

  it('打开手动记账弹窗并展示防重复流水号', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '手动记账' }))
    expect(await screen.findByRole('dialog', { name: '手动记一笔' })).toBeInTheDocument()
    expect(screen.getByLabelText('流水号（可选，用于防重复）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '记录流水' })).toBeInTheDocument()
  })

  it('选择压缩包时要求输入只用于本次解密的密码', async () => {
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['zip'], 'statement.zip', { type: 'application/zip' })] } })
    expect(await screen.findByRole('dialog', { name: '输入账单解压密码' })).toBeInTheDocument()
    expect(screen.getByText(/密码只用于本次本地解密，不会保存/)).toBeInTheDocument()
    expect(screen.getByLabelText('解压密码（多份可换行）')).toBeInTheDocument()
  })
})
