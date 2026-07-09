// Оркестрация оплат RunFerry: приём оплаты (в т.ч. ЧАСТЯМИ) от РАЗНЫХ ФОП и АВТО-выдача
// фискального чека Checkbox тем же ФОП, что принял оплату.
//
// Главное правило (по требованию): payments/{orderId}.fopId фиксирует ФОП; фискализация
// берёт креды Checkbox по этому fopId — «кто принял оплату, тот и выдал чек».
//
// Единый обработчик «платёж подтверждён → выбить чек» общий для LiqPay и monobank Частин.
// Все секреты — в env (FOPS_CONFIG), не в коде. Подписи вебхуков обязательно проверяются.
//
// Инварианты безопасности денег (заложены по итогам аудита):
//  • amount при создании ДОЛЖЕН точно совпадать с суммой goods (в копейках) — иначе списание
//    и фискальный чек разойдутся. Единица истины — checkbox.goodsTotalKop.
//  • Фискализация «застолблена» транзакцией (claimFiscalization) → двойной колбэк не выбьет
//    два чека; плюс идемпотентность у Checkbox по детерминированному id.
//  • Терминальный статус 'paid' не откатывается поздним/повторным колбэком.
//  • Крон-реконсиляция добивает застрявшие monobank-заявки и повторяет непробитые чеки.
import crypto from 'crypto'
import { getFop, fopHas, listFopsPublic, hasAnyFop } from './fops.js'
import * as liqpay from './liqpay.js'
import * as monoChast from './monoChast.js'
import * as checkbox from './checkbox.js'

const nowIso = () => new Date().toISOString()
const newOrderId = () => 'pay-' + crypto.randomUUID().slice(0, 18)

// Валидация позиций чека: без валидных price/qty фискальный чек уйдёт с NaN/отрицательной суммой.
const validateGoods = (goods) => {
  if (!Array.isArray(goods) || !goods.length) return 'потрібні позиції (goods)'
  for (const g of goods) {
    if (!g || typeof g.name !== 'string' || !g.name.trim()) return 'у позиції немає назви'
    const price = Number(g.price)
    if (!Number.isFinite(price) || price <= 0) return `невірна ціна позиції «${g && g.name}»`
    const qty = g.qty == null ? 1 : Number(g.qty)
    if (!Number.isFinite(qty) || qty <= 0) return `невірна кількість позиції «${g.name}»`
  }
  return null
}

export function registerPayments(app, deps) {
  const { adminDb } = deps
  const PUBLIC = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  const SANDBOX = process.env.PAYMENTS_SANDBOX === 'true'
  const ADMIN_TOKEN = process.env.PAYMENTS_ADMIN_TOKEN || ''

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

  // Атомарно «застолбить» право выбить чек. true → фискализируем МЫ; false → уже выбит/в процессе.
  // Закрывает гонку двух параллельных success-колбэков (иначе оба прошли бы проверку receiptId).
  const claimFiscalization = async (orderId) =>
    adminDb.runTransaction(async (tx) => {
      const ref = col().doc(orderId)
      const snap = await tx.get(ref)
      if (!snap.exists) return false
      const d = snap.data()
      if (d.receiptId || d.fiscalizeClaimedAt) return false
      tx.set(ref, { fiscalizeClaimedAt: nowIso() }, { merge: true })
      return true
    })

  // ЕДИНЫЙ модуль фискализации: чек выбивает ФОП из order.fopId (идемпотентно + атомарный claim).
  const fiscalize = async (order, paymentLabel) => {
    if (!order || order.receiptId) return // уже выбит
    const fop = getFop(order.fopId)
    if (!fop) return
    if (!fopHas(fop, 'checkbox.licenseKey')) {
      await saveOrder({ orderId: order.orderId, receiptStatus: 'no-checkbox' })
      console.warn(`payments: ⚠️ ФОП ${order.fopId} без Checkbox — ГРОШІ Є, ЧЕК НЕ ВИБИТО для ${order.orderId}`)
      return
    }
    const claimed = await claimFiscalization(order.orderId)
    if (!claimed) return // другой колбэк/поток уже фискализирует или чек выбит
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
      // снимаем claim (fiscalizeClaimedAt=null), чтобы reconcile/повторный колбэк попробовали снова
      await saveOrder({
        orderId: order.orderId,
        receiptStatus: 'error',
        receiptError: (e.response && JSON.stringify(e.response.data)) || e.message,
        fiscalizeClaimedAt: null,
      })
      console.error(`payments: ⚠️ ОШИБКА ЧЕКА (гроші є, чек ні) ${order.orderId}:`, (e.response && e.response.data) || e.message)
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

      // Позиции валидны?
      const gErr = validateGoods(goods)
      if (gErr) return res.status(400).json({ success: false, error: { code: 'BAD_GOODS', message: gErr } })

      // Сумма положительна И ТОЧНО совпадает с суммой позиций (в копейках) — единый источник истины.
      // Так гарантируем: сколько списали, на столько и фискальный чек.
      const amountKop = checkbox.toKop(amount)
      const goodsKop = checkbox.goodsTotalKop(goods)
      if (!Number.isFinite(amountKop) || amountKop <= 0) {
        return res.status(400).json({ success: false, error: { code: 'BAD_AMOUNT', message: 'Невірна сума' } })
      }
      if (amountKop !== goodsKop) {
        return res.status(400).json({
          success: false,
          error: { code: 'AMOUNT_MISMATCH', message: `Сума (${(amountKop / 100).toFixed(2)}) не збігається з позиціями (${(goodsKop / 100).toFixed(2)})` },
        })
      }

      const orderId = newOrderId()
      const order = { orderId, fopId, amount: amountKop / 100, goods, method, status: 'pending', createdAt: nowIso(), ...(deliveryEmail ? { deliveryEmail } : {}) }

      if (method.startsWith('liqpay')) {
        if (!fopHas(fop, 'liqpay.privateKey')) return res.status(400).json({ success: false, error: { code: 'NO_LIQPAY', message: 'У ФОП немає LiqPay' } })
        const lpMethod = method === 'liqpay-paypart' ? 'paypart' : method === 'liqpay-moment' ? 'moment_part' : 'card'
        const co = liqpay.buildCheckout(fop, {
          orderId, amountUah: order.amount, description: description || `Оплата RunFerry #${orderId}`,
          method: lpMethod, serverUrl: PUBLIC ? `${PUBLIC}/api/liqpay/callback` : undefined, resultUrl, sandbox: SANDBOX,
        })
        order.provider = 'liqpay'
        await saveOrder(order)
        return res.json({ success: true, data: { orderId, provider: 'liqpay', checkoutUrl: co.checkoutUrl, data: co.data, signature: co.signature } })
      }

      if (method === 'mono-chast') {
        if (!fopHas(fop, 'monoChast.storeSecret')) return res.status(400).json({ success: false, error: { code: 'NO_MONO_CHAST', message: 'У ФОП немає monobank Частини' } })
        if (!clientPhone) return res.status(400).json({ success: false, error: { code: 'NO_PHONE', message: 'Потрібен clientPhone' } })
        // products и total_sum считаем из одного источника (Σ построчно), чтобы банк не отклонил заявку
        // из-за расхождения total_sum и суммы products (см. аудит).
        const products = goods.map((g) => ({ name: String(g.name), count: Number(g.qty) || 1, sum: Math.round(Number(g.price) * (Number(g.qty) || 1) * 100) / 100 }))
        const monoTotal = Math.round(products.reduce((s, p) => s + p.sum, 0) * 100) / 100
        const bank = await monoChast.createOrder(fop, {
          storeOrderId: orderId, clientPhone, totalSum: monoTotal, goods: products,
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

  // Статус заказа (для поллинга фронтом). orderId — это capability-token (высокоэнтропийный,
  // неперебираемый), знание id = право видеть статус своего платежа. fiscalCode НЕ отдаём
  // (внутренний фискальный код); taxUrl — ссылка на чек, законно принадлежит покупателю.
  app.get('/api/pay/status', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    const o = await loadOrder(String(req.query.orderId || ''))
    if (!o) return res.status(404).json({ success: false })
    res.json({ success: true, data: { status: o.status, receiptStatus: o.receiptStatus || null, taxUrl: o.taxUrl || null } })
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

      const isSuccess = decoded.status === 'success' || decoded.status === 'wait_accept'
      // Терминальный 'paid' не откатываем поздним/повторным колбэком; промежуточные — обновляем.
      if (order.status !== 'paid' && !isSuccess) {
        await saveOrder({ orderId: order.orderId, status: decoded.status, paytype: decoded.paytype || order.method, providerOrderId: decoded.payment_id ? String(decoded.payment_id) : order.providerOrderId })
        return
      }
      if (decoded.status !== 'success') return // wait_accept и т.п. — ждём финального success

      // Сверка суммы/валюты/песочницы перед выдачей ФИСКАЛЬНОГО чека (защита от рассинхронизации и тестовых денег).
      const paidKop = checkbox.toKop(decoded.amount)
      const okAmount = Number.isFinite(paidKop) && paidKop === checkbox.toKop(order.amount)
      const okCurrency = !decoded.currency || decoded.currency === 'UAH'
      const okSandbox = SANDBOX || !(decoded.sandbox === 1 || decoded.sandbox === '1' || decoded.sandbox === true)
      if (!okAmount || !okCurrency || !okSandbox) {
        await saveOrder({ orderId: order.orderId, status: 'paid', receiptStatus: 'amount-mismatch', receiptError: `decoded amount=${decoded.amount} ${decoded.currency} sandbox=${decoded.sandbox} (order ${order.amount} UAH)` })
        return console.warn('liqpay callback: сумма/валюта/sandbox не совпали — чек НЕ выбит', order.orderId)
      }

      if (order.status !== 'paid') await saveOrder({ orderId: order.orderId, status: 'paid', paytype: decoded.paytype || order.method, providerOrderId: decoded.payment_id ? String(decoded.payment_id) : order.providerOrderId })
      await fiscalize({ ...order, status: 'paid' }, 'Оплата частинами (LiqPay)')
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
      if (state === 'WAITING_FOR_STORE_CONFIRM') {
        // Уже оплаченный заказ не переподтверждаем (защита от реплея старого колбэка).
        if (order.status !== 'paid') {
          await saveOrder({ orderId: order.orderId, status: state, orderSubState: body.order_sub_state || null })
          // клиент согласился — подтверждаем заказ (спишется первый платёж → ACTIVE)
          await monoChast.confirmOrder(fop, providerOrderId).catch((e) => console.error('order/confirm:', e.message))
        }
      } else if (state === 'ACTIVE' || state === 'DONE') {
        if (order.status !== 'paid') await saveOrder({ orderId: order.orderId, status: 'paid', orderSubState: body.order_sub_state || null })
        await fiscalize({ ...order, status: 'paid' }, 'Оплата частинами (monobank)')
      } else if (order.status !== 'paid') {
        // FAILURE/EXPIRED/… — обновляем, но НЕ откатываем терминальный paid
        await saveOrder({ orderId: order.orderId, status: state, orderSubState: body.order_sub_state || null })
      }
    } catch (e) {
      console.error('mono chast callback error:', e.message)
    }
  })

  // Реконсиляция: колбэки банков не гарантированы → добиваем застрявшие monobank-заявки опросом
  // order/state и повторяем непробитые чеки (paid без receiptId). Транзакционный claim делает это
  // безопасным даже при нескольких инстансах Cloud Run.
  const reconcile = async () => {
    if (!adminDb || !hasAnyFop()) return { checked: 0 }
    let checked = 0
    // 1) monobank «висит» на подтверждении/активации — спросить банк напрямую.
    try {
      const stuck = await col().where('status', '==', 'WAITING_FOR_STORE_CONFIRM').limit(50).get()
      for (const doc of stuck.docs) {
        const o = doc.data()
        if (o.provider !== 'mono-chast' || !o.providerOrderId) continue
        const fop = getFop(o.fopId)
        if (!fop) continue
        checked++
        try {
          const st = await monoChast.orderState(fop, o.providerOrderId)
          const s = st && st.state
          if (s === 'ACTIVE' || s === 'DONE') {
            await saveOrder({ orderId: o.orderId, status: 'paid' })
            await fiscalize({ ...o, status: 'paid' }, 'Оплата частинами (monobank)')
          } else if (s === 'WAITING_FOR_STORE_CONFIRM') {
            await monoChast.confirmOrder(fop, o.providerOrderId).catch(() => {})
          } else if (s) {
            await saveOrder({ orderId: o.orderId, status: s })
          }
        } catch (e) { console.error('reconcile mono', o.orderId, e.message) }
      }
    } catch (e) { console.error('reconcile stuck query:', e.message) }
    // 2) деньги есть, чек не выбит (error) — повторить фискализацию.
    try {
      const failed = await col().where('receiptStatus', '==', 'error').limit(50).get()
      for (const doc of failed.docs) {
        const o = doc.data()
        if (o.status !== 'paid' || o.receiptId) continue
        checked++
        await fiscalize(o, o.provider === 'liqpay' ? 'Оплата частинами (LiqPay)' : 'Оплата частинами (monobank)')
      }
    } catch (e) { console.error('reconcile failed query:', e.message) }
    return { checked }
  }

  // Ручной триггер реконсиляции (для крон-джобы/админки). Защищён токеном PAYMENTS_ADMIN_TOKEN.
  app.post('/api/pay/reconcile', async (req, res) => {
    if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(403).json({ success: false })
    const r = await reconcile()
    res.json({ success: true, data: r })
  })

  // Список «гроші є, чек ні» (paid без receiptId) — для админки/мониторинга. Защищён токеном.
  app.get('/api/pay/unfiscalized', async (req, res) => {
    if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(403).json({ success: false })
    if (!adminDb) return res.status(503).json({ success: false })
    const q = await col().where('status', '==', 'paid').limit(200).get()
    const items = q.docs.map((d) => d.data()).filter((o) => !o.receiptId)
      .map((o) => ({ orderId: o.orderId, fopId: o.fopId, amount: o.amount, receiptStatus: o.receiptStatus || null, receiptError: o.receiptError || null, createdAt: o.createdAt }))
    res.json({ success: true, data: items })
  })

  // Периодическая реконсиляция (Cloud Run с --no-cpu-throttling держит инстанс живым).
  // Отключается PAYMENTS_RECONCILE=false; период — PAYMENTS_RECONCILE_MS (по умолчанию 3 мин).
  if (adminDb && process.env.PAYMENTS_RECONCILE !== 'false') {
    const everyMs = Number(process.env.PAYMENTS_RECONCILE_MS) || 180000
    const t = setInterval(() => { reconcile().catch((e) => console.error('reconcile loop:', e.message)) }, everyMs)
    if (t.unref) t.unref()
  }
}

export default registerPayments
