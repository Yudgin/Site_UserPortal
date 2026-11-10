// Журнал відправлень «Посилки» (docs/service-requirements.md §36): Нова Пошта по всіх ФОП і особистих акаунтах,
// ручні записи (самовивіз, автобус, інше) і реєстр передач водієві. Браузер колекції не читає (правила Firestore
// закривають parcels / parcelTransfers / npAccounts / npAccountSecrets / npSyncState типовою забороною) — лише ці маршрути.
//
//   GET    /api/parcels?days=30            журнал: останні N днів + усе незавершене. Власник — усе; директор — лише
//                                          ділові посилки, привʼязані до заявок його центрів. Приватне — тільки власнику.
//   POST   /api/parcels/sync               синхронізація з НП: x-admin-token (Cloud Scheduler) або власник (кнопка).
//   POST   /api/parcels/manual             ручний запис: самовивіз / автобус / інше (власник).
//   PUT    /api/parcels/manual/:id         правка ручного запису;  DELETE — видалення.
//   PUT    /api/parcels/:id/meta           нотатка і привʼязка до заявки для будь-якої посилки (власник).
//   GET    /api/parcels/transfers          реєстр передач водієві (власник).
//   PUT    /api/parcels/transfers/:id      створити ('new') / змінити передачу: водій, сума, валюта, посилки. Сума
//                                          ділиться порівну між посилками (копійка до копійки).  DELETE — видалити.
//   GET/PUT /api/parcels/settings          «наші телефони»: посилка на такий номер — вхідна (власник).
//   GET    /api/parcels/accounts           акаунти НП (ФОП з ключем + особисті) зі станом синхронізації (власник).
//   PUT    /api/parcels/accounts/:id       особистий акаунт: назва, активність, ключ (write-only).  DELETE — видалити.
//   POST   /api/parcels/accounts/:id/check перевірка ключа трьома методами читання: що віддає НП цьому ключу.
import { verifyFirebaseAdmin, verifyFirebaseStaff } from './adminAuth.js'
import { npCall } from './novaPoshtaTtn.js'
import { listNpFops } from './fops.js'
import { normPhone } from './phone.js'
import { makeNp, syncAll, npReqDate, recomputeDirections } from './npParcels.js'

const nowIso = () => new Date().toISOString()
const clip = (v, n = 200) => (v == null ? '' : String(v).trim().slice(0, n))
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0 }
const cleanId = (v) => clip(v, 64).replace(/[^\w-]/g, '')
const DAY = 864e5

export const MANUAL_METHODS = ['pickup', 'bus', 'other']
export const MANUAL_GROUPS = ['draft', 'transit', 'received', 'problem']
const MANUAL_STATUS = { draft: 'Підготовлено', transit: 'Передано', received: 'Отримано', problem: 'Проблема' }
export const CURRENCIES = ['EUR', 'UAH', 'PLN', 'USD']

// ---- Акаунти НП: ФОП з ключем (ключ лежить у fopSecrets) + особисті (npAccounts / npAccountSecrets) ----
// «Наші телефони» — номери, посилки на які вважаються вхідними: задані власником (npSyncState/_meta.ownPhones)
// плюс телефон одержувача із шаблонів сценарію «до нас» (npTemplates, scenario 'incoming'). Діють для акаунтів ФОП.
export async function loadOwnPhones(adminDb) {
  const [meta, tpl] = await Promise.all([adminDb.collection('npSyncState').doc('_meta').get(), adminDb.collection('npTemplates').get()])
  const manual = ((meta.exists && meta.data().ownPhones) || []).map(normPhone).filter(Boolean)
  const fromTemplates = tpl.docs.map((d) => d.data() || {}).filter((t) => t.scenario === 'incoming').map((t) => normPhone(t.recipientPhone)).filter(Boolean)
  return { manual, all: [...new Set([...manual, ...fromTemplates])] }
}

export async function loadAccounts(adminDb, listFops = listNpFops) {
  const own = (await loadOwnPhones(adminDb)).all
  const fopAcc = listFops().map((f) => ({
    id: `fop:${f.id}`, kind: 'fop', fopId: f.id, name: f.name, private: false, active: f.active !== false,
    apiKey: f.apiKey, senderRef: f.senderRef || '', phones: [...new Set([normPhone(f.senderPhone), ...own].filter(Boolean))],
  }))
  const [meta, sec] = await Promise.all([adminDb.collection('npAccounts').get(), adminDb.collection('npAccountSecrets').get()])
  const secrets = Object.fromEntries(sec.docs.map((d) => [d.id, d.data() || {}]))
  const personal = meta.docs.map((d) => {
    const m = d.data() || {}
    return { id: `acc:${d.id}`, kind: 'personal', name: m.name || d.id, private: m.private !== false, active: m.active !== false, apiKey: (secrets[d.id] && secrets[d.id].apiKey) || '', phones: [] }
  })
  return [...fopAcc, ...personal]
}

// ---- Доступ ----
// Власник бачить усе. Директор — ділову посилку, привʼязану до заявки його центру (ті самі заявки він уже бачить).
export const canSee = (staff, p) => !!staff && (staff.role === 'owner'
  || (p.private !== true && !!p.link?.serviceCenterId && (staff.centers || []).some((c) => c && c.centerId === p.link.serviceCenterId)))

// ---- «Потребує уваги» (рахується під час читання, щоб не залежати від давності запису) ----
export const attentionOf = (p, now) => {
  const out = []
  if (p.final) return out
  const nowMs = Date.parse(now)
  if (p.group === 'problem') out.push('problem')
  if (p.group === 'arrived') {
    const arrived = Date.parse(p.arrivedAt || p.statusAt || '')
    if (arrived && (nowMs - arrived) / DAY >= 3) out.push('waiting') // лежить на відділенні 3+ дні
    if (p.storageFrom && Date.parse(`${p.storageFrom}T00:00:00Z`) - nowMs <= 2 * DAY) out.push('storage') // платне зберігання за 2 дні або вже
    if (p.autoReturnAt && Date.parse(p.autoReturnAt) - nowMs <= 3 * DAY) out.push('autoReturn')
  }
  if (p.group === 'draft' && p.transfer?.date && (nowMs - Date.parse(`${p.transfer.date}T00:00:00Z`)) / DAY >= 5) out.push('driver') // у водія 5+ днів
  return out
}

const publicParcel = (id, p, now) => {
  const { privBy, linkTry, phones, ...rest } = p
  return { id, ...rest, attention: attentionOf(p, now) }
}

// ---- Передачі водієві: сума порівну, копійка до копійки (залишок — першим посилкам) ----
export const splitCost = (total, ids) => {
  const n = ids.length
  if (!n) return {}
  const cents = Math.round(num(total) * 100)
  const base = Math.floor(cents / n)
  let rest = cents - base * n
  const out = {}
  for (const id of ids) { out[id] = (base + (rest > 0 ? 1 : 0)) / 100; if (rest > 0) rest-- }
  return out
}

const dayOf = (v, fallback) => { const m = String(v || '').match(/^\d{4}-\d{2}-\d{2}/); return m ? m[0] : fallback }
const partyIn = (b) => ({ name: clip(b?.name, 160), company: '', phone: normPhone(b?.phone) || clip(String(b?.phone ?? '').replace(/[^\d+]/g, ''), 20), city: clip(b?.city, 120), address: clip(b?.address, 240) })
const maskPhone = (p) => String(p || '').replace(/^(\+?\d{5})\d+(\d{2})$/, '$1•••••$2')

export function registerParcels(app, deps = {}) {
  const {
    adminDb, verifyAdmin = verifyFirebaseAdmin, verifyStaff = verifyFirebaseStaff, listFops = listNpFops,
    npImpl = npCall, now = nowIso, gapMs = 1200,
  } = deps
  const ADMIN_TOKEN = process.env.PAYMENTS_ADMIN_TOKEN || ''
  const np = makeNp(npImpl, { gapMs })
  const sigCache = new Map()
  const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } })
  const ownerGate = async (req, res) => {
    if (await verifyAdmin(req)) return true
    fail(res, 403, 'FORBIDDEN', 'Доступ лише для власника')
    return false
  }
  const ready = (res) => { if (adminDb) return true; res.status(503).json({ success: false }); return false }
  const col = () => adminDb.collection('parcels')
  const transfers = () => adminDb.collection('parcelTransfers')

  // Привʼязка до заявки за id (ручні записи й ручна привʼязка): заявка мусить існувати.
  const linkOf = async (serviceRequestId) => {
    const id = cleanId(serviceRequestId)
    if (!id) return null
    const s = await adminDb.collection('serviceRequests').doc(id).get()
    if (!s.exists) return undefined
    const sr = s.data() || {}
    return { kind: 'manual', serviceRequestId: id, boatOrderId: null, serviceCenterId: sr.serviceCenterId || null, title: clip(sr.clientName, 120) }
  }

  // ---- Журнал ----
  app.get('/api/parcels', async (req, res) => {
    const staff = await verifyStaff(req, ['owner', 'director'])
    if (!staff) return fail(res, 403, 'FORBIDDEN', 'Немає доступу до журналу посилок')
    if (!ready(res)) return
    try {
      const t = now()
      const days = Math.min(400, Math.max(1, Math.round(num(req.query.days)) || 30))
      const from = new Date(Date.parse(t) - days * DAY).toISOString()
      const [recent, active] = await Promise.all([col().where('sortAt', '>=', from).get(), col().where('final', '==', false).get()])
      const byId = new Map()
      for (const d of [...recent.docs, ...active.docs]) byId.set(d.id, d.data())
      const items = [...byId.entries()].filter(([, p]) => canSee(staff, p)).map(([id, p]) => publicParcel(id, p, t))
        .sort((a, b) => String(b.sortAt || '').localeCompare(String(a.sortAt || '')))
      const accounts = (await loadAccounts(adminDb, listFops)).map((a) => ({ id: a.id, name: a.name, kind: a.kind, private: a.private }))
      const seen = new Set(items.flatMap((p) => p.accountIds || []))
      res.json({ success: true, data: { items, days, accounts: staff.role === 'owner' ? accounts : accounts.filter((a) => !a.private && seen.has(a.id)), owner: staff.role === 'owner' } })
    } catch (e) {
      console.error('parcels list:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // ---- Синхронізація з НП ----
  app.post('/api/parcels/sync', async (req, res) => {
    const byToken = !!ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN
    if (!byToken && !(await verifyAdmin(req))) return fail(res, 403, 'FORBIDDEN', 'Доступ лише для власника')
    if (!ready(res)) return
    const metaRef = adminDb.collection('npSyncState').doc('_meta')
    const t = now()
    try {
      const meta = await metaRef.get()
      if (meta.exists && Date.parse(meta.data().lockedUntil || '') > Date.parse(t)) return fail(res, 409, 'BUSY', 'Синхронізація вже триває — зачекайте хвилину')
      await metaRef.set({ lockedUntil: new Date(Date.parse(t) + 4 * 60 * 1000).toISOString() }, { merge: true })
      const accounts = await loadAccounts(adminDb, listFops)
      const only = clip(req.body?.accountId, 80) || undefined
      const data = await syncAll(accounts, { adminDb, np, now: t, gapMs, sigCache, only, forceLink: req.body?.link === true })
      await metaRef.set({ lockedUntil: null, lastRunAt: t }, { merge: true })
      res.json({ success: true, data })
    } catch (e) {
      console.error('parcels sync:', e.message)
      try { await metaRef.set({ lockedUntil: null }, { merge: true }) } catch { /* замок сам спливе */ }
      res.status(500).json({ success: false, error: { code: 'SYNC_FAILED', message: 'Не вдалося синхронізувати з Новою Поштою' } })
    }
  })

  // ---- Ручні записи: самовивіз, автобус, інше ----
  const manualDoc = async (b, prev, by, t) => {
    const method = MANUAL_METHODS.includes(b.method) ? b.method : null
    if (!method) return { error: 'Оберіть спосіб: самовивіз, автобус або інше' }
    const direction = b.direction === 'in' ? 'in' : 'out'
    const group = MANUAL_GROUPS.includes(b.group) ? b.group : 'transit'
    const day = dayOf(b.date, t.slice(0, 10))
    const createdAt = `${day}T09:00:00.000Z` // ручний запис має лише день; полудень Києва, щоб день не зʼїжджав
    const counterparty = partyIn(b.counterparty)
    if (!counterparty.name && !counterparty.phone && !clip(b.description, 300)) return { error: 'Вкажіть, кому або від кого, чи опис' }
    let link = prev?.link || null
    if (b.serviceRequestId !== undefined) {
      link = await linkOf(b.serviceRequestId)
      if (link === undefined) return { error: 'Заявку з таким номером не знайдено' }
    }
    const cur = CURRENCIES.includes(b.cost?.currency) ? b.cost.currency : 'UAH'
    const amount = Math.max(0, num(b.cost?.amount))
    const statusName = MANUAL_STATUS[group]
    const history = !prev ? [{ at: t, code: '', name: statusName }]
      : prev.group !== group ? [...(prev.history || []), { at: t, code: '', name: statusName }].slice(-30) : prev.history || []
    return {
      doc: {
        method, manual: true, number: clip(b.number, 40), direction, directions: [direction], accountIds: [], accountDirs: {}, fopId: null,
        private: b.private === true,
        group, statusCode: '', statusName, final: group === 'received',
        createdAt, sortAt: createdAt, statusAt: prev && prev.group === group ? prev.statusAt || t : t,
        receivedAt: group === 'received' ? prev?.receivedAt || t : null,
        sender: direction === 'in' ? counterparty : partyIn({}), recipient: direction === 'out' ? counterparty : partyIn({}),
        description: clip(b.description, 300), declaredCost: Math.max(0, num(b.declaredCost)), cod: Math.max(0, num(b.cod)),
        extraCost: amount > 0 ? { amount: Math.round(amount * 100) / 100, currency: cur } : null,
        note: clip(b.note, 500),
        link, linkTry: false, transfer: prev?.transfer || null, sources: ['manual'], history,
        phones: [counterparty.phone].filter(Boolean),
        firstSeenAt: prev?.firstSeenAt || t, updatedAt: t, createdBy: prev?.createdBy || by || null,
      },
    }
  }

  app.post('/api/parcels/manual', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const t = now()
      const { doc, error } = await manualDoc(req.body || {}, null, 'owner', t)
      if (error) return fail(res, 400, 'BAD_INPUT', error)
      const ref = col().doc()
      await ref.set(doc)
      res.json({ success: true, data: publicParcel(ref.id, doc, t) })
    } catch (e) {
      console.error('parcels manual create:', e.message)
      res.status(500).json({ success: false })
    }
  })

  app.put('/api/parcels/manual/:id', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const ref = col().doc(cleanId(req.params.id) || '-')
      const snap = await ref.get()
      if (!snap.exists || snap.data().manual !== true) return fail(res, 404, 'NOT_FOUND', 'Ручний запис не знайдено')
      const t = now()
      const { doc, error } = await manualDoc(req.body || {}, snap.data(), null, t)
      if (error) return fail(res, 400, 'BAD_INPUT', error)
      await ref.set(doc)
      res.json({ success: true, data: publicParcel(ref.id, doc, t) })
    } catch (e) {
      console.error('parcels manual update:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Передача після зміни складу: частки порівну; посилкам пишемо transfer, прибраним — знімаємо.
  const applyTransfer = async (id, tr, prevIds, t) => {
    const shares = splitCost(tr.cost, tr.parcelIds)
    for (const pid of prevIds.filter((x) => !tr.parcelIds.includes(x))) {
      const ref = col().doc(pid)
      const s = await ref.get()
      if (s.exists && s.data().transfer?.id === id) await ref.update({ transfer: null, updatedAt: t })
    }
    for (const pid of tr.parcelIds) {
      await col().doc(pid).update({ transfer: { id, date: tr.date, driver: tr.driver, share: shares[pid], currency: tr.currency }, updatedAt: t })
    }
    return shares
  }

  app.delete('/api/parcels/manual/:id', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const id = cleanId(req.params.id) || '-'
      const ref = col().doc(id)
      const snap = await ref.get()
      if (!snap.exists || snap.data().manual !== true) return fail(res, 404, 'NOT_FOUND', 'Ручний запис не знайдено')
      const trId = snap.data().transfer?.id
      await ref.delete()
      if (trId) {
        const trRef = transfers().doc(trId)
        const trSnap = await trRef.get()
        if (trSnap.exists) {
          const t = now()
          const tr = { ...trSnap.data(), parcelIds: (trSnap.data().parcelIds || []).filter((x) => x !== id) }
          const shares = await applyTransfer(trId, tr, [], t)
          await trRef.set({ ...tr, shares, updatedAt: t })
        }
      }
      res.json({ success: true })
    } catch (e) {
      console.error('parcels manual delete:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Нотатка й ручна привʼязка до заявки — для будь-якої посилки (і НП, і ручної).
  app.put('/api/parcels/:id/meta', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const ref = col().doc(cleanId(req.params.id) || '-')
      const snap = await ref.get()
      if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'Посилку не знайдено')
      const t = now()
      const patch = { updatedAt: t }
      if (req.body?.note !== undefined) patch.note = clip(req.body.note, 500)
      if (req.body?.serviceRequestId !== undefined) {
        const link = await linkOf(req.body.serviceRequestId)
        if (link === undefined) return fail(res, 400, 'NO_REQUEST', 'Заявку з таким номером не знайдено')
        patch.link = link
        patch.linkTry = false
      }
      await ref.update(patch)
      res.json({ success: true, data: publicParcel(ref.id, { ...snap.data(), ...patch }, t) })
    } catch (e) {
      console.error('parcels meta:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // ---- Реєстр передач водієві ----
  app.get('/api/parcels/transfers', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const snap = await transfers().get()
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 300)
      res.json({ success: true, data: items })
    } catch (e) {
      console.error('parcels transfers list:', e.message)
      res.status(500).json({ success: false })
    }
  })

  app.put('/api/parcels/transfers/:id', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const b = req.body || {}
      const t = now()
      const isNew = req.params.id === 'new'
      const ref = isNew ? transfers().doc() : transfers().doc(cleanId(req.params.id) || '-')
      const snap = isNew ? null : await ref.get()
      if (!isNew && !snap.exists) return fail(res, 404, 'NOT_FOUND', 'Передачу не знайдено')
      const prev = snap ? snap.data() : null
      const driver = clip(b.driver, 120)
      if (!driver) return fail(res, 400, 'BAD_INPUT', 'Вкажіть водія або перевізника')
      const parcelIds = [...new Set((Array.isArray(b.parcelIds) ? b.parcelIds : []).map(cleanId).filter(Boolean))].slice(0, 100)
      if (!parcelIds.length) return fail(res, 400, 'BAD_INPUT', 'Додайте хоча б одну посилку')
      for (const pid of parcelIds) {
        const s = await col().doc(pid).get()
        if (!s.exists) return fail(res, 400, 'NO_PARCEL', `Посилку ${pid} не знайдено в журналі`)
        const other = s.data().transfer?.id
        if (other && other !== ref.id) return fail(res, 409, 'IN_OTHER_TRANSFER', `Посилка ${s.data().number || pid} уже в іншій передачі`)
      }
      const tr = {
        date: dayOf(b.date, t.slice(0, 10)), driver, driverPhone: normPhone(b.driverPhone) || clip(b.driverPhone, 20), route: clip(b.route, 200),
        cost: Math.round(Math.max(0, num(b.cost)) * 100) / 100, currency: CURRENCIES.includes(b.currency) ? b.currency : 'EUR',
        parcelIds, note: clip(b.note, 500), done: b.done === true,
        createdAt: prev?.createdAt || t, updatedAt: t,
      }
      const shares = await applyTransfer(ref.id, tr, prev?.parcelIds || [], t)
      await ref.set({ ...tr, shares })
      res.json({ success: true, data: { id: ref.id, ...tr, shares } })
    } catch (e) {
      console.error('parcels transfer save:', e.message)
      res.status(500).json({ success: false })
    }
  })

  app.delete('/api/parcels/transfers/:id', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const id = cleanId(req.params.id) || '-'
      const ref = transfers().doc(id)
      const snap = await ref.get()
      if (!snap.exists) return fail(res, 404, 'NOT_FOUND', 'Передачу не знайдено')
      await applyTransfer(id, { ...snap.data(), parcelIds: [] }, snap.data().parcelIds || [], now())
      await ref.delete()
      res.json({ success: true })
    } catch (e) {
      console.error('parcels transfer delete:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // ---- Акаунти НП ----
  app.get('/api/parcels/accounts', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const [accounts, stSnap] = await Promise.all([loadAccounts(adminDb, listFops), adminDb.collection('npSyncState').get()])
      const states = Object.fromEntries(stSnap.docs.map((d) => [d.id, d.data() || {}]))
      res.json({
        success: true,
        data: accounts.map((a) => {
          const s = states[a.id] || {}
          return {
            id: a.id, kind: a.kind, name: a.name, private: a.private, active: a.active, keySet: !!a.apiKey,
            lastSyncAt: s.lastSyncAt || null, lastOkAt: s.lastOkAt || null, lastError: s.lastError || null, counts: s.counts || null,
            phones: (s.phones || []).map(maskPhone), backfilledAt: s.backfilledAt || null,
          }
        }),
      })
    } catch (e) {
      console.error('parcels accounts:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // «Наші телефони»: посилка на такий номер — вхідна. Після зміни напрям уже збережених посилок перераховується.
  app.get('/api/parcels/settings', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const own = await loadOwnPhones(adminDb)
      res.json({ success: true, data: { ownPhones: own.manual, fromTemplates: own.all.filter((p) => !own.manual.includes(p)) } })
    } catch (e) {
      console.error('parcels settings:', e.message)
      res.status(500).json({ success: false })
    }
  })

  app.put('/api/parcels/settings', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const raw = Array.isArray(req.body?.ownPhones) ? req.body.ownPhones : []
      const bad = raw.map((p) => clip(p, 40)).filter((p) => p && !normPhone(p))
      if (bad.length) return fail(res, 400, 'BAD_PHONE', `Не схоже на український номер: ${bad.join(', ')}`)
      const ownPhones = [...new Set(raw.map(normPhone).filter(Boolean))].slice(0, 30)
      const t = now()
      await adminDb.collection('npSyncState').doc('_meta').set({ ownPhones, updatedAt: t }, { merge: true })
      const accounts = await loadAccounts(adminDb, listFops)
      const all = [...new Set(accounts.flatMap((a) => a.phones || []))]
      const states = await adminDb.collection('npSyncState').get()
      const learned = states.docs.flatMap((d) => (d.id === '_meta' ? [] : d.data().phones || []))
      sigCache.clear()
      const recalculated = await recomputeDirections(adminDb, [...all, ...learned], t)
      res.json({ success: true, data: { ownPhones, recalculated } })
    } catch (e) {
      console.error('parcels settings save:', e.message)
      res.status(500).json({ success: false })
    }
  })

  app.put('/api/parcels/accounts/:id', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    const id = cleanId(String(req.params.id).replace(/^acc:/, ''))
    if (!id || String(req.params.id).startsWith('fop:')) return fail(res, 400, 'BAD_ID', 'Ключ ФОП змінюється на сторінці «ФОПи та ключі»')
    try {
      const b = req.body || {}
      const t = now()
      await adminDb.collection('npAccounts').doc(id).set({ name: clip(b.name, 120) || id, private: b.private !== false, active: b.active !== false, updatedAt: t }, { merge: true })
      const key = clip(b.apiKey, 4000)
      if (key) await adminDb.collection('npAccountSecrets').doc(id).set({ apiKey: key, updatedAt: t }, { merge: true })
      res.json({ success: true, data: { id: `acc:${id}` } })
    } catch (e) {
      console.error('parcels account save:', e.message)
      res.status(500).json({ success: false })
    }
  })

  app.delete('/api/parcels/accounts/:id', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    const id = cleanId(String(req.params.id).replace(/^acc:/, ''))
    if (!id || String(req.params.id).startsWith('fop:')) return fail(res, 400, 'BAD_ID', 'ФОП видаляється на сторінці «ФОПи та ключі»')
    try {
      // Посилки акаунта в журналі лишаються (приватні, як і були) — стираємо тільки ключ і сам акаунт.
      await Promise.all([adminDb.collection('npAccounts').doc(id).delete(), adminDb.collection('npAccountSecrets').doc(id).delete(), adminDb.collection('npSyncState').doc(`acc:${id}`).delete()])
      res.json({ success: true })
    } catch (e) {
      console.error('parcels account delete:', e.message)
      res.status(500).json({ success: false })
    }
  })

  // Перевірка ключа лише читанням: що НП віддає цьому ключу кожним із трьох методів. Ключ — щойно введений
  // (тіло, не зберігаємо) або збережений. Назовні — лічильники й замаскований телефон, без даних посилок.
  app.post('/api/parcels/accounts/:id/check', async (req, res) => {
    if (!(await ownerGate(req, res))) return
    if (!ready(res)) return
    try {
      const typed = clip(req.body?.apiKey, 4000)
      const stored = typed ? null : (await loadAccounts(adminDb, listFops)).find((a) => a.id === String(req.params.id))
      const apiKey = typed || stored?.apiKey || ''
      if (!apiKey) return fail(res, 400, 'NO_KEY', 'Немає ключа: введіть його або збережіть в акаунті')
      const nowMs = Date.parse(now())
      const range = { DateTimeFrom: npReqDate(new Date(nowMs - 14 * DAY)), DateTimeTo: npReqDate(new Date(nowMs + DAY)) }
      const probe = async (method, props, pick) => {
        try {
          const r = await np(apiKey, 'InternetDocument', method, props)
          if (!r || r.success !== true) return { ok: false, count: 0, error: clip([...(r?.errors || []), ...(r?.warnings || [])].join('; '), 300) || 'немає відповіді' }
          const rows = pick(r)
          return { ok: true, count: rows.length, rows }
        } catch (e) { return { ok: false, count: 0, error: clip(e.message, 300) } }
      }
      const byPhone = (r) => (r.data && r.data[0] && Array.isArray(r.data[0].result) ? r.data[0].result : [])
      const list = await probe('getDocumentList', { ...range, GetFullList: '0', Page: '1' }, (r) => r.data || [])
      const out = await probe('getOutgoingDocumentsByPhone', { ...range, Limit: '100', Page: '1' }, byPhone)
      const inc = await probe('getIncomingDocumentsByPhone', { ...range, Limit: '100', Page: '1' }, byPhone)
      const phone = normPhone(out.rows?.[0]?.PhoneSender) || normPhone(inc.rows?.[0]?.PhoneRecipient) || ''
      const slim = ({ rows, ...rest }) => rest
      res.json({ success: true, data: { list: slim(list), outgoing: slim(out), incoming: slim(inc), phone: maskPhone(phone) } })
    } catch (e) {
      console.error('parcels account check:', e.message)
      res.status(500).json({ success: false })
    }
  })
}

export default registerParcels
