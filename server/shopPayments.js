// Что оплата monobank меняет в заказе магазина (shopOrders). payments.js уже записал деньги в payments/{id} и зовёт
// эти хуки из settleMonoAcquire. Любой хук можно звать повторно: сбой лечит сверка по метке bankRecheck или следующий колбэк.
// Чек здесь не выбивается. В текстах алертов нет имени, телефона и отделения: только номер, сумма, что случилось и что делать.
// Здесь же алерт владельцу и сообщение покупателю: повторы того и другого идут из сверки (shopReconcile.js).
import * as monoAcquire from './monoAcquire.js'
import { orderStatusUrl, transitionPatch, withGuideStep } from './shopCore.js'

const nowIso = () => new Date().toISOString()
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const SMS_RETRY_MS = 10 * 60 * 1000
const SMS_TRIES = 4 // первая попытка и 3 повтора в сверке
export const KYIV_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }) // YYYY-MM-DD, как id в shopDaily
const newAlert = (at, text) => ({ at, sentAt: null, text })
const ageMs = (at) => Date.now() - Date.parse(at)

// Что получает покупатель. Тексты ещё не утверждены владельцем: править здесь. secret в журнал оповещений не попадает.
const BUYER_MESSAGES = {
  paid: (order, link) => ({ text: `RunFerry: оплату ${order.total} грн отримано. Замовлення і умови: ${link}`, secret: link }),
  rcpt: (_order, url) => ({ text: `RunFerry: ваш чек: ${url}`, secret: url }),
  ttn: (_order, ttn) => ({ text: `RunFerry: накладна створена, ТТН ${ttn}` }),
}
const MESSAGE_NAME = { paid: 'про оплату зі статусом замовлення', rcpt: 'із чеком', ttn: 'із номером накладної' }

// Вид сообщения о накладной: у каждого номера свой, новая накладная после удаления старой тоже уходит покупателю.
export const ttnMessageKind = (ttn) => `ttn-${ttn}`

// Отправить сообщение заново: попытки с нуля. Журнал оповещений не шлёт второй раз по тому же ключу, поэтому resends даёт новый ключ:
// первое сообщение могло уйти на неверный номер и считаться доставленным.
export const messageResetPatch = (order, kinds) => {
  const sms = {}
  const alerts = {}
  for (const kind of kinds) {
    sms[kind] = { status: null, at: null, tries: 0, resends: ((order.sms || {})[kind]?.resends || 0) + 1 }
    alerts[`sms-${kind}`] = null
  }
  return { sms, alerts }
}

// Пора ли слать сообщение: не доставлено, попытки не кончились, прошлая не свежая.
export const messageDue = (order, kind) => {
  const rec = (order.sms || {})[kind] || {}
  return rec.status !== 'sent' && !(order.alerts || {})[`sms-${kind}`] && !(ageMs(rec.at) < SMS_RETRY_MS)
}

export function createShopPaymentHooks({ adminDb, payments, mono = monoAcquire, siteUrl = 'https://my.runferry.com', notifyClient, sendSms }) {
  const orderRef = (id) => adminDb.collection('shopOrders').doc(String(id))
  const cardUrl = (ref) => `${siteUrl}/shop-orders/${ref.id}`
  const loadSales = async () => {
    const snap = await adminDb.collection('system').doc('shopSales').get()
    return snap.exists ? snap.data() : {}
  }

  // Запасной канал, когда Telegram не ответил: не чаще раза в час на всех экземплярах, каждый алерт один раз.
  const smsOwner = async (ref, kind, alert) => {
    if (!sendSms || alert.smsAt) return
    const { ownerPhone } = await loadSales()
    if (!ownerPhone) return
    const stampRef = adminDb.collection('system').doc('shopOwnerSms')
    const claimed = await adminDb.runTransaction(async (tx) => {
      const stamp = await tx.get(stampRef)
      if (stamp.exists && ageMs(stamp.data().at) < HOUR_MS) return false
      tx.set(stampRef, { at: nowIso() })
      return true
    })
    if (!claimed) return
    const sent = await sendSms(ownerPhone, alert.text)
    if (sent && sent.ok === false) return console.error(`shop: SMS власнику ${kind} ${ref.id}:`, sent.error)
    await ref.set({ alerts: { [kind]: { smsAt: nowIso() } } }, { merge: true })
  }

  // Алерт встаёт в транзакции вместе с причиной, поэтому параллельные вызовы шлют его один раз. Не дошёл: sentAt остаётся пустым,
  // сверка повторит, а владелец тем временем получит SMS.
  const sendAlerts = async (ref, alerts) => {
    for (const [kind, alert] of Object.entries(alerts)) {
      try {
        const text = withGuideStep(kind, alert.text)
        if (await payments.notifyOwner(text)) await ref.set({ alerts: { [kind]: { sentAt: nowIso() } } }, { merge: true })
        else await smsOwner(ref, kind, { ...alert, text })
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

  // Смотрим только назад по времени: иначе пара заказов алертила бы дважды. Тот же покупатель: тот же телефон или то же имя
  // с тем же отделением или почтой (телефон с опечаткой исправили новым заказом). Однофамильцы с разными адресами дублем не считаются.
  const alertPossibleDuplicate = async (ref, shop) => {
    if ((!shop.phoneKey && !shop.clientName) || (shop.alerts && shop.alerts['possible-duplicate'])) return
    try {
      const paidAt = Date.parse(shop.paidAt)
      const col = adminDb.collection('shopOrders')
      const [byPhone, byName] = await Promise.all([
        shop.phoneKey ? col.where('phoneKey', '==', shop.phoneKey).get() : null,
        shop.clientName ? col.where('clientName', '==', shop.clientName).get() : null,
      ])
      const sameAddress = (o) => (!!shop.clientWarehouseRef && o.clientWarehouseRef === shop.clientWarehouseRef) || (!!shop.email && o.email === shop.email)
      const same = [
        ...(byPhone ? byPhone.docs.map((d) => ({ ...d.data(), id: d.id })) : []),
        ...(byName ? byName.docs.map((d) => ({ ...d.data(), id: d.id })).filter(sameAddress) : []),
      ]
      const earlier = same.find((o) => {
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

  // Заказ стал paid: склад уменьшается в той же транзакции.
  const takeStock = (tx, salesRef, sales, shop, alerts, at, url) => {
    const sku = sales && sales.exists ? (sales.data().skus || {})[shop.sku] : null
    if (!sku || typeof sku.stock !== 'number') return
    const head = `⚠️ Замовлення ${shop.orderNo}`
    const left = sku.stock - (shop.qty || 1)
    tx.set(salesRef, { skus: { [shop.sku]: { stock: Math.max(left, 0), ...(left <= 0 ? { inStock: false } : {}) } } }, { merge: true })
    if (left < 0) alerts['stock-oversold'] = newAlert(at, `${head}: оплачено більше, ніж було на складі (${shop.sku}), продаж артикула вимкнено. Домовтеся з покупцем або поверніть гроші: ${url}`)
    else if (left === 0) alerts['stock-out'] = newAlert(at, `${head}: артикул ${shop.sku} закінчився, продаж вимкнено. Поповніть залишок на сторінці замовлень: ${url}`)
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
      takeStock(tx, salesRef, sales, shop, alerts, at, url)

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
      return { shop: { ...shop, ...paid }, alerts, nowPaid: to === 'paid' }
    })
    if (!result) return console.error(`shop: оплата ${paidId} без замовлення ${payment.shopOrderId}`)
    await sendAlerts(ref, result.alerts)
    await removeOtherInvoices(result.shop, paidId)
    await alertPossibleDuplicate(ref, result.shop)
    // Без ожидания: чек не должен ждать Telegram и SMS. Что не дошло, повторит сверка.
    if (result.nowPaid && notifyClient) {
      for (const send of [alertNewPaid, sendPaidMessage]) send(ref).catch((e) => console.error(`shop: сповіщення про оплату ${ref.id}:`, e.message))
    }
  }

  // Владелец сверил оплату с банком: amount в гривнах. Из payment_review заказ становится paid, склад уменьшается здесь: при входе в payment_review его не трогали.
  // Заказ в paid только получает отметку: она разрешает накладную, если банк не показывает сумму. Заказ в другом состоянии не меняется, ответ false.
  const onShopPaymentConfirmed = async (orderId, { by, amount } = {}) => {
    const ref = orderRef(orderId)
    const result = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const shop = snap.exists ? snap.data() : null
      if (!shop || (shop.state !== 'payment_review' && shop.state !== 'paid')) return null
      const at = nowIso()
      const amountConfirmed = { by: by || null, at, amount }
      const alerts = {}
      if (shop.state === 'paid') {
        tx.set(ref, { amountConfirmed, updatedAt: at }, { merge: true })
        return { alerts }
      }
      const salesRef = adminDb.collection('system').doc('shopSales')
      takeStock(tx, salesRef, await tx.get(salesRef), shop, alerts, at, cardUrl(ref))
      tx.set(ref, transitionPatch(shop, 'paid', { at, by, patch: { amountConfirmed, ...(Object.keys(alerts).length ? { alerts } : {}) } }), { merge: true })
      return { alerts, nowPaid: true }
    })
    if (!result) return false
    await sendAlerts(ref, result.alerts)
    if (result.nowPaid && notifyClient) sendPaidMessage(ref).catch((e) => console.error(`shop: сповіщення про оплату ${ref.id}:`, e.message))
    return true
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

  // Один алерт на заказ и вид: повторы колбэка и сверки второго сообщения не шлют. textOf(заказ, адрес карточки).
  const shopAlert = async (orderId, kind, textOf) => {
    const ref = orderRef(orderId)
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
    if (!alerts) return console.error(`shop: алерт ${kind} без замовлення ${orderId}`)
    await sendAlerts(ref, alerts)
  }

  // Сообщение покупателю: kind пишется в sms.<kind>, ключ журнала <id заказа>-<kind>, повтор доставленного не шлётся. build(заказ) даёт { text, secret }.
  // Без сообщения покупатель не найдёт страницу статуса: адрес больше нигде не хранится. Поэтому, когда попытки кончились, сообщаем владельцу.
  const sendBuyerMessage = async (ref, kind, build) => {
    if (!notifyClient) return
    const claim = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists || !snap.data().clientPhone) return null
      const rec = (snap.data().sms || {})[kind] || {}
      if (rec.status === 'sent' || ageMs(rec.at) < SMS_RETRY_MS) return null
      if ((rec.tries || 0) >= SMS_TRIES) return { gaveUp: true }
      const tries = (rec.tries || 0) + 1
      tx.set(ref, { sms: { [kind]: { status: 'pending', at: nowIso(), tries } } }, { merge: true })
      return { order: snap.data(), tries, clientKey: `${ref.id}-${kind}${rec.resends ? `-r${rec.resends}` : ''}` }
    })
    if (!claim) return
    let status = 'failed'
    if (!claim.gaveUp) {
      try {
        const { text, secret } = await build(claim.order)
        const sent = await notifyClient({
          event: 'shop', text, phone: claim.order.clientPhone, clientKey: claim.clientKey, by: 'shop',
          journal: { text: secret ? text.split(secret).join('…') : text },
        })
        status = sent?.status === 'sent' || sent?.status === 'pending' ? sent.status : 'failed'
      } catch (e) {
        console.error(`shop: повідомлення ${kind} ${ref.id}:`, e.message)
      }
      await ref.set({ sms: { [kind]: { status, at: nowIso() } } }, { merge: true })
    }
    if (status === 'failed' && (claim.gaveUp || claim.tries >= SMS_TRIES)) {
      await shopAlert(ref.id, `sms-${kind}`, (shop, url) => `⚠️ Замовлення ${shop.orderNo}: покупець не отримав повідомлення ${MESSAGE_NAME[kind.split('-')[0]] || ''}. Перевірте телефон на картці і надішліть ще раз: ${url}`)
    }
  }

  // Заказ стал оплаченным: владельцу пора собирать посылку, покупателю ссылка на статус. Оба вызова можно повторять, это делает сверка.
  const alertNewPaid = (ref) => shopAlert(ref.id, 'new-paid', (shop, url) => `✅ Замовлення ${shop.orderNo}: оплачено ${shop.total} грн, ${shop.sku}. Створіть накладну: ${url}`)
  const sendPaidMessage = (ref) => sendBuyerMessage(ref, 'paid', async (order) => {
    const { siteBaseUrl } = await loadSales()
    if (!/^https:\/\/\S+$/.test(String(siteBaseUrl || '').trim())) throw new Error('немає siteBaseUrl')
    return BUYER_MESSAGES.paid(order, orderStatusUrl(siteBaseUrl, order.statusToken))
  })
  const sendReceiptMessage = (ref, taxUrl) => sendBuyerMessage(ref, 'rcpt', async (order) => BUYER_MESSAGES.rcpt(order, taxUrl))
  const sendTtnMessage = (ref, ttn) => sendBuyerMessage(ref, ttnMessageKind(ttn), async (order) => BUYER_MESSAGES.ttn(order, ttn))

  // Подписанный колбэк сказал «возврат», а прочитать статус не вышло. Заказ не трогаем: решит ответ банка в сверке.
  const onShopReversalSignal = (payment) => shopAlert(payment.shopOrderId, 'reversed-signal', (shop, url) =>
    `⚠️ Замовлення ${shop.orderNo}: банк повідомив про повернення ${payment.amount} грн, але статус не вдалося перечитати. Чек не вийде, доки банк не відповість. Накладну не створюйте, звірте оплату в кабінеті monobank: ${url}`)

  // Банк показал по оплаченному счёту статус не из нашего списка. Как он показывает чарджбэк, неизвестно: когда банк ответит, завести ветку как у reversed.
  const onShopUnknownStatus = (payment, { status } = {}) => {
    const shown = String(status).slice(0, 40)
    return shopAlert(payment.shopOrderId, `unknown-status-${shown.replace(/[^\w-]/g, '_')}`, (shop, url) =>
      `⚠️ Замовлення ${shop.orderNo}: банк показує статус «${shown}» за оплатою ${payment.amount} грн. Чек і накладну не робіть, доки не звірите оплату в кабінеті monobank: ${url}`)
  }

  // Почта покупателя для чека: в payments её видел бы весь персонал, поэтому она только в заказе.
  const receiptEmail = async (payment) => {
    const snap = await orderRef(payment.shopOrderId).get()
    return snap.exists ? snap.data().email || null : null
  }

  return { onShopPaid, onShopPaymentConfirmed, onShopReversed, onShopPartialRefund, onShopReversalSignal, onShopUnknownStatus, receiptEmail, removeLiveInvoice, sendAlerts, shopAlert, sendBuyerMessage, alertNewPaid, sendPaidMessage, sendReceiptMessage, sendTtnMessage }
}

export default createShopPaymentHooks
