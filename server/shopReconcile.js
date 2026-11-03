// Шаг магазина в общей сверке оплат (payments.addReconcileStep): всё, что само не случится, если колбэк банка, Telegram,
// сообщение или касса не дошли. Опрос счетов, закрытие брошенных заказов, чек, напоминания владельцу, посылки Новой Почты,
// стирание данных. Экземпляров сервера несколько, сверка идёт на каждом: переходы и разовые алерты только транзакциями.
// В алертах нет имени, телефона и отделения. Токен статуса и данные покупателя в журнал не пишем.
import { loadFopFresh } from './fops.js'
import * as monoAcquire from './monoAcquire.js'
import * as checkbox from './checkbox.js'
import { npCall as realNpCall } from './novaPoshtaTtn.js'
import { KYIV_DAY, messageDue, ttnMessageKind } from './shopPayments.js'
import {
  RECEIPT_FAILED, acceptsOrders, claimFresh, invoiceFinal, npDeliveredAt, npDeliveryFrom, npOutcome, piiPurgePatch, shopSellable, transitionPatch, ttnGonePatch,
} from './shopCore.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const INVOICE_POLL_AFTER_MS = 2 * MIN
const LIVE_INVOICE_POLL_MS = 2 * MIN // сверка идёт раз в 3 минуты: опрашиваем живой счёт на каждом проходе
const CLOSED_INVOICE_POLL_MS = 15 * MIN
const EXPIRE_AFTER_MS = DAY
const PAID_POLL_MS = HOUR
const PAID_POLL_COLD_MS = DAY
// Сколько после оплаты ждём возврат и чарджбэк по полученному заказу. Как банк показывает чарджбэк, неизвестно (раздел I плана); 120 дней: обычный срок карточных споров.
const PAID_WATCH_MS = 120 * DAY
const RECEIPT_PUSH_AFTER_MS = 2 * MIN
const RECEIPT_LATE_MS = 10 * MIN
export const RECEIPT_CLAIM_STALE_MS = 10 * MIN
const NO_TTN_AFTER_MS = DAY
const NP_POLL_MS = 30 * MIN
const NP_BATCH = 100
const NP_NOT_HANDED_MS = 48 * HOUR
const NP_STALE_MS = DAY
const NP_NO_FINAL_MS = 45 * DAY
const REFUND_ALERT_MS = 20 * DAY
const ALERT_RETRY_MS = 2 * MIN
const UNPAID_PII_MS = 30 * DAY
const SLOW_SCAN_MS = HOUR
const PURGE_EVERY_MS = DAY
const BANK_CALLS_PER_PASS = 50
const PASS_BUDGET_MS = 2 * MIN

const EVERY_PASS_STATES = ['awaiting_payment', 'paid', 'cod_confirmed', 'payment_review', 'shipped', 'refused']
// Эти копятся годами, поэтому реже. reversed только ради непосланных алертов.
const SLOW_STATES = ['delivered', 'returned', 'reversed']
const COLD_PAID_STATES = new Set(['delivered', 'returned'])
const UNPAID_STATES = ['cancelled', 'expired']
const PAID_FINAL_STATES = ['delivered', 'returned', 'reversed']
// Сверка повторит сама (error) или решает владелец (amount-mismatch), либо касса у ФОП не подключена (no-checkbox).
const NO_RECEIPT_PUSH = new Set(['error', 'amount-mismatch', 'no-checkbox'])

// Что случилось и что сделать: тексты для владельца, шаги подробнее в памятке.
const ALERT = {
  receiptFailed: (o, url, status) => `⚠️ Замовлення ${o.orderNo}: ${o.total} грн оплачено, чек не вийшов (${status}). Перевірте кабінет Checkbox і видайте чек вручну або повторіть його на картці замовлення: ${url}`,
  receiptLate: (o, url) => `⚠️ Замовлення ${o.orderNo}: ${o.total} грн оплачено, чека немає понад 10 хвилин. Перевірте кабінет Checkbox і картку замовлення: ${url}`,
  receiptClaim: (o, url) => `⚠️ Замовлення ${o.orderNo}: ${o.total} грн оплачено, чек завис, і каса не відповідає, чи він є. Новий чек не виписуйте, спершу перевірте кабінет Checkbox: ${url}`,
  noTtn: (o, url, days) => `⚠️ Замовлення ${o.orderNo}: ${o.total} грн, уже ${days} дн. без накладної. Створіть її або зв'яжіться з покупцем: ${url}`,
  notHanded: (o, url) => `⚠️ Замовлення ${o.orderNo}: накладна ${o.ttn} створена понад 48 годин тому, а посилку не здано. Здайте її або видаліть накладну в кабінеті НП і перевірте статус на картці: ${url}`,
  ttnGone: (o, url, code) => `⚠️ Замовлення ${o.orderNo}: НП більше не знає накладну ${o.ttn} (код ${code}), замовлення знову чекає накладну. Створіть нову: ${url}`,
  refused: (o, url) => `⚠️ Замовлення ${o.orderNo}: ${o.total} грн, посилку ${o.ttn} не отримано, вона повертається. Вирішіть повернення коштів: у кабінеті monobank і чек повернення в Checkbox. Коли посилка прийде, відмітьте це на картці: ${url}`,
  npStale: (o, url, days) => `⚠️ Замовлення ${o.orderNo}: статус накладної ${o.ttn} не оновлюється вже ${days} дн. Перевірте посилку в кабінеті НП і ключ НП у ФОП: ${url}`,
  npNoFinal: (o, url) => `⚠️ Замовлення ${o.orderNo}: посилка ${o.ttn} уже 45 днів без остаточного статусу. Перевірте її в кабінеті НП: ${url}`,
  refundDay20: (o, url) => `⚠️ Замовлення ${o.orderNo}: минуло 20 днів після відмови або заяви на повернення, ${o.total} грн треба повернути не пізніше 30-го дня. Поверніть гроші в кабінеті monobank і оформіть чек повернення в Checkbox: ${url}`,
  gate: (url, missing) => `⚠️ Магазин: ФОП не проходить перевірку (${missing.join(', ')}), нові замовлення карткою не приймаються, кнопка «Купити» зникла. Перевірте блок готовності: ${url}`,
}

const nowIso = () => new Date().toISOString()
const ageMs = (at) => Date.now() - Date.parse(at)
const failText = (e) => e?.response?.status || e?.message

const safely = async (what, fn) => {
  try {
    return await fn()
  } catch (e) {
    console.error(`shop reconcile: ${what}:`, failText(e))
    return undefined
  }
}

export function createShopReconcile(deps) {
  const {
    adminDb, payments, hooks, mono = monoAcquire, cbx = checkbox, npCall = realNpCall, siteUrl = 'https://my.runferry.com',
    slowScanMs = SLOW_SCAN_MS, purgeEveryMs = PURGE_EVERY_MS, bankCallsPerPass = BANK_CALLS_PER_PASS, passBudgetMs = PASS_BUDGET_MS,
  } = deps
  const orders = () => adminDb.collection('shopOrders')
  const loadSales = async () => {
    const snap = await adminDb.collection('system').doc('shopSales').get()
    return snap.exists ? snap.data() : null
  }
  const canCallBank = (pass) => pass.checked < bankCallsPerPass && Date.now() < pass.deadline
  const readStates = async (states) => {
    const found = []
    for (const state of states) {
      await safely(`читання ${state}`, async () => {
        const q = await orders().where('state', '==', state).get()
        for (const d of q.docs) found.push({ ref: orders().doc(d.id), order: d.data() })
      })
    }
    return found
  }
  // Предпроверка, чтобы не открывать транзакцию на каждом проходе; повтор закрывает сам shopAlert.
  const alertOnce = async (ref, order, kind, textOf) => {
    if (!(order.alerts || {})[kind]) await hooks.shopAlert(ref.id, kind, textOf)
  }

  // Банк о счёте. Сумма и возврат решаются в settleMonoAcquire. Спросить не вышло: повторим на следующем проходе.
  const settleFromBank = async (p, pass) => {
    if (!canCallBank(pass)) return
    const fop = await payments.resolveFop(p.fopId)
    if (!fop) {
      console.warn(`shop reconcile: ФОП ${p.fopId} не завантажено, платіж ${p.orderId} чекає`)
      return
    }
    pass.checked += 1
    await payments.settleMonoAcquire(p, await mono.invoiceStatus(fop, p.providerOrderId), 'reconcile')
  }

  // ---------- п. 1: неоплаченный заказ ----------

  // Банк не знает снятый или давно закрытый счёт: это не повод держать заказ открытым.
  const bankForgot = (p, e) => invoiceFinal(p) && [400, 404].includes(e?.response?.status)

  // true, если все счета прочитаны. Банк мог принять деньги и по failure, и по снятому счёту: в общей сверке их уже нет, поэтому здесь все.
  const readInvoices = async (ref, docs, pass) => {
    let allRead = true
    for (const p of docs) {
      if (!p || p.status === 'reversed' || !p.providerOrderId) continue
      if (!canCallBank(pass)) return false
      const fop = await payments.resolveFop(p.fopId)
      if (!fop) {
        allRead = false
        continue
      }
      pass.checked += 1
      try {
        const st = await mono.invoiceStatus(fop, p.providerOrderId)
        await adminDb.runTransaction(async (tx) => {
          const cur = (await tx.get(ref)).data()
          if (cur.payment?.paymentId === p.orderId && cur.payment.status !== st?.status) tx.set(ref, { payment: { status: String(st?.status || '') } }, { merge: true })
        })
        // Тот же конечный ответ ничего не меняет, запись не нужна.
        if (st?.status !== p.status) await payments.settleMonoAcquire(p, st, 'reconcile')
      } catch (e) {
        if (!bankForgot(p, e)) {
          allRead = false
          console.error(`shop reconcile: рахунок ${p.orderId}:`, failText(e))
        }
      }
    }
    return allRead
  }

  const expireOrder = async (ref, order, count) => {
    const at = nowIso()
    const phoneRef = order.phoneKey ? adminDb.collection('shopPhones').doc(order.phoneKey) : null
    await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (cur.state !== 'awaiting_payment' || claimFresh(cur.payment?.initiatedAt) || (cur.paymentIds || []).length !== count) return
      const phone = phoneRef ? await tx.get(phoneRef) : null
      tx.set(ref, transitionPatch(cur, 'expired', { at, by: 'reconcile', patch: { payment: { pageUrl: null } } }), { merge: true })
      if (phone?.exists && (phone.data().openCard || {})[cur.sku] === ref.id) tx.set(phoneRef, { openCard: { [cur.sku]: null } }, { merge: true })
    })
  }

  // Срок 24 часа считается с первого прохода, когда все счета оказались закрыты: updatedAt оплаты для этого не годится, опрос его двигает.
  const pollInvoices = async (ref, order, pass) => {
    if (ageMs(order.createdAt) < INVOICE_POLL_AFTER_MS) return
    const ids = order.paymentIds || []
    const load = () => Promise.all(ids.map((id) => payments.loadOrder(id)))
    const docs = await load()
    const anyLive = docs.some((p) => !invoiceFinal(p))
    const closeDue = !anyLive && ageMs(order.invoicesFinalAt) >= EXPIRE_AFTER_MS
    const every = anyLive ? LIVE_INVOICE_POLL_MS : CLOSED_INVOICE_POLL_MS
    if (!closeDue && ageMs(order.invoicesCheckedAt) < every) return
    if (ids.length && !canCallBank(pass)) return
    const claimed = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (cur.state !== 'awaiting_payment' || (!closeDue && ageMs(cur.invoicesCheckedAt) < every)) return false
      tx.set(ref, { invoicesCheckedAt: nowIso() }, { merge: true })
      return true
    })
    if (!claimed) return

    const allRead = await readInvoices(ref, docs, pass)
    const after = await load()
    if (after.some((p) => !invoiceFinal(p)) || claimFresh(order.payment?.initiatedAt)) {
      if (order.invoicesFinalAt) await ref.set({ invoicesFinalAt: null }, { merge: true })
      return
    }
    if (!allRead) return
    if (closeDue) await expireOrder(ref, order, ids.length)
    else if (!order.invoicesFinalAt) await ref.set({ invoicesFinalAt: nowIso() }, { merge: true })
  }

  // ---------- оплаченный заказ: опрос счёта и чек (пп. 2, 3, 4) ----------

  // Первый раз через срок после оплаты: сразу после неё и колбэк, и страница статуса только что спрашивали банк.
  const paidPollDue = (order) => {
    const cold = COLD_PAID_STATES.has(order.state)
    if (cold && ageMs(order.paidAt) > PAID_WATCH_MS) return false
    return !(ageMs(order.payment?.lastBankCheckAt || order.paidAt) < (cold ? PAID_POLL_COLD_MS : PAID_POLL_MS))
  }

  // Метка bankRecheck появляется только при сбое: без этого опроса возврат или чарджбэк после отправки никто бы не заметил.
  const pollPaidInvoice = async (ref, order, p, pass) => {
    if (p.status !== 'paid' || !p.providerOrderId || !paidPollDue(order) || !canCallBank(pass)) return
    const claimed = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (!paidPollDue(cur)) return false
      tx.set(ref, { payment: { lastBankCheckAt: nowIso() } }, { merge: true })
      return true
    })
    if (claimed) await settleFromBank(p, pass)
  }

  // Захват старше срока: процесс упал посреди чека, а Checkbox мог его создать. Сначала смотрим по детерминированному id.
  const recoverReceiptClaim = async (ref, order, p, pass) => {
    const fop = await payments.resolveFop(p.fopId)
    if (!fop) {
      console.warn(`shop reconcile: ФОП ${p.fopId} не завантажено, чек ${p.orderId} чекає`)
      return
    }
    let found
    try {
      found = await cbx.getReceipt(fop, payments.receiptUuidFor(p.orderId, p.receiptAttempt))
    } catch (e) {
      if (e?.response?.status !== 404) {
        console.error(`shop reconcile: чек ${p.orderId}:`, failText(e))
        await alertOnce(ref, order, 'receipt-claim', ALERT.receiptClaim)
        return
      }
      const payRef = adminDb.collection('payments').doc(p.orderId)
      const released = await adminDb.runTransaction(async (tx) => {
        const cur = (await tx.get(payRef)).data()
        if (cur.receiptId || cur.fiscalizeClaimedAt !== p.fiscalizeClaimedAt) return false
        tx.set(payRef, { fiscalizeClaimedAt: null, updatedAt: nowIso() }, { merge: true })
        return true
      })
      if (released) await settleFromBank({ ...p, fiscalizeClaimedAt: null }, pass)
      return
    }
    await payments.saveOrder({
      orderId: p.orderId, receiptId: found.receiptId, fiscalCode: found.fiscalCode, taxUrl: found.taxUrl,
      receiptStatus: found.status || 'done', receiptError: null, receiptAt: nowIso(),
    })
  }

  // Чек только через ответ банка: пока его не было, деньги могли вернуть, а колбэк о возврате не гарантирован.
  // true: занялись чеком, отдельный опрос этого счёта на проходе не нужен.
  const pushReceipt = async (ref, order, p, pass) => {
    if (p.status !== 'paid' || p.receiptId || NO_RECEIPT_PUSH.has(p.receiptStatus)) return false
    if (p.fiscalizeClaimedAt) {
      if (ageMs(p.fiscalizeClaimedAt) < RECEIPT_CLAIM_STALE_MS) return false
      await recoverReceiptClaim(ref, order, p, pass)
      return true
    }
    if (ageMs(order.paidAt) < RECEIPT_PUSH_AFTER_MS) return false
    await settleFromBank(p, pass)
    return true
  }

  // receiptId здесь не признак: его пишет и чек в статусе CREATED. Готов только чек со ссылкой.
  const watchReceipt = async (ref, order, p) => {
    if (p.status === 'reversed' || p.receiptStatus === 'amount-mismatch') return
    if (p.taxUrl) {
      if (order.receipt?.status !== 'ready' || order.receipt?.taxUrl !== p.taxUrl) await ref.set({ receipt: { status: 'ready', taxUrl: p.taxUrl, checkedAt: nowIso() } }, { merge: true })
      if (messageDue(order, 'rcpt')) await hooks.sendReceiptMessage(ref, p.taxUrl)
      return
    }
    if (RECEIPT_FAILED.has(p.receiptStatus)) {
      if (order.receipt?.status !== 'failed') await ref.set({ receipt: { status: 'failed', checkedAt: nowIso() } }, { merge: true })
      await alertOnce(ref, order, 'receipt-failed', (o, url) => ALERT.receiptFailed(o, url, p.receiptStatus))
    } else if (ageMs(order.paidAt) >= RECEIPT_LATE_MS) {
      await alertOnce(ref, order, 'receipt-late', ALERT.receiptLate)
    }
  }

  const reconcilePaid = async (ref, order, pass) => {
    // Обычный случай: чек дошёл, банк спрашивали недавно. Таких заказов большинство, документ оплаты читать незачем.
    if (!paidPollDue(order) && order.receipt?.status === 'ready' && !messageDue(order, 'rcpt')) return
    const paid = await payments.loadOrder(order.paidPaymentId)
    if (!paid) return
    const pushed = await safely(`чек ${order.orderNo}`, () => pushReceipt(ref, order, paid, pass))
    if (!pushed) await safely(`опитування ${order.orderNo}`, () => pollPaidInvoice(ref, order, paid, pass))
    await watchReceipt(ref, order, (await payments.loadOrder(order.paidPaymentId)) || paid)
  }

  // ---------- напоминания (пп. 5, 7) ----------

  // В shipped тоже: накладную могли создать раньше, чем дошло сообщение, а ссылка на статус есть только в нём. Наложка денег ещё не платила.
  const announcePaid = async (ref, order) => {
    if (order.method !== 'card') return
    if (order.state === 'paid' && !(order.alerts || {})['new-paid']) await hooks.alertNewPaid(ref)
    if ((order.state === 'paid' || order.state === 'shipped') && messageDue(order, 'paid')) await hooks.sendPaidMessage(ref)
  }

  // Сообщение о накладной могло не уйти: сервер упал после записи номера или не ответил SMS. Наложка ждёт заготовку чека (вторая волна).
  const announceTtn = async (ref, order) => {
    if (order.state === 'shipped' && order.method === 'card' && order.ttn && messageDue(order, ttnMessageKind(order.ttn))) await hooks.sendTtnMessage(ref, order.ttn)
  }

  // Срок считается от входа в состояние: после удаления накладной заказ снова ждёт новую, и старая дата оплаты ни при чём.
  const watchNoTtn = async (ref, order) => {
    if ((order.state !== 'paid' && order.state !== 'cod_confirmed') || order.ttn) return
    const entered = (order.history || []).at(-1)?.at || order.paidAt
    const days = Math.floor(ageMs(entered) / NO_TTN_AFTER_MS)
    if (days >= 1) await alertOnce(ref, order, `no-ttn-${days}`, (o, url) => ALERT.noTtn(o, url, days))
  }

  // Срок возврата денег 30 дней: напоминаем на 20-й. refundRequestedAt ставит владелец на карточке заказа.
  const watchRefundDeadline = async (ref, order) => {
    if (order.method !== 'card' || !order.paidPaymentId || order.state === 'reversed') return
    const starts = (order.history || []).filter((h) => h.to === 'refused' || h.to === 'returned').map((h) => h.at)
    if (order.refundRequestedAt) starts.push(order.refundRequestedAt)
    const oldest = Math.max(...starts.map(ageMs).filter(Number.isFinite), -Infinity)
    if (oldest >= REFUND_ALERT_MS) await alertOnce(ref, order, 'refund-day-20', ALERT.refundDay20)
  }

  // ---------- п. 8: что не дошло ----------

  // Свежий алерт ещё шлёт его автор. triedAt не даёт нескольким экземплярам повторить одно и то же.
  const retryAlerts = async (ref, doc) => {
    for (const [kind, alert] of Object.entries(doc.alerts || {})) {
      if (!alert || alert.sentAt || ageMs(alert.at) < ALERT_RETRY_MS || ageMs(alert.triedAt) < ALERT_RETRY_MS) continue
      const claimed = await adminDb.runTransaction(async (tx) => {
        const cur = ((await tx.get(ref)).data().alerts || {})[kind]
        if (!cur || cur.sentAt || ageMs(cur.triedAt) < ALERT_RETRY_MS) return false
        tx.set(ref, { alerts: { [kind]: { triedAt: nowIso() } } }, { merge: true })
        return true
      })
      if (claimed) await hooks.sendAlerts(ref, { [kind]: alert })
    }
  }

  const sweepDayAlerts = async () => {
    for (const date of [new Date(), new Date(Date.now() - DAY)]) {
      const ref = adminDb.collection('shopDaily').doc(KYIV_DAY.format(date))
      const snap = await ref.get()
      if (snap.exists) await retryAlerts(ref, snap.data())
    }
  }

  // Накладная легла на закрытый заказ. Закрытые заказы сверка не читает, а алерт не должен потеряться.
  const sweepClosedTtnAlerts = async () => {
    const q = await orders().where('ttnOnClosed', '==', true).get()
    for (const d of q.docs) await safely(`алерти ${d.id}`, () => retryAlerts(orders().doc(d.id), d.data()))
  }

  // ---------- п. 6: посылки ----------

  // null: заказ уже не тот (накладную заменили, пока шёл запрос). Иначе исход для этого номера.
  const applyParcel = async (ref, order, doc) => {
    const code = String(doc?.StatusCode ?? '').trim()
    const outcome = npOutcome(code, { shippedAt: order.shippedAt })
    const at = nowIso()
    const delivery = npDeliveryFrom(doc, order.npDelivery, at)
    const moved = await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      if (cur.state !== 'shipped' || String(cur.ttn) !== String(order.ttn)) return false
      const seen = { npCheckedAt: at, npDelivery: delivery }
      const patch = outcome === 'delivered'
        ? transitionPatch(cur, 'delivered', { at, by: 'np', patch: { npCheckedAt: at, npDelivery: { ...delivery, final: true, deliveredAt: npDeliveredAt(doc, at) } } })
        : outcome === 'refused'
          ? transitionPatch(cur, 'refused', { at, by: 'np', patch: { npCheckedAt: at, refusedAt: at, npDelivery: { ...delivery, final: true } } })
          : outcome === 'back'
            ? transitionPatch(cur, cur.method === 'cod' ? 'cod_confirmed' : 'paid', { at, by: 'np', patch: ttnGonePatch(cur, code, at) })
            : null
      tx.set(ref, patch || seen, { merge: true })
      return true
    })
    if (!moved) return null
    if (outcome === 'refused') await alertOnce(ref, order, `refused-${order.ttn}`, ALERT.refused)
    if (outcome === 'back') await alertOnce(ref, order, `ttn-gone-${order.ttn}`, (o, url) => ALERT.ttnGone({ ...o, ttn: order.ttn }, url, code))
    if (outcome === 'not-handed' && ageMs(order.shippedAt) >= NP_NOT_HANDED_MS) await alertOnce(ref, order, `np-not-handed-${order.ttn}`, ALERT.notHanded)
    return outcome
  }

  // Ключ у каждого ФОП свой: партии по ключу.
  const queryParcels = async (group, fopId, outcomes, pass) => {
    const fop = await payments.resolveFop(fopId)
    const apiKey = fop?.novaPoshta?.apiKey
    if (!apiKey) {
      console.warn(`shop reconcile: у ФОП ${fopId} немає ключа НП, посилки чекають`)
      return
    }
    for (let i = 0; i < group.length; i += NP_BATCH) {
      if (Date.now() >= pass.deadline) return
      const batch = group.slice(i, i + NP_BATCH)
      const resp = await npCall(apiKey, 'TrackingDocument', 'getStatusDocuments', { Documents: batch.map(({ order }) => ({ DocumentNumber: String(order.ttn) })) })
      if (resp?.success !== true || !Array.isArray(resp.data)) throw new Error('відповідь НП не успішна')
      const byNumber = new Map(resp.data.filter(Boolean).map((d) => [String(d.Number), d]))
      for (const { ref, order } of batch) {
        const doc = byNumber.get(String(order.ttn))
        if (doc) outcomes.set(ref.id, await safely(`посилка ${order.orderNo}`, () => applyParcel(ref, order, doc)))
      }
    }
  }

  // Кнопка на карточке заказа: тот же разбор, не дожидаясь прохода. undefined, если НП не вернула этот номер.
  const refreshParcel = async (ref, order) => {
    const outcomes = new Map()
    await queryParcels([{ ref, order }], order.npFopId || order.fopId, outcomes, { deadline: Infinity })
    return outcomes.get(ref.id)
  }

  const trackParcels = async (shipped, pass) => {
    const outcomes = new Map()
    const groups = new Map()
    for (const item of shipped) {
      if (ageMs(item.order.npCheckedAt) < NP_POLL_MS) continue
      const fopId = item.order.npFopId || item.order.fopId
      groups.set(fopId, [...(groups.get(fopId) || []), item])
    }
    for (const [fopId, group] of groups) await safely(`посилки ФОП ${fopId}`, () => queryParcels(group, fopId, outcomes, pass))
    // После опроса: заказ, только что получивший ответ НП, не должен выглядеть забытым.
    for (const { ref, order } of shipped) {
      const outcome = outcomes.get(ref.id)
      if (outcome === 'delivered' || outcome === 'refused' || outcome === 'back') continue
      await safely(`сроки посилки ${order.orderNo}`, async () => {
        const staleDays = Math.floor(ageMs(order.npCheckedAt || order.shippedAt) / NP_STALE_MS)
        if (!outcomes.has(ref.id) && staleDays >= 1) await alertOnce(ref, order, `np-stale-${order.ttn}-${staleDays}`, (o, url) => ALERT.npStale(o, url, staleDays))
        if (ageMs(order.shippedAt) >= NP_NO_FINAL_MS) await alertOnce(ref, order, `np-no-final-${order.ttn}`, ALERT.npNoFinal)
      })
    }
  }

  // ---------- гейт ФОП ----------

  // Лента просто перестаёт показывать кнопку: без этого владелец не узнал бы, что продажи встали. Раз в сутки.
  const checkGate = async () => {
    const cfg = await loadSales()
    if (!acceptsOrders(cfg) || (cfg.methods || {}).card !== true) return
    const fopId = String(cfg.fopId || '').trim()
    const gate = shopSellable(fopId ? await loadFopFresh(adminDb, fopId) : null, 'card', cfg)
    if (gate.ok) return
    const ref = adminDb.collection('shopDaily').doc(KYIV_DAY.format(new Date()))
    const fresh = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.exists && (snap.data().alerts || {})['gate-card']) return {}
      const alerts = { 'gate-card': { at: nowIso(), sentAt: null, text: ALERT.gate(`${siteUrl}/shop-orders`, gate.missing) } }
      tx.set(ref, { alerts }, { merge: true })
      return alerts
    })
    await hooks.sendAlerts(ref, fresh)
  }

  // ---------- п. 9: стирание ----------

  // Срок для оплаченных заказов решает бухгалтер: limits.piiPaidDays. Пока числа нет, оплаченные не стираются.
  const purgeOld = async () => {
    const cfg = await safely('налаштування для стирання', loadSales)
    const paidDays = cfg?.limits?.piiPaidDays
    const paidMs = Number.isInteger(paidDays) && paidDays > 0 ? paidDays * DAY : null
    const purge = async ({ ref, order }, olderThanMs, fits) => {
      if (order.piiPurgedAt || !fits(order) || !(ageMs(order.createdAt) >= olderThanMs)) return
      await adminDb.runTransaction(async (tx) => {
        const cur = (await tx.get(ref)).data()
        if (!cur.piiPurgedAt && cur.state === order.state && fits(cur)) tx.set(ref, piiPurgePatch(nowIso()), { merge: true })
      })
    }
    for (const item of await readStates(UNPAID_STATES)) {
      await safely(`стирання ${item.order.orderNo}`, () => purge(item, UNPAID_PII_MS, (o) => !o.paidPaymentId))
    }
    if (paidMs === null) return
    for (const item of await readStates(PAID_FINAL_STATES)) {
      await safely(`стирання ${item.order.orderNo}`, () => purge(item, paidMs, () => true))
    }
  }

  // ---------- проход ----------

  const reconcileOrder = async ({ ref, order }, pass) => {
    const part = (what, fn) => safely(`${what} ${order.orderNo}`, fn)
    if (order.state === 'awaiting_payment') await part('рахунки', () => pollInvoices(ref, order, pass))
    if (order.paidPaymentId && order.state !== 'reversed') await part('оплата', () => reconcilePaid(ref, order, pass))
    await part('сповіщення про оплату', () => announcePaid(ref, order))
    await part('сповіщення про накладну', () => announceTtn(ref, order))
    await part('накладна', () => watchNoTtn(ref, order))
    await part('строк повернення', () => watchRefundDeadline(ref, order))
    await part('алерти', () => retryAlerts(ref, order))
  }

  let running = false
  let lastSlowAt = -Infinity
  let lastPurgeAt = -Infinity

  const step = async () => {
    if (running) return { checked: 0 }
    running = true
    const pass = { checked: 0, deadline: Date.now() + passBudgetMs }
    try {
      const slowDue = Date.now() - lastSlowAt >= slowScanMs
      if (slowDue) lastSlowAt = Date.now()
      const hot = await readStates(EVERY_PASS_STATES)
      const cold = slowDue ? await readStates(SLOW_STATES) : []
      for (const item of [...hot, ...cold]) await reconcileOrder(item, pass)
      await safely('посилки', () => trackParcels(hot.filter(({ order }) => order.state === 'shipped' && order.ttn), pass))
      await safely('алерти дня', sweepDayAlerts)
      await safely('алерти закритих', sweepClosedTtnAlerts)
      if (slowDue) await safely('гейт', checkGate)
      if (Date.now() - lastPurgeAt >= purgeEveryMs) {
        lastPurgeAt = Date.now()
        await safely('стирання', purgeOld)
      }
    } finally {
      running = false
    }
    return { checked: pass.checked }
  }

  return { step, refreshParcel }
}

export default createShopReconcile
