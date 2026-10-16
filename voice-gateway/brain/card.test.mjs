import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCard, groupPhone, spoken, CARD_MAX } from './card.mjs'

const NOW = Date.parse('2026-10-16T08:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86400e3).toISOString()
const SR = (o) => ({ id: 'sr1', clientName: 'Петренко Іван', status: 'in_work', stage: 'diagnosed', onec: { number: '0001234' }, boat: 'Runferry R3', complaint: 'Не крутиться правий гвинт', createdAt: daysAgo(6), ...o })
const opts = { number: '0500000001', nowMs: NOW }

test('номер групами, як читається вголос', () => {
  assert.equal(groupPhone('+380500000001'), '050 000 00 01')
  assert.equal(groupPhone('0500000001'), '050 000 00 01')
  assert.equal(groupPhone('12'), '12')
})

test('spoken: « · » → речення, «№» → «номер», обрубок слова після clip() прибирається', () => {
  assert.equal(spoken('Ремонт №1234 · Діагностовано · Runferry R3'), 'Ремонт номер 1234. Діагностовано. Runferry R3')
  assert.equal(spoken('Ремонт №1234 (+2) · Отримано'), 'Ремонт номер 1234 (ще 2). Отримано')
  assert.equal(spoken('Ремонт №1 · Не крутиться правий гвин…'), 'Ремонт номер 1. Не крутиться правий')
  assert.equal(spoken('Ремонт №558 · Виконано · -Ремонт ББВ · Пульт'), 'Ремонт номер 558. Виконано. Ремонт ББВ. Пульт')
  assert.equal(spoken('Ремонт · Runferry R3-mini'), 'Ремонт. Runferry R3-mini')
})

test('відкрита заявка: ім\'я, номер ремонту, етап, кораблик, скарга', () => {
  const c = buildCard({ requests: [SR()], profile: null, orders: [] }, opts)
  assert.equal(c.text, 'Дзвонить Петренко Іван. Ремонт номер 1234. Діагностовано. Runferry R3. Не крутиться правий гвинт.')
  assert.equal(c.category, 'openRequest')
  assert.equal(c.serviceRequestId, 'sr1')
  assert.ok(!c.text.includes('·') && !c.text.includes('№'))
})

test('закритий ремонт → «Останній ремонт», статус; категорія knownClient', () => {
  const c = buildCard({ requests: [SR({ status: 'done', stage: 'received', createdAt: daysAgo(400) })], profile: null, orders: [] }, opts)
  // опис обрізаний DESC_MAX (70) приймача — обрубок слова «пр…» прибрано
  assert.equal(c.text, 'Дзвонить Петренко Іван. Останній ремонт номер 1234. Виконано. Runferry R3. Не крутиться.')
  assert.equal(c.category, 'knownClient')
})

test('нічого не знаємо → номер групами і «У базі порталу немає»', () => {
  const c = buildCard({ requests: [], profile: null, orders: [] }, opts)
  assert.equal(c.text, 'Дзвонить номер 050 000 00 01. У базі порталу немає.')
  assert.equal(c.category, 'unknown')
  assert.equal(c.serviceRequestId, null)
})

test('профіль без імені й заявок; покупець кораблика', () => {
  assert.equal(buildCard({ requests: [], profile: { source: 'telegram' }, orders: [] }, opts).text, 'Дзвонить номер 050 000 00 01. Звертався, заявок у базі немає.')
  const c = buildCard({ requests: [], profile: null, orders: [{ id: 'bo1', status: 'done', clientName: 'Сидоренко Олег', soldAt: '2025-06-12T09:00:00Z' }] }, opts)
  assert.equal(c.text, 'Дзвонить Сидоренко Олег. Купив кораблик 12.06.2025, ремонтів у базі немає.')
  assert.equal(c.category, 'knownClient')
})

test('пошук не встиг (null) → лише номер, без «немає в базі»; внутрішній номер', () => {
  assert.equal(buildCard(null, opts).text, 'Дзвонить номер 050 000 00 01.')
  assert.equal(buildCard(null, { number: '907' }).text, 'Дзвонить внутрішній номер 907.')
  assert.equal(buildCard(null, { number: '' }).text, 'Дзвонить невідомий номер.')
})

test('довгі ім\'я і скарга → коротко (≤ ~200), без обрубків', () => {
  const c = buildCard({ requests: [SR({ clientName: 'Олександр-Костянтин Вільгельмович Петренко-Шевченко-Коваленко', complaint: 'Після удару об камінь не крутиться правий гвинт і пищить пульт, ще й ехолот показує нісенітницю' })], profile: null, orders: [] }, opts)
  assert.ok(c.text.length <= CARD_MAX, c.text)
  assert.ok(!c.text.includes('…'), c.text)
  assert.match(c.text, /^Дзвонить Олександр-Костянтин/)
  assert.match(c.text, /\.$/)
})

test('кілька відкритих заявок → «(ще N)»', () => {
  const c = buildCard({ requests: [SR(), SR({ id: 'sr2', onec: { number: '77' }, createdAt: daysAgo(10) })], profile: null, orders: [] }, opts)
  assert.match(c.text, /^Дзвонить Петренко Іван\. Ремонт номер 1234 \(ще 1\)\. /)
})
