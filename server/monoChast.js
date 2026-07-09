// monobank «Покупка Частинами» (оплата частями/рассрочка) — ОТДЕЛЬНЫЙ продукт и API
// (не путать с эквайрингом invoice/create). Base URL u2.monobank.com.ua; авторизация —
// заголовки store-id + signature=Base64(HMAC-SHA256(тело_как_байты, store_secret)).
// Креды пер-ФОП (fop.monoChast: {storeId, storeSecret}).
import axios from 'axios'
import crypto from 'crypto'

const BASE = process.env.MONO_CHAST_BASE_URL || 'https://u2.monobank.com.ua'

// signature = base64(HMAC-SHA256(body_str, store_secret))
export const chastSignature = (storeSecret, bodyStr) =>
  crypto.createHmac('sha256', storeSecret).update(Buffer.from(bodyStr, 'utf8')).digest('base64')

const request = async (fop, path, bodyObj) => {
  const mc = fop.monoChast || {}
  if (!mc.storeId || !mc.storeSecret) throw new Error(`ФОП ${fop.id}: monobank Частини не настроены`)
  const body = JSON.stringify(bodyObj)
  const headers = {
    'Content-Type': 'application/json',
    'store-id': mc.storeId,
    signature: chastSignature(mc.storeSecret, body),
  }
  const r = await axios.post(`${BASE}${path}`, body, { headers, timeout: 20000 })
  return r.data
}

// Создать заявку на рассрочку. goods: [{name, count, sum}]. Возвращает ответ банка (order_id и т.д.).
export const createOrder = (fop, { storeOrderId, clientPhone, totalSum, goods, availablePrograms, resultCallback }) =>
  request(fop, '/api/order/create', {
    store_order_id: String(storeOrderId),
    client_phone: clientPhone,
    total_sum: Number(totalSum),
    ...(Array.isArray(availablePrograms) && availablePrograms.length ? { available_programs: availablePrograms } : {}),
    products: (goods || []).map((g) => ({ name: g.name, count: g.count || 1, sum: Number(g.sum) })),
    ...(resultCallback ? { result_callback: resultCallback } : {}),
  })

// Подтвердить заявку (после согласия клиента) — после этого списывается первый платёж → ACTIVE.
export const confirmOrder = (fop, orderId) => request(fop, '/api/order/confirm', { order_id: orderId })
// Отклонить/отменить
export const rejectOrder = (fop, orderId) => request(fop, '/api/order/reject', { order_id: orderId })
// Опрос статуса (надёжнее вебхука для ACTIVE/DONE)
export const orderState = (fop, orderId) => request(fop, '/api/order/state', { order_id: orderId })

// Проверить подпись входящего result_callback (HMAC от сырого тела)
export const verifyCallbackSig = (fop, rawBody, sigHeader) => {
  const secret = fop && fop.monoChast && fop.monoChast.storeSecret
  if (!secret || !rawBody || !sigHeader) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sigHeader)))
  } catch {
    return false
  }
}

export default { createOrder, confirmOrder, rejectOrder, orderState, verifyCallbackSig, chastSignature }
