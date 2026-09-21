// Синхронизация КАРТОТЕКИ РЕМОНТОВ из 1С в наши заявки (serviceRequests).
// Источник — два контура 1С:
//   1) список:  POST {ONEC_AD_BASE_URL}/repair/repair_ListPOST_Full (Basic — те же
//      реквизиты, что у bot-контура: ONEC_BOT_USERNAME/PASSWORD) → [{id, Number, Date, Dist}]
//   2) полный объект: GET {ONEC_PORTAL_API_BASE}/repair/{guid} (публичный facebook-контур)
// Схождение без дублей: сначала ищем существующую заявку — sr-ext-<guid> (ручной перенос
// со /serviceshare и клиентская форма) или ЛЮБУЮ с externalRequestId == guid (заявки из
// чата живут под sr-<sessionId>); нет — создаём sr-ext-<guid>.
// Портальные поля НЕ затираются: контент заполняем только в пустые (fill), статус — только
// при создании (инференс по ТТН; появится поле status в 1С — маппинг заменит инференс).
// Снимок 1С: в самой заявке — только мета onec {guid, number, rawHash, ...} (список заявок
// остаётся лёгким), полный raw — в поддокументе serviceRequests/{id}/onec/snapshot; повторный
// прогон сверяет rawHash (канонизированная сериализация) и без изменений НЕ пишет ничего.
// Гейт: админ (Firebase) ИЛИ x-admin-token (Cloud Scheduler, как pay-reconcile); от
// параллельных прогонов — Firestore-замок system/onecSyncRepairs (протухает за 10 мин).
import axios from 'axios'
import crypto from 'crypto'
import { verifyFirebaseAdmin } from './adminAuth.js'

const AD_BASE = (process.env.ONEC_AD_BASE_URL || 'https://portal.runferry.com/login/hs/ad').replace(/\/+$/, '')
const API_BASE = (process.env.ONEC_PORTAL_API_BASE || 'https://portal.runferry.com/api/hs/facebook').replace(/\/+$/, '')
const AUTH = process.env.ONEC_BOT_USERNAME
  ? { username: process.env.ONEC_BOT_USERNAME, password: process.env.ONEC_BOT_PASSWORD || '' }
  : null

// Бюджет одного прогона: Cloud Run отдаёт 300s на запрос — новые ремонты не берём в работу
// после 240s (недоделанное доберёт следующий прогон, сверка по rawHash дешёвая).
const RUN_BUDGET_MS = 240000
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RAW_LIMIT = 900000 // предел Firestore-документа 1МБ

const nowIso = () => new Date().toISOString()
const isEmpty = (v) => v === undefined || v === null || v === ''

// Канонизированная сериализация (ключи отсортированы) — Firestore возвращает map'ы со своим
// порядком ключей, «сырой» JSON.stringify дал бы ложные отличия. Хеш — для сверки без чтения snapshot.
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v
// monopayUrl НЕ хешируем: 1С генерирует СВЕЖУЮ monobank-ссылку при каждом чтении объекта,
// иначе все неоплаченные ремонты «менялись» бы каждый прогон.
const VOLATILE_KEYS = ['monopayUrl']
const rawHashOf = (obj) => {
  const src = { ...obj }
  for (const k of VOLATILE_KEYS) delete src[k]
  return crypto.createHash('sha256').update(JSON.stringify(sortKeys(src))).digest('hex').slice(0, 32)
}

// «05.06.2025 14:46:59» — локальное киевское время 1С → честный UTC-ISO (смещение по датам DST).
const kyivOffsetMin = (probe) => {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'longOffset' })
      .formatToParts(probe).find((p) => p.type === 'timeZoneName')
    const m = String(part?.value || '').match(/GMT([+-])(\d{2}):(\d{2})/)
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 180
  } catch { return 180 }
}
const parse1cDate = (s) => {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/)
  if (!m) return null
  const guess = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6])
  if (Number.isNaN(guess)) return null
  return new Date(guess - kyivOffsetMin(new Date(guess)) * 60000).toISOString()
}

// Телефон 1С приходит ЧИСЛОМ (676181511 — потерян ведущий ноль) или строкой в вольном
// формате → каноничный +380…; мусор (склейка двух номеров и т.п.) не пишем вовсе,
// поле останется пустым и заполнится позже чистым значением.
const normPhone = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '')
  if (!d || d === '0') return ''
  if (d.length === 9) return '+380' + d
  if (d.length === 10 && d.startsWith('0')) return '+38' + d
  if (d.length === 11 && d.startsWith('80')) return '+3' + d
  if (d.length === 12 && d.startsWith('380')) return '+' + d
  const m = d.match(/380\d{9}/)
  return m ? '+' + m[0] : ''
}

// 1С иногда кладёт телефон клиента прямо в поля ПІБ (см. normalizeClientInfo в
// src/api/endpoints/service.ts) — в имя такие части не берём, но используем как
// запасной источник телефона.
const looksLikePhone = (s) => !!s && !/[a-zа-яґєіїʼ']/i.test(s) && s.replace(/\D/g, '').length >= 9

// ТТН из 1С — число или строка; 0/пусто = нет.
const normTtn = (v) => {
  const d = String(v ?? '').replace(/\D/g, '')
  return d && d !== '0' ? d : ''
}

// Статус НОВОЙ заявки по данным 1С (пока в 1С нет явного поля status). Лесенка владельца:
// обратная ТТН есть → відправили клієнту → done; в истории посылки было «отримано» →
// кораблик у нас → in_work; «не знайдено» (номер стёрт НП через ~6 мес) без «отримано»
// в истории → клиент так и не отправил → cancelled; «Створена» → очікуємо відправку,
// статусы между «Створена» и «отримано» → в дороге к нам — в обоих случаях new
// (живой статус НП виден чипом в списках).
const inferStatus = (raw) => {
  if (normTtn(raw?.returnTtn)) return 'done'
  const hist = Array.isArray(raw?.shipment?.statusHistory) ? raw.shipment.statusHistory : []
  const all = hist.map((h) => String(h?.status || '')).join(' ')
  const last = hist.length ? String(hist[hist.length - 1]?.status || '') : ''
  if (normTtn(raw?.shipment?.ttn)) {
    if (/отримано|вручен/i.test(all)) return 'in_work'
    if (/не знайдено/i.test(last)) return 'cancelled'
  }
  return 'new'
}

export function registerOnecSync(app, deps) {
  const { adminDb } = deps
  const ADMIN_TOKEN = process.env.PAYMENTS_ADMIN_TOKEN || ''

  const allowed = async (req) => {
    if (ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN) return true
    return verifyFirebaseAdmin(req)
  }

  // Один ремонт: полный объект из 1С → upsert. Возвращает 'created'|'updated'|'unchanged'.
  const syncOne = async (item) => {
    const guid = String(item.id || '').trim().toLowerCase()
    if (!GUID_RE.test(guid)) throw new Error('bad guid')
    const { data: raw } = await axios.get(`${API_BASE}/repair/${guid}`, { timeout: 20000 })
    // 1С может ответить HTTP 200 с пустышкой/ошибкой — такое не считаем ремонтом.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (isEmpty(raw.FixNumber) && isEmpty(raw.requestId))) {
      throw new Error('bad 1C response')
    }

    const col = adminDb.collection('serviceRequests')
    return adminDb.runTransaction(async (tx) => {
      // Куда писать: sr-ext-<guid> → любая заявка с этим externalRequestId (из чата
      // живут под sr-<sessionId>) → новая sr-ext-<guid>. Все чтения — до записей.
      const extRef = col.doc(`sr-ext-${guid}`)
      let snap = await tx.get(extRef)
      if (!snap.exists) {
        const q = await tx.get(col.where('externalRequestId', '==', guid).limit(1))
        if (!q.empty) snap = q.docs[0]
      }
      const exists = snap.exists
      const ref = exists ? snap.ref : extRef
      const cur = exists ? snap.data() : null
      const now = nowIso()

      const ci = raw.ClientInfo || {}
      const nameParts = [ci.LastName, ci.FirstName, ci.MiddleName].map((p) => String(p || '').trim()).filter(Boolean)
      const clientName = nameParts.filter((p) => !looksLikePhone(p)).join(' ')
      const phoneFromName = nameParts.filter(looksLikePhone).map(normPhone).find(Boolean) || ''

      const patch = {}
      // Контент — только в ПУСТЫЕ поля (портальные правки и PII не затираем).
      const fill = (key, val) => { if (isEmpty(val)) return; if (!exists || isEmpty(cur[key])) patch[key] = val }
      fill('externalRequestId', guid)
      fill('clientName', clientName)
      fill('clientPhone', normPhone(raw.Telephone) || phoneFromName)
      fill('complaint', String(raw.complaint || item.Dist || '').slice(0, 2000))
      fill('waybillNumber', normTtn(raw.shipment?.ttn))
      fill('returnTtn', normTtn(raw.returnTtn))
      // Адрес НП 1С отдаёт текстом без Ref-ов — кладём текст, только если адреса нет совсем
      // (Ref при необходимости резолвится на карточке заявки/при создании ТТН).
      if (!exists || (isEmpty(cur.clientCityName) && isEmpty(cur.clientCityRef))) {
        if (!isEmpty(ci.City)) patch.clientCityName = String(ci.City)
        if (!isEmpty(ci.tWarehouse)) patch.clientWarehouseName = String(ci.tWarehouse)
      }

      const rawJson = JSON.stringify(raw)
      const rawHash = rawHashOf(raw)
      const same = exists && cur.onec?.rawHash === rawHash
      if (exists && same && Object.keys(patch).length === 0) return 'unchanged'

      if (!exists) {
        patch.id = ref.id
        patch.createdAt = parse1cDate(item.Date) || now
        patch.createdBy = '1c-sync'
        patch.status = inferStatus(raw)
        patch.sessionId = null
      }
      patch.updatedAt = now
      // В заявке — только мета (список заявок не тянет тяжёлые снимки); listDate при точечном
      // прогоне (без списка) сохраняем прежний.
      patch.onec = {
        guid,
        number: String(raw.FixNumber || item.Number || (cur?.onec?.number ?? '')),
        listDate: item.Date || cur?.onec?.listDate || '',
        syncedAt: now,
        rawHash,
        rawSize: rawJson.length,
      }
      if (!same) {
        // Полный сырой объект 1С — в поддокумент: «раскручивать» новые поля можно без 1С.
        const snapRef = ref.collection('onec').doc('snapshot')
        tx.set(snapRef, rawJson.length <= RAW_LIMIT
          ? { guid, syncedAt: now, raw }
          : { guid, syncedAt: now, tooLarge: true, rawSize: rawJson.length })
      }
      if (exists) tx.update(ref, patch) // update заменяет onec ЦЕЛИКОМ (merge:true деп-мержил бы raw)
      else tx.set(ref, patch)
      return exists ? 'updated' : 'created'
    })
  }

  // POST /api/onec/sync-repairs { guids?: string[] } → { total, created, updated, unchanged, deferred, errors }
  app.post('/api/onec/sync-repairs', async (req, res) => {
    if (!adminDb) return res.status(503).json({ success: false, error: 'no adminDb' })
    if (!(await allowed(req))) return res.status(403).json({ success: false })

    // Замок от параллельных прогонов (кнопка + Cloud Scheduler): протухает за 10 минут.
    const lockRef = adminDb.collection('system').doc('onecSyncRepairs')
    const claimed = await adminDb.runTransaction(async (tx) => {
      const s = await tx.get(lockRef)
      const since = s.exists ? s.data().runningSince : null
      if (since && Date.now() - Date.parse(since) < 10 * 60 * 1000) return false
      tx.set(lockRef, { runningSince: nowIso() }, { merge: true })
      return true
    }).catch(() => false)
    if (!claimed) return res.status(409).json({ success: false, error: 'sync already running' })

    try {
      let list
      const bodyGuids = Array.isArray(req.body?.guids)
        ? [...new Set(req.body.guids.map((g) => String(g).trim().toLowerCase()))].filter((g) => GUID_RE.test(g)).slice(0, 600)
        : null
      if (bodyGuids && bodyGuids.length) {
        list = bodyGuids.map((id) => ({ id }))
      } else {
        const { data } = await axios.post(`${AD_BASE}/repair/repair_ListPOST_Full`, {}, {
          timeout: 60000, headers: { 'Content-Type': 'application/json' }, ...(AUTH ? { auth: AUTH } : {}),
        })
        list = Array.isArray(data?.List) ? data.List : null
        if (!list) return res.status(502).json({ success: false, error: '1C list: unexpected response' })
      }

      const stats = { total: list.length, created: 0, updated: 0, unchanged: 0, deferred: 0, errors: [] }
      const deadline = Date.now() + RUN_BUDGET_MS
      let i = 0
      const worker = async () => {
        while (i < list.length) {
          if (Date.now() > deadline) return
          const item = list[i++]
          try { stats[await syncOne(item)]++ } catch (e) {
            stats.errors.push({ guid: String(item.id || ''), error: e?.response?.status ? `HTTP ${e.response.status}` : String(e.message || e).slice(0, 200) })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, list.length || 1) }, worker))
      stats.deferred = stats.total - stats.created - stats.updated - stats.unchanged - stats.errors.length
      if (stats.errors.length > 20) stats.errors = stats.errors.slice(0, 20) // не раздуваем ответ
      console.log(`onec sync-repairs: total=${stats.total} created=${stats.created} updated=${stats.updated} unchanged=${stats.unchanged} deferred=${stats.deferred} errors=${stats.errors.length}`)
      await lockRef.set({ runningSince: null, lastRunAt: nowIso(), lastStats: { ...stats, errors: stats.errors.length } }, { merge: true }).catch(() => {})
      res.json({ success: true, ...stats })
    } catch (e) {
      await lockRef.set({ runningSince: null }, { merge: true }).catch(() => {})
      console.error('onec sync-repairs:', e?.response?.status || e.message)
      res.status(502).json({ success: false, error: String(e?.message || e).slice(0, 200) })
    }
  })
}
