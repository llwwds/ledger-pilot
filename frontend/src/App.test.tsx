import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => Promise.resolve({
    ok: true,
    json: async () => input.includes('label-catalog') || input.endsWith('/api/rules') ? [] : ({
      summary: { income: 12000, expense: 3600, net: 8400 }, trend: [], categories: [], channels: [], recent: [],
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
    expect(await screen.findByText('¥12,000.00')).toBeInTheDocument()
    expect(screen.getByText('流水标注')).toBeInTheDocument()
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
