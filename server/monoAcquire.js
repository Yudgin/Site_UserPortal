// monobank Acquiring (эквайринг — оплата картой через платёжную страницу monobank).
// Не путать с monobank «Покупка Частинами» (monoChast) — это другой продукт/API.
// Base https://api.monobank.ua; авторизация — заголовок X-Token (мерчант-токен пер-ФОП:
// fop.monoAcquire.token). Вебхук подписан ECDSA-SHA256 публичным ключом мерчанта (X-Sign).
import axios from 'axios'
import crypto from 'crypto'

const BASE = process.env.MONO_ACQUIRE_BASE_URL || 'https://api.monobank.ua'

const tokenOf = (fop) => {
  const t = fop && fop.monoAcquire && fop.monoAcquire.token
  if (!t) throw new Error(`ФОП ${fop.id}: monobank еквайринг не налаштований (token)`)
  return t
}

export const toKop = (uah) => Math.round(Number(uah) * 100)

// Создать инвойс. goods: [{name, qty, sumKop, code?}]. amountKop должен = Σ goods.sumKop.
// Возвращает {invoiceId, pageUrl}. Клиент перенаправляется на pageUrl.
export const createInvoice = async (fop, { amountKop, reference, destination, goods, redirectUrl, webHookUrl, validitySec }) => {
  const basket = (goods || []).map((g) => ({
    name: String(g.name).slice(0, 128),
    qty: Number(g.qty) || 1,
    sum: Math.round(g.sumKop),
    unit: 'шт.',
    code: String(g.code || g.name || 'pos').slice(0, 50),
  }))
  const body = {
    amount: Math.round(amountKop),
    ccy: 980,
    merchantPaymInfo: {
      reference: String(reference),
      destination: (destination || 'Оплата послуг RunFerry').slice(0, 280),
      ...(basket.length ? { basketOrder: basket } : {}),
    },
    ...(redirectUrl ? { redirectUrl } : {}),
    ...(webHookUrl ? { webHookUrl } : {}),
    ...(validitySec ? { validity: validitySec } : {}),
    paymentType: 'debit',
  }
  const r = await axios.post(`${BASE}/api/merchant/invoice/create`, body, {
    headers: { 'X-Token': tokenOf(fop), 'Content-Type': 'application/json' }, timeout: 20000,
  })
  return r.data // { invoiceId, pageUrl }
}

// Статус инвойса (надёжнее вебхука для reconcile). Возвращает {invoiceId, status, amount, ...}.
export const invoiceStatus = async (fop, invoiceId) => {
  const r = await axios.get(`${BASE}/api/merchant/invoice/status`, {
    headers: { 'X-Token': tokenOf(fop) }, params: { invoiceId }, timeout: 15000,
  })
  return r.data
}

// Публичный ключ мерчанта (для проверки подписи вебхука). Кэш пер-ФОП, инвалидация по requestFresh.
const pubKeyCache = new Map()
export const getPubKey = async (fop, requestFresh = false) => {
  if (!requestFresh && pubKeyCache.has(fop.id)) return pubKeyCache.get(fop.id)
  const r = await axios.get(`${BASE}/api/merchant/pubkey`, { headers: { 'X-Token': tokenOf(fop) }, timeout: 15000 })
  const keyB64 = r.data && r.data.key
  const pem = keyB64 ? Buffer.from(String(keyB64), 'base64').toString('utf8') : null
  if (pem) pubKeyCache.set(fop.id, pem)
  return pem
}

// Проверить подпись вебхука: X-Sign = base64(ECDSA-SHA256(rawBody)), ключ — pubkey мерчанта.
// При неудаче обновляем ключ (мог ротироваться) и пробуем ещё раз.
export const verifyWebhook = async (fop, rawBody, xSign) => {
  if (!rawBody || !xSign) return false
  const check = (pem) => {
    if (!pem) return false
    try {
      const v = crypto.createVerify('SHA256')
      v.update(rawBody)
      v.end()
      return v.verify(pem, Buffer.from(String(xSign), 'base64'))
    } catch { return false }
  }
  try {
    if (check(await getPubKey(fop))) return true
    return check(await getPubKey(fop, true)) // ключ мог обновиться — перезапросить
  } catch (e) {
    console.error('monoAcquire verifyWebhook:', e.message)
    return false
  }
}

export default { createInvoice, invoiceStatus, getPubKey, verifyWebhook, toKop }
