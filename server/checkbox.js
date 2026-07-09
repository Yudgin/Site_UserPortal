// Checkbox (ПРРО) — авто-выдача фискального чека. Каждый ФОП имеет свою кассу/кассира,
// поэтому чек выбивается кредами КОНКРЕТНОГО ФОП (fop.checkbox: {licenseKey, pinCode, cashierName}).
// Суммы — целые КОПЕЙКИ; количество — в ТЫСЯЧНЫХ (1 шт = 1000). payments должны точно равняться goods.
import axios from 'axios'
import crypto from 'crypto'

const BASE = process.env.CHECKBOX_BASE_URL || 'https://api.checkbox.in.ua'
const CLIENT_NAME = 'RunFerry-Backend'

// грн (число/строка) → копейки (целое)
export const toKop = (uah) => Math.round(Number(uah) * 100)
// uuid v4 (для идемпотентности чека)
const uuid = () => crypto.randomUUID()

// Кэш токена кассира пер-ФОП; пересоздаём при 401.
const tokenCache = new Map() // fopId -> access_token

const headers = (fop, withAuth = true) => ({
  'Content-Type': 'application/json',
  'X-Client-Name': CLIENT_NAME,
  'X-License-Key': fop.checkbox.licenseKey,
  ...(withAuth && tokenCache.get(fop.id) ? { Authorization: `Bearer ${tokenCache.get(fop.id)}` } : {}),
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
  return token
}

const ensureToken = async (fop) => {
  if (!tokenCache.get(fop.id)) await signin(fop)
}

// Убедиться, что открыта смена; иначе открыть и дождаться OPENED.
export const ensureShift = async (fop) => {
  await ensureToken(fop)
  const cur = await axios.get(`${BASE}/api/v1/cashier/shift`, { headers: headers(fop), timeout: 15000 }).catch(() => null)
  if (cur && cur.data && cur.data.status === 'OPENED') return cur.data
  await axios.post(`${BASE}/api/v1/shifts`, {}, { headers: headers(fop), timeout: 20000 })
  // ждём OPENED (регистрация в ДПС ~5-7с)
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await axios.get(`${BASE}/api/v1/cashier/shift`, { headers: headers(fop), timeout: 15000 }).catch(() => null)
    if (s && s.data && s.data.status === 'OPENED') return s.data
  }
  throw new Error(`ФОП ${fop.id}: смена Checkbox не открылась`)
}

// Собрать тело чека продажи. goods: [{name, price(грн), qty, code?}]. paymentLabel — подпись оплаты.
export const buildSellPayload = (fop, { goods, paymentLabel, receiptId }) => {
  const items = (goods || []).map((g) => ({
    good: { code: g.code || undefined, name: String(g.name), price: toKop(g.price) },
    quantity: Math.round((g.qty || 1) * 1000),
  }))
  const total = items.reduce((s, it) => s + it.good.price * (it.quantity / 1000), 0)
  return {
    id: receiptId || uuid(),
    cashier_name: (fop.checkbox && fop.checkbox.cashierName) || fop.name || fop.id,
    goods: items,
    payments: [{ type: 'CASHLESS', value: Math.round(total), label: paymentLabel || 'Безготівкова оплата' }],
  }
}

// Выбить фискальный чек продажи. Возвращает {receiptId, fiscalCode, taxUrl, status}.
export const sellReceipt = async (fop, { goods, paymentLabel, receiptId, deliveryEmail }) => {
  await ensureShift(fop)
  const payload = buildSellPayload(fop, { goods, paymentLabel, receiptId })
  if (deliveryEmail) payload.delivery = { email: deliveryEmail }
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

export const closeShift = async (fop) => {
  await ensureToken(fop)
  const r = await axios.post(`${BASE}/api/v1/shifts/close`, {}, { headers: headers(fop), timeout: 20000 })
  return r.data
}

export default { signin, ensureShift, sellReceipt, closeShift, buildSellPayload, toKop }
