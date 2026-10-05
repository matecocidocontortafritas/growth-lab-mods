import { expect, mock, test } from 'claude-code/testing'

// 2026-10-05 17:00 en Argentina (20:00 UTC)
const NOW = Date.parse('2026-10-05T20:00:00Z')
const TOOL = 'mcp__tiendanube__list_orders'

const order = (n: number, at: string, total: string, pago: string, status = 'open') => ({
  id: String(n),
  number: String(n),
  status,
  payment_status: pago,
  completed_at: at,
  total: { amount: total, currency: 'ARS' },
  customer: { name: `Cliente ${n}` },
})

const ORDERS = [
  order(103, '2026-10-05T19:36:47Z', '117985.46', 'paid'),
  order(102, '2026-10-05T14:00:00Z', '50000', 'pending'),
  order(101, '2026-10-05T12:00:00Z', '30000', 'paid', 'cancelled'),
  // 02:00 UTC del 5 = 23:00 del 4 en Argentina: no es de hoy
  order(100, '2026-10-05T02:00:00Z', '99999', 'paid'),
]

const PANE = {
  plugin: 'pedidos',
  component: 'Pane',
  requestId: 'pedidos',
  props: { title: 'Pedidos de hoy', isFocused: false, bodyColumns: 70, placement: 'dock' } as never,
} as const

const TOOLS = [
  { name: 'Bash', description: 'Runs a command', mcp: false },
  { name: 'mcp__shopify__list_orders', description: 'Shopify orders', mcp: true },
  { name: TOOL, description: 'Tool to retrieve a list of orders for the Tiendanube store', mcp: true },
]

test('encuentra solo el conector de Tiendanube y suma lo cobrado de hoy', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  const calls: Record<string, unknown>[] = []
  on('tool.call', async ($, e) => {
    calls.push({ ...e } as Record<string, unknown>)
    return { result: {}, text: JSON.stringify({ orders: ORDERS, total: ORDERS.length }) }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    const all = (await ui.find({ type: 'Box' }))?.text ?? ''
    expect(all).toContain('$117.985')
    expect(all).toContain('2 pedidos')
    expect(all).toContain('pendiente $50.000')
    expect(all).toContain('1 cancelados')
    expect(all).not.toContain('#100')
    expect(all).toContain('16:36 #103')
    await ui.unmount()
  }

  expect(calls[0]).toEqual(
    expect.objectContaining({ tool: TOOL, completed_at_from: '2026-10-05T00:00:00-03:00', page: 1 }),
  )
})

test('sin conector de Tiendanube, explica cómo conectarlo', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS.slice(0, 1) }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Box' }))?.text ?? '').toContain('admin-mcp.tiendanube.com')
})

test('si Claude Code no deja llamar, muestra el permiso exacto a agregar', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  on('tool.call', async () => ({ deny: 'auto mode' }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  const all = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(all).toContain(`"${TOOL}"`)
})

test('la herramienta cargada en /config gana sobre la detectada', { options: { tiendanube_tool: 'mcp__otra__list_orders' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => ({ value: TOOLS }))
  const calls: Record<string, unknown>[] = []
  on('tool.call', async ($, e) => {
    calls.push({ ...e } as Record<string, unknown>)
    return { result: {}, text: JSON.stringify({ orders: [], total: 0 }) }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(calls[0]?.tool).toBe('mcp__otra__list_orders')
})
