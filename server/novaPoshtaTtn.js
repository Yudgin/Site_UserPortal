// Создание ТТН Новой Почты (InternetDocument.save) по шаблону посылки + отправителю ФОП.
// Сценарии:
//  • incoming (приём кораблика): counterparty отправителя И получателя = ФОП, но CitySender/
//    SenderAddress = отделение КЛИЕНТА (он сдаёт у себя), PayerType=Sender+Cash (платит клиент).
//  • return / purchase / parts (сервис → клиент): отправитель = ФОП, получатель = КЛИЕНТ
//    (создаём Counterparty PrivatePerson + ContactPerson). Для return по умолчанию наложенный
//    платёж (COD) = сумма фактической сметы, если она ещё НЕ оплачена (иначе COD снимаем).
// Ключ НП и refs берём у ФОП (write-only секреты). Ошибки НП отдаём текстом — доточить маппинг.
//
// Два шляхи доступу (§30 docs/service-requirements.md):
//  • ВЛАСНИК за email (admin@runferry.de) з templateId — повний: будь-який шаблон, ФОП, наложка,
//    заявка або замовлення кораблика; без лімітів — як було. Без templateId (застосунок) — шлях центру нижче.
//  • ДЕЛЕГОВАНИЙ (роль owner/director з users/{uid}, застосунок «RunFerry Сервіс»): лише заявка
//    СВОГО центру (директор), шаблон = serviceCenters/{center}.returnTtnTemplateId (сценарій return),
//    ФОП і наложка — з шаблону/факту (поля тіла ігноруються), оголошена вартість 1–20 000 (інакше 300),
//    відділення клієнта — з тіла або заявки (без тихого фолбеку на фіксованого отримувача),
//    409 TTN_EXISTS без replace:true, ліміти 5/хв і 30/добу на uid, за бажанням notify:true →
//    оповіщення клієнта через notifyClient (журнал notifications, ідемпотентно за номером).
//  • GET /api/np/ttn/preview?serviceRequestId= — що буде створено (шаблон, ФОП, наложка, адреса),
//    не розкриваючи npTemplates застосунку (правила Firestore їх закривають).
import axios from 'axios'
import { FieldValue } from 'firebase-admin/firestore'
import { ADMIN_EMAIL, verifyFirebaseStaff } from './adminAuth.js'
import { getFop } from './fops.js'
import { combine, rateLimit } from './rateLimit.js'

const NP_URL = 'https://api.novaposhta.ua/v2.0/json/'
const nowIso = () => new Date().toISOString()

export const DEFAULT_COST = 300
export const COST_MAX = 20000

const npDate = () => {
  const p = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date())
  const g = (t) => p.find((x) => x.type === t)?.value
  return `${g('day')}.${g('month')}.${g('year')}`
}

export const npCall = async (apiKey, modelName, calledMethod, methodProperties) => {
  const { data } = await axios.post(NP_URL, { apiKey, modelName, calledMethod, methodProperties }, { timeout: 20000 })
  return data
}

export const npErr = (resp, fallback) => {
  const errs = (resp && (resp.errors || resp.warnings)) || []
  return (Array.isArray(errs) && errs.length && errs.join('; ')) || fallback
}

// Оголошена вартість з телефону: ціле 1–20 000, інакше типові 300 (за великий кораблик власник
// може поставити більше з хаба — там обмеження немає).
export const normalizeCost = (v) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 1 && n <= COST_MAX ? n : DEFAULT_COST
}

const normTtn = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d && d !== '0' ? d : '' }

// Разбить «Прізвище Ім'я По-батькові» на части (для Counterparty PrivatePerson).
const splitName = (full) => {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  return { LastName: parts[0] || 'Клієнт', FirstName: parts[1] || 'Клієнт', MiddleName: parts[2] || '' }
}

// Создать/получить counterparty получателя (частное лицо) + его ContactPerson.
const resolveRecipient = async (np, apiKey, { name, phone, cityRef }) => {
  const nm = splitName(name)
  const resp = await np(apiKey, 'Counterparty', 'save', {
    CounterpartyProperty: 'Recipient',
    CounterpartyType: 'PrivatePerson',
    CityRef: cityRef,
    FirstName: nm.FirstName,
    LastName: nm.LastName,
    MiddleName: nm.MiddleName,
    Phone: phone || '',
  })
  if (!resp || resp.success !== true || !resp.data || !resp.data[0]) {
    throw new Error(npErr(resp, 'Не вдалося створити отримувача НП'))
  }
  const cp = resp.data[0]
  const contactRef = cp.ContactPerson?.data?.[0]?.Ref || cp.Ref
  return { ref: cp.Ref, contactRef }
}

// Создать адрес НП для counterparty (курьерская доставка) → возвращает address Ref.
const resolveAddressRef = async (np, apiKey, counterpartyRef, addr) => {
  if (!addr || !addr.streetRef) throw new Error('Для адресної доставки не задана вулиця')
  const resp = await np(apiKey, 'Address', 'save', {
    CounterpartyRef: counterpartyRef,
    StreetRef: addr.streetRef,
    BuildingNumber: String(addr.house || ''),
    Flat: String(addr.flat || ''),
  })
  if (!resp || resp.success !== true || !resp.data || !resp.data[0]) throw new Error(npErr(resp, 'Не вдалося створити адресу НП'))
  return resp.data[0].Ref
}

// Наложений платіж (COD) для відправки клієнту: явне число (лише власник) → як є; інакше для
// шаблону з cod (чи замовлення з методом 'cod') — сума фактичної калькуляції, якщо вона ще не
// оплачена, або сума замовлення; ФОП має приймати післяплату. 0 — без наложки.
export async function computeCod(adminDb, { explicit, sr, srId, boId, tpl, fop, recipientTarget }) {
  const given = Number(explicit)
  if (Number.isFinite(given)) return Math.max(0, Math.round(given))
  const fopAcceptsCod = fop?.methods ? fop.methods.cod !== false : true
  const orderWantsCod = !!boId && Array.isArray(sr?.payMethods) && sr.payMethods.includes('cod')
  if (!((tpl?.cod || orderWantsCod) && fopAcceptsCod && recipientTarget === 'client')) return 0
  if (srId && sr?.actualEstimateId) {
    try {
      const est = await adminDb.collection('priceEstimates').doc(String(sr.actualEstimateId)).get()
      const e = est.exists ? est.data() : null
      if (e && e.status !== 'paid' && !e.paymentId) return Math.round(Number(e.total) || 0)
    } catch { /* ignore */ }
    return 0
  }
  if (boId && !sr?.paidAt) return Math.round(Number(sr?.total) || 0)
  return 0
}

const err = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, error: { code, message, ...extra } })

export function registerNpTtn(app, deps = {}) {
  const {
    adminDb = null,
    verifyStaff = verifyFirebaseStaff,
    resolveFop = getFop,
    np = npCall,
    notifyClient = null, // ({ serviceRequestId, event, ttn, by }) → запис журналу notifications
    createPerMinute = 5,
    createPerDay = 30,
    previewPerMinute = 30,
  } = deps

  // Хто викликає: власник за email — повний шлях; роль owner/director — делегований.
  const actorOf = async (req) => {
    const staff = await verifyStaff(req, ['owner', 'director'])
    if (!staff) return null
    return { ...staff, full: staff.email === ADMIN_EMAIL }
  }
  const createLimiter = combine(
    rateLimit({ name: 'np-ttn-create-min', windowMs: 60 * 1000, max: createPerMinute, keyFn: (req) => req.staff.uid, message: 'Забагато накладних поспіль — зачекайте хвилину' }),
    rateLimit({ name: 'np-ttn-create-day', windowMs: 24 * 3600 * 1000, max: createPerDay, keyFn: (req) => req.staff.uid, message: 'Денний ліміт створення накладних вичерпано' }),
  )
  const previewLimiter = rateLimit({ name: 'np-ttn-preview', windowMs: 60 * 1000, max: previewPerMinute, keyFn: (req) => req.staff.uid, message: 'Забагато запитів — зачекайте хвилину' })
  const runLimiter = (limiter, req, res) => { let passed = false; limiter(req, res, () => { passed = true }); return passed }

  // Контекст делегованого створення/превʼю: заявка (свого центру для директора), центр, шаблон
  // «з ремонту» центру. problem — перша знайдена перешкода (status/code/message), sr/center/tpl —
  // усе, що встигли прочитати (превʼю показує й часткову картину).
  async function centerContext(staff, srId) {
    const out = { sr: null, srRef: null, centerId: '', center: null, tplId: '', tpl: null, problem: null }
    const srRef = adminDb.collection('serviceRequests').doc(srId)
    const srSnap = await srRef.get()
    if (!srSnap.exists) { out.problem = { status: 404, code: 'NO_SR', message: 'Заявку не знайдено' }; return out }
    out.sr = srSnap.data(); out.srRef = srRef
    const centerId = String(out.sr.serviceCenterId || '')
    out.centerId = centerId
    if (!centerId) { out.problem = { status: 400, code: 'NO_CENTER', message: 'У заявки не вказано сервісний центр' }; return out }
    if (!staff.full && staff.role !== 'owner') {
      const own = (staff.centers || []).some((c) => c && c.centerId === centerId)
      if (!own) { out.problem = { status: 403, code: 'OTHER_CENTER', message: 'Заявка іншого сервісного центру' }; return out }
    }
    const cSnap = await adminDb.collection('serviceCenters').doc(centerId).get()
    out.center = cSnap.exists ? cSnap.data() : null
    const tplId = String(out.center?.returnTtnTemplateId || '')
    out.tplId = tplId
    if (!tplId) { out.problem = { status: 400, code: 'NO_CENTER_TEMPLATE', message: 'У центру не задано шаблон ТТН «з ремонту» — налаштуйте його на порталі («Доступ та центри»)' }; return out }
    const tSnap = await adminDb.collection('npTemplates').doc(tplId).get()
    if (!tSnap.exists) { out.problem = { status: 404, code: 'NO_TPL', message: 'Шаблон ТТН центру не знайдено' }; return out }
    out.tpl = tSnap.data()
    if (out.tpl.active === false) { out.problem = { status: 400, code: 'TEMPLATE_INACTIVE', message: 'Шаблон ТТН центру вимкнено' }; return out }
    if ((out.tpl.scenario || 'incoming') !== 'return') { out.problem = { status: 400, code: 'BAD_SCENARIO', message: 'Шаблон центру «з ремонту» має сценарій не «повернення клієнту»' }; return out }
    return out
  }

  // ФОП шаблону з ключем і повними refs відправника, або problem.
  const fopOf = (fopId) => {
    const fop = resolveFop(fopId)
    const npc = fop && fop.novaPoshta
    if (!npc || !npc.apiKey) return { fop: null, problem: { status: 400, code: 'NO_NP_KEY', message: 'У ФОП шаблону не заданий ключ/відправник Нової Пошти («ФОПи та ключі»)' } }
    if (!npc.senderRef || !npc.contactRef || !npc.cityRef || !npc.warehouseRef) {
      return { fop, problem: { status: 400, code: 'NP_SENDER_INCOMPLETE', message: 'Не заповнені refs відправника НП у ФОП (Sender/Contact/City/Warehouse)' } }
    }
    return { fop, problem: null }
  }

  app.post('/api/np/ttn/create', async (req, res) => {
    const staff = await actorOf(req)
    if (!staff) return err(res, 403, 'FORBIDDEN', 'Доступ лише для власника або директора сервісу')
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const b = req.body || {}
      // Субъект ТТН: сервисная заявка (serviceRequestId) ИЛИ замовлення кораблика (boatOrderId).
      const srId = String(b.serviceRequestId || '')
      let boId = String(b.boatOrderId || '')
      let tplId = String(b.templateId || '')
      let fopIdOverride = String(b.fopId || '')
      let codOverride = b.codAmount
      let cost = Math.max(1, Math.round(Number(b.cost) || DEFAULT_COST))
      let sr = null
      let subjRef = null
      let tpl = null
      // Повний шлях — лише коли власник за email сам обрав шаблон (діалог хаба). Із застосунку
      // власник шле заявку без templateId — тоді йде шляхом центру, як директор, але без розрізу
      // по центрах (centerContext пропускає перевірку для staff.full).
      const delegated = !staff.full || (!tplId && !!srId)

      if (delegated) {
        if (!srId) return err(res, 400, 'BAD_REQ', 'Потрібна заявка (serviceRequestId)')
        const ctx = await centerContext(staff, srId)
        if (ctx.problem) return err(res, ctx.problem.status, ctx.problem.code, ctx.problem.message)
        const existing = normTtn(ctx.sr.returnTtn)
        if (existing && b.replace !== true) {
          return err(res, 409, 'TTN_EXISTS', `У заявки вже є ТТН клієнту ${existing}. Замінити її можна лише явно.`, { ttn: existing })
        }
        req.staff = staff
        if (!runLimiter(createLimiter, req, res)) return
        boId = ''
        tplId = ctx.tplId
        fopIdOverride = '' // ФОП — лише з шаблону
        codOverride = undefined // наложка — лише авто
        cost = normalizeCost(b.cost)
        sr = ctx.sr; subjRef = ctx.srRef; tpl = ctx.tpl
      } else {
        if ((!srId && !boId) || !tplId) return err(res, 400, 'BAD_REQ', 'serviceRequestId (або boatOrderId) і templateId обовʼязкові')
        subjRef = srId
          ? adminDb.collection('serviceRequests').doc(srId)
          : adminDb.collection('boatOrders').doc(boId)
        const [srSnap, tplSnap] = await Promise.all([
          subjRef.get(),
          adminDb.collection('npTemplates').doc(tplId).get(),
        ])
        if (!srSnap.exists) return err(res, 404, 'NO_SR', srId ? 'Заявку не знайдено' : 'Замовлення не знайдено')
        if (!tplSnap.exists) return err(res, 404, 'NO_TPL', 'Шаблон не знайдено')
        sr = srSnap.data() // заявка або замовлення: clientName/clientPhone — однакові поля
        tpl = tplSnap.data()
      }
      const scenario = tpl.scenario || 'incoming'

      // ФОП-відправник: явний вибір з діалогу (напр. ФОП методу 'cod' замовлення) → ФОП шаблону.
      const { fop, problem: fopProblem } = fopOf(fopIdOverride || tpl.fopId)
      if (fopProblem) return err(res, fopProblem.status, fopProblem.code, fopProblem.message)
      const npc = fop.novaPoshta
      const apiKey = npc.apiKey
      // Номер у описі: для заявки — номер ремонту; для замовлення кораблика номер не додаємо
      // (випадковий id у описі посилки ні до чого).
      const repairNo = srId ? (sr.externalRequestId || sr.id || '') : ''
      const description = `${tpl.description || 'Прикормочний кораблик'}${repairNo ? ` №${repairNo}` : ''}`.trim().slice(0, 500)

      const senderTarget = tpl.senderTarget || 'service'
      const recipientTarget = tpl.recipientTarget || (scenario === 'incoming' ? 'service' : 'client')

      // Адреса клієнта: з тіла (діалог/пікер у застосунку) або з заявки (форма /repair/new, пікер).
      const clientCityRef = String(b.clientCityRef || sr.clientCityRef || '')
      const clientWarehouseRef = String(b.clientWarehouseRef || sr.clientWarehouseRef || '')
      const clientPhone = String((delegated ? '' : b.clientPhone) || sr.clientPhone || '')
      const clientName = String((delegated ? '' : b.clientName) || sr.clientName || 'Клієнт')
      // Делегований шлях: клієнт — лише з його відділенням, без тихого фолбеку на фіксованого
      // отримувача шаблону (інакше кораблик поїде «кудись»).
      if (delegated && recipientTarget === 'client' && (!clientCityRef || !clientWarehouseRef)) {
        return err(res, 400, 'NO_CLIENT_ADDRESS', 'Вкажіть відділення Нової Пошти клієнта')
      }

      // Режим доставки по каждой стороне из serviceType (Warehouse=отделение, Doors=адрес/курьер).
      const serviceType = tpl.serviceType || 'WarehouseWarehouse'
      const senderDelivery = serviceType.startsWith('Warehouse') ? 'warehouse' : 'address'
      const recipientDelivery = serviceType.endsWith('Warehouse') ? 'warehouse' : 'address'

      // ---- Отправитель ---- (counterparty всегда = ФОП; адрес: заявка (если задана) → иначе шаблон)
      const useClientSender = senderTarget === 'client' && clientCityRef && clientWarehouseRef
      let senderCity, senderAddr
      if (useClientSender) {
        senderCity = clientCityRef; senderAddr = clientWarehouseRef // адрес из заявки клиента
      } else {
        senderCity = tpl.sender?.cityRef || npc.cityRef
        senderAddr = senderDelivery === 'address'
          ? await resolveAddressRef(np, apiKey, npc.senderRef, tpl.sender)
          : (tpl.sender?.warehouseRef || npc.warehouseRef)
      }
      const senderFields = {
        CitySender: senderCity, Sender: npc.senderRef, SenderAddress: senderAddr,
        ContactSender: npc.contactRef, SendersPhone: npc.senderPhone || '',
      }

      // ---- Получатель ---- (сервис = ФОП; client/fixed = частное лицо через Counterparty.save)
      // Для client: данные из заявки, если заданы; иначе fallback на фикс. данные шаблона.
      let recipientFields
      if (recipientTarget === 'service') {
        const rCity = tpl.recipient?.cityRef || npc.cityRef
        const rAddr = recipientDelivery === 'address'
          ? await resolveAddressRef(np, apiKey, npc.senderRef, tpl.recipient)
          : (tpl.recipient?.warehouseRef || npc.warehouseRef)
        recipientFields = { CityRecipient: rCity, Recipient: npc.senderRef, RecipientAddress: rAddr, ContactRecipient: npc.contactRef, RecipientsPhone: npc.senderPhone || '' }
      } else {
        const useClientRecip = recipientTarget === 'client' && clientCityRef && clientWarehouseRef
        const rCity = useClientRecip ? clientCityRef : (tpl.recipient?.cityRef || '')
        const rName = useClientRecip ? clientName : (tpl.recipientName || 'Отримувач')
        const rPhone = useClientRecip ? clientPhone : (tpl.recipientPhone || '')
        if (!rCity) return err(res, 400, 'NO_RECIP_CITY', 'Немає міста отримувача (ні в заявці, ні в шаблоні)')
        const rec = await resolveRecipient(np, apiKey, { name: rName, phone: rPhone, cityRef: rCity })
        let rAddr
        if (useClientRecip) {
          rAddr = clientWarehouseRef // клиент — только отделение (курьер клиенту — окремий крок)
        } else if (recipientDelivery === 'address') {
          rAddr = await resolveAddressRef(np, apiKey, rec.ref, tpl.recipient)
        } else {
          rAddr = tpl.recipient?.warehouseRef || ''
          if (!rAddr) return err(res, 400, 'NO_RECIP_ADDR', 'Немає відділення отримувача (ні в заявці, ні в шаблоні)')
        }
        recipientFields = { CityRecipient: rCity, Recipient: rec.ref, RecipientAddress: rAddr, ContactRecipient: rec.contactRef, RecipientsPhone: rPhone }
      }

      // ---- Плательщик ---- (приём: платит клиент-отправитель; иначе по шаблону)
      const payerType = senderTarget === 'client' ? 'Sender' : (tpl.payerType === 'sender' ? 'Sender' : 'Recipient')

      // ---- Наложенный платёж (COD) ---- (для отправки клиенту с флагом cod: сумма факта, снимаем если оплачено)
      const codAmount = await computeCod(adminDb, { explicit: codOverride, sr, srId, boId, tpl, fop, recipientTarget })

      const mp = {
        DateTime: npDate(),
        CargoType: tpl.cargoType || 'Parcel',
        Weight: String(tpl.weight || 1),
        ServiceType: serviceType,
        SeatsAmount: String(tpl.seatsAmount || 1),
        Description: description,
        Cost: String(cost),
        ...(tpl.volumeGeneral ? { VolumeGeneral: String(tpl.volumeGeneral) } : {}),
        PayerType: payerType, PaymentMethod: 'Cash',
        ...senderFields,
        ...recipientFields,
        ...(codAmount > 0 ? { BackwardDeliveryData: [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: String(codAmount) }] } : {}),
      }

      const npResp = await np(apiKey, 'InternetDocument', 'save', mp)
      if (!npResp || npResp.success !== true || !npResp.data || !npResp.data[0]) {
        return res.status(502).json({ success: false, error: { code: 'NP_ERROR', message: npErr(npResp, 'Нова Пошта відхилила запит'), npErrors: (npResp && (npResp.errors || npResp.warnings)) || [] } })
      }
      const doc = npResp.data[0]
      const ttn = doc.IntDocNumber || doc.Number || ''

      // Куди писати номер: заявка — за напрямком (incoming → waybillNumber «до нас»; return/purchase/
      // parts → returnTtn «клієнту», щоб не затирати вхідну ТТН із 1С); замовлення кораблика — ttn.
      // Для відправки клієнту етап ремонту → «Відправлено» (якщо ще не); сума наложки і ФОП —
      // для майбутнього закриття оплати за післяплатою.
      if (srId) {
        const toClient = scenario !== 'incoming'
        const now = nowIso()
        const patch = {
          [toClient ? 'returnTtn' : 'waybillNumber']: ttn,
          npDocRef: doc.Ref || null, npScenario: scenario,
          npCostOnSite: doc.CostOnSite || null, npEstimatedDelivery: doc.EstimatedDeliveryDate || null,
          npCodAmount: codAmount > 0 ? codAmount : 0, npFopId: fop.id || null,
          npCreatedBy: staff.email || staff.uid || null, npCreatedAt: now,
          updatedAt: now,
        }
        if (toClient && sr.stage !== 'shipped') {
          patch.stage = 'shipped'
          patch.stageSince = now
          patch.stageHistory = FieldValue.arrayUnion({ stage: 'shipped', at: now, by: 'np-ttn', note: `ТТН ${ttn}` })
          patch.waitingParts = null
        }
        await subjRef.set(patch, { merge: true })
      } else {
        await subjRef.set({
          ttn, npDocRef: doc.Ref || null, npScenario: scenario,
          npCostOnSite: doc.CostOnSite || null, npEstimatedDelivery: doc.EstimatedDeliveryDate || null,
          updatedAt: nowIso(),
        }, { merge: true })
      }

      // Делегований шлях з notify:true — одразу повідомити клієнта (журнал notifications, ідемпотентно
      // за номером). Відмова оповіщення НЕ скасовує створеної накладної: віддаємо її статус поруч.
      let notification = null
      if (delegated && b.notify === true && srId && ttn) {
        if (typeof notifyClient !== 'function') {
          notification = { status: 'failed', error: 'оповіщення недоступне на сервері' }
        } else {
          try {
            const rec = await notifyClient({ serviceRequestId: srId, event: 'ttn', ttn, by: staff.email || staff.uid })
            notification = rec ? { status: rec.status || 'failed', channel: rec.channel || null, via: rec.via || null, error: rec.error || null, skipped: rec.skipped === true } : { status: 'failed', error: 'порожня відповідь' }
          } catch (e) {
            notification = { status: 'failed', error: e?.message || 'не вдалося надіслати' }
          }
        }
      }

      return res.json({ success: true, data: { ttn, ref: doc.Ref || null, scenario, cost: doc.CostOnSite || null, estimatedDelivery: doc.EstimatedDeliveryDate || null, codAmount, ...(notification ? { notification } : {}) } })
    } catch (e) {
      console.error('np ttn create:', e?.response?.data || e.message)
      res.status(500).json({ success: false, error: { code: 'TTN_FAILED', message: e?.message || 'Не вдалося створити ТТН' } })
    }
  })

  // Превʼю для застосунку: що саме буде створено за шаблоном центру — без розкриття npTemplates.
  // canCreate=false + reasonCode/reason — чому не можна (NO_CLIENT_ADDRESS застосунок лікує пікером).
  app.get('/api/np/ttn/preview', async (req, res) => {
    const staff = await actorOf(req)
    if (!staff) return err(res, 403, 'FORBIDDEN', 'Доступ лише для власника або директора сервісу')
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const srId = String(req.query?.serviceRequestId || '')
      if (!srId) return err(res, 400, 'BAD_REQ', 'Потрібна заявка (serviceRequestId)')
      req.staff = staff
      if (!runLimiter(previewLimiter, req, res)) return
      const ctx = await centerContext(staff, srId)
      // Без заявки або чужий центр — помилка; решта перешкод — у превʼю (canCreate=false).
      if (ctx.problem && (ctx.problem.code === 'NO_SR' || ctx.problem.code === 'OTHER_CENTER')) {
        return err(res, ctx.problem.status, ctx.problem.code, ctx.problem.message)
      }
      const sr = ctx.sr
      const tpl = ctx.tpl
      let problem = ctx.problem
      let fop = null
      if (!problem) {
        const f = fopOf(tpl.fopId)
        fop = f.fop
        problem = f.problem
      }
      const recipientTarget = tpl ? (tpl.recipientTarget || 'client') : 'client'
      const codAmount = tpl && fop && !problem
        ? await computeCod(adminDb, { sr, srId, tpl, fop, recipientTarget })
        : 0
      const clientAddress = {
        cityRef: sr.clientCityRef || null, cityName: sr.clientCityName || null,
        warehouseRef: sr.clientWarehouseRef || null, warehouseName: sr.clientWarehouseName || null,
      }
      if (!problem && recipientTarget === 'client' && (!clientAddress.cityRef || !clientAddress.warehouseRef)) {
        problem = { code: 'NO_CLIENT_ADDRESS', message: 'Вкажіть відділення Нової Пошти клієнта' }
      }
      const repairNo = sr.externalRequestId || sr.id || ''
      return res.json({
        success: true,
        data: {
          serviceRequestId: srId,
          centerId: ctx.centerId || null,
          centerName: ctx.center?.name || null,
          templateId: ctx.tplId || null,
          templateName: tpl?.name || null,
          scenario: tpl?.scenario || null,
          size: tpl?.size || null,
          weight: tpl?.weight ?? null,
          seatsAmount: tpl?.seatsAmount ?? null,
          volumeGeneral: tpl?.volumeGeneral ?? null,
          serviceType: tpl?.serviceType || 'WarehouseWarehouse',
          description: tpl ? `${tpl.description || 'Прикормочний кораблик'}${repairNo ? ` №${repairNo}` : ''}`.trim().slice(0, 500) : null,
          fopId: fop?.id || tpl?.fopId || null,
          fopName: fop?.name || null,
          cod: !!(tpl?.cod),
          codAmount,
          costDefault: DEFAULT_COST,
          costMax: COST_MAX,
          clientAddress,
          existingTtn: normTtn(sr.returnTtn) || null,
          stage: sr.stage || null,
          canCreate: !problem,
          reasonCode: problem?.code || null,
          reason: problem?.message || null,
        },
      })
    } catch (e) {
      console.error('np ttn preview:', e?.message || e)
      res.status(500).json({ success: false, error: { code: 'PREVIEW_FAILED', message: e?.message || 'Не вдалося підготувати превʼю' } })
    }
  })
}

export default registerNpTtn
