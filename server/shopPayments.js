// Что оплата monobank меняет в заказе магазина (shopOrders). payments.js уже записал деньги в payments/{id} и зовёт
// эти хуки из settleMonoAcquire. Любой хук можно звать повторно: сбой лечит сверка по метке bankRecheck или следующий колбэк.
// Чек здесь не выбивается. В текстах алертов нет имени, телефона и отделения: только номер, сумма, что случилось и что делать.
import * as monoAcquire from './monoAcquire.js'

const nowIso = () => new Date().toISOString()
const DAY_MS = 24 * 60 * 60 * 1000
const KYIV_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }) // YYYY-MM-DD, как id в shopDaily
const newAlert = (at, text) => ({ at, sentAt: null, text })

export function createShopPaymentHooks({ adminDb, payments, mono = monoAcquire, siteUrl = 'https://my.runferry.com' }) {
  const orderRef = (id) => adminDb.collection('shopOrders').doc(String(id))
  const cardUrl = (ref) => `${siteUrl}/shop-orders/${ref.id}`

  // Алерт встаёт в транзакции вместе с причиной, поэтому параллельные вызовы шлют его один раз. Не дошёл: sentAt остаётся пустым.
  const sendAlerts = async (ref, alerts) => {
    for (const [kind, alert] of Object.entries(alerts)) {
      try {
        if (await payments.notifyOwner(alert.text)) await ref.set({ alerts: { [kind]: { sentAt: nowIso() } } }, { merge: true })
      } catch (e) {
        console.error(`shop: алерт ${kind} ${ref.id}:`, e.message)
      }
    }
  }

  // Снять ещё живой счёт в банке. Поздний успех по снятому счёту всё равно проводит оплату.
  const removeLiveInvoice = async (paymentId) => {
    const p = await payments.loadOrder(paymentId)
    if (!p || p.status !== 'pending' || p.provider !== 'mono-acquire' || !p.providerOrderId) return false
    const fop = await payments.resolveFop(p.fopId)
    if (!fop) throw new Error(`ФОП ${p.fopId} не завантажено`)
    await mono.removeInvoice(fop, p.providerOrderId)
    // Пока банк отвечал, колбэк мог записать оплату: её не затираем.
    const ref = adminDb.collection('payments').doc(String(paymentId))
    return adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (snap.data()?.status !== 'pending') return false
      tx.set(ref, { status: 'removed', updatedAt: nowIso() }, { merge: true })
      return true
    })
  }

  const removeOtherInvoices = async (shop, paidId) => {
    for (const id of shop.paymentIds || []) {
      if (id === paidId) continue
      try {
        await removeLiveInvoice(id)
      } catch (e) {
        console.error(`shop: рахунок ${id} не знято:`, e.message)
      }
    }
  }

  // Смотрим только назад по времени: иначе пара заказов алертила бы дважды.
  const alertPossibleDuplicate = async (ref, shop) => {
    if (!shop.phoneKey || (shop.alerts && shop.alerts['possible-duplicate'])) return
    try {
      const paidAt = Date.parse(shop.paidAt)
      const same = await adminDb.collection('shopOrders').where('phoneKey', '==', shop.phoneKey).get()
      const earlier = same.docs.map((d) => ({ ...d.data(), id: d.id })).find((o) => {
        const at = Date.parse(o.paidAt)
        return o.id !== ref.id && o.state !== 'reversed' && at <= paidAt && paidAt - at <= DAY_MS
      })
      if (!earlier) return
      const alert = newAlert(nowIso(), `⚠️ Замовлення ${shop.orderNo}: можливий дубль, той самий покупець за добу оплатив ${earlier.orderNo}. Перевірте обидва перед відправкою: ${cardUrl(ref)}`)
      const fresh = await adminDb.runTransaction(async (tx) => {
        const s = await tx.get(ref)
        if (s.data().alerts && s.data().alerts['possible-duplicate']) return false
        tx.set(ref, { alerts: { 'possible-duplicate': alert } }, { merge: true })
        return true
      })
      if (fresh) await sendAlerts(ref, { 'possible-duplicate': alert })
    } catch (e) {
      console.error(`shop: перевірка дубля ${ref.id}:`, e.message)
    }
  }

  // Деньги по счёту пришли. mismatch: текст расхождения с банком, если он есть; missing: каких полей банк не прислал.
  const onShopPaid = async (payment, { source, mismatch = '', missing = [] } = {}) => {
    const ref = orderRef(payment.shopOrderId)
    const paidId = payment.orderId
    const result = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return null
      const shop = snap.data()
      const at = nowIso()
      const head = `⚠️ Замовлення ${shop.orderNo}`
      const url = cardUrl(ref)
      const alerts = {}

      if (shop.paidPaymentId) {
        const extraKind = `extra-payment-${paidId}`
        if (shop.paidPaymentId !== paidId && !(shop.alerts && shop.alerts[extraKind])) {
          alerts[extraKind] = newAlert(at, `${head}: зайвий платіж ${payment.amount} грн, замовлення вже оплачено іншим рахунком. Поверніть ці гроші в кабінеті monobank і оформіть чек повернення в Checkbox: ${url}`)
          tx.set(ref, { alerts, updatedAt: at }, { merge: true })
        }
        return { shop, alerts }
      }

      const wasOpen = shop.state === 'awaiting_payment'
      const to = mismatch || !wasOpen ? 'payment_review' : 'paid'
      const phoneRef = shop.phoneKey ? adminDb.collection('shopPhones').doc(String(shop.phoneKey)) : null
      const phone = phoneRef ? await tx.get(phoneRef) : null
      const salesRef = to === 'paid' && shop.sku ? adminDb.collection('system').doc('shopSales') : null
      const sales = salesRef ? await tx.get(salesRef) : null
      const dayRef = wasOpen && shop.createdAt ? adminDb.collection('shopDaily').doc(KYIV_DAY.format(new Date(shop.createdAt))) : null
      const day = dayRef ? await tx.get(dayRef) : null

      if (phone && phone.exists && (phone.data().openCard || {})[shop.sku] === ref.id) tx.set(phoneRef, { openCard: { [shop.sku]: null } }, { merge: true })
      if (day && day.exists && day.data().unpaid > 0) tx.set(dayRef, { unpaid: day.data().unpaid - 1 }, { merge: true })
      const sku = sales && sales.exists ? (sales.data().skus || {})[shop.sku] : null
      if (sku && typeof sku.stock === 'number') {
        const left = sku.stock - (shop.qty || 1)
        tx.set(salesRef, { skus: { [shop.sku]: { stock: Math.max(left, 0), ...(left <= 0 ? { inStock: false } : {}) } } }, { merge: true })
        if (left < 0) alerts['stock-oversold'] = newAlert(at, `${head}: оплачено більше, ніж було на складі (${shop.sku}), продаж артикула вимкнено. Домовтеся з покупцем або поверніть гроші: ${url}`)
        else if (left === 0) alerts['stock-out'] = newAlert(at, `${head}: артикул ${shop.sku} закінчився, продаж вимкнено. Поповніть залишок на сторінці замовлень: ${url}`)
      }

      if (mismatch) alerts['amount-mismatch'] = newAlert(at, `${head}: ${shop.total} грн, дані банку не збігаються (${mismatch}). Чек не виписано. Звірте суму в кабінеті monobank і вирішіть на картці замовлення: ${url}`)
      if (!wasOpen) alerts['late-payment'] = newAlert(at, `${head}: ${payment.amount} грн оплачено вже після закриття замовлення. Вирішіть на картці замовлення: відправити чи повернути гроші: ${url}`)
      if (missing.length) alerts['amount-unverified'] = newAlert(at, `${head}: ${shop.total} грн оплачено, але банк не надіслав ${missing.join(', ')}, суму не звірено. Звірте її в кабінеті monobank: ${url}`)

      const paid = { state: to, paidPaymentId: paidId, paidAt: at, paidSource: source || null, payment: { pageUrl: null } }
      tx.set(ref, {
        ...paid,
        history: [...(shop.history || []), { at, from: shop.state || null, to, by: source || null }],
        ...(Object.keys(alerts).length ? { alerts } : {}),
        updatedAt: at,
      }, { merge: true })
      return { shop: { ...shop, ...paid }, alerts }
    })
    if (!result) return console.error(`shop: оплата ${paidId} без замовлення ${payment.shopOrderId}`)
    await sendAlerts(ref, result.alerts)
    await removeOtherInvoices(result.shop, paidId)
    await alertPossibleDuplicate(ref, result.shop)
  }

  // Банк вернул оплату. Заказ меняется, только если вернули именно оплативший счёт. refunded: сумма, если банк оставил часть денег.
  const onShopReversed = async (payment, { hadReceipt, source, refunded = null } = {}) => {
    const ref = orderRef(payment.shopOrderId)
    const result = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return null
      const shop = snap.data()
      const at = nowIso()
      const paying = shop.paidPaymentId === payment.orderId
      const kind = paying ? 'reversed' : `extra-reversed-${payment.orderId}`
      const receipt = hadReceipt ? 'Чек було виписано: оформіть чек повернення в Checkbox.' : 'У нас чека немає: чек повернення потрібен, лише якщо чек є в кабінеті Checkbox.'
      const sum = refunded ? `${refunded} грн із ${payment.amount} грн` : `${payment.amount} грн`
      const rest = refunded ? ' На рахунку лишилась решта: звірте суму в кабінеті monobank.' : ''
      const alerts = {}
      if (!(shop.alerts && shop.alerts[kind])) {
        alerts[kind] = newAlert(at, paying
          ? `⚠️ Замовлення ${shop.orderNo}: банк повернув ${sum}. ${receipt}${rest} Накладну не створюйте, а якщо посилка вже пішла, зупиніть її: ${cardUrl(ref)}`
          : `⚠️ Замовлення ${shop.orderNo}: повернуто зайвий платіж ${sum}, замовлення лишається без змін. ${receipt}${rest} ${cardUrl(ref)}`)
      }
      const moved = paying && shop.state !== 'reversed'
      if (moved || Object.keys(alerts).length) {
        tx.set(ref, {
          ...(moved ? {
            state: 'reversed', reversedAt: at,
            ...(refunded ? { partialRefund: { amount: refunded, at } } : {}),
            history: [...(shop.history || []), { at, from: shop.state || null, to: 'reversed', by: source || null }],
          } : {}),
          ...(Object.keys(alerts).length ? { alerts } : {}),
          updatedAt: at,
        }, { merge: true })
      }
      return { alerts }
    })
    if (!result) return console.error(`shop: повернення ${payment.orderId} без замовлення ${payment.shopOrderId}`)
    await sendAlerts(ref, result.alerts)
  }

  // Банк вернул часть оплаты: amount в гривнах, всего возвращено на сейчас. Чек за полную сумму остаётся, разницу оформляет владелец.
  const onShopPartialRefund = async (payment, { amount } = {}) => {
    const ref = orderRef(payment.shopOrderId)
    const kind = `partial-refund-${Math.round(amount * 100)}`
    const result = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return null
      const shop = snap.data()
      if (shop.alerts && shop.alerts[kind]) return { alerts: {} }
      const at = nowIso()
      const alerts = { [kind]: newAlert(at, `⚠️ Замовлення ${shop.orderNo}: банк повернув частину оплати, ${amount} грн. Оформіть чек повернення на різницю в Checkbox: ${cardUrl(ref)}`) }
      tx.set(ref, {
        ...(shop.paidPaymentId === payment.orderId ? { partialRefund: { amount, at } } : {}),
        alerts,
        updatedAt: at,
      }, { merge: true })
      return { alerts }
    })
    if (!result) return console.error(`shop: часткове повернення ${payment.orderId} без замовлення ${payment.shopOrderId}`)
    await sendAlerts(ref, result.alerts)
  }

  // Один алерт на заказ и вид: повторы колбэка и сверки второго сообщения не шлют.
  const alertOnce = async (payment, kind, textOf) => {
    const ref = orderRef(payment.shopOrderId)
    const alerts = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return null
      const shop = snap.data()
      if (shop.alerts && shop.alerts[kind]) return {}
      const at = nowIso()
      const fresh = { [kind]: newAlert(at, textOf(shop, cardUrl(ref))) }
      tx.set(ref, { alerts: fresh, updatedAt: at }, { merge: true })
      return fresh
    })
    if (!alerts) return console.error(`shop: алерт ${kind} ${payment.orderId} без замовлення ${payment.shopOrderId}`)
    await sendAlerts(ref, alerts)
  }

  // Подписанный колбэк сказал «возврат», а прочитать статус не вышло. Заказ не трогаем: решит ответ банка в сверке.
  const onShopReversalSignal = (payment) => alertOnce(payment, 'reversed-signal', (shop, url) =>
    `⚠️ Замовлення ${shop.orderNo}: банк повідомив про повернення ${payment.amount} грн, але статус не вдалося перечитати. Чек не вийде, доки банк не відповість. Накладну не створюйте, звірте оплату в кабінеті monobank: ${url}`)

  // Банк показал по оплаченному счёту статус не из нашего списка. Как он показывает чарджбэк, неизвестно: когда банк ответит, завести ветку как у reversed.
  const onShopUnknownStatus = (payment, { status } = {}) => {
    const shown = String(status).slice(0, 40)
    return alertOnce(payment, `unknown-status-${shown.replace(/[^\w-]/g, '_')}`, (shop, url) =>
      `⚠️ Замовлення ${shop.orderNo}: банк показує статус «${shown}» за оплатою ${payment.amount} грн. Чек і накладну не робіть, доки не звірите оплату в кабінеті monobank: ${url}`)
  }

  // Почта покупателя для чека: в payments её видел бы весь персонал, поэтому она только в заказе.
  const receiptEmail = async (payment) => {
    const snap = await orderRef(payment.shopOrderId).get()
    return snap.exists ? snap.data().email || null : null
  }

  return { onShopPaid, onShopReversed, onShopPartialRefund, onShopReversalSignal, onShopUnknownStatus, receiptEmail, removeLiveInvoice }
}

export default createShopPaymentHooks
