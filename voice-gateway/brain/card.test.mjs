import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCard, groupPhone, spoken, hidePhones, CARD_MAX } from './card.mjs'

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

test('нічого не знаємо → «новий клієнт, у базі порталу немає» — без номера (з speakNumber — номер групами, як раніше)', () => {
  const c = buildCard({ requests: [], profile: null, orders: [] }, opts)
  assert.equal(c.text, 'Дзвонить новий клієнт, у базі порталу немає.')
  assert.equal(c.category, 'unknown')
  assert.equal(c.serviceRequestId, null)
  assert.equal(buildCard({ requests: [], profile: null, orders: [] }, { ...opts, speakNumber: true }).text, 'Дзвонить номер 050 000 00 01. У базі порталу немає.')
})

test('профіль без імені й заявок; покупець кораблика', () => {
  assert.equal(buildCard({ requests: [], profile: { source: 'telegram' }, orders: [] }, opts).text, 'Дзвонить клієнт. Звертався, заявок у базі немає.')
  assert.equal(buildCard({ requests: [], profile: { source: 'telegram' }, orders: [] }, { ...opts, speakNumber: true }).text, 'Дзвонить номер 050 000 00 01. Звертався, заявок у базі немає.')
  const c = buildCard({ requests: [], profile: null, orders: [{ id: 'bo1', status: 'done', clientName: 'Сидоренко Олег', soldAt: '2025-06-12T09:00:00Z' }] }, opts)
  assert.equal(c.text, 'Дзвонить Сидоренко Олег. Купив кораблик 12.06.2025, ремонтів у базі немає.')
  assert.equal(c.category, 'knownClient')
})

test('пошук не встиг (null) → «Дзвонить клієнт.», без «немає в базі»; внутрішній номер', () => {
  assert.equal(buildCard(null, opts).text, 'Дзвонить клієнт.')
  assert.equal(buildCard(null, { ...opts, speakNumber: true }).text, 'Дзвонить номер 050 000 00 01.')
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

test('номер телефону в картку не потрапляє: ні замість імені, ні зі скарги (навіть обрізаної), ні з кораблика; дата й номер ремонту лишаються', () => {
  const noPhone = (t) => !/(\d[\s()+.-]*){9,}/.test(t) && !/050|067/.test(t)
  const cases = [
    SR({ clientName: '050 000 00 01' }),
    SR({ complaint: 'Не крутиться гвинт, передзвоніть на +38 (067) 123-45-67 після обіду, будь ласка, дуже треба' }),
    SR({ complaint: 'Передзвоніть 0671234567' }),
    SR({ boat: 'R3 (власник 0500000006)' }),
  ]
  for (const r of cases) {
    const c = buildCard({ requests: [r], profile: null, orders: [] }, opts)
    assert.ok(noPhone(c.text), c.text)
    assert.match(c.text, /Ремонт номер 1234/)
  }
  assert.equal(buildCard({ requests: [SR({ clientName: '050 000 00 01' })], profile: null, orders: [] }, opts).text.startsWith('Дзвонить клієнт. Ремонт номер 1234.'), true)
  assert.equal(hidePhones('Купив кораблик 12.06.2025, ремонтів у базі немає.'), 'Купив кораблик 12.06.2025, ремонтів у базі немає.')
  assert.equal(hidePhones('Ремонт номер 558. 12.06.2025'), 'Ремонт номер 558. 12.06.2025')
  assert.equal(hidePhones('Дзвонить +380501234567.'), 'Дзвонить.')
  // телефон після дати чи числа з крапкою (кінець речення) — раніше лишався разом із ними; «/» як розділювач
  assert.equal(hidePhones('Купив 12.06.2025. 0500000006 Іван'), 'Купив 12.06.2025. Іван')
  assert.equal(hidePhones('Ремонт 558. 050 000 00 06'), 'Ремонт 558.')
  assert.equal(hidePhones('Купив 12.06.2025. 0500000006 дзвонити ввечері.'), 'Купив 12.06.2025. дзвонити ввечері.')
  assert.equal(hidePhones('Дзвоніть 050/000/00/06, після 18'), 'Дзвоніть, після 18')
  assert.equal(hidePhones('тел. 050.000.00.06'), 'тел.')
  assert.equal(hidePhones('R3. 2 гвинти, 3.5 кг, ремонт 1234.'), 'R3. 2 гвинти, 3.5 кг, ремонт 1234.')
  for (const complaint of ['Купив 12.06.2025. 0500000006 дзвонити ввечері', 'Ремонт 558. 050 000 00 06', 'Номер 050/000/00/06']) {
    const c = buildCard({ requests: [SR({ complaint })], profile: null, orders: [] }, opts)
    assert.ok(noPhone(c.text) && !/111/.test(c.text), c.text)
  }
  // з speakNumber (VG_CARD_SPEAK_NUMBER=1) скаргу не чіпаємо — як раніше
  assert.match(buildCard({ requests: [SR({ complaint: 'Передзвоніть 0671234567' })], profile: null, orders: [] }, { ...opts, speakNumber: true }).text, /0671234567/)
})
