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
import axios from 'axios'
import { getAuth } from 'firebase-admin/auth'
import { getFop, fopHas, listFopsPublic, hasAnyFop } from './fops.js'
import * as liqpay from './liqpay.js'
import * as monoChast from './monoChast.js'
import * as monoAcquire from './monoAcquire.js'
import * as checkbox from './checkbox.js'

const nowIso = () => new Date().toISOString()
const ADMIN_EMAIL = 'admin@runferry.de'
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

  const OWNER_CHAT = process.env.OWNER_TELEGRAM_CHAT_ID || ''
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''

  // Админ-запрос: общий токен (крон) ИЛИ Firebase ID-токен админа (админ-UI, Authorization: Bearer).
  const isAdminReq = async (req) => {
    if (ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN) return true
    const m = (req.get('authorization') || '').match(/^Bearer (.+)$/)
    if (!m) return false
    try {
      const dec = await getAuth().verifyIdToken(m[1], true) // checkRevoked
      return dec.email === ADMIN_EMAIL && dec.email_verified === true
    } catch {
      return false
    }
  }

  // Уведомление владельцу в Telegram (для «гроші є, чек ні»). Один раз на заказ (ownerNotified).
  const notifyOwner = async (text) => {
    if (!OWNER_CHAT || !TG_TOKEN) return
    try {
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { chat_id: OWNER_CHAT, text }, { timeout: 8000 })
    } catch (e) {
      console.error('notifyOwner:', e.message)
    }
  }
  const notifyOwnerNoReceipt = async (order, reason) => {
    if (!order || order.ownerNotified) return
    // Атомарно «застолбить» отправку (ownerNotified), чтобы параллельные ретрай-вебхуки не
    // задублировали алерт. Ветка no-checkbox идёт до claimFiscalization, поэтому свой claim здесь.
    let claimed = false
    try {
      claimed = await adminDb.runTransaction(async (tx) => {
        const ref = col().doc(order.orderId)
        const s = await tx.get(ref)
        if (!s.exists || s.data().ownerNotified) return false
        tx.set(ref, { ownerNotified: true }, { merge: true })
        return true
      })
    } catch (e) {
      console.error('ownerNotified claim:', e.message)
      return
    }
    if (!claimed) return
    await notifyOwner(`⚠️ RunFerry: оплата ${order.orderId} на ${order.amount} грн пройшла, але ЧЕК НЕ ВИБИТО (${reason}). ФОП ${order.fopId}. Перевірте в адмінці оплат.`)
  }

  // Обратная запись «деньги пришли» в документ-источник оплаты: фактическую смету
  // (priceEstimates + связанная заявка) и/или замовлення кораблика (boatOrders).
  // Пишем backend-ом (минуя правила). Блоки независимы: ошибка одного не валит другой.
  const markEstimatePaid = async (order, receipt) => {
    if (!order) return
    if (order.estimateId) {
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
    // Привязываем оплату к нашей заявке. Статус → 'done', но НЕ «воскрешаем» скасовану заявку.
    if (order.serviceRequestId) {
      try {
        const srRef = adminDb.collection('serviceRequests').doc(String(order.serviceRequestId))
        await adminDb.runTransaction(async (tx) => {
          const s = await tx.get(srRef)
          const p = { paymentId: order.orderId, updatedAt: nowIso() }
          if (!s.exists || s.data().status !== 'cancelled') p.status = 'done'
          tx.set(srRef, p, { merge: true })
        })
      } catch (e) {
        console.error('serviceRequest writeback:', e.message)
      }
    }
    // Замовлення кораблика: фиксируем оплату/чек (статус НЕ трогаем — ход выполнения ведёт админ).
    if (order.boatOrderId) {
      try {
        await adminDb.collection('boatOrders').doc(String(order.boatOrderId)).set({
          paidAt: nowIso(),
          paymentId: order.orderId,
          ...(receipt ? { taxUrl: receipt.taxUrl || null, fiscalCode: receipt.fiscalCode || null } : {}),
          updatedAt: nowIso(),
        }, { merge: true })
      } catch (e) {
        console.error('boatOrder writeback:', e.message)
      }
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
      await notifyOwnerNoReceipt(order, 'ФОП без Checkbox')
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
      await notifyOwnerNoReceipt(order, 'помилка Checkbox')
      console.error(`payments: ⚠️ ОШИБКА ЧЕКА (гроші є, чек ні) ${order.orderId}:`, (e.response && e.response.data) || e.message)
    }
  }

  // Публичный список ФОП + доступные методы (для UI выбора, без секретов)
  app.get('/api/fops', (req, res) => res.json({ success: true, data: listFopsPublic() }))

  // Ядро создания оплаты (переиспользуется HTTP-роутом и оплатой из сметы).
  // Возвращает { ok:true, data } или { ok:false, status, code, message }. Деньги — server-authoritative:
  // amount обязан точно совпадать с суммой позиций (в копейках), иначе чек и списание разойдутся.
  const createPayment = async ({ fopId, amount, goods, method = 'liqpay-card', description, clientPhone, resultUrl, deliveryEmail, estimateId, serviceRequestId, boatOrderId }) => {
    const fop = getFop(fopId)
    if (!fop) return { ok: false, status: 400, code: 'BAD_FOP', message: 'Невідомий ФОП' }
    // Новую оплату НЕ принимаем на выключенный ФОП (но getFop его резолвит для старых заказов).
    if (fop.active === false) return { ok: false, status: 400, code: 'FOP_INACTIVE', message: 'ФОП вимкнено' }

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
      ...(serviceRequestId ? { serviceRequestId: String(serviceRequestId) } : {}),
      ...(boatOrderId ? { boatOrderId: String(boatOrderId) } : {}),
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

    if (method === 'mono-acquire') {
      if (!fopHas(fop, 'monoAcquire.token')) return { ok: false, status: 400, code: 'NO_MONO_ACQUIRE', message: 'У ФОП немає monobank еквайрингу' }
      // basketOrder в копейках; построчное округление КАК в Checkbox → Σ позиций == goodsKop == amount
      // сметы (иначе monobank отклонит amount≠Σ, или спишет иначе, чем в чеке).
      const lineKop = (priceUah, qty) => Math.round((Math.round(Number(priceUah) * 100) * Math.round((qty || 1) * 1000)) / 1000)
      const basket = goods.map((g) => ({ name: String(g.name), qty: Number(g.qty) || 1, sumKop: lineKop(g.price, Number(g.qty) || 1), code: g.code }))
      const amountKop = basket.reduce((s, b) => s + b.sumKop, 0)
      const inv = await monoAcquire.createInvoice(fop, {
        amountKop, reference: orderId, destination: description || `Оплата RunFerry #${orderId}`, goods: basket,
        redirectUrl: resultUrl, webHookUrl: PUBLIC ? `${PUBLIC}/api/mono/acquire/callback` : undefined,
      })
      order.provider = 'mono-acquire'
      order.providerOrderId = String(inv.invoiceId || orderId)
      order.status = 'pending'
      await saveOrder(order)
      return { ok: true, data: { orderId, provider: 'mono-acquire', pageUrl: inv.pageUrl } }
    }

    return { ok: false, status: 400, code: 'BAD_METHOD', message: 'Невідомий метод' }
  }

  // Создать оплату. body: { fopId, amount, goods:[{name,price,qty}], method, description, clientPhone?, resultUrl?, deliveryEmail?, estimateId? }
  // method: 'liqpay-card' | 'liqpay-paypart' | 'liqpay-moment' | 'mono-chast'
  // ВНИМАНИЕ: произвольная оплата (сумма/goods/fopId из тела) — ТОЛЬКО админ. Клиент платит
  // фактическую смету через /api/estimates/pay (там сумма/статус берутся из БД, а не от клиента).
  // Публичный доступ сюда позволял бы оплатить смету на любую сумму и пометить её оплаченной.
  app.post('/api/pay/create', async (req, res) => {
    if (!(await isAdminReq(req))) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для адміністратора' } })
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
      // fopId из тела ИГНОРИРУЕМ — ФОП жёстко берётся со сметы (назначил мастер): «кто принял — тот и чек».
      const { estimateId, method, clientPhone, resultUrl, deliveryEmail, description } = req.body || {}
      if (!estimateId) return res.status(400).json({ success: false, error: { code: 'NO_ESTIMATE', message: 'Потрібен estimateId' } })
      const ref = adminDb.collection('priceEstimates').doc(String(estimateId))

      // Транзакционно проверяем статус и «застолбляем» инициацию оплаты (защита от двойного заказа).
      const claim = await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        if (!s.exists) return { ok: false, status: 404, code: 'ESTIMATE_NOT_FOUND', message: 'Кошторис не знайдено' }
        const e = s.data()
        if (e.kind !== 'actual') return { ok: false, status: 400, code: 'NOT_ACTUAL', message: 'Оплата лише з фактичного кошторису' }
        if (e.paymentId || e.status === 'paid') return { ok: false, status: 409, code: 'ALREADY_PAID', message: 'Кошторис уже оплачено' }
        if (e.status === 'rejected') return { ok: false, status: 409, code: 'REJECTED', message: 'Кошторис відхилено' }
        if (e.status === 'pending_approval') return { ok: false, status: 409, code: 'NEEDS_APPROVAL', message: 'Кошторис очікує погодження клієнта' }
        if (e.status !== 'approved') return { ok: false, status: 409, code: 'NOT_APPROVED', message: 'Кошторис не погоджено' }
        if (!Array.isArray(e.receiptGoods) || !e.receiptGoods.length) return { ok: false, status: 400, code: 'NO_GOODS', message: 'У кошторисі немає позицій для чека' }
        if (!e.fopId) return { ok: false, status: 400, code: 'NO_FOP', message: 'ФОП для кошторису не призначено' }
        const recent = e.payInitiatedAt && Date.now() - Date.parse(e.payInitiatedAt) < 3 * 60 * 1000
        if (recent) return { ok: false, status: 409, code: 'PAY_IN_PROGRESS', message: 'Оплата вже створюється — оновіть сторінку за хвилину' }
        tx.set(ref, { payInitiatedAt: nowIso() }, { merge: true })
        return { ok: true, est: e }
      })
      if (!claim.ok) return res.status(claim.status).json({ success: false, error: { code: claim.code, message: claim.message } })

      const est = claim.est
      // Целостность пути: факт должен быть по ВЫБРАННОМУ клиентом варианту. Если факт собран по
      // варианту A, а клиент затем переизбрал B — не даём оплатить «не тот» путь (снимаем claim).
      if (est.parentEstimateId) {
        const pSnap = await adminDb.collection('priceEstimates').doc(String(est.parentEstimateId)).get()
        const parent = pSnap.exists ? pSnap.data() : null
        if (parent && parent.offerId) {
          const oSnap = await adminDb.collection('estimateOffers').doc(String(parent.offerId)).get()
          const offer = oSnap.exists ? oSnap.data() : null
          if (offer && offer.selectedVariantId && offer.selectedVariantId !== est.parentEstimateId) {
            await ref.set({ payInitiatedAt: null }, { merge: true }).catch(() => {})
            return res.status(409).json({ success: false, error: { code: 'PATH_CHANGED', message: 'Клієнт змінив обраний варіант — потрібен новий фактичний кошторис' } })
          }
        }
      }
      const goods = est.receiptGoods
      // Сумма к оплате = согласованный total сметы. createPayment сверит amount==Σ(goods): для
      // корректной сметы совпадёт (estimate2goods точен по построению), а если позиции не
      // покрывают total (напр. знижкові/від'ємні рядки не потрапили в чек) — оплата будет
      // отклонена AMOUNT_MISMATCH, а не тихо спишет с клиента больше/меньше согласованного.
      const amount = est.total
      // ФОП зависит от ВЫБРАННОГО клиентом способа: берём из payOptions сметы (дефолт из центра,
      // выставлен мастером — «кто принял, тот и чек»). У старых смет без payOptions — единый est.fopId.
      const chosenMethod = method || 'liqpay-card'
      const methodKey = { 'liqpay-card': 'liqpayCard', 'liqpay-paypart': 'liqpayPaypart', 'liqpay-moment': 'liqpayPaypart', 'mono-chast': 'monoChast', 'mono-acquire': 'monoAcquire' }[chosenMethod]
      let payFopId = est.fopId
      if (Array.isArray(est.payOptions) && est.payOptions.length) {
        const opt = est.payOptions.find((o) => o && o.method === methodKey && o.fopId)
        if (!opt) {
          await ref.set({ payInitiatedAt: null }, { merge: true }).catch(() => {}) // снять claim
          return res.status(400).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Цей спосіб оплати недоступний для кошторису' } })
        }
        payFopId = opt.fopId
      }
      try {
        const r = await createPayment({
          fopId: payFopId, amount, goods, method: chosenMethod,
          description: description || `Оплата RunFerry (кошторис ${estimateId})`,
          clientPhone, resultUrl, deliveryEmail: deliveryEmail || undefined, estimateId,
          serviceRequestId: est.serviceRequestId || null,
        })
        if (!r.ok) {
          await ref.set({ payInitiatedAt: null }, { merge: true }).catch(() => {}) // снять claim → можно повторить
          return res.status(r.status).json({ success: false, error: { code: r.code, message: r.message } })
        }
        return res.json({ success: true, data: r.data })
      } catch (err) {
        await ref.set({ payInitiatedAt: null }, { merge: true }).catch(() => {})
        throw err
      }
    } catch (e) {
      console.error('estimates/pay error:', (e.response && e.response.data) || e.message)
      res.status(500).json({ success: false, error: { code: 'PAY_FAILED', message: 'Не вдалося створити оплату' } })
    }
  })

  // Оплата ЗАМОВЛЕННЯ КОРАБЛИКА (boatOrders): сумма и позиции берутся из документа замовлення
  // (server-authoritative), метод и ФОП выбирает админ. Только админ: замовлення создаёт он же.
  // Правило дропшипа: payTo='dropshipper' ⇒ гроші отримує дропшипер — посилання/чек не наші (409).
  // body: { boatOrderId, fopId, method, deliveryEmail?, resultUrl? }
  app.post('/api/boat-orders/pay', async (req, res) => {
    if (!(await isAdminReq(req))) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для адміністратора' } })
    if (!adminDb) return res.status(503).json({ success: false, error: { code: 'NO_DB', message: 'Firestore не настроен' } })
    if (!hasAnyFop()) return res.status(503).json({ success: false, error: { code: 'NO_FOPS', message: 'ФОП не настроены (FOPS_CONFIG)' } })
    try {
      const { boatOrderId, fopId, method, deliveryEmail, resultUrl } = req.body || {}
      if (!boatOrderId || !fopId || !method) {
        return res.status(400).json({ success: false, error: { code: 'BAD_REQ', message: 'Потрібні boatOrderId, fopId і method' } })
      }
      const ref = adminDb.collection('boatOrders').doc(String(boatOrderId))

      // Транзакционно проверяем состояние и «застолбляем» инициацию (защита от двойной оплаты).
      const claim = await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        if (!s.exists) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Замовлення не знайдено' }
        const o = s.data()
        if (o.payTo === 'dropshipper') return { ok: false, status: 409, code: 'DROPSHIP_PAY', message: 'Гроші отримує дропшипер — посилання на оплату і чек на його стороні' }
        // Оплачене — блок; НЕоплачений існуючий лінк можна перевиставити (інший метод/ФОП):
        // повторний вебхук старого лінка все одно припишеться до цього ж замовлення.
        if (o.paidAt) return { ok: false, status: 409, code: 'ALREADY_PAID', message: 'Замовлення вже оплачено' }
        if (o.status === 'cancelled') return { ok: false, status: 409, code: 'CANCELLED', message: 'Замовлення скасовано' }
        if (!Array.isArray(o.lines) || !o.lines.length) return { ok: false, status: 400, code: 'NO_LINES', message: 'У замовленні немає рядків вартості' }
        const recent = o.payInitiatedAt && Date.now() - Date.parse(o.payInitiatedAt) < 3 * 60 * 1000
        if (recent) return { ok: false, status: 409, code: 'PAY_IN_PROGRESS', message: 'Оплата вже створюється — спробуйте за хвилину' }
        tx.set(ref, { payInitiatedAt: nowIso() }, { merge: true })
        return { ok: true, bo: o }
      })
      if (!claim.ok) return res.status(claim.status).json({ success: false, error: { code: claim.code, message: claim.message } })

      const bo = claim.bo
      // Чек — построчно (назва+вартість, кількість при qty≠1); код позиції обов'язковий для каси.
      // Додаткова знижка рядка (extraOff %/грн) вшита в ефективну ціну за одиницю — ТА САМА
      // формула, що в UI (types/boats.ts): gross=r2(price*qty); off=min(gross, pct? r2(gross*p/100): r2(off));
      // effUnit=r2((gross-off)/qty). Тоді замовлення, списання і чек сходяться копійка в копійку.
      const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100
      const effUnit = (l) => {
        const qty = Number(l.qty) || 1
        const gross = r2((Number(l.price) || 0) * qty)
        const raw = Number(l.extraOff) || 0
        const off = raw > 0 ? Math.min(l.extraOffKind === 'pct' ? r2((gross * raw) / 100) : r2(raw), gross) : 0
        return r2((gross - off) / qty)
      }
      const goods = bo.lines.map((l, i) => ({ name: String(l.label || `Позиція ${i + 1}`), price: effUnit(l), qty: Number(l.qty) || 1, code: `POS-${i + 1}` }))
      try {
        const r = await createPayment({
          fopId, amount: bo.total, goods, method,
          description: `Оплата кораблика (замовлення ${boatOrderId})`,
          clientPhone: bo.clientPhone || undefined, resultUrl, deliveryEmail: deliveryEmail || undefined,
          boatOrderId,
        })
        if (!r.ok) {
          await ref.set({ payInitiatedAt: null }, { merge: true }).catch(() => {}) // снять claim → можно повторить
          return res.status(r.status).json({ success: false, error: { code: r.code, message: r.message } })
        }
        // Ссылку/платёж фиксируем на замовленні — для UI и повторного показа.
        await ref.set({
          paymentId: r.data.orderId, payMethod: method,
          payUrl: r.data.pageUrl || r.data.checkoutUrl || null,
          payCreatedAt: nowIso(), payInitiatedAt: null, updatedAt: nowIso(),
        }, { merge: true }).catch(() => {})
        return res.json({ success: true, data: r.data })
      } catch (err) {
        await ref.set({ payInitiatedAt: null }, { merge: true }).catch(() => {})
        throw err
      }
    } catch (e) {
      console.error('boat-orders/pay error:', (e.response && e.response.data) || e.message)
      res.status(500).json({ success: false, error: { code: 'PAY_FAILED', message: 'Не вдалося створити оплату' } })
    }
  })

  // Согласование/отклонение роста фактической сметы клиентом. Доступ по знанию id сметы
  // (криптостойкий capability-token). Пишем backend-ом (клиент правила не проходит). Переходы
  // валидируются: approve только из pending_approval; reject терминален; paid неизменяем.
  const setEstimateStatus = async (id, status, allowedFrom, extra = {}) => {
    const ref = adminDb.collection('priceEstimates').doc(String(id))
    // Транзакция: проверка допустимости перехода и запись атомарны (нет гонки approve/reject).
    return adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Кошторис не знайдено' }
      const est = snap.data()
      if (est.paymentId || est.status === 'paid') return { ok: false, status: 409, code: 'ALREADY_PAID', message: 'Кошторис уже оплачено' }
      if (est.status === 'rejected') return { ok: false, status: 409, code: 'REJECTED', message: 'Кошторис відхилено остаточно' }
      if (allowedFrom && !allowedFrom.includes(est.status || 'approved')) {
        return { ok: false, status: 409, code: 'BAD_STATE', message: 'Недопустимий перехід статусу' }
      }
      tx.set(ref, { status, updatedAt: nowIso(), ...extra }, { merge: true })
      return { ok: true }
    })
  }

  app.post('/api/estimates/:id/approve', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const r = await setEstimateStatus(req.params.id, 'approved', ['pending_approval'], { approvedAt: nowIso() })
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
      const r = await setEstimateStatus(req.params.id, 'rejected', ['pending_approval', 'approved'], { rejectedAt: nowIso() })
      if (!r.ok) return res.status(r.status).json({ success: false, error: { code: r.code, message: r.message } })
      return res.json({ success: true })
    } catch (e) {
      console.error('estimate reject:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Публичный БЕЗОПАСНЫЙ вид сметы для клиента (без внутренней экономики/PII: ставка, подытоги,
  // сезонный коэффициент, createdBy, requestId, receiptGoods — не отдаются). Клиент грузит смету
  // через этот эндпоинт, а не напрямую из Firestore (правило get закрыто до админа).
  const safeEstimate = (e) => e ? ({
    id: e.id,
    title: e.title || '',
    complaint: e.complaint || '',
    kind: e.kind || 'preliminary',
    stage: e.stage || (e.kind === 'actual' ? 'actual' : 'proposed'),
    variantLabel: e.variantLabel || '',
    status: e.status || 'approved',
    total: e.total,
    // Знижка кошторису (вже вшита в рядки) — для показу клієнту «було / знижка / разом».
    discount: e.discount || null,
    currency: e.currency || 'UAH',
    lines: (e.lines || []).map((l) => ({ type: l.type, refId: l.refId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, complaintIndex: l.complaintIndex ?? null })),
    // Разрезы по требованиям (только метка + направление — клиенту показываем структуру, без внутреннего).
    sections: Array.isArray(e.sections) ? e.sections.map((s) => ({ complaint: s.complaint || '', serviceKind: s.serviceKind || null })) : null,
    fopId: e.fopId || null,
    // Разрешённые способы оплаты (только ключи, без fopId — сервер сам резолвит ФОП при оплате).
    payMethods: Array.isArray(e.payOptions) ? e.payOptions.map((o) => o && o.method).filter(Boolean) : [],
    parentEstimateId: e.parentEstimateId || null,
    paid: e.status === 'paid' || !!e.paidAt,
    paidAt: e.paidAt || null,
    updatedAt: e.updatedAt || null, // время последнего сохранения (для истории)
    taxUrl: e.taxUrl || null,
    // История правок (снимки прежних версий) — без editedBy (внутреннее). Видно и клиенту.
    history: Array.isArray(e.history) ? e.history.map((v) => ({
      at: v.at || null,
      total: v.total,
      lines: (v.lines || []).map((l) => ({ type: l.type, refId: l.refId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, complaintIndex: l.complaintIndex ?? null })),
      sections: Array.isArray(v.sections) ? v.sections.map((s) => ({ complaint: s.complaint || '', serviceKind: s.serviceKind || null })) : null,
    })) : [],
  }) : null

  // Контекст сметы для клиента: обращение (канал), зафиксированная в заявке жалоба + кораблик,
  // диагностика, предложения (варианты) и какой выбран. Всё — данные самого клиента (по id сметы).
  const buildEstimateContext = async (e) => {
    try {
      const srId = e && e.serviceRequestId
      if (!srId) return null
      const rs = await adminDb.collection('serviceRequests').doc(String(srId)).get()
      if (!rs.exists) return null
      const r = rs.data()
      let offer = null
      if (r.offerId) {
        const os = await adminDb.collection('estimateOffers').doc(String(r.offerId)).get()
        if (os.exists) {
          const o = os.data()
          const variants = []
          for (const vid of (o.variantIds || [])) {
            const vs = await adminDb.collection('priceEstimates').doc(String(vid)).get()
            if (vs.exists) { const vd = vs.data(); variants.push({ id: String(vid), label: vd.variantLabel || 'Варіант', total: vd.total, chosen: o.selectedVariantId === vid }) }
          }
          offer = { selectedVariantId: o.selectedVariantId || null, variants }
        }
      }
      let channel = null
      if (r.sessionId) {
        const cs = await adminDb.collection('chatSessions').doc(String(r.sessionId)).get()
        if (cs.exists) channel = cs.data().channel || null
      }
      return {
        complaint: r.complaint || '',
        boat: r.boat || '',
        diagnostics: r.diagnostics && r.diagnostics.text ? { text: r.diagnostics.text, at: r.diagnostics.at || null } : null,
        channel,
        offer,
      }
    } catch (err) {
      console.error('buildEstimateContext:', err.message)
      return null
    }
  }

  app.get('/api/estimates/:id/public', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const snap = await adminDb.collection('priceEstimates').doc(String(req.params.id)).get()
      if (!snap.exists) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Кошторис не знайдено' } })
      const e = snap.data()
      let parent = null
      if (e.parentEstimateId) {
        const p = await adminDb.collection('priceEstimates').doc(String(e.parentEstimateId)).get()
        parent = p.exists ? p.data() : null
      }
      // Контекст для клиента: как обращался, что зафиксировано в заявке, диагностика, предложения.
      // Безопасно по знанию id сметы (крипто-стойкий capability-token) — это данные самого клиента.
      const context = await buildEstimateContext(e)
      return res.json({ success: true, data: { estimate: safeEstimate(e), parent: safeEstimate(parent), context } })
    } catch (err) {
      console.error('estimate public:', err.message)
      res.status(500).json({ success: false })
    }
  })

  // Публичный вид ПРЕДЛОЖЕНИЯ (набора вариантов) для клиента: варианты (безопасные виды) + выбранный.
  app.get('/api/offers/:id/public', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const snap = await adminDb.collection('estimateOffers').doc(String(req.params.id)).get()
      if (!snap.exists) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Пропозицію не знайдено' } })
      const offer = snap.data()
      const ids = Array.isArray(offer.variantIds) ? offer.variantIds : []
      // Грузим варианты и отдаём в порядке variantIds (безопасные виды, без внутренней экономики)
      const variants = []
      for (const vid of ids) {
        const vs = await adminDb.collection('priceEstimates').doc(String(vid)).get()
        if (vs.exists) variants.push(safeEstimate(vs.data()))
      }
      return res.json({ success: true, data: {
        offer: { id: offer.id, title: offer.title || '', status: offer.status || 'pending_choice', selectedVariantId: offer.selectedVariantId || null },
        variants,
      } })
    } catch (err) {
      console.error('offer public:', err.message)
      res.status(500).json({ success: false })
    }
  })

  // Клиент выбирает вариант (путь ремонта). Доступ по знанию id предложения (capability-token).
  // Пишем backend-ом. Пока не выбран/не «заморожен» — можно переизбрать; после — фиксируется chosen.
  app.post('/api/offers/:id/choose', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const { variantId } = req.body || {}
      if (!variantId) return res.status(400).json({ success: false, error: { code: 'NO_VARIANT', message: 'Потрібен variantId' } })
      const ref = adminDb.collection('estimateOffers').doc(String(req.params.id))
      const out = await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        if (!s.exists) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Пропозицію не знайдено' }
        const offer = s.data()
        // Оффер заморожен (по выбранному варианту уже собран факт) — переизбор запрещён.
        if (offer.status === 'locked') return { ok: false, status: 409, code: 'LOCKED', message: 'Вибір зафіксовано — зверніться до майстра' }
        const ids = Array.isArray(offer.variantIds) ? offer.variantIds : []
        if (!ids.includes(String(variantId))) return { ok: false, status: 400, code: 'BAD_VARIANT', message: 'Такого варіанта немає в пропозиції' }
        // Повторный выбор того же варианта — идемпотентно, не переписываем chosenAt.
        if (offer.selectedVariantId === String(variantId) && offer.status === 'chosen') return { ok: true }
        tx.set(ref, { selectedVariantId: String(variantId), status: 'chosen', chosenAt: nowIso(), updatedAt: nowIso() }, { merge: true })
        return { ok: true, serviceRequestId: offer.serviceRequestId || null }
      })
      // Клиент выбрал путь → двигаем нашу заявку в «погоджено». НО не воскрешаем отменённую/
      // завершённую и не откатываем оплаченную (иначе поздний выбор варианта «оживит» заявку).
      if (out.ok && out.serviceRequestId) {
        const srRef = adminDb.collection('serviceRequests').doc(String(out.serviceRequestId))
        await adminDb.runTransaction(async (tx) => {
          const s = await tx.get(srRef)
          if (!s.exists) return
          const d = s.data()
          if (d.status === 'cancelled' || d.status === 'done' || d.paymentId) return
          tx.set(srRef, { status: 'approved', updatedAt: nowIso() }, { merge: true })
        }).catch(() => {})
      }
      if (!out.ok) return res.status(out.status).json({ success: false, error: { code: out.code, message: out.message } })
      return res.json({ success: true })
    } catch (err) {
      console.error('offer choose:', err.message)
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

  // Вебхук monobank Acquiring (JSON, ECDSA-подпись в X-Sign, ключ — pubkey мерчанта).
  app.post('/api/mono/acquire/callback', async (req, res) => {
    res.sendStatus(200)
    try {
      if (!adminDb) return
      const body = req.body || {}
      const invoiceId = body.invoiceId
      if (!invoiceId) return
      const order = await findByProviderOrderId(invoiceId)
      if (!order) return console.warn('mono acquire callback: заказ не найден', invoiceId)
      const fop = getFop(order.fopId)
      if (!(await monoAcquire.verifyWebhook(fop, req.rawBody, req.get('X-Sign')))) return console.warn('mono acquire callback: неверная подпись', order.orderId)

      const status = body.status
      if (status === 'success') {
        if (order.status !== 'paid') await saveOrder({ orderId: order.orderId, status: 'paid', paytype: 'mono-acquire' })
        await fiscalize({ ...order, status: 'paid' }, 'Оплата карткою (monobank)')
      } else if (order.status !== 'paid' && (status === 'failure' || status === 'expired' || status === 'reversed')) {
        await saveOrder({ orderId: order.orderId, status }) // терминальный не-paid не откатываем
      }
    } catch (e) {
      console.error('mono acquire callback error:', e.message)
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
        const lbl = o.provider === 'liqpay' ? 'Оплата частинами (LiqPay)' : o.provider === 'mono-acquire' ? 'Оплата карткою (monobank)' : 'Оплата частинами (monobank)'
        await fiscalize(o, lbl)
      }
    } catch (e) { console.error('reconcile failed query:', e.message) }
    // 3) LiqPay «pending» дольше 5 минут — спросить статус напрямую (потерянный success-колбэк:
    // деньги списаны, вебхук не дошёл → оплата зависла без чека). Свежие не трогаем (клиент ещё платит).
    try {
      const cutoff = Date.now() - 5 * 60 * 1000
      const pend = await col().where('status', '==', 'pending').limit(50).get()
      for (const doc of pend.docs) {
        const o = doc.data()
        if (o.createdAt && Date.parse(o.createdAt) > cutoff) continue
        const fop = getFop(o.fopId)
        if (!fop) continue
        if (o.provider === 'liqpay') {
          checked++
          try {
            const st = await liqpay.queryStatus(fop, o.orderId)
            const s = st && st.status
            if (s === 'success' || s === 'wait_compensation') {
              // Оплачено. Сверяем сумму (как вебхук) прежде чем помечать paid и бить чек.
              const paidAmt = Number(st.amount)
              if (Number.isFinite(paidAmt) && Math.abs(paidAmt - Number(o.amount)) < 0.01) {
                await saveOrder({ orderId: o.orderId, status: 'paid', paytype: st.paytype || o.method, providerOrderId: st.payment_id ? String(st.payment_id) : o.providerOrderId })
                await fiscalize({ ...o, status: 'paid' }, 'Оплата частинами (LiqPay)')
              } else {
                console.warn('reconcile liqpay: сумма не совпала, чек НЕ бьём', o.orderId, paidAmt, o.amount)
              }
            } else if (s === 'failure' || s === 'error' || s === 'reversed') {
              await saveOrder({ orderId: o.orderId, status: s }) // окончательно не прошёл
            }
            // processing/wait_accept/wait_secure и т.п. — оставляем pending, проверим позже
          } catch (e) { console.error('reconcile liqpay', o.orderId, e.message) }
        } else if (o.provider === 'mono-acquire' && o.providerOrderId) {
          checked++
          try {
            const st = await monoAcquire.invoiceStatus(fop, o.providerOrderId)
            const s = st && st.status
            if (s === 'success') {
              await saveOrder({ orderId: o.orderId, status: 'paid', paytype: 'mono-acquire' })
              await fiscalize({ ...o, status: 'paid' }, 'Оплата карткою (monobank)')
            } else if (s === 'failure' || s === 'expired' || s === 'reversed') {
              await saveOrder({ orderId: o.orderId, status: s })
            }
            // created/processing/hold — оставляем pending
          } catch (e) { console.error('reconcile mono-acquire', o.orderId, e.message) }
        }
      }
    } catch (e) { console.error('reconcile liqpay pending query:', e.message) }
    return { checked }
  }

  // Ручной триггер реконсиляции (для крон-джобы/админки). Доступ: токен ИЛИ Firebase ID-токен админа.
  app.post('/api/pay/reconcile', async (req, res) => {
    if (!(await isAdminReq(req))) return res.status(403).json({ success: false })
    const r = await reconcile()
    res.json({ success: true, data: r })
  })

  // Список «гроші є, чек ні» (paid без receiptId) — для админки/мониторинга.
  app.get('/api/pay/unfiscalized', async (req, res) => {
    if (!(await isAdminReq(req))) return res.status(403).json({ success: false })
    if (!adminDb) return res.status(503).json({ success: false })
    const q = await col().where('status', '==', 'paid').limit(200).get()
    const items = q.docs.map((d) => d.data()).filter((o) => !o.receiptId)
      .map((o) => ({ orderId: o.orderId, fopId: o.fopId, amount: o.amount, receiptStatus: o.receiptStatus || null, receiptError: o.receiptError || null, createdAt: o.createdAt }))
    res.json({ success: true, data: items })
  })

  // Повторно выбить чек по конкретному заказу (оплачен, но чека нет). Админ-доступ.
  app.post('/api/pay/:orderId/refiscalize', async (req, res) => {
    if (!(await isAdminReq(req))) return res.status(403).json({ success: false })
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const order = await loadOrder(String(req.params.orderId))
      if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Оплату не знайдено' } })
      if (order.receiptId) return res.status(409).json({ success: false, error: { code: 'ALREADY_FISCAL', message: 'Чек вже виписано' } })
      if (order.status !== 'paid') return res.status(409).json({ success: false, error: { code: 'NOT_PAID', message: 'Оплата не завершена' } })
      const label = order.provider === 'liqpay' ? 'Оплата частинами (LiqPay)' : 'Оплата частинами (monobank)'
      await fiscalize(order, label)
      const after = await loadOrder(String(req.params.orderId))
      return res.json({ success: true, data: { receiptStatus: after?.receiptStatus || null, taxUrl: after?.taxUrl || null, receiptId: after?.receiptId || null } })
    } catch (e) {
      console.error('refiscalize:', e.message)
      res.status(500).json({ success: false, error: { code: 'REFISCAL_FAILED', message: 'Не вдалося виписати чек' } })
    }
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
