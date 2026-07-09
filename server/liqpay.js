// LiqPay (ПриватБанк): оплата картой и ЧАСТЯМИ (paytype=paypart/moment_part).
// Одна интеграция на карту + части. Подпись: base64(sha1(private_key + data + private_key))
// (бинарный digest). Тот же алгоритм — для проверки входящего вебхука на server_url.
// Ключи берутся ПЕР-ФОП (fop.liqpay), чтобы деньги и чек шли от нужного ФОП.
import crypto from 'crypto'

const CHECKOUT_URL = 'https://www.liqpay.ua/api/3/checkout'

// data = base64(JSON(params))
const encodeData = (params) => Buffer.from(JSON.stringify(params)).toString('base64')

// signature = base64(sha1(private + data + private))
export const liqpaySignature = (privateKey, data) =>
  crypto.createHash('sha1').update(privateKey + data + privateKey).digest('base64')

// Собрать данные для формы Checkout. Возвращает { checkoutUrl, data, signature }.
// method: 'card' | 'paypart' | 'moment_part' (или список через запятую).
export const buildCheckout = (fop, { orderId, amountUah, description, method = 'card', serverUrl, resultUrl, sandbox }) => {
  const lp = fop.liqpay || {}
  if (!lp.publicKey || !lp.privateKey) throw new Error(`ФОП ${fop.id}: LiqPay не настроен`)
  const params = {
    public_key: lp.publicKey,
    version: 3,
    action: 'pay',
    amount: Number(amountUah),
    currency: 'UAH',
    description: String(description || 'Оплата RunFerry'),
    order_id: String(orderId),
    ...(method && method !== 'card' ? { paytype: method } : {}),
    ...(serverUrl ? { server_url: serverUrl } : {}),
    ...(resultUrl ? { result_url: resultUrl } : {}),
    language: 'uk',
    ...(sandbox ? { sandbox: 1 } : {}),
  }
  const data = encodeData(params)
  return { checkoutUrl: CHECKOUT_URL, data, signature: liqpaySignature(lp.privateKey, data) }
}

// Декодировать data вебхука БЕЗ проверки (чтобы вытащить order_id и найти ФОП).
export const decodeCallbackData = (data) => {
  try {
    return JSON.parse(Buffer.from(String(data), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

// Проверить подпись вебхука кредами конкретного ФОП. Возвращает true/false.
export const verifyCallback = (fop, data, signature) => {
  const priv = fop && fop.liqpay && fop.liqpay.privateKey
  if (!priv || !data || !signature) return false
  const expected = liqpaySignature(priv, String(data))
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)))
  } catch {
    return false
  }
}

export default { buildCheckout, decodeCallbackData, verifyCallback, liqpaySignature }
