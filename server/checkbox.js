// Checkbox (ПРРО) — авто-выдача фискального чека. Каждый ФОП имеет свою кассу/кассира,
// поэтому чек выбивается кредами КОНКРЕТНОГО ФОП (fop.checkbox: {licenseKey, pinCode, cashierName}).
// Суммы — целые КОПЕЙКИ; количество — в ТЫСЯЧНЫХ (1 шт = 1000). payments должны точно равняться goods.
import axios from 'axios'
import crypto from 'crypto'

const BASE = process.env.CHECKBOX_BASE_URL || 'https://api.checkbox.in.ua'
const CLIENT_NAME = 'RunFerry-Backend'

// грн (число/строка) → копейки (целое)
export const toKop = (uah) => Math.round(Number(uah) * 100)
// Сумма позиции в копейках: цена(коп) × количество(тысячные) / 1000, округление ПОСТРОЧНО.
// Checkbox валидирует payments против ПОСТРОЧНО округлённых позиций — считаем так же,
// иначе payments != goods и чек не выбьется.
const lineTotalKop = (priceKop, qtyThousandths) => Math.round((priceKop * qtyThousandths) / 1000)
// Итог по goods в копейках (целое) — единый источник истины: и для payments.value в чеке,
// и для серверной сверки с order.amount перед созданием оплаты.
export const goodsTotalKop = (goods) =>
  (goods || []).reduce((s, g) => s + lineTotalKop(toKop(g.price), Math.round((g.qty || 1) * 1000)), 0)
// uuid v4 (для идемпотентности чека)
const uuid = () => crypto.randomUUID()

// Кэш токена кассира пер-ФОП; пересоздаём при 401. Токен годится только с тем ключом кассы, с которым выдан:
// ключ сменили (или проверили новый, пока у другого кода ФОП из кэша со старым) — новый вход, а не чужой токен.
const tokenCache = new Map() // fopId -> access_token
const tokenLicense = new Map() // fopId -> licenseKey, с которым выдан токен
const tokenFor = (fop) => (tokenLicense.get(fop.id) === fop.checkbox.licenseKey ? tokenCache.get(fop.id) : undefined)

const headers = (fop, withAuth = true) => ({
  'Content-Type': 'application/json',
  'X-Client-Name': CLIENT_NAME,
  'X-License-Key': fop.checkbox.licenseKey,
  ...(withAuth && tokenFor(fop) ? { Authorization: `Bearer ${tokenFor(fop)}` } : {}),
})

// Вход кассира (по пин-коду; иначе login/password). Кэширует токен.
export const signin = async (fop) => {
  const cb = fop.checkbox || {}
  if (!cb.licenseKey) throw new Error(`ФОП ${fop.id}: Checkbox не настроен`)
  let token
  if (cb.pinCode) {
    const r = await axios.post(`${BASE}/api/v1/cashier/signinPinCode`, { pin_code: String(cb.pinCode) }, { headers: headers(fop, false), timeout: 15000 })
    token = r.data && r.data.access_token
  } else if (cb.login && cb.password) {
    const r = await axios.post(`${BASE}/api/v1/cashier/signin`, { login: cb.login, password: cb.password }, { headers: headers(fop, false), timeout: 15000 })
    token = r.data && r.data.access_token
  } else {
    throw new Error(`ФОП ${fop.id}: нет pinCode/login для Checkbox`)
  }
  if (!token) throw new Error(`ФОП ${fop.id}: Checkbox signin не вернул токен`)
  tokenCache.set(fop.id, token)
  tokenLicense.set(fop.id, cb.licenseKey)
  return token
}

const ensureToken = async (fop) => {
  if (!tokenFor(fop)) await signin(fop)
}

const is401 = (e) => !!(e.response && e.response.status === 401)

// Текущая смена. Прочие сбои чтения считаем «смены нет», а 401 отдаём наверх: токен протух, и открытие смены тоже откажет.
const readShift = (fop) => axios.get(`${BASE}/api/v1/cashier/shift`, { headers: headers(fop), timeout: 15000 }).catch((e) => {
  if (is401(e)) throw e
  return null
})

const openShift = async (fop) => {
  const cur = await readShift(fop)
  const status = cur && cur.data && cur.data.status
  if (status === 'OPENED') return cur.data
  // Смена уже открывается (например, повтор после 401 посреди ожидания) — второй запрос на открытие не шлём, только ждём.
  if (status !== 'CREATED' && status !== 'OPENING') {
    await axios.post(`${BASE}/api/v1/shifts`, {}, { headers: headers(fop), timeout: 20000 })
  }
  // ждём OPENED (регистрация в ДПС ~5-7с)
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await readShift(fop)
    if (s && s.data && s.data.status === 'OPENED') return s.data
  }
  throw new Error(`ФОП ${fop.id}: смена Checkbox не открылась`)
}

// Убедиться, что открыта смена; иначе открыть и дождаться OPENED. Токен мог протухнуть → один повтор после переавторизации.
export const ensureShift = async (fop) => {
  await ensureToken(fop)
  try {
    return await openShift(fop)
  } catch (e) {
    if (!is401(e)) throw e
    tokenCache.delete(fop.id)
    await signin(fop)
    return openShift(fop)
  }
}

// Собрать тело чека продажи. goods: [{name, price(грн), qty, code?}]. paymentLabel — подпись оплаты.
export const buildSellPayload = (fop, { goods, paymentLabel, receiptId }) => {
  // good.code (артикул) — у части касс Checkbox обязателен (валидация value_error.missing).
  // Если у позиции нет своего кода — подставляем позиционный, чтобы чек не отклонялся.
  const items = (goods || []).map((g, i) => ({
    good: { code: String(g.code || `POS-${i + 1}`), name: String(g.name), price: toKop(g.price) },
    quantity: Math.round((g.qty || 1) * 1000),
  }))
  // ПОСТРОЧНОЕ округление в копейках (как валидирует Checkbox) → payments точно равны goods.
  const total = items.reduce((s, it) => s + lineTotalKop(it.good.price, it.quantity), 0)
  return {
    id: receiptId || uuid(),
    cashier_name: (fop.checkbox && fop.checkbox.cashierName) || fop.name || fop.id,
    goods: items,
    payments: [{ type: 'CASHLESS', value: total, label: paymentLabel || 'Безготівкова оплата' }],
  }
}

// Отправить готовое тело чека (продажа или возврат) в открытую смену. Возвращает {receiptId, fiscalCode, taxUrl, status}.
const postReceipt = async (fop, payload) => {
  await ensureShift(fop)
  let res
  try {
    res = await axios.post(`${BASE}/api/v1/receipts/sell`, payload, { headers: headers(fop), timeout: 30000 })
  } catch (e) {
    // токен мог протухнуть → один повтор после переавторизации
    if (e.response && e.response.status === 401) {
      tokenCache.delete(fop.id)
      await ensureShift(fop)
      res = await axios.post(`${BASE}/api/v1/receipts/sell`, payload, { headers: headers(fop), timeout: 30000 })
    } else {
      throw e
    }
  }
  const d = res.data || {}
  return { receiptId: d.id || payload.id, fiscalCode: d.fiscal_code || null, taxUrl: d.tax_url || null, status: d.status || null }
}

// Выбить фискальный чек продажи. Возвращает {receiptId, fiscalCode, taxUrl, status}.
export const sellReceipt = async (fop, { goods, paymentLabel, receiptId, deliveryEmail }) => {
  const payload = buildSellPayload(fop, { goods, paymentLabel, receiptId })
  if (deliveryEmail) payload.delivery = { email: deliveryEmail }
  return postReceipt(fop, payload)
}

// Чек возврата к чеку продажи relatedReceiptId: те же позиции с is_return и та же сумма тем же способом
// (так в Checkbox оформляется возврат). Деньги, как и чек продажи, он не двигает: только фискальная запись.
export const returnReceipt = async (fop, { goods, paymentLabel, relatedReceiptId, receiptId }) => {
  if (!relatedReceiptId) throw new Error(`ФОП ${fop.id}: для чека возврата нужен id чека продажи`)
  const sale = buildSellPayload(fop, { goods, paymentLabel, receiptId })
  return postReceipt(fop, { ...sale, goods: sale.goods.map((g) => ({ ...g, is_return: true })), related_receipt_id: relatedReceiptId })
}

// Готова ли подпись (КЕП) кассира: {online, type, shift_open_possibility}. Только чтение (readAsCashier ниже).
export const checkSignature = (fop) => readAsCashier(fop, '/api/v1/cashier/check-signature')
// Состояние оплаты Checkbox: {status, date_to_block, units, status_changed_at}. Только чтение. Заблокированную за
// неоплату кассу Checkbox при продаже отклоняет с кодом organization.billing_disabled.
export const billingStatus = (fop) => readAsCashier(fop, '/api/v1/organization/billing-status')

export const closeShift = async (fop) => {
  await ensureToken(fop)
  const r = await axios.post(`${BASE}/api/v1/shifts/close`, {}, { headers: headers(fop), timeout: 20000 })
  return r.data
}

// Статус чека по id: fiscal_code/tax_url появляются ПОСЛЕ асинхронной регистрации в ДПС
// (сразу после receipts/sell чек в статусе CREATED без кода — его добивает reconcile).
export const getReceipt = async (fop, receiptId) => {
  await ensureToken(fop)
  let res
  try {
    res = await axios.get(`${BASE}/api/v1/receipts/${receiptId}`, { headers: headers(fop), timeout: 20000 })
  } catch (e) {
    // токен мог протухнуть → один повтор после переавторизации
    if (e.response && e.response.status === 401) {
      tokenCache.delete(fop.id)
      await signin(fop)
      res = await axios.get(`${BASE}/api/v1/receipts/${receiptId}`, { headers: headers(fop), timeout: 20000 })
    } else {
      throw e
    }
  }
  const d = res.data || {}
  return { receiptId: d.id || receiptId, fiscalCode: d.fiscal_code || null, taxUrl: d.tax_url || null, status: d.status || null }
}

// Только чтение, для блока готовности: чеки и смену не трогают. Токен мог протухнуть → один повтор после переавторизации.
const readAsCashier = async (fop, path) => {
  await ensureToken(fop)
  const read = () => axios.get(`${BASE}${path}`, { headers: headers(fop), timeout: 15000 })
  try {
    return (await read()).data
  } catch (e) {
    if (!is401(e)) throw e
    tokenCache.delete(fop.id)
    await signin(fop)
    return (await read()).data
  }
}
export const cashierMe = (fop) => readAsCashier(fop, '/api/v1/cashier/me')
export const cashierShift = (fop) => readAsCashier(fop, '/api/v1/cashier/shift')
// Касса по ключу лицензии: вход кассира не нужен.
export const cashRegisterInfo = async (fop) => (await axios.get(`${BASE}/api/v1/cash-registers/info`, { headers: headers(fop, false), timeout: 15000 })).data

export default { signin, ensureShift, sellReceipt, returnReceipt, closeShift, getReceipt, cashierMe, cashierShift, cashRegisterInfo, checkSignature, billingStatus, buildSellPayload, toKop, goodsTotalKop }
