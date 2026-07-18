// Создание ТТН Новой Почты (InternetDocument.save) по шаблону посылки + отправителю ФОП.
// Сценарии:
//  • incoming (приём кораблика): counterparty отправителя И получателя = ФОП, но CitySender/
//    SenderAddress = отделение КЛИЕНТА (он сдаёт у себя), PayerType=Sender+Cash (платит клиент).
//  • return / purchase / parts (сервис → клиент): отправитель = ФОП, получатель = КЛИЕНТ
//    (создаём Counterparty PrivatePerson + ContactPerson). Для return по умолчанию наложенный
//    платёж (COD) = сумма фактической сметы, если она ещё НЕ оплачена (иначе COD снимаем).
// Ключ НП и refs берём у ФОП (write-only секреты). Ошибки НП отдаём текстом — доточить маппинг.
import axios from 'axios'
import { verifyFirebaseAdmin } from './adminAuth.js'
import { getFop } from './fops.js'

const NP_URL = 'https://api.novaposhta.ua/v2.0/json/'
const nowIso = () => new Date().toISOString()

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

// Разбить «Прізвище Ім'я По-батькові» на части (для Counterparty PrivatePerson).
const splitName = (full) => {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  return { LastName: parts[0] || 'Клієнт', FirstName: parts[1] || 'Клієнт', MiddleName: parts[2] || '' }
}

// Создать/получить counterparty получателя (частное лицо) + его ContactPerson.
const resolveRecipient = async (apiKey, { name, phone, cityRef }) => {
  const nm = splitName(name)
  const resp = await npCall(apiKey, 'Counterparty', 'save', {
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
const resolveAddressRef = async (apiKey, counterpartyRef, addr) => {
  if (!addr || !addr.streetRef) throw new Error('Для адресної доставки не задана вулиця')
  const resp = await npCall(apiKey, 'Address', 'save', {
    CounterpartyRef: counterpartyRef,
    StreetRef: addr.streetRef,
    BuildingNumber: String(addr.house || ''),
    Flat: String(addr.flat || ''),
  })
  if (!resp || resp.success !== true || !resp.data || !resp.data[0]) throw new Error(npErr(resp, 'Не вдалося створити адресу НП'))
  return resp.data[0].Ref
}

export function registerNpTtn(app, deps) {
  const { adminDb } = deps

  app.post('/api/np/ttn/create', async (req, res) => {
    if (!(await verifyFirebaseAdmin(req))) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника' } })
    }
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const b = req.body || {}
      // Субъект ТТН: сервисная заявка (serviceRequestId) ИЛИ замовлення кораблика (boatOrderId).
      const srId = String(b.serviceRequestId || '')
      const boId = String(b.boatOrderId || '')
      const tplId = String(b.templateId || '')
      if ((!srId && !boId) || !tplId) return res.status(400).json({ success: false, error: { code: 'BAD_REQ', message: 'serviceRequestId (або boatOrderId) і templateId обовʼязкові' } })

      const subjRef = srId
        ? adminDb.collection('serviceRequests').doc(srId)
        : adminDb.collection('boatOrders').doc(boId)
      const [srSnap, tplSnap] = await Promise.all([
        subjRef.get(),
        adminDb.collection('npTemplates').doc(tplId).get(),
      ])
      if (!srSnap.exists) return res.status(404).json({ success: false, error: { code: 'NO_SR', message: srId ? 'Заявку не знайдено' : 'Замовлення не знайдено' } })
      if (!tplSnap.exists) return res.status(404).json({ success: false, error: { code: 'NO_TPL', message: 'Шаблон не знайдено' } })
      const sr = srSnap.data() // заявка або замовлення: clientName/clientPhone — однакові поля
      const tpl = tplSnap.data()
      const scenario = tpl.scenario || 'incoming'

      const fop = getFop(tpl.fopId)
      const np = fop && fop.novaPoshta
      if (!np || !np.apiKey) return res.status(400).json({ success: false, error: { code: 'NO_NP_KEY', message: 'У ФОП шаблону не заданий ключ/відправник Нової Пошти («ФОПи та ключі»)' } })
      if (!np.senderRef || !np.contactRef || !np.cityRef || !np.warehouseRef) {
        return res.status(400).json({ success: false, error: { code: 'NP_SENDER_INCOMPLETE', message: 'Не заповнені refs відправника НП у ФОП (Sender/Contact/City/Warehouse)' } })
      }

      const apiKey = np.apiKey
      // Номер у описі: для заявки — номер ремонту; для замовлення кораблика номер не додаємо
      // (випадковий id у описі посилки ні до чого).
      const repairNo = srId ? (sr.externalRequestId || sr.id || '') : ''
      const description = `${tpl.description || 'Прикормочний кораблик'}${repairNo ? ` №${repairNo}` : ''}`.trim().slice(0, 500)

      const senderTarget = tpl.senderTarget || 'service'
      const recipientTarget = tpl.recipientTarget || (scenario === 'incoming' ? 'service' : 'client')

      // Адрес клиента из диалога (нужен, когда какая-то сторона = клиент заявки)
      const clientCityRef = String(b.clientCityRef || '')
      const clientWarehouseRef = String(b.clientWarehouseRef || '')
      const clientPhone = String(b.clientPhone || sr.clientPhone || '')
      const clientName = String(b.clientName || sr.clientName || 'Клієнт')

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
        senderCity = tpl.sender?.cityRef || np.cityRef
        senderAddr = senderDelivery === 'address'
          ? await resolveAddressRef(apiKey, np.senderRef, tpl.sender)
          : (tpl.sender?.warehouseRef || np.warehouseRef)
      }
      const senderFields = {
        CitySender: senderCity, Sender: np.senderRef, SenderAddress: senderAddr,
        ContactSender: np.contactRef, SendersPhone: np.senderPhone || '',
      }

      // ---- Получатель ---- (сервис = ФОП; client/fixed = частное лицо через Counterparty.save)
      // Для client: данные из заявки, если заданы; иначе fallback на фикс. данные шаблона.
      let recipientFields
      if (recipientTarget === 'service') {
        const rCity = tpl.recipient?.cityRef || np.cityRef
        const rAddr = recipientDelivery === 'address'
          ? await resolveAddressRef(apiKey, np.senderRef, tpl.recipient)
          : (tpl.recipient?.warehouseRef || np.warehouseRef)
        recipientFields = { CityRecipient: rCity, Recipient: np.senderRef, RecipientAddress: rAddr, ContactRecipient: np.contactRef, RecipientsPhone: np.senderPhone || '' }
      } else {
        const useClientRecip = recipientTarget === 'client' && clientCityRef && clientWarehouseRef
        const rCity = useClientRecip ? clientCityRef : (tpl.recipient?.cityRef || '')
        const rName = useClientRecip ? clientName : (tpl.recipientName || 'Отримувач')
        const rPhone = useClientRecip ? clientPhone : (tpl.recipientPhone || '')
        if (!rCity) return res.status(400).json({ success: false, error: { code: 'NO_RECIP_CITY', message: 'Немає міста отримувача (ні в заявці, ні в шаблоні)' } })
        const rec = await resolveRecipient(apiKey, { name: rName, phone: rPhone, cityRef: rCity })
        let rAddr
        if (useClientRecip) {
          rAddr = clientWarehouseRef // клиент — только отделение (курьер клиенту — окремий крок)
        } else if (recipientDelivery === 'address') {
          rAddr = await resolveAddressRef(apiKey, rec.ref, tpl.recipient)
        } else {
          rAddr = tpl.recipient?.warehouseRef || ''
          if (!rAddr) return res.status(400).json({ success: false, error: { code: 'NO_RECIP_ADDR', message: 'Немає відділення отримувача (ні в заявці, ні в шаблоні)' } })
        }
        recipientFields = { CityRecipient: rCity, Recipient: rec.ref, RecipientAddress: rAddr, ContactRecipient: rec.contactRef, RecipientsPhone: rPhone }
      }

      // ---- Плательщик ---- (приём: платит клиент-отправитель; иначе по шаблону)
      const payerType = senderTarget === 'client' ? 'Sender' : (tpl.payerType === 'sender' ? 'Sender' : 'Recipient')

      // ---- Наложенный платёж (COD) ---- (для отправки клиенту с флагом cod: сумма факта, снимаем если оплачено)
      // ФОП должен принимать накладений платіж (переключатель методів у ФОП). Явно вимкнено → COD не додаємо.
      const fopAcceptsCod = fop?.methods ? fop.methods.cod !== false : true
      let codAmount = Number(b.codAmount)
      if (!Number.isFinite(codAmount)) {
        codAmount = 0
        if (tpl.cod && fopAcceptsCod && recipientTarget === 'client') {
          if (srId && sr.actualEstimateId) {
            try {
              const est = await adminDb.collection('priceEstimates').doc(String(sr.actualEstimateId)).get()
              const e = est.exists ? est.data() : null
              if (e && e.status !== 'paid' && !e.paymentId) codAmount = Math.round(Number(e.total) || 0)
            } catch { /* ignore */ }
          } else if (boId && !sr.paidAt) {
            // Замовлення кораблика: наложка = сума замовлення, якщо воно ще не оплачене онлайн.
            codAmount = Math.round(Number(sr.total) || 0)
          }
        }
      }

      const mp = {
        DateTime: npDate(),
        CargoType: tpl.cargoType || 'Parcel',
        Weight: String(tpl.weight || 1),
        ServiceType: tpl.serviceType || 'WarehouseWarehouse',
        SeatsAmount: String(tpl.seatsAmount || 1),
        Description: description,
        Cost: String(Math.max(1, Math.round(Number(b.cost) || 300))),
        ...(tpl.volumeGeneral ? { VolumeGeneral: String(tpl.volumeGeneral) } : {}),
        PayerType: payerType, PaymentMethod: 'Cash',
        ...senderFields,
        ...recipientFields,
        ...(codAmount > 0 ? { BackwardDeliveryData: [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: String(codAmount) }] } : {}),
      }

      const npResp = await npCall(apiKey, 'InternetDocument', 'save', mp)
      if (!npResp || npResp.success !== true || !npResp.data || !npResp.data[0]) {
        return res.status(502).json({ success: false, error: { code: 'NP_ERROR', message: npErr(npResp, 'Нова Пошта відхилила запит'), npErrors: (npResp && (npResp.errors || npResp.warnings)) || [] } })
      }
      const doc = npResp.data[0]
      const ttn = doc.IntDocNumber || doc.Number || ''

      // Куда писать номер: заявка — waybillNumber; замовлення кораблика — ttn.
      if (srId) {
        await adminDb.collection('serviceRequests').doc(srId).set({
          waybillNumber: ttn, npDocRef: doc.Ref || null, npScenario: scenario,
          npCostOnSite: doc.CostOnSite || null, npEstimatedDelivery: doc.EstimatedDeliveryDate || null,
          updatedAt: nowIso(),
        }, { merge: true })
      } else {
        await adminDb.collection('boatOrders').doc(boId).set({
          ttn, npDocRef: doc.Ref || null, npScenario: scenario,
          npCostOnSite: doc.CostOnSite || null, npEstimatedDelivery: doc.EstimatedDeliveryDate || null,
          updatedAt: nowIso(),
        }, { merge: true })
      }

      return res.json({ success: true, data: { ttn, ref: doc.Ref || null, scenario, cost: doc.CostOnSite || null, estimatedDelivery: doc.EstimatedDeliveryDate || null } })
    } catch (e) {
      console.error('np ttn create:', e?.response?.data || e.message)
      res.status(500).json({ success: false, error: { code: 'TTN_FAILED', message: e?.message || 'Не вдалося створити ТТН' } })
    }
  })
}

export default registerNpTtn
