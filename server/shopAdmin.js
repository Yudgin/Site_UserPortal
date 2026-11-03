// Страницы владельца «Замовлення з сайту»: заказы, накладная, отметки, настройки, блок готовности. Браузер ходит только сюда:
// shopOrders, shopPhones, shopDaily и system/* закрыты правилом Firestore по умолчанию. Вход: владелец или директор;
// настройки, тест алерта, сброс счётчика и разблокировка номера только владелец по почте.
// Цена, ФОП, наложка и адрес накладной берутся из заказа и настроек, телом запроса не задаются. Токен статуса и данные покупателя в журнал не пишем.
import { ADMIN_EMAIL, verifyFirebaseStaff } from './adminAuth.js'
import { loadFopFresh } from './fops.js'
import { checkMonoAcquire } from './fopKeyCheck.js'
import * as monoAcquire from './monoAcquire.js'
import * as checkbox from './checkbox.js'
import { npCall, saveInternetDocument } from './novaPoshtaTtn.js'
import { INVOICE_VALIDITY_SEC, isPostomat, withBudget } from './shopOrders.js'
import { KYIV_DAY, messageResetPatch, ttnMessageKind } from './shopPayments.js'
import { RECEIPT_CLAIM_STALE_MS, createShopReconcile } from './shopReconcile.js'
import {
  acceptsOrders, canTransition, claimFresh, npMissing, npTemplateProblems, orderAdminRow, orderAdminView, orderNeedsAction, phoneKeyOf, pricedItem, publicSeller,
  salesSettingsNext, shopLimit, shopPhone, shopSellable, siteBaseUrlOk, transitionPatch, ttnGonePatch, validateRecipient, withGuideStep,
} from './shopCore.js'

const LIST_LIMIT = 200
const ACTION_STATES = ['paid', 'cod_confirmed', 'payment_review', 'shipped', 'refused', 'returned']
const ORDER_ID_RE = /^so-[A-Za-z0-9]{1,40}$/
const TTN_RE = /^\d{8,20}$/
const ADDRESS_BUDGET_MS = 4000
const READINESS_BUDGET_MS = 12000
const RESEND_PAUSE_MS = 30 * 1000
// Чек только при этих статусах кассы или если касса его не знает: иначе новый чек мог бы стать вторым.
const RECEIPT_RETRY_STATUSES = new Set(['ERROR', 'CANCELLED'])
const TEST_ALERT_TEXT = withGuideStep('test-alert', '✅ RunFerry: перевірка сповіщень магазину. Якщо ви це читаєте, алерти доходять.')

const TEMPLATE_PROBLEM_TEXT = {
  missing: 'шаблон не вибрано або його немає',
  inactive: 'шаблон вимкнено',
  scenario: 'сценарій шаблону не «запчастини»',
  fop: 'шаблон іншого ФОП',
  description: 'у шаблоні порожній опис',
  sender: 'відправник у шаблоні не сервіс',
  recipient: 'отримувач у шаблоні не клієнт',
  'service-type': 'у шаблоні доставка не до відділення',
}

const ALERT = {
  ttnOnClosed: (o, url, ttn) => `⚠️ Замовлення ${o.orderNo}: накладну ${ttn} створено, але замовлення вже закрите. Посилку не передавайте і видаліть накладну в кабінеті НП: ${url}`,
  paymentBlocked: (o, url, reason) => `⚠️ Замовлення ${o.orderNo}: накладну не створено, банк не підтверджує оплату (${reason}). Посилку не передавайте, звірте оплату в кабінеті monobank: ${url}`,
}

const nowIso = () => new Date().toISOString()
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const clip = (v, n = 200) => (v == null ? null : String(v).slice(0, n))
const failText = (e) => e?.response?.status || e?.message
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra } })
const answer = (res, data, status = 200) => res.status(status).json({ success: true, data })
const refusal = (status, code, message, extra = {}) => ({ refused: { status, code, message, extra } })
const refuse = (res, { status, code, message, extra }) => fail(res, status, code, message, extra)
const forcedOf = (req) => new Set(Array.isArray(req.body?.force) ? req.body.force : [])
const finalKopOf = (st) => (st?.finalAmount == null || st.finalAmount === '' ? NaN : Number(st.finalAmount))
// Успех с нулём на счёте settleMonoAcquire считает полным возвратом: денег нет, какой бы статус ни показал банк.
const bankHoldsMoney = (st) => st?.status === 'success' && !(finalKopOf(st) <= 0)
const bankStatusText = (st) => clip(st?.status, 40) || 'невідомий'

const ttnUnknownRefusal = () => refusal(409, 'TTN_UNKNOWN', 'Невідомо, чи створилась накладна: перевірте кабінет НП. Є накладна: вкажіть її номер. Немає: створіть ще раз', { actions: ['attach', 'force'] })

// Что мешает создать накладную или привязать номер, кроме оплаты и шаблона. force с TTN_UNKNOWN: владелец проверил кабинет НП и накладной там нет.
function ttnObstacle(order, forced) {
  if (order.ttn) return refusal(409, 'TTN_EXISTS', `У замовлення вже є накладна ${order.ttn}`, { ttn: order.ttn })
  if (!canTransition(order, 'shipped')) return refusal(409, 'BAD_STATE', 'Накладна можлива лише для оплаченого замовлення')
  // Вторая волна: у наложки накладная без заготовки чека Checkbox недопустима, это шаг P17.
  if (order.method !== 'card') return refusal(409, 'METHOD_OFF', 'Накладна для післяплати ще недоступна')
  if (claimFresh(order.ttnCreatingAt) && !order.ttnError) return refusal(409, 'TTN_IN_PROGRESS', 'Накладна вже створюється, оновіть сторінку за хвилину')
  if ((order.ttnCreatingAt || order.ttnError) && !forced.has('TTN_UNKNOWN')) return ttnUnknownRefusal()
  return null
}

export function registerShopAdmin(app, deps) {
  const {
    adminDb, hooks, payments, npRequest, sendSms, verifyStaff = verifyFirebaseStaff, mono = monoAcquire, cbx = checkbox, np = npCall, siteUrl = 'https://my.runferry.com',
    addressBudgetMs = ADDRESS_BUDGET_MS, readinessBudgetMs = READINESS_BUDGET_MS,
  } = deps
  const { refreshParcel } = createShopReconcile({ adminDb, payments, hooks, mono, cbx, npCall: np, siteUrl })
  const orders = () => adminDb.collection('shopOrders')
  const salesRef = () => adminDb.collection('system').doc('shopSales')
  const loadSales = async () => {
    const s = await salesRef().get()
    return s.exists ? s.data() : null
  }

  // ---------- вход ----------

  const route = (what, handler, { ownerOnly = false } = {}) => async (req, res) => {
    try {
      const staff = await verifyStaff(req, ['owner', 'director'])
      if (!staff) return fail(res, 403, 'FORBIDDEN', 'Доступ лише для власника або директора')
      const full = staff.email === ADMIN_EMAIL
      if (ownerOnly && !full) return fail(res, 403, 'OWNER_ONLY', 'Це може зробити лише власник')
      if (!adminDb) return fail(res, 503, 'NO_DB', 'База недоступна')
      await handler(req, res, { ...staff, full, by: staff.email || staff.uid })
    } catch (e) {
      console.error(`shop admin: ${what}:`, failText(e))
      if (!res.headersSent) fail(res, 500, 'INTERNAL', 'Не вдалося виконати, спробуйте ще раз')
    }
  }
  const ownerRoute = (what, handler) => route(what, handler, { ownerOnly: true })
  const orderRoute = (what, handler) => route(what, async (req, res, staff) => {
    const id = String(req.params.id || '')
    const snap = ORDER_ID_RE.test(id) ? await orders().doc(id).get() : null
    if (!snap?.exists) return fail(res, 404, 'NOT_FOUND', 'Замовлення не знайдено')
    return handler({ req, res, staff, ref: orders().doc(id), order: snap.data() })
  })

  // ---------- список и карточка ----------

  const rowsOf = (docs) => docs.map((d) => orderAdminRow(d.id, d.data())).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  // Живые счета магазина по документам оплат: снятие могло не пройти и у заказа, который уже закрыт.
  const liveInvoices = async () => (await payments.readByStatus('pending'))
    .filter((p) => p.shopOrderId && Date.now() - Date.parse(p.createdAt) < INVOICE_VALIDITY_SEC * 1000)

  // Первый экран и счётчики панели. Составных индексов нет: только равенство по одному полю.
  const actionList = async () => {
    const reads = [...ACTION_STATES.map((state) => orders().where('state', '==', state).get()), orders().where('ttnOnClosed', '==', true).get()]
    const seen = new Map()
    for (const q of await Promise.all(reads)) for (const d of q.docs) seen.set(d.id, d)
    const docs = [...seen.values()].filter((d) => orderNeedsAction(d.data()))
    const [live, day] = await Promise.all([liveInvoices(), adminDb.collection('shopDaily').doc(KYIV_DAY.format(new Date())).get()])
    const items = rowsOf(docs)
    return {
      items,
      counters: {
        action: items.length,
        noTtn: items.filter((r) => (r.state === 'paid' || r.state === 'cod_confirmed') && !r.ttn).length,
        liveInvoices: live.length,
        unpaidToday: (day.exists && day.data().unpaid) || 0,
      },
    }
  }

  app.get('/api/shop/admin/orders', route('список', async (req, res) => {
    const rawPhone = str(req.query.phone)
    if (rawPhone) {
      const phone = shopPhone(rawPhone)
      if (!phone) return fail(res, 400, 'BAD_INPUT', 'Вкажіть телефон у форматі +380…', { fields: ['phone'] })
      return answer(res, { items: rowsOf((await orders().where('phoneKey', '==', phoneKeyOf(phone)).get()).docs) })
    }
    const orderNo = str(req.query.orderNo).toUpperCase()
    if (orderNo) return answer(res, { items: rowsOf((await orders().where('orderNo', '==', orderNo).get()).docs) })
    if (req.query.view === 'action') return answer(res, await actionList())
    return answer(res, { items: rowsOf((await orders().orderBy('createdAt', 'desc').limit(LIST_LIMIT).get()).docs) })
  }))

  const invoiceRow = (p, order) => ({
    id: p.orderId, status: p.status, amount: p.amount, createdAt: p.createdAt, paying: p.orderId === order.paidPaymentId,
    receiptStatus: p.receiptStatus || null, receiptError: p.receiptError || null, taxUrl: p.taxUrl || null,
    receiptEmailDropped: p.receiptEmailDropped === true, partialRefund: p.partialRefund || null,
  })

  const cardOf = async (ref, order) => {
    const [cfg, ...docs] = await Promise.all([loadSales(), ...(order.paymentIds || []).map((id) => payments.loadOrder(id))])
    return { ...orderAdminView(ref.id, order, { siteBaseUrl: cfg?.siteBaseUrl }), invoices: docs.filter(Boolean).map((p) => invoiceRow(p, order)) }
  }

  app.get('/api/shop/admin/orders/:id', orderRoute('картка', async ({ res, ref, order }) => answer(res, await cardOf(ref, order))))

  // ---------- накладная ----------

  const invoiceProblem = (order, p, st) => {
    if (st?.status !== 'success') return `статус ${bankStatusText(st)}`
    const confirmed = order.amountConfirmed?.amount
    const needKop = cbx.toKop(confirmed ?? order.total)
    const finalKop = finalKopOf(st)
    if (finalKop < needKop) return `лишилось ${finalKop / 100} грн із ${needKop / 100} грн`
    if (confirmed != null) return ''
    const { mismatch, missing } = payments.amountAudit(p, st)
    return [...mismatch, ...(missing.includes('amount') ? ['банк не показав суму'] : [])].join('; ')
  }

  // Оплата картой: спрашиваем банк прямо сейчас, колбэк о возврате мог не дойти. refused или null.
  const paidCheck = async (ref, order, fop, forced) => {
    const p = order.paidPaymentId ? await payments.loadOrder(order.paidPaymentId) : null
    const blocked = (reason) => {
      // Без ожидания: Telegram не должен задерживать ответ, а причину владелец уже видит на странице.
      hooks.shopAlert(ref.id, 'ttn-payment-blocked', (o, url) => ALERT.paymentBlocked(o, url, reason)).catch((e) => console.error(`shop admin: алерт ${ref.id}:`, e.message))
      return refusal(409, 'PAYMENT_NOT_CONFIRMED', `Банк не підтверджує оплату: ${reason}. Звірте її в кабінеті monobank`, { reason })
    }
    if (!p || p.status !== 'paid') return blocked(`оплата ${clip(p?.status, 40) || 'не знайдена'}`)
    let st
    try {
      st = await mono.invoiceStatus(fop, p.providerOrderId)
    } catch (e) {
      console.warn(`shop admin: статус рахунку ${p.orderId}:`, failText(e))
      return refusal(502, 'BANK_UNAVAILABLE', 'Банк не відповів, накладну не створено. Спробуйте за хвилину')
    }
    const problem = invoiceProblem(order, p, st)
    if (problem) {
      // Возврат и незнакомый статус должны дойти до заказа и владельца сразу, а не на следующем опросе.
      if (!bankHoldsMoney(st)) payments.settleMonoAcquire(p, st, 'ttn').catch((e) => console.error(`shop admin: оплата ${p.orderId}:`, failText(e)))
      return blocked(problem)
    }
    if (p.receiptStatus !== 'DONE' && !p.taxUrl && !forced.has('NO_RECEIPT')) {
      return refusal(409, 'NO_RECEIPT', 'Чека ще немає. Спершу перевірте чек; відправити без нього можна лише явним підтвердженням', { actions: ['force'] })
    }
    return null
  }

  // Пока ничего не занято: параллельные запросы пройдут это вместе, а дальше захват пропустит один.
  const ttnPreflight = async (ref, order, forced) => {
    const cfg = await loadSales()
    const tplId = str(cfg?.npTemplateId)
    const tplSnap = tplId ? await adminDb.collection('npTemplates').doc(tplId).get() : null
    const tpl = tplSnap?.exists ? tplSnap.data() : null
    const problems = npTemplateProblems(tpl, order.fopId)
    if (problems.length) return refusal(409, 'BAD_TEMPLATE', `Шаблон НП не підходить: ${problems.map((k) => TEMPLATE_PROBLEM_TEXT[k]).join('; ')}`, { problems })
    // Без адреса saveInternetDocument молча взял бы фиксированного получателя шаблона.
    if (!order.clientCityRef || !order.clientWarehouseRef || !order.clientPhone || !order.clientName) return refusal(409, 'NO_CLIENT_ADDRESS', 'У замовленні немає даних отримувача')
    const fop = await loadFopFresh(adminDb, order.fopId)
    const missing = npMissing(fop)
    if (missing.length) return refusal(409, 'NP_NOT_CONFIGURED', `У ФОП замовлення не заповнено: ${missing.join(', ')}`, { missing })
    if (order.method === 'card') {
      const blocked = await paidCheck(ref, order, fop, forced)
      if (blocked) return blocked
    }
    return { fop, tpl }
  }

  // Номер в заказ. Заказ успели закрыть: номер всё равно сохраняем и зовём владельца, посылку нельзя передавать. guard: попытка привязки ещё может отказать.
  // Сообщение и алерт без ожидания: что не дошло, повторит сверка.
  const recordTtn = async (ref, ttn, fields, { by, note, guard = () => null }) => {
    const at = nowIso()
    const base = { ttn, npDelivery: null, npCheckedAt: null, ttnCreatingAt: null, ttnError: null, ...fields }
    const out = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      const obstacle = guard(cur)
      if (obstacle) return obstacle
      const patch = transitionPatch(cur, 'shipped', { at, by, note, patch: { ...base, shippedAt: at } })
      tx.set(ref, patch || { ...base, ttnOnClosed: true, updatedAt: at }, { merge: true })
      return { shipped: !!patch }
    })
    if (out.refused) return out
    const later = out.shipped
      ? hooks.sendTtnMessage(ref, ttn)
      : hooks.shopAlert(ref.id, `ttn-on-closed-${ttn}`, (o, url) => ALERT.ttnOnClosed(o, url, ttn))
    later.catch((e) => console.error(`shop admin: сповіщення про накладну ${ref.id}:`, e.message))
    return out
  }
  const ttnRecorded = (res, ttn, { shipped }) => (shipped
    ? answer(res, { ttn, state: 'shipped' })
    : fail(res, 409, 'ORDER_CLOSED', `Накладну ${ttn} створено, але замовлення вже закрите. Посилку не передавайте, видаліть накладну в кабінеті НП`, { ttn }))

  // Код НП по одному номеру: '' если НП ответила без этого номера, null если не ответила.
  const npCodeOf = async (fopId, number) => {
    const fop = await loadFopFresh(adminDb, fopId)
    const apiKey = fop?.novaPoshta?.apiKey
    if (!apiKey) return null
    try {
      const r = await withBudget(np(apiKey, 'TrackingDocument', 'getStatusDocuments', { Documents: [{ DocumentNumber: number }] }), addressBudgetMs)
      if (r?.success !== true || !Array.isArray(r.data)) return null
      return String(r.data.find((d) => String(d?.Number) === number)?.StatusCode ?? '').trim()
    } catch (e) {
      console.warn(`shop admin: номер накладної не перевірено: ${failText(e)}`)
      return null
    }
  }

  const ttnUnknown = async (res, ref) => {
    await ref.set({ ttnError: 'unknown', updatedAt: nowIso() }, { merge: true })
    return refuse(res, ttnUnknownRefusal().refused)
  }

  app.post('/api/shop/admin/orders/:id/ttn', orderRoute('накладна', async ({ req, res, staff, ref, order }) => {
    const forced = forcedOf(req)
    const early = ttnObstacle(order, forced)
    if (early) return refuse(res, early.refused)
    const ready = await ttnPreflight(ref, order, forced)
    if (ready.refused) return refuse(res, ready.refused)
    const { fop, tpl } = ready

    const claim = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      const obstacle = ttnObstacle(cur, forced)
      if (obstacle) return obstacle
      const at = nowIso()
      tx.set(ref, { ttnCreatingAt: at, ttnError: null, updatedAt: at }, { merge: true })
      return { cur }
    })
    if (claim.refused) return refuse(res, claim.refused)
    // Получатель из захвата: пока шли проверки и банк, его могли исправить, а теперь /recipient откажет.
    const { cur } = claim

    const release = () => ref.set({ ttnCreatingAt: null, ttnError: null, updatedAt: nowIso() }, { merge: true })
    const notes = ['TTN_UNKNOWN', 'NO_RECEIPT'].filter((c) => forced.has(c))
    let saved
    try {
      saved = await saveInternetDocument({
        np, apiKey: fop.novaPoshta.apiKey, npc: fop.novaPoshta, tpl, scenario: 'parts',
        description: `${str(tpl.description).slice(0, 480)} ${order.sku}`,
        cost: Math.round(order.total),
        // Без плюса, как в примерах НП: неизвестно, примет ли она другой вид.
        client: { cityRef: cur.clientCityRef, warehouseRef: cur.clientWarehouseRef, phone: cur.clientPhone.replace(/\D/g, ''), name: cur.clientName },
        codAmount: 0, // оплаченный заказ наложку не получает никогда, наложка только у заказа наложкой (вторая волна)
      })
    } catch (e) {
      console.error(`shop admin: НП ${order.orderNo}:`, failText(e))
      // Таймаут самого InternetDocument.save мог создать накладную: захват остаётся. На шагах сторон до неё не дошли.
      if (!e.noDocument) return ttnUnknown(res, ref)
      await release()
      return fail(res, 502, 'NP_ERROR', e.isAxiosError ? 'Нова Пошта не відповіла, накладну не створено. Спробуйте ще раз' : e.message)
    }
    if (saved.problem && saved.problem.noDocument) {
      await release()
      return fail(res, saved.problem.status, saved.problem.code, saved.problem.message, saved.problem.extra)
    }
    // Странный ответ, в том числе успех без номера: накладная могла появиться.
    if (saved.problem || !saved.ttn) return ttnUnknown(res, ref)

    const ttn = String(saved.ttn)
    const { doc } = saved
    try {
      return ttnRecorded(res, ttn, await recordTtn(ref, ttn, {
        npDocRef: doc.Ref || null, npCostOnSite: doc.CostOnSite ?? null, npEstimatedDelivery: doc.EstimatedDeliveryDate || null, npFopId: fop.id,
      }, { by: staff.by, note: notes.length ? `force: ${notes.join(', ')}` : null }))
    } catch (e) {
      // Накладная есть, заказ о ней не знает: без номера в ответе её пришлось бы искать в кабинете. Захват остаётся.
      console.error(`shop admin: накладна ${ttn} замовлення ${order.orderNo} не записана:`, failText(e))
      await ref.set({ ttnError: 'unknown', updatedAt: nowIso() }, { merge: true }).catch(() => {})
      return fail(res, 500, 'TTN_NOT_SAVED', `Накладну ${ttn} створено, але не збережено. Вкажіть цей номер кнопкою «Прив'язати накладну»`, { ttn })
    }
  }))

  // Накладная из кабинета НП или после TTN_UNKNOWN: тут ничего не создаётся, поэтому банк и чек не спрашиваем.
  app.post('/api/shop/admin/orders/:id/ttn/attach', orderRoute('привʼязка накладної', async ({ req, res, staff, ref, order }) => {
    const number = String(req.body?.number ?? '').replace(/\D/g, '')
    if (!TTN_RE.test(number)) return fail(res, 400, 'BAD_INPUT', 'Вкажіть номер накладної: лише цифри', { fields: ['number'] })
    const forced = forcedOf(req)
    // Захват не помеха: владелец как раз и разбирается с накладной, исход которой неизвестен. Кроме запроса, который идёт прямо сейчас.
    const obstacle = (o) => ttnObstacle(o, new Set(['TTN_UNKNOWN']))
    const early = obstacle(order)
    if (early) return refuse(res, early.refused)

    // Номер уйдёт покупателю сообщением, поэтому опечатку ловим сразу. НП не отвечает: принимаем, ради этого случая кнопка и есть.
    if (!forced.has('TTN_NOT_FOUND')) {
      const code = await npCodeOf(order.fopId, number)
      if (code === '2' || code === '3') return fail(res, 422, 'TTN_NOT_FOUND', 'НП не знає цей номер. Перевірте його; свіжа накладна могла ще не зʼявитись, тоді підтвердьте', { actions: ['force'] })
    }

    const out = await recordTtn(ref, number, { npDocRef: null, npCostOnSite: null, npEstimatedDelivery: null, npFopId: order.fopId }, { by: staff.by, note: 'attach', guard: obstacle })
    if (out.refused) return refuse(res, out.refused)
    return ttnRecorded(res, number, out)
  }))

  // Накладная на закрытом заказе: плашка горит, пока её не удалят в кабинете НП. Код 2: номер уходит в историю, заказ остаётся закрытым.
  const refreshClosedTtn = async (res, ref, order) => {
    const code = await npCodeOf(order.npFopId || order.fopId, String(order.ttn))
    if (code === null) return fail(res, 502, 'NP_UNAVAILABLE', 'Нова Пошта не відповіла, спробуйте ще раз')
    if (code !== '2') return answer(res, { outcome: 'none', state: order.state, ttn: order.ttn })
    await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (cur.ttnOnClosed !== true || String(cur.ttn) !== String(order.ttn)) return
      const at = nowIso()
      tx.set(ref, { ...ttnGonePatch(cur, code, at), ttnOnClosed: false, updatedAt: at }, { merge: true })
    })
    return answer(res, { outcome: 'back', state: order.state, ttn: null })
  }

  // Внеочередной запрос: владелец удалил накладную в кабинете, нажал кнопку, код 2 вернул заказ в paid.
  app.post('/api/shop/admin/orders/:id/ttn/refresh', orderRoute('статус накладної', async ({ res, ref, order }) => {
    if (order.ttnOnClosed === true) return refreshClosedTtn(res, ref, order)
    if (order.state !== 'shipped' || !order.ttn) return fail(res, 409, 'NOT_SHIPPED', 'Статус перевіряється лише для відправленого замовлення')
    let outcome
    try {
      outcome = await refreshParcel(ref, order)
    } catch (e) {
      console.warn(`shop admin: статус накладної ${order.orderNo}:`, failText(e))
    }
    if (outcome === undefined) return fail(res, 502, 'NP_UNAVAILABLE', 'Нова Пошта не відповіла, спробуйте ще раз')
    const after = (await ref.get()).data()
    return answer(res, { outcome, state: after.state, ttn: after.ttn || null })
  }))

  // ---------- заказ ----------

  // Только без денег: оплаченное возвращается в кабинете банка, а заказ закрывает reversed. Счётчик дня не уменьшается, как и у отмены покупателем.
  app.post('/api/shop/admin/orders/:id/cancel', orderRoute('скасування', async ({ res, staff, ref, order }) => {
    const phoneRef = order.phoneKey ? adminDb.collection('shopPhones').doc(order.phoneKey) : null
    const out = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      // Любой захват: зависший тоже значит, что накладная могла появиться.
      if (cur.ttnError || cur.ttnCreatingAt) return refusal(409, 'TTN_UNKNOWN', 'Накладна створюється або могла створитись: спершу перевірте кабінет НП')
      if (!canTransition(cur, 'cancelled')) return refusal(409, 'NOT_CANCELLABLE', 'Це замовлення скасувати не можна')
      const phone = phoneRef ? await tx.get(phoneRef) : null
      const patch = transitionPatch(cur, 'cancelled', { by: staff.by, patch: { cancelReason: 'owner', payment: { pageUrl: null } } })
      tx.set(ref, patch, { merge: true })
      if (phone?.exists && (phone.data().openCard || {})[cur.sku] === ref.id) tx.set(phoneRef, { openCard: { [cur.sku]: null } }, { merge: true })
      return { paymentIds: cur.paymentIds || [] }
    })
    if (out.refused) return refuse(res, out.refused)
    // Без ожидания: от живого счёта защищает опрос и алерт, а не успех снятия.
    for (const id of out.paymentIds) hooks.removeLiveInvoice(id).catch((e) => console.error(`shop admin: рахунок ${id} не знято:`, failText(e)))
    return answer(res, { state: 'cancelled' })
  }))

  const warehouseFits = async (cityRef, warehouseRef) => {
    try {
      const r = await withBudget(npRequest('Address', 'getWarehouses', { CityRef: cityRef, FindByString: '', Limit: 5000 }), addressBudgetMs)
      if (r?.success !== true || !Array.isArray(r.data)) throw new Error('відповідь НП не успішна')
      return r.data.some((wh) => String(wh?.Ref || '').toLowerCase() === warehouseRef && !isPostomat(wh))
    } catch (e) {
      console.warn('shop admin: відділення не перевірено:', e.message)
      return null
    }
  }

  // Опечатка покупателя в телефоне: страница статуса доступна только по сообщению. Отпечаток не меняем: повтор той же формы должен найти этот же заказ.
  // Новый телефон получает все сообщения заново: прежние могли уйти на чужой номер.
  app.post('/api/shop/admin/orders/:id/recipient', orderRoute('отримувач', async ({ req, res, staff, ref, order }) => {
    const input = validateRecipient(req.body)
    if (!input.ok) return fail(res, 400, 'BAD_INPUT', 'Перевірте поля', { fields: input.fields })
    const v = input.value
    if (order.piiPurgedAt) return fail(res, 409, 'PII_PURGED', 'Дані цього замовлення вже стерто')
    const changesParcel = ['lastName', 'firstName', 'middleName', 'cityRef'].some((k) => k in v)
    let addressVerified
    if (v.cityRef) {
      const fits = await warehouseFits(v.cityRef, v.warehouseRef)
      if (fits === false) return fail(res, 422, 'BAD_WAREHOUSE', 'Це відділення не належить місту або це поштомат')
      addressVerified = fits === true
    }
    const out = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (claimFresh(cur.ttnCreatingAt) && !cur.ttnError) return refusal(409, 'TTN_IN_PROGRESS', 'Накладна вже створюється, оновіть сторінку за хвилину')
      if (changesParcel && (cur.ttn || cur.ttnError || cur.ttnCreatingAt)) return refusal(409, 'TTN_EXISTS', 'Накладна вже є: отримувача змініть у кабінеті НП')
      const phoneChanged = !!v.phone && v.phone !== cur.clientPhone
      const newPhoneKey = phoneChanged ? phoneKeyOf(v.phone) : null
      const holdsSlot = phoneChanged && cur.state === 'awaiting_payment'
      const oldPhoneRef = holdsSlot && cur.phoneKey ? adminDb.collection('shopPhones').doc(cur.phoneKey) : null
      const newPhoneRef = holdsSlot ? adminDb.collection('shopPhones').doc(newPhoneKey) : null
      const [oldPhone, newPhone] = await Promise.all([oldPhoneRef ? tx.get(oldPhoneRef) : null, newPhoneRef ? tx.get(newPhoneRef) : null])

      const at = nowIso()
      const fields = Object.keys(v)
      const names = { lastName: v.lastName ?? cur.lastName, firstName: v.firstName ?? cur.firstName, middleName: v.middleName ?? cur.middleName }
      tx.set(ref, {
        ...('lastName' in v || 'firstName' in v || 'middleName' in v ? { ...names, clientName: [names.lastName, names.firstName, names.middleName].filter(Boolean).join(' ') } : {}),
        ...('email' in v ? { email: v.email } : {}),
        ...(v.cityRef ? { clientCityRef: v.cityRef, clientCityName: v.cityName, clientWarehouseRef: v.warehouseRef, clientWarehouseName: v.warehouseName, addressVerified } : {}),
        ...(phoneChanged ? { clientPhone: v.phone, phoneKey: newPhoneKey, ...messageResetPatch(cur, Object.keys(cur.sms || {})) } : {}),
        recipientEdits: [...(cur.recipientEdits || []), { at, by: staff.by, fields }],
        updatedAt: at,
      }, { merge: true })
      if (oldPhone?.exists && (oldPhone.data().openCard || {})[cur.sku] === ref.id) tx.set(oldPhoneRef, { openCard: { [cur.sku]: null } }, { merge: true })
      if (newPhoneRef && !(newPhone.exists && (newPhone.data().openCard || {})[cur.sku])) tx.set(newPhoneRef, { openCard: { [cur.sku]: ref.id } }, { merge: true })
      return {}
    })
    if (out.refused) return refuse(res, out.refused)
    return answer(res, await cardOf(ref, (await ref.get()).data()))
  }))

  // Отметки владельца. Состояние денег решает ответ банка, а не кнопка: подтвердить можно только то, что банк показывает сейчас.
  const bankAnswer = async (p) => {
    const fop = await payments.resolveFop(p.fopId)
    if (!fop) throw new Error(`ФОП ${p.fopId} не завантажено`)
    return mono.invoiceStatus(fop, p.providerOrderId)
  }
  const bankDown = (res, e) => {
    console.warn('shop admin: банк:', failText(e))
    return fail(res, 502, 'BANK_UNAVAILABLE', 'Банк не відповів, спробуйте за хвилину')
  }

  const confirmPayment = async ({ res, staff, ref, order }) => {
    if (order.state !== 'payment_review' && order.state !== 'paid') return fail(res, 409, 'BAD_STATE', 'Оплату можна підтвердити лише в замовленні, що чекає рішення')
    const p = order.paidPaymentId ? await payments.loadOrder(order.paidPaymentId) : null
    if (!p || p.status !== 'paid') return fail(res, 409, 'NOT_PAID', 'Оплату не знайдено або її повернуто')
    let st
    try {
      st = await bankAnswer(p)
    } catch (e) {
      return bankDown(res, e)
    }
    if (!bankHoldsMoney(st)) {
      payments.settleMonoAcquire(p, st, 'owner').catch((e) => console.error(`shop admin: оплата ${p.orderId}:`, failText(e)))
      return fail(res, 409, 'PAYMENT_NOT_CONFIRMED', `Банк показує статус ${bankStatusText(st)}: підтвердити оплату не можна`)
    }
    const finalKop = finalKopOf(st)
    const amount = finalKop > 0 ? finalKop / 100 : st.amount != null ? Number(st.amount) / 100 : p.amount
    if (!(await hooks.onShopPaymentConfirmed(ref.id, { by: staff.by, amount }))) return fail(res, 409, 'BAD_STATE', 'Стан замовлення вже змінився, оновіть сторінку')
    // Снять метку до чека: иначе захват откажет. Деньги остаются как есть, чек выбивается через банк, как при любом проведении.
    const cleared = p.receiptStatus === 'amount-mismatch' ? { receiptStatus: null, receiptError: null } : null
    if (cleared) await payments.saveOrder({ orderId: p.orderId, ...cleared })
    await payments.settleMonoAcquire({ ...p, ...cleared }, st, 'owner')
    const after = (await ref.get()).data()
    return answer(res, { state: after.state, amountConfirmed: after.amountConfirmed })
  }

  const checkReversed = async ({ res, ref, order }) => {
    const p = order.paidPaymentId ? await payments.loadOrder(order.paidPaymentId) : null
    if (!p) return fail(res, 409, 'NOT_PAID', 'Оплату не знайдено')
    let st
    try {
      st = await bankAnswer(p)
    } catch (e) {
      return bankDown(res, e)
    }
    if (st?.status !== 'reversed' && (st?.status !== 'success' || bankHoldsMoney(st))) return fail(res, 409, 'BANK_NOT_REVERSED', `Банк показує статус ${bankStatusText(st)}: повернення ще не видно`)
    await payments.settleMonoAcquire(p, st, 'owner')
    return answer(res, { state: (await ref.get()).data().state })
  }

  const MARKS = {
    returned: async ({ res, staff, ref }) => {
      const moved = await adminDb.runTransaction(async (tx) => {
        const cur = (await tx.get(ref)).data()
        const patch = transitionPatch(cur, 'returned', { by: staff.by })
        if (patch) tx.set(ref, patch, { merge: true })
        return !!patch
      })
      if (!moved) return fail(res, 409, 'BAD_STATE', 'Посилка має бути у стані «не отримано»')
      return answer(res, { state: 'returned' })
    },
    // Срок возврата денег: сверка напомнит на 20-й день. Первая дата остаётся.
    'refund-requested': async ({ res, staff, ref, order }) => {
      if (order.method !== 'card' || !order.paidPaymentId || order.state === 'reversed') return fail(res, 409, 'BAD_STATE', 'У цього замовлення немає оплати, яку можна повернути')
      const at = order.refundRequestedAt || nowIso()
      if (!order.refundRequestedAt) await ref.set({ refundRequestedAt: at, refundRequestedBy: staff.by, updatedAt: nowIso() }, { merge: true })
      return answer(res, { refundRequestedAt: at })
    },
    'confirm-payment': confirmPayment,
    'check-reversed': checkReversed,
  }

  app.post('/api/shop/admin/orders/:id/mark', orderRoute('відмітка', async (ctx) => {
    const action = Object.hasOwn(MARKS, String(ctx.req.body?.action)) ? MARKS[ctx.req.body.action] : null
    if (!action) return fail(ctx.res, 400, 'BAD_INPUT', 'Невідома відмітка', { fields: ['action'] })
    return action(ctx)
  }))

  // Новый чек с новым id: только когда прежнего точно нет. Автоматически не вызывается (что Checkbox делает с таким чеком, неизвестно, риск двух чеков).
  // Чек через ответ банка: пока его не было, деньги могли вернуть.
  app.post('/api/shop/admin/orders/:id/receipt-retry', orderRoute('повтор чека', async ({ res, ref, order }) => {
    const p = order.paidPaymentId ? await payments.loadOrder(order.paidPaymentId) : null
    if (!p || p.status !== 'paid') return fail(res, 409, 'NOT_PAID', 'Оплату не знайдено або її повернуто')
    if (p.receiptStatus === 'amount-mismatch') return fail(res, 409, 'AMOUNT_REVIEW', 'Сума не збіглася з банком: спершу підтвердіть оплату')
    if (!p.receiptId && p.fiscalizeClaimedAt && Date.now() - Date.parse(p.fiscalizeClaimedAt) < RECEIPT_CLAIM_STALE_MS) return fail(res, 409, 'RECEIPT_IN_PROGRESS', 'Чек зараз виписується, зачекайте')
    const fop = await payments.resolveFop(p.fopId)
    if (!fop) return fail(res, 503, 'NO_FOP', 'ФОП не завантажено, спробуйте за хвилину')

    let known = null
    try {
      known = await cbx.getReceipt(fop, payments.receiptUuidFor(p.orderId, p.receiptAttempt))
    } catch (e) {
      if (e?.response?.status !== 404) {
        console.warn(`shop admin: чек ${p.orderId}:`, failText(e))
        return fail(res, 502, 'CHECKBOX_UNAVAILABLE', 'Каса не відповіла, чек не виписано. Спробуйте пізніше')
      }
    }
    if (known && !RECEIPT_RETRY_STATUSES.has(known.status)) {
      if (known.status === 'DONE' || known.taxUrl) {
        await payments.saveOrder({ orderId: p.orderId, receiptId: known.receiptId, fiscalCode: known.fiscalCode, taxUrl: known.taxUrl, receiptStatus: known.status || 'done', receiptError: null })
      }
      return fail(res, 409, 'RECEIPT_EXISTS', `У касі вже є цей чек (${clip(known.status, 40) || 'статус невідомий'}): новий виписати не можна`)
    }

    let st
    try {
      st = await bankAnswer(p)
    } catch (e) {
      return bankDown(res, e)
    }
    if (!bankHoldsMoney(st)) {
      payments.settleMonoAcquire(p, st, 'owner').catch((e) => console.error(`shop admin: оплата ${p.orderId}:`, failText(e)))
      return fail(res, 409, 'PAYMENT_NOT_CONFIRMED', `Банк показує статус ${bankStatusText(st)}: чек не виписано`)
    }

    const at = nowIso()
    const cleared = { receiptAttempt: (p.receiptAttempt || 0) + 1, receiptId: null, fiscalCode: null, taxUrl: null, receiptStatus: null, receiptError: null, receiptAt: null, fiscalizeClaimedAt: null }
    await payments.saveOrder({ orderId: p.orderId, ...cleared })
    await ref.set({ receipt: { status: 'none', taxUrl: null, checkedAt: at }, alerts: { 'receipt-failed': null, 'receipt-late': null, 'receipt-claim': null }, updatedAt: at }, { merge: true })
    await payments.settleMonoAcquire({ ...p, ...cleared }, st, 'owner')
    const after = await payments.loadOrder(p.orderId)
    return answer(res, { receiptStatus: after?.receiptStatus || null, taxUrl: after?.taxUrl || null, receiptAttempt: cleared.receiptAttempt })
  }))

  // Журнал оповещений сам второй раз не шлёт: messageResetPatch даёт новый ключ. Двойной клик не должен быть двумя платными SMS.
  app.post('/api/shop/admin/orders/:id/resend', orderRoute('повторне повідомлення', async ({ req, res, ref, order }) => {
    const what = String(req.body?.kind || '')
    if (!order.clientPhone) return fail(res, 409, 'NO_PHONE', 'У замовленні немає телефону')
    const paid = order.paidPaymentId ? await payments.loadOrder(order.paidPaymentId) : null
    const senders = {
      paid: order.method === 'card' && paid && order.state !== 'reversed' ? { kind: 'paid', send: () => hooks.sendPaidMessage(ref) } : null,
      rcpt: paid?.taxUrl ? { kind: 'rcpt', send: () => hooks.sendReceiptMessage(ref, paid.taxUrl) } : null,
      ttn: order.ttn ? { kind: ttnMessageKind(order.ttn), send: () => hooks.sendTtnMessage(ref, order.ttn) } : null,
    }
    if (!Object.hasOwn(senders, what)) return fail(res, 400, 'BAD_INPUT', 'Невідомий вид повідомлення', { fields: ['kind'] })
    const sender = senders[what]
    if (!sender) return fail(res, 409, 'NOTHING_TO_SEND', 'Для цього замовлення такого повідомлення ще немає')
    const reset = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (Date.now() - Date.parse((cur.sms || {})[sender.kind]?.at) < RESEND_PAUSE_MS) return false
      tx.set(ref, { ...messageResetPatch(cur, [sender.kind]), updatedAt: nowIso() }, { merge: true })
      return true
    })
    if (!reset) return fail(res, 429, 'TOO_SOON', 'Повідомлення щойно надіслано, зачекайте пів хвилини')
    await sender.send()
    const after = (await ref.get()).data()
    return answer(res, { kind: sender.kind, status: (after.sms || {})[sender.kind]?.status || 'failed' })
  }))

  // ---------- настройки ----------

  app.get('/api/shop/admin/settings', route('налаштування', async (_req, res, staff) => {
    const cfg = await loadSales()
    if (!cfg) return answer(res, { settings: null })
    const { ownerPhone: _phone, ...rest } = cfg
    return answer(res, { settings: staff.full ? cfg : rest })
  }))

  // Транзакция: склад уменьшается транзакцией оплаты, настройки не должны затереть её параллельно.
  app.put('/api/shop/admin/settings', ownerRoute('налаштування', async (req, res, staff) => {
    const out = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(salesRef())
      const r = salesSettingsNext(req.body, snap.exists ? snap.data() : {})
      if (!r.ok) return r
      const next = { ...r.next, updatedAt: nowIso(), updatedBy: staff.by }
      tx.set(salesRef(), next)
      return { ok: true, next }
    })
    if (out.ok) return answer(res, { settings: out.next })
    const message = {
      OWNER_TEST_REQUIRED: 'Спершу успішно перевірте сповіщення: без них продажі не вмикаються',
      COD_PAIR_FORBIDDEN: 'Такий вид післяплати з таким чеком заборонений',
    }[out.code] || 'Перевірте поля налаштувань'
    return fail(res, 400, out.code, message, { fields: out.fields })
  }))

  app.post('/api/shop/admin/test-alert', ownerRoute('тест алерта', async (_req, res) => {
    const telegram = await payments.notifyOwner(TEST_ALERT_TEXT)
    const phone = (await loadSales())?.ownerPhone
    let sms = 'no-phone'
    if (phone && sendSms) {
      const sent = await sendSms(phone, TEST_ALERT_TEXT).catch((e) => ({ ok: false, error: e.message }))
      sms = sent?.ok === false ? 'failed' : 'sent'
    }
    if (!telegram) return fail(res, 502, 'ALERT_FAILED', 'Telegram не доставив сповіщення: перевірте бота і змінну OWNER_TELEGRAM_CHAT_ID', { sms })
    const at = nowIso()
    await salesRef().set({ ownerTestOkAt: at }, { merge: true })
    return answer(res, { ownerTestOkAt: at, sms })
  }))

  // Аварийная кнопка: и директору, ведь заменяет владельца. Сначала выключатель: портал отказывает сразу, а снятие счетов может идти долго.
  // Заказ остаётся в awaiting_payment: снятый счёт считается закрытым, после включения продаж покупателю предложат новый.
  app.post('/api/shop/admin/disable-and-remove-invoices', route('вимкнення', async (_req, res, staff) => {
    const at = nowIso()
    await salesRef().set({ mode: 'off', updatedAt: at, updatedBy: staff.by }, { merge: true })
    const live = await liveInvoices()
    const results = await Promise.allSettled(live.map((p) => hooks.removeLiveInvoice(p.orderId)))
    let failed = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') return
      failed += 1
      console.error(`shop admin: рахунок ${live[i].orderId} не знято:`, failText(r.reason))
    })
    return answer(res, { mode: 'off', total: live.length, failed })
  }))

  // alerts['day-limit'] тоже: иначе второго алерта в этот день уже не будет.
  app.post('/api/shop/admin/daily-reset', ownerRoute('лічильник', async (_req, res) => {
    const day = KYIV_DAY.format(new Date())
    await adminDb.collection('shopDaily').doc(day).set({ unpaid: 0, alerts: { 'day-limit': null } }, { merge: true })
    return answer(res, { day, unpaid: 0 })
  }))

  app.post('/api/shop/admin/phones/unblock', ownerRoute('розблокування', async (req, res) => {
    const phone = shopPhone(req.body?.phone)
    if (!phone) return fail(res, 400, 'BAD_INPUT', 'Вкажіть телефон у форматі +380…', { fields: ['phone'] })
    await adminDb.collection('shopPhones').doc(phoneKeyOf(phone)).set({ codBlocked: false }, { merge: true })
    return answer(res, { codBlocked: false })
  }))

  // ---------- готовность ----------

  // Чтение кассы для блока готовности: смену и чеки не трогает. Что не ответило, то unknown: зелёное только по подтверждённому ответу.
  const checkboxReadiness = async (fop) => {
    const cb = fop?.checkbox || {}
    if (!cb.licenseKey) return { status: 'none', message: 'Ключ каси не заданий' }
    const statusOfError = (e) => ([401, 403].includes(e?.response?.status) ? 'bad' : 'unknown')
    const [me, shift, register] = await Promise.allSettled([cbx.cashierMe(fop), cbx.cashierShift(fop), cbx.cashRegisterInfo(fop)])
    const out = { status: me.status === 'fulfilled' ? 'ok' : statusOfError(me.reason) }
    if (me.status === 'fulfilled') {
      const m = me.value || {}
      out.cashier = { name: clip(m.full_name), blocked: m.blocked ?? null, organization: clip(m.organization?.title), edrpou: clip(m.organization?.edrpou, 32) }
      out.autoCloseShiftAt = m.organization?.auto_close_shift_at ?? null
    } else {
      console.warn('shop admin: каса, вхід:', failText(me.reason))
    }
    // Смены нет: тело пустое, это не сбой.
    out.shift = shift.status === 'fulfilled'
      ? { status: clip(shift.value?.status, 40), openedAt: clip(shift.value?.opened_at, 40) }
      : { status: 'unknown' }
    out.cashRegister = register.status === 'fulfilled'
      ? { title: clip(register.value?.title), address: clip(register.value?.address), fiscalNumber: clip(register.value?.fiscal_number, 64), ettnAcquiring: !!register.value?.ettn_acquiring_id }
      : { status: statusOfError(register.reason) }
    return out
  }

  const withinBudget = (work, onTimeout) => withBudget(work, readinessBudgetMs).catch((e) => {
    console.warn('shop admin: готовність:', failText(e))
    return onTimeout
  })
  const NOT_ANSWERED = { status: 'unknown', message: 'Сервіс не відповів, спробуйте пізніше' }

  app.get('/api/shop/admin/readiness', route('готовність', async (_req, res) => {
    const cfg = await loadSales()
    const fopId = str(cfg?.fopId)
    const tplId = str(cfg?.npTemplateId)
    const [fop, tplSnap, prices, day] = await Promise.all([
      fopId ? loadFopFresh(adminDb, fopId) : null,
      tplId ? adminDb.collection('npTemplates').doc(tplId).get() : null,
      adminDb.collection('priceList').doc('current').get(),
      adminDb.collection('shopDaily').doc(KYIV_DAY.format(new Date())).get(),
    ])
    const tpl = tplSnap?.exists ? tplSnap.data() : null
    const [merchant, cash] = await Promise.all([
      fop ? withinBudget(checkMonoAcquire(fop, mono.merchantDetails), NOT_ANSWERED) : { status: 'none', message: 'ФОП не вибрано' },
      fop ? withinBudget(checkboxReadiness(fop), NOT_ANSWERED) : { status: 'none', message: 'ФОП не вибрано' },
    ])
    const templateProblems = npTemplateProblems(tpl, fopId)
    const items = Object.entries(cfg?.skus || {}).map(([sku, rule]) => {
      const { item, reason } = pricedItem(prices.exists ? prices.data() : null, sku, rule)
      return { sku, enabled: rule?.enabled === true, inStock: rule?.inStock === true, stock: rule?.stock ?? null, priceUah: item?.priceUah ?? null, problem: reason || null }
    })
    const card = shopSellable(fop, 'card', cfg)
    // Для первой покупки: всё, что должно быть на месте, пока продажи не включены. Условия H6, которые код проверить не может, здесь не перечислены.
    const problems = [
      ...(siteBaseUrlOk(cfg?.siteBaseUrl) ? [] : ['siteBaseUrl']),
      ...(str(cfg?.offerVersion) ? [] : ['offerVersion']),
      ...(cfg?.ownerTestOkAt ? [] : ['ownerTest']),
      ...(cfg?.ownerPhone ? [] : ['ownerPhone']),
      ...(card.ok ? [] : ['fopGate']),
      ...(merchant.status === 'ok' ? [] : ['monoAcquire']),
      ...(cash.status === 'ok' ? [] : ['checkbox']),
      ...(cash.autoCloseShiftAt ? [] : ['autoCloseShift']),
      ...(templateProblems.length ? ['npTemplate'] : []),
      ...(items.some((i) => i.enabled && i.problem) ? ['items'] : []),
    ]
    return answer(res, {
      mode: cfg?.mode || 'off',
      methods: cfg?.methods || {},
      ready: !problems.length,
      problems,
      fop: fop ? { id: fop.id, name: fop.name, active: fop.active } : null,
      seller: publicSeller(fop),
      sellable: { card },
      monoAcquire: merchant,
      npTemplate: { id: tplId || null, name: tpl?.name || null, problems: templateProblems, problemTexts: templateProblems.map((k) => TEMPLATE_PROBLEM_TEXT[k]), description: tpl?.description || null, weight: tpl?.weight ?? null, payerType: tpl?.payerType || null },
      checkbox: cash,
      ownerTestOkAt: cfg?.ownerTestOkAt || null,
      ownerPhoneSet: !!cfg?.ownerPhone,
      siteBaseUrl: cfg?.siteBaseUrl || null,
      callbackBaseUrlSet: !!process.env.SHOP_CALLBACK_BASE_URL,
      offerVersion: cfg?.offerVersion || null,
      items,
      today: { unpaid: (day.exists && day.data().unpaid) || 0, limit: shopLimit(cfg, 'unpaidPerDay') },
      acceptsOrders: acceptsOrders(cfg),
    })
  }))

  // Адрес мимо маршрута и битое тело иначе ответили бы страницей HTML. Тело в журнал не пишем.
  app.use('/api/shop/admin', (_req, res) => fail(res, 404, 'NOT_FOUND', 'No such shop admin route'))
  app.use('/api/shop/admin', (err, _req, res, _next) => {
    const client = err.status >= 400 && err.status < 500
    fail(res, client ? err.status : 500, client ? 'BAD_INPUT' : 'INTERNAL', client ? 'Bad request body' : 'Internal error')
  })
}

export default registerShopAdmin
