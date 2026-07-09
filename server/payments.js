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

  // Обратная запись в фактическую смету (priceEstimates), из которой создана оплата.
  // Деньги пришли → смета 'paid' + ссылки на платёж/чек. Пишем backend-ом (минуя правила).
  const markEstimatePaid = async (order, receipt) => {
    if (!order || !order.estimateId) return
    try {
      await adminDb.collection('priceEstimates').doc(String(order.estimateId)).set({
        status: 'paid',
        paymentId: order.orderId,
        fopId: order.fopId,
        paidAt: nowIso(),
        ...(receipt ? { taxUrl: receipt.taxUrl || null, fiscalCode: receipt.fiscalCode || null } : {}),
        updatedAt: nowIso(),
      }, { merge: true })
    } catch (e) {
      console.error('estimate writeback:', e.message)
    }
  }

  // ЕДИНЫЙ модуль фискализации: чек выбивает ФОП из order.fopId (идемпотентно + атомарный claim).
  const fiscalize = async (order, paymentLabel) => {
    if (!order || order.receiptId) return // уже выбит
    const fop = getFop(order.fopId)
    if (!fop) return
    if (!fopHas(fop, 'checkbox.licenseKey')) {
      await saveOrder({ orderId: order.orderId, receiptStatus: 'no-checkbox' })
      await markEstimatePaid(order, null) // деньги есть, чека не будет (ФОП без ПРРО)
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
      await markEstimatePaid(order, res)
      console.log(`payments: чек выписан ${order.orderId} (ФОП ${order.fopId}) fiscal=${res.fiscalCode}`)
    } catch (e) {
      // снимаем claim (fiscalizeClaimedAt=null), чтобы reconcile/повторный колбэк попробовали снова
      await saveOrder({
        orderId: order.orderId,
        receiptStatus: 'error',
        receiptError: (e.response && JSON.stringify(e.response.data)) || e.message,
        fiscalizeClaimedAt: null,
      })
      await markEstimatePaid(order, null) // деньги пришли; чек добьёт reconcile и допишет taxUrl
      console.error(`payments: ⚠️ ОШИБКА ЧЕКА (гроші є, чек ні) ${order.orderId}:`, (e.response && e.response.data) || e.message)
    }
  }

  // Публичный список ФОП + доступные методы (для UI выбора, без секретов)
  app.get('/api/fops', (req, res) => res.json({ success: true, data: listFopsPublic() }))

  // Ядро создания оплаты (переиспользуется HTTP-роутом и оплатой из сметы).
  // Возвращает { ok:true, data } или { ok:false, status, code, message }. Деньги — server-authoritative:
  // amount обязан точно совпадать с суммой позиций (в копейках), иначе чек и списание разойдутся.
  const createPayment = async ({ fopId, amount, goods, method = 'liqpay-card', description, clientPhone, resultUrl, deliveryEmail, estimateId }) => {
    const fop = getFop(fopId)
    if (!fop) return { ok: false, status: 400, code: 'BAD_FOP', message: 'Невідомий ФОП' }

    const gErr = validateGoods(goods)
    if (gErr) return { ok: false, status: 400, code: 'BAD_GOODS', message: gErr }

    const amountKop = checkbox.toKop(amount)
    const goodsKop = checkbox.goodsTotalKop(goods)
    if (!Number.isFinite(amountKop) || amountKop <= 0) return { ok: false, status: 400, code: 'BAD_AMOUNT', message: 'Невірна сума' }
    if (amountKop !== goodsKop) {
      return { ok: false, status: 400, code: 'AMOUNT_MISMATCH', message: `Сума (${(amountKop / 100).toFixed(2)}) не збігається з позиціями (${(goodsKop / 100).toFixed(2)})` }
    }

    const orderId = newOrderId()
    const order = {
      orderId, fopId, amount: amountKop / 100, goods, method, status: 'pending', createdAt: nowIso(),
      ...(deliveryEmail ? { deliveryEmail } : {}), ...(estimateId ? { estimateId: String(estimateId) } : {}),
    }

    if (method.startsWith('liqpay')) {
      if (!fopHas(fop, 'liqpay.privateKey')) return { ok: false, status: 400, code: 'NO_LIQPAY', message: 'У ФОП немає LiqPay' }
      const lpMethod = method === 'liqpay-paypart' ? 'paypart' : method === 'liqpay-moment' ? 'moment_part' : 'card'
      const co = liqpay.buildCheckout(fop, {
        orderId, amountUah: order.amount, description: description || `Оплата RunFerry #${orderId}`,
        method: lpMethod, serverUrl: PUBLIC ? `${PUBLIC}/api/liqpay/callback` : undefined, resultUrl, sandbox: SANDBOX,
      })
      order.provider = 'liqpay'
      await saveOrder(order)
      return { ok: true, data: { orderId, provider: 'liqpay', checkoutUrl: co.checkoutUrl, data: co.data, signature: co.signature } }
    }

    if (method === 'mono-chast') {
      if (!fopHas(fop, 'monoChast.storeSecret')) return { ok: false, status: 400, code: 'NO_MONO_CHAST', message: 'У ФОП немає monobank Частини' }
      if (!clientPhone) return { ok: false, status: 400, code: 'NO_PHONE', message: 'Потрібен clientPhone' }
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
      return { ok: true, data: { orderId, provider: 'mono-chast', bank } }
    }

    return { ok: false, status: 400, code: 'BAD_METHOD', message: 'Невідомий метод' }
  }

  // Создать оплату. body: { fopId, amount, goods:[{name,price,qty}], method, description, clientPhone?, resultUrl?, deliveryEmail?, estimateId? }
  // method: 'liqpay-card' | 'liqpay-paypart' | 'liqpay-moment' | 'mono-chast'
  app.post('/api/pay/create', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false, error: { code: 'NO_DB', message: 'Firestore не настроен' } })
    if (!hasAnyFop()) return res.status(503).json({ success: false, error: { code: 'NO_FOPS', message: 'ФОП не настроены (FOPS_CONFIG)' } })
    try {
      const r = await createPayment(req.body || {})
      if (!r.ok) return res.status(r.status).json({ success: false, error: { code: r.code, message: r.message } })
      return res.json({ success: true, data: r.data })
    } catch (e) {
      console.error('pay/create error:', (e.response && e.response.data) || e.message)
      res.status(500).json({ success: false, error: { code: 'PAY_FAILED', message: 'Не вдалося створити оплату' } })
    }
  })

  // Оплатить ФАКТИЧЕСКУЮ смету: деньги и позиции берём из persisted-сметы (priceEstimates),
  // а не из тела запроса — smету собирает мастер в админке, оплату инициирует по её id.
  // body: { estimateId, fopId?, method?, clientPhone?, resultUrl?, deliveryEmail?, description? }
  app.post('/api/estimates/pay', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false, error: { code: 'NO_DB', message: 'Firestore не настроен' } })
    if (!hasAnyFop()) return res.status(503).json({ success: false, error: { code: 'NO_FOPS', message: 'ФОП не настроены (FOPS_CONFIG)' } })
    try {
      const { estimateId, fopId, method, clientPhone, resultUrl, deliveryEmail, description } = req.body || {}
      if (!estimateId) return res.status(400).json({ success: false, error: { code: 'NO_ESTIMATE', message: 'Потрібен estimateId' } })
      const snap = await adminDb.collection('priceEstimates').doc(String(estimateId)).get()
      if (!snap.exists) return res.status(404).json({ success: false, error: { code: 'ESTIMATE_NOT_FOUND', message: 'Кошторис не знайдено' } })
      const est = snap.data()
      if (est.kind !== 'actual') return res.status(400).json({ success: false, error: { code: 'NOT_ACTUAL', message: 'Оплата лише з фактичного кошторису' } })
      if (est.paymentId || est.status === 'paid') return res.status(409).json({ success: false, error: { code: 'ALREADY_PAID', message: 'Кошторис уже оплачено' } })
      if (est.status === 'pending_approval') return res.status(409).json({ success: false, error: { code: 'NEEDS_APPROVAL', message: 'Кошторис очікує погодження клієнта' } })
      const goods = est.receiptGoods
      if (!Array.isArray(goods) || !goods.length) return res.status(400).json({ success: false, error: { code: 'NO_GOODS', message: 'У кошторисі немає позицій для чека' } })

      const useFopId = fopId || est.fopId
      const r = await createPayment({
        fopId: useFopId, amount: est.total, goods, method: method || 'liqpay-card',
        description: description || `Оплата RunFerry (кошторис ${estimateId})`,
        clientPhone, resultUrl, deliveryEmail: deliveryEmail || undefined, estimateId,
      })
      if (!r.ok) return res.status(r.status).json({ success: false, error: { code: r.code, message: r.message } })
      // Зафиксируем выбранный ФОП на смете (провайдер оплаты определён)
      await adminDb.collection('priceEstimates').doc(String(estimateId)).set({ fopId: useFopId, updatedAt: nowIso() }, { merge: true }).catch(() => {})
      return res.json({ success: true, data: r.data })
    } catch (e) {
      console.error('estimates/pay error:', (e.response && e.response.data) || e.message)
      res.status(500).json({ success: false, error: { code: 'PAY_FAILED', message: 'Не вдалося створити оплату' } })
    }
  })

  // Согласование/отклонение роста фактической сметы клиентом. Доступ по знанию id сметы
  // (криптостойкий capability-token, как chatSessions). Пишем backend-ом (клиент правила не проходит).
  const setEstimateStatus = async (id, status, extra = {}) => {
    const ref = adminDb.collection('priceEstimates').doc(String(id))
    const snap = await ref.get()
    if (!snap.exists) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Кошторис не знайдено' }
    const est = snap.data()
    if (est.paymentId || est.status === 'paid') return { ok: false, status: 409, code: 'ALREADY_PAID', message: 'Кошторис уже оплачено' }
    await ref.set({ status, updatedAt: nowIso(), ...extra }, { merge: true })
    return { ok: true }
  }

  app.post('/api/estimates/:id/approve', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const r = await setEstimateStatus(req.params.id, 'approved', { approvedAt: nowIso() })
      if (!r.ok) return res.status(r.status).json({ success: false, error: { code: r.code, message: r.message } })
      return res.json({ success: true })
    } catch (e) {
      console.error('estimate approve:', e.message)
      res.status(500).json({ success: false })
    }
  })

  app.post('/api/estimates/:id/reject', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const r = await setEstimateStatus(req.params.id, 'rejected', { rejectedAt: nowIso() })
      if (!r.ok) return res.status(r.status).json({ success: false, error: { code: r.code, message: r.message } })
      return res.json({ success: true })
    } catch (e) {
      console.error('estimate reject:', e.message)
      res.status(500).json({ success: false })
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
