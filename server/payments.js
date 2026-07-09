// Оркестрация оплат RunFerry: приём оплаты (в т.ч. ЧАСТЯМИ) от РАЗНЫХ ФОП и АВТО-выдача
// фискального чека Checkbox тем же ФОП, что принял оплату.
//
// Главное правило (по требованию): payments/{orderId}.fopId фиксирует ФОП; фискализация
// берёт креды Checkbox по этому fopId — «кто принял оплату, тот и выдал чек».
//
// Единый обработчик «платёж подтверждён → выбить чек» общий для LiqPay и monobank Частин.
// Все секреты — в env (FOPS_CONFIG), не в коде. Подписи вебхуков обязательно проверяются.
import crypto from 'crypto'
import { getFop, fopHas, listFopsPublic, hasAnyFop } from './fops.js'
import * as liqpay from './liqpay.js'
import * as monoChast from './monoChast.js'
import * as checkbox from './checkbox.js'

const nowIso = () => new Date().toISOString()
const newOrderId = () => 'pay-' + crypto.randomUUID().slice(0, 18)

export function registerPayments(app, deps) {
  const { adminDb } = deps
  const PUBLIC = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  const SANDBOX = process.env.PAYMENTS_SANDBOX === 'true'

  const col = () => adminDb.collection('payments')
  const loadOrder = async (orderId) => {
    const s = await col().doc(orderId).get()
    return s.exists ? s.data() : null
  }
  const saveOrder = async (order) => col().doc(order.orderId).set({ ...order, updatedAt: nowIso() }, { merge: true })
  const findByProviderOrderId = async (providerOrderId) => {
    const q = await col().where('providerOrderId', '==', String(providerOrderId)).limit(1).get()
    return q.empty ? null : q.docs[0].data()
  }

  // ЕДИНЫЙ модуль фискализации: чек выбивает ФОП из order.fopId (идемпотентно).
  const fiscalize = async (order, paymentLabel) => {
    if (!order || order.receiptId) return // уже выбит
    const fop = getFop(order.fopId)
    if (!fop) return
    if (!fopHas(fop, 'checkbox.licenseKey')) {
      await saveOrder({ orderId: order.orderId, receiptStatus: 'no-checkbox' })
      console.warn(`payments: ФОП ${order.fopId} без Checkbox — чек не выписан для ${order.orderId}`)
      return
    }
    try {
      const res = await checkbox.sellReceipt(fop, {
        goods: order.goods,
        paymentLabel,
        receiptId: `rcpt-${order.orderId}`, // детерминированный id → идемпотентность у Checkbox
        deliveryEmail: order.deliveryEmail || undefined,
      })
      await saveOrder({
        orderId: order.orderId,
        receiptId: res.receiptId,
        fiscalCode: res.fiscalCode,
        taxUrl: res.taxUrl,
        receiptStatus: res.status || 'done',
        receiptAt: nowIso(),
      })
      console.log(`payments: чек выписан ${order.orderId} (ФОП ${order.fopId}) fiscal=${res.fiscalCode}`)
    } catch (e) {
      await saveOrder({ orderId: order.orderId, receiptStatus: 'error', receiptError: (e.response && JSON.stringify(e.response.data)) || e.message })
      console.error(`payments: ошибка чека ${order.orderId}:`, (e.response && e.response.data) || e.message)
    }
  }

  // Публичный список ФОП + доступные методы (для UI выбора, без секретов)
  app.get('/api/fops', (req, res) => res.json({ success: true, data: listFopsPublic() }))

  // Создать оплату. body: { fopId, amount, goods:[{name,price,qty}], method, description, clientPhone?, resultUrl?, deliveryEmail? }
  // method: 'liqpay-card' | 'liqpay-paypart' | 'liqpay-moment' | 'mono-chast'
  app.post('/api/pay/create', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false, error: { code: 'NO_DB', message: 'Firestore не настроен' } })
    if (!hasAnyFop()) return res.status(503).json({ success: false, error: { code: 'NO_FOPS', message: 'ФОП не настроены (FOPS_CONFIG)' } })
    try {
      const { fopId, amount, goods, method = 'liqpay-card', description, clientPhone, resultUrl, deliveryEmail } = req.body || {}
      const fop = getFop(fopId)
      if (!fop) return res.status(400).json({ success: false, error: { code: 'BAD_FOP', message: 'Невідомий ФОП' } })
      if (!Number(amount) || !Array.isArray(goods) || !goods.length) return res.status(400).json({ success: false, error: { code: 'BAD_INPUT', message: 'Потрібні amount і goods' } })

      const orderId = newOrderId()
      const order = { orderId, fopId, amount: Number(amount), goods, method, status: 'pending', createdAt: nowIso(), ...(deliveryEmail ? { deliveryEmail } : {}) }

      if (method.startsWith('liqpay')) {
        if (!fopHas(fop, 'liqpay.privateKey')) return res.status(400).json({ success: false, error: { code: 'NO_LIQPAY', message: 'У ФОП немає LiqPay' } })
        const lpMethod = method === 'liqpay-paypart' ? 'paypart' : method === 'liqpay-moment' ? 'moment_part' : 'card'
        const co = liqpay.buildCheckout(fop, {
          orderId, amountUah: amount, description: description || `Оплата RunFerry #${orderId}`,
          method: lpMethod, serverUrl: PUBLIC ? `${PUBLIC}/api/liqpay/callback` : undefined, resultUrl, sandbox: SANDBOX,
        })
        order.provider = 'liqpay'
        await saveOrder(order)
        return res.json({ success: true, data: { orderId, provider: 'liqpay', checkoutUrl: co.checkoutUrl, data: co.data, signature: co.signature } })
      }

      if (method === 'mono-chast') {
        if (!fopHas(fop, 'monoChast.storeSecret')) return res.status(400).json({ success: false, error: { code: 'NO_MONO_CHAST', message: 'У ФОП немає monobank Частини' } })
        if (!clientPhone) return res.status(400).json({ success: false, error: { code: 'NO_PHONE', message: 'Потрібен clientPhone' } })
        const bank = await monoChast.createOrder(fop, {
          storeOrderId: orderId, clientPhone, totalSum: amount,
          goods: goods.map((g) => ({ name: g.name, count: g.qty || 1, sum: Number(g.price) * (g.qty || 1) })),
          resultCallback: PUBLIC ? `${PUBLIC}/api/mono/chast/callback` : undefined,
        })
        order.provider = 'mono-chast'
        order.providerOrderId = String(bank.order_id || orderId)
        order.status = 'WAITING_FOR_CLIENT'
        await saveOrder(order)
        return res.json({ success: true, data: { orderId, provider: 'mono-chast', bank } })
      }

      return res.status(400).json({ success: false, error: { code: 'BAD_METHOD', message: 'Невідомий метод' } })
    } catch (e) {
      console.error('pay/create error:', (e.response && e.response.data) || e.message)
      res.status(500).json({ success: false, error: { code: 'PAY_FAILED', message: 'Не вдалося створити оплату' } })
    }
  })

  // Статус заказа (для поллинга фронтом)
  app.get('/api/pay/status', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    const o = await loadOrder(String(req.query.orderId || ''))
    if (!o) return res.status(404).json({ success: false })
    res.json({ success: true, data: { status: o.status, receiptStatus: o.receiptStatus || null, taxUrl: o.taxUrl || null, fiscalCode: o.fiscalCode || null } })
  })

  // Вебхук LiqPay (form-encoded: data + signature). Роутинг по order_id → fopId → проверка подписи ЭТОГО ФОП.
  app.post('/api/liqpay/callback', async (req, res) => {
    res.sendStatus(200) // быстрый 200; обработка в фоне
    try {
      if (!adminDb) return
      const data = req.body && req.body.data
      const signature = req.body && req.body.signature
      const decoded = liqpay.decodeCallbackData(data)
      if (!decoded || !decoded.order_id) return console.warn('liqpay callback: нет order_id')
      const order = await loadOrder(String(decoded.order_id))
      if (!order) return console.warn('liqpay callback: заказ не найден', decoded.order_id)
      const fop = getFop(order.fopId)
      if (!liqpay.verifyCallback(fop, data, signature)) return console.warn('liqpay callback: неверная подпись', order.orderId)
      if (order.receiptId) return // идемпотентно
      await saveOrder({ orderId: order.orderId, status: decoded.status, paytype: decoded.paytype || order.method, providerOrderId: decoded.payment_id ? String(decoded.payment_id) : order.providerOrderId })
      if (decoded.status === 'success') {
        await saveOrder({ orderId: order.orderId, status: 'paid' })
        await fiscalize({ ...order, status: 'paid' }, 'Оплата частинами (LiqPay)')
      }
    } catch (e) {
      console.error('liqpay callback error:', e.message)
    }
  })

  // Вебхук monobank Частин (JSON, HMAC от сырого тела в заголовке signature).
  app.post('/api/mono/chast/callback', async (req, res) => {
    res.sendStatus(200)
    try {
      if (!adminDb) return
      const body = req.body || {}
      const providerOrderId = body.order_id
      if (!providerOrderId) return
      const order = await findByProviderOrderId(providerOrderId)
      if (!order) return console.warn('mono chast callback: заказ не найден', providerOrderId)
      const fop = getFop(order.fopId)
      if (!monoChast.verifyCallbackSig(fop, req.rawBody, req.get('signature'))) return console.warn('mono chast callback: неверная подпись', order.orderId)

      const state = body.state
      await saveOrder({ orderId: order.orderId, status: state, orderSubState: body.order_sub_state || null })
      if (state === 'WAITING_FOR_STORE_CONFIRM') {
        // клиент согласился — подтверждаем заказ (спишется первый платёж → ACTIVE)
        await monoChast.confirmOrder(fop, providerOrderId).catch((e) => console.error('order/confirm:', e.message))
      } else if ((state === 'ACTIVE' || state === 'DONE') && !order.receiptId) {
        await saveOrder({ orderId: order.orderId, status: 'paid' })
        await fiscalize({ ...order, status: 'paid' }, 'Оплата частинами (monobank)')
      }
    } catch (e) {
      console.error('mono chast callback error:', e.message)
    }
  })
}

export default registerPayments
