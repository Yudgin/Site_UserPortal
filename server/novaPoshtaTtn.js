// Создание ТТН Новой Почты (InternetDocument.save) по шаблону посылки + отправителю ФОП.
// Сценарий «приём кораблика»: посылка от сервиса к сервису (counterparty отправителя И получателя
// = ФОП), но город/отделение отправителя — КЛИЕНТА (он сдаёт кораблик у себя), плательщик —
// отправитель наличными (клиент платит доставку при сдаче). Ключ НП и refs берём у ФОП (write-only
// секреты). Первый прод-вызов может вернуть ошибку НП — отдаём её текстом, чтобы доточить маппинг.
import axios from 'axios'
import { verifyFirebaseAdmin } from './adminAuth.js'
import { getFop } from './fops.js'

const NP_URL = 'https://api.novaposhta.ua/v2.0/json/'
const nowIso = () => new Date().toISOString()

// dd.mm.yyyy в часовом поясе Украины
const npDate = () => {
  const p = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date())
  const g = (t) => p.find((x) => x.type === t)?.value
  return `${g('day')}.${g('month')}.${g('year')}`
}

const npCall = async (apiKey, modelName, calledMethod, methodProperties) => {
  const { data } = await axios.post(NP_URL, { apiKey, modelName, calledMethod, methodProperties }, { timeout: 20000 })
  return data
}

export function registerNpTtn(app, deps) {
  const { adminDb } = deps

  // Создать ТТН на ПРИЁМ кораблика. body: { serviceRequestId, templateId, clientCityRef,
  // clientWarehouseRef, cost, codAmount?, payerType?, notifyClient? }
  app.post('/api/np/ttn/create', async (req, res) => {
    if (!(await verifyFirebaseAdmin(req))) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Доступ лише для власника' } })
    }
    if (!adminDb) return res.status(503).json({ success: false })
    try {
      const b = req.body || {}
      const srId = String(b.serviceRequestId || '')
      const tplId = String(b.templateId || '')
      if (!srId || !tplId) return res.status(400).json({ success: false, error: { code: 'BAD_REQ', message: 'serviceRequestId і templateId обовʼязкові' } })

      const [srSnap, tplSnap] = await Promise.all([
        adminDb.collection('serviceRequests').doc(srId).get(),
        adminDb.collection('npTemplates').doc(tplId).get(),
      ])
      if (!srSnap.exists) return res.status(404).json({ success: false, error: { code: 'NO_SR', message: 'Заявку не знайдено' } })
      if (!tplSnap.exists) return res.status(404).json({ success: false, error: { code: 'NO_TPL', message: 'Шаблон не знайдено' } })
      const sr = srSnap.data()
      const tpl = tplSnap.data()

      const fop = getFop(tpl.fopId)
      const np = fop && fop.novaPoshta
      if (!np || !np.apiKey) {
        return res.status(400).json({ success: false, error: { code: 'NO_NP_KEY', message: 'У ФОП шаблону не заданий ключ/відправник Нової Пошти (сторінка «ФОПи та ключі»)' } })
      }
      if (!np.senderRef || !np.contactRef || !np.cityRef || !np.warehouseRef) {
        return res.status(400).json({ success: false, error: { code: 'NP_SENDER_INCOMPLETE', message: 'Не заповнені refs відправника НП у ФОП (Sender/Contact/City/Warehouse)' } })
      }
      const clientCityRef = String(b.clientCityRef || '')
      const clientWarehouseRef = String(b.clientWarehouseRef || '')
      if (!clientCityRef || !clientWarehouseRef) {
        return res.status(400).json({ success: false, error: { code: 'NO_CLIENT_ADDR', message: 'Вкажіть місто та відділення клієнта (звідки надсилає)' } })
      }

      const repairNo = sr.externalRequestId || sr.id || ''
      const description = `${tpl.description || 'Прикормочний кораблик'}${repairNo ? ` №${repairNo}` : ''}`.trim().slice(0, 500)
      // Приём кораблика: платит отправитель (клиент) готівкою при здачі у своєму відділенні.
      const mp = {
        PayerType: 'Sender',
        PaymentMethod: 'Cash',
        DateTime: npDate(),
        CargoType: tpl.cargoType || 'Parcel',
        Weight: String(tpl.weight || 1),
        ServiceType: 'WarehouseWarehouse',
        SeatsAmount: String(tpl.seatsAmount || 1),
        Description: description,
        Cost: String(Math.max(1, Math.round(Number(b.cost) || 300))),
        ...(tpl.volumeGeneral ? { VolumeGeneral: String(tpl.volumeGeneral) } : {}),
        // Отправитель: counterparty ФОП, но город/отделение — клиента (он сдаёт у себя)
        CitySender: clientCityRef,
        Sender: np.senderRef,
        SenderAddress: clientWarehouseRef,
        ContactSender: np.contactRef,
        SendersPhone: np.senderPhone || '',
        // Получатель: сервис (ФОП)
        CityRecipient: np.cityRef,
        Recipient: np.senderRef,
        RecipientAddress: np.warehouseRef,
        ContactRecipient: np.contactRef,
        RecipientsPhone: np.senderPhone || '',
        ...(Number(b.codAmount) > 0
          ? { BackwardDeliveryData: [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: String(Math.round(Number(b.codAmount))) }] }
          : {}),
      }

      const npResp = await npCall(np.apiKey, 'InternetDocument', 'save', mp)
      if (!npResp || npResp.success !== true || !npResp.data || !npResp.data[0]) {
        const errs = (npResp && (npResp.errors || npResp.warnings)) || []
        return res.status(502).json({ success: false, error: { code: 'NP_ERROR', message: (Array.isArray(errs) && errs.join('; ')) || 'Нова Пошта відхилила запит', npErrors: errs } })
      }
      const doc = npResp.data[0]
      const ttn = doc.IntDocNumber || doc.Number || ''

      // Сохраняем номер и ссылку на заявку. Не откатываем статус/оплату.
      await adminDb.collection('serviceRequests').doc(srId).set({
        waybillNumber: ttn,
        npDocRef: doc.Ref || null,
        npCostOnSite: doc.CostOnSite || null,
        npEstimatedDelivery: doc.EstimatedDeliveryDate || null,
        updatedAt: nowIso(),
      }, { merge: true })

      return res.json({ success: true, data: { ttn, ref: doc.Ref || null, cost: doc.CostOnSite || null, estimatedDelivery: doc.EstimatedDeliveryDate || null } })
    } catch (e) {
      console.error('np ttn create:', e?.response?.data || e.message)
      res.status(500).json({ success: false, error: { code: 'TTN_FAILED', message: e?.message || 'Не вдалося створити ТТН' } })
    }
  })
}

export default registerNpTtn
