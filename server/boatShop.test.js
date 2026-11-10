import test from 'node:test'
import assert from 'node:assert/strict'
import {
  lineEffTotal, orderKind, isShopOrder, clientDueToUs, payMode, lineShopNet, lineShopFee,
  orderShopNet, shopDue, boatPayGate, boatCodAmount,
} from './boatShop.js'

// Кораблик 10 000 грн з комісією 15 % — приклад із записки (магазину коштує 8 500).
const boat = (shopPct = 15) => ({ id: 'l1', kind: 'boat', label: 'Кораблик', price: 10000, qty: 1, shopPct })
const order = (over = {}) => ({ kind: 'dropship', dropshipperId: 'shop-1', ttnBy: 'us', lines: [boat()], total: 10000, ...over })

test('kind: explicit wins; legacy order with a dropshipper is dropship; otherwise retail', () => {
  assert.equal(orderKind({}), 'retail')
  assert.equal(orderKind({ dropshipperId: 'x' }), 'dropship')
  assert.equal(orderKind({ dropshipperId: 'x', kind: 'buyout' }), 'buyout')
  assert.equal(orderKind({ dropshipperId: 'x', kind: 'retail' }), 'retail')
  assert.equal(orderKind({ kind: 'nonsense' }), 'retail')
  assert.equal(isShopOrder({}), false)
  assert.equal(isShopOrder({ kind: 'buyout' }), true)
})

test('the four cases of the design note: who got the client money → who owes whom', () => {
  // усе отримав магазин (його ТТН)
  const his = order({ ttnBy: 'shop', collectByUs: 0 })
  assert.equal(clientDueToUs(his), 0); assert.equal(payMode(his), 'none'); assert.equal(shopDue(his), 8500)
  // усе отримали ми (наша ТТН з наложкою на всю суму) → винні магазину комісію
  const ours = order({ collectByUs: 10000 })
  assert.equal(clientDueToUs(ours), 10000); assert.equal(payMode(ours), 'full'); assert.equal(shopDue(ours), -1500)
  // аванс 2 000 магазину, решта нам
  const split = order({ collectByUs: 8000 })
  assert.equal(clientDueToUs(split), 8000); assert.equal(payMode(split), 'split'); assert.equal(shopDue(split), 500)
  // викуп на склад магазину
  const buyout = order({ kind: 'buyout', collectByUs: 10000 })
  assert.equal(clientDueToUs(buyout), 0, 'buyout ignores collectByUs'); assert.equal(shopDue(buyout), 8500)
})

test('commission is per line: boat 20 %, bag 10 %, accessory without commission', () => {
  const o = order({
    collectByUs: 0, total: 13000,
    lines: [boat(20), { id: 'l2', kind: 'bag', price: 2000, qty: 1, shopPct: 10 }, { id: 'l3', kind: 'accessory', price: 500, qty: 2 }],
  })
  assert.equal(lineShopNet(o.lines[0]), 8000)
  assert.equal(lineShopFee(o.lines[0]), 2000)
  assert.equal(lineShopNet(o.lines[1]), 1800)
  assert.equal(lineShopNet(o.lines[2]), 1000, 'no shopPct = no commission')
  assert.equal(orderShopNet(o), 10800)
  assert.equal(shopDue(o), 10800)
})

test('extra line discount lowers the base of the commission; percent is clamped to 0..100', () => {
  const l = { price: 10000, qty: 1, extraOff: 10, extraOffKind: 'pct', shopPct: 15 }
  assert.equal(lineEffTotal(l), 9000)
  assert.equal(lineShopNet(l), 7650)
  assert.equal(lineShopNet({ price: 1000, qty: 1, shopPct: 150 }), 0)
  assert.equal(lineShopNet({ price: 1000, qty: 1, shopPct: -5 }), 1000)
  assert.equal(lineShopNet({ price: 333.33, qty: 3, shopPct: 15 }), 849.99)
})

test('collectByUs is clamped to 0..total; a shop waybill always means the shop collects', () => {
  assert.equal(clientDueToUs(order({ collectByUs: -5 })), 0)
  assert.equal(clientDueToUs(order({ collectByUs: 999999 })), 10000)
  assert.equal(clientDueToUs(order({ ttnBy: 'shop', collectByUs: 4000 })), 0)
  assert.equal(clientDueToUs(order({ collectByUs: '8000' })), 8000)
})

test('legacy orders without collectByUs follow payTo; retail is always the full total', () => {
  assert.equal(clientDueToUs({ dropshipperId: 'x', payTo: 'dropshipper', total: 5000, lines: [] }), 0)
  assert.equal(clientDueToUs({ dropshipperId: 'x', payTo: 'us', total: 5000, lines: [] }), 5000)
  assert.equal(clientDueToUs({ dropshipperId: 'x', total: 5000, lines: [] }), 5000)
  assert.equal(clientDueToUs({ total: 5000, collectByUs: 100, lines: [] }), 5000, 'retail ignores collectByUs')
  assert.equal(shopDue({ total: 5000, lines: [{ price: 5000, qty: 1, shopPct: 15 }] }), 0, 'retail owes nothing')
  assert.equal(clientDueToUs({ lines: [{ price: 1200, qty: 2 }] }), 2400, 'total falls back to the lines')
})

test('pay link gate: full → allowed; none → DROPSHIP_PAY; split → SPLIT_PAY; buyout → BUYOUT_PAY', () => {
  assert.equal(boatPayGate({ total: 5000, lines: [] }), null, 'retail')
  assert.equal(boatPayGate(order({ collectByUs: 10000 })), null)
  assert.equal(boatPayGate(order({ collectByUs: 0 })).code, 'DROPSHIP_PAY')
  assert.equal(boatPayGate(order({ ttnBy: 'shop' })).code, 'DROPSHIP_PAY')
  assert.equal(boatPayGate({ dropshipperId: 'x', payTo: 'dropshipper', total: 5000 }).code, 'DROPSHIP_PAY', 'legacy rule kept')
  assert.equal(boatPayGate(order({ collectByUs: 8000 })).code, 'SPLIT_PAY')
  assert.equal(boatPayGate(order({ kind: 'buyout' })).code, 'BUYOUT_PAY')
  for (const o of [order({ collectByUs: 0 }), order({ collectByUs: 8000 }), order({ kind: 'buyout' })]) assert.equal(boatPayGate(o).status, 409)
})

test('COD in our waybill = what the client pays us, whole hryvnias; nothing once paid', () => {
  assert.equal(boatCodAmount({ total: 40490.4, lines: [] }), 40490, 'retail: whole order as before')
  assert.equal(boatCodAmount(order({ collectByUs: 8000 })), 8000)
  assert.equal(boatCodAmount(order({ collectByUs: 0 })), 0)
  assert.equal(boatCodAmount(order({ ttnBy: 'shop', collectByUs: 8000 })), 0)
  assert.equal(boatCodAmount(order({ kind: 'buyout' })), 0)
  assert.equal(boatCodAmount(order({ collectByUs: 8000, paidAt: '2026-11-10T10:00:00Z' })), 0)
  assert.equal(boatCodAmount(null), 0)
})
