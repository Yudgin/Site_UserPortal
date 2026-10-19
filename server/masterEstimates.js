// Работы по заявке и калькуляции мастера (этап 1 проекта runferry-briefs/service-app/master-estimates-brief-2026-10-19.md).
//
// Ремонт кораблика делают несколько человек (доставка, внесение в базу, ремонт, тест на воде) — у каждой работы свой
// исполнитель: serviceRequests/{id}/works/{workId}. Исполнитель (свой мастер или партнёрский центр, напр. «Катрина»)
// выставляет КАЛЬКУЛЯЦИЮ МАСТЕРА — описание своих работ и стоимость: masterEstimates/{id} (direction 'from_master').
// Владелец/директор:
//   • принимает или возвращает её с комментарием;
//   • «на основании» калькуляций мастеров составляет калькуляцию КЛИЕНТУ — вариант предложения или факт —
//     наценкой центра % с правкой сумм по строкам (подбор из прайса — этап 3);
//   • из калькуляции клиенту выставляет калькуляцию мастеру (direction 'to_master', суммы вручную; правила доли/фикса и
//     учёт выплат — отдельная сессия начислений, runferry-briefs/payroll/).
// Все записи — только сервер (Admin SDK); приложение и портал читают Firestore по правилам.
// Расчёты кошторису клиенту — ОБЩЕЕ ядро estimateEngine.js (не менять здесь: файл общий с ботом сотрудников).
// Строки калькуляции клиенту из калькуляций мастера — строки вне прайса (extra:true, refId 'extra:<id>') с пометкой
// fromMaster; в ФАКТЕ они ещё и записи журнала serviceRequests.extraExpenses (source 'master') — редактор факта портала
// со сверкой витрат их сохраняет при пересохранении. Поля оплаты не трогаются.
import crypto from 'crypto'
import { verifyFirebaseStaff } from './adminAuth.js'
import { rateLimit } from './rateLimit.js'
import {
  round2, clip, newId, nowIso, tName, displayNo, extraLine, withLines, estimate2goods, estimatePatch,
  estimateBlocked, requestVisible,
} from './estimateEngine.js'
import { payOptionsFromCenter } from './estimateActions.js'
import { statusTimes } from './statusTimes.js'

// ---------- справочники и проверки (чистые функции) ----------

export const WORK_KINDS = {
  delivery_in: 'Доставка до сервісу',
  intake: 'Прийом і внесення в базу',
  diagnostics: 'Діагностика',
  repair: 'Ремонт',
  water_test: 'Тест на воді',
  packing: 'Пакування',
  delivery_out: 'Відправка клієнту',
  other: 'Інше',
}
export const WORK_STATUSES = ['planned', 'in_progress', 'done', 'cancelled']
export const ME_KINDS = ['preliminary', 'actual']
export const ME_EDITABLE = ['draft', 'returned']
export const MAX_LINES = 50
export const MAX_LINE_AMOUNT = 1_000_000
export const HISTORY_LIMIT = 20
const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/
const ASSIGNEE_ROLES = ['owner', 'director', 'master']

const fail = (status, code, message) => ({ ok: false, status, code, message })
const ok = (data) => ({ ok: true, data })

// Строки калькуляции мастера: назва ≤120, кількість 0.01–10 000 (за замовчуванням 1), сума рядка 0.01–1 000 000,
// нотатка ≤300. amount — сума рядка (не ціна за одиницю), як у майстра в 1С.
export const normalizeLines = (raw) => {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Додайте хоча б один рядок.' }
  if (raw.length > MAX_LINES) return { error: `Не більше ${MAX_LINES} рядків.` }
  const lines = []
  for (const [i, l] of raw.entries()) {
    const title = clip(l && l.title, 120).trim()
    const amount = round2(Number(l && l.amount))
    const qty = l && l.qty != null && l.qty !== '' ? round2(Number(l.qty)) : 1
    if (!title) return { error: `Рядок ${i + 1}: потрібна назва.` }
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_LINE_AMOUNT) return { error: `Рядок ${i + 1}: сума від 0.01 до 1 000 000 грн.` }
    if (!Number.isFinite(qty) || qty <= 0 || qty > 10000) return { error: `Рядок ${i + 1}: кількість від 0.01 до 10 000.` }
    const note = clip(l && l.note, 300).trim()
    lines.push({ title, qty, amount, unitPrice: round2(amount / qty), ...(note ? { note } : {}) })
  }
  return { lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) }
}

// Сумма клиенту за строку мастера: явная правка или наценка %.
export const clientAmountFor = (masterAmount, markupPct, override) => {
  if (override != null && override !== '') return round2(Number(override))
  return round2(Number(masterAmount) * (1 + (Number(markupPct) || 0) / 100))
}

// Строка калькуляции клиенту из строки мастера: строка вне прайса (общее ядро extraLine) + пометка источника.
export const clientLineFromMaster = ({ expId, me, index, line, clientAmount }) => ({
  ...extraLine({ id: expId, title: line.qty !== 1 ? `${line.title} (${line.qty} шт)` : line.title, amount: clientAmount }),
  fromMaster: { masterEstimateId: me.id, index, masterAmount: line.amount, performerUid: me.performerUid },
})

// Владелец — всё; директор — заявки своих центров.
export const canManage = (staff, sr) => staff.role === 'owner' || (staff.role === 'director' && requestVisible(staff, sr))

const snapshot = (me, staff) => ({ at: me.updatedAt || me.createdAt || nowIso(), total: me.total, lines: me.lines || [], comment: me.comment || '', editedBy: staff.email || null })

// ---------- действия (Firestore Admin SDK) ----------

export function createMasterEstimateActions({ adminDb }) {
  const col = (name) => adminDb.collection(name)
  const getDoc = async (name, id) => {
    if (!id) return null
    const s = await col(name).doc(String(id)).get()
    return s.exists ? { id: s.id, ...s.data() } : null
  }
  const worksCol = (srId) => col('serviceRequests').doc(String(srId)).collection('works')
  const getWork = async (srId, workId) => {
    if (!workId) return null
    const s = await worksCol(srId).doc(String(workId)).get()
    return s.exists ? { id: s.id, ...s.data() } : null
  }
  const loadRequest = async (staff, requestId) => {
    const sr = await getDoc('serviceRequests', requestId)
    if (!sr) return { err: fail(404, 'NO_SR', 'Заявку не знайдено.') }
    if (!requestVisible(staff, sr)) return { err: fail(403, 'OTHER_CENTER', 'Заявка іншого сервісного центру.') }
    return { sr }
  }
  const staffName = (p, uid) => (p && (p.displayName || p.email)) || uid
  // Исполнитель: активный owner/director/master; не-владелец — с доступом к центру заявки.
  const loadAssignee = async (uid, sr) => {
    const p = await getDoc('users', uid)
    if (!p || p.active !== true || !ASSIGNEE_ROLES.includes(p.role)) return null
    if (p.role !== 'owner' && !(Array.isArray(p.centers) && sr.serviceCenterId && p.centers.some((c) => c && c.centerId === sr.serviceCenterId))) return null
    return { uid, name: staffName(p, uid), role: p.role }
  }
  const selfAssignee = (staff) => ({ uid: staff.uid, name: staff.email || staff.uid, role: staff.role })
  const newWork = (sr, { kind, title, assignee }, staff, now) => ({
    kind, title: title || WORK_KINDS[kind], assigneeUid: assignee ? assignee.uid : null, assigneeName: assignee ? assignee.name : null,
    centerId: sr.serviceCenterId || null, status: 'planned', createdAt: now, createdBy: staff.email || null, createdByUid: staff.uid, updatedAt: now,
  })

  // ---- работы ----

  const addWork = async (staff, p) => {
    const { sr, err } = await loadRequest(staff, p.requestId)
    if (err) return err
    const kind = String(p.kind || 'other')
    if (!WORK_KINDS[kind]) return fail(400, 'BAD_KIND', 'Невідомий вид роботи.')
    const title = clip(p.title, 120).trim() || WORK_KINDS[kind]
    let assignee = null
    if (staff.role === 'master') {
      if (p.assigneeUid && p.assigneeUid !== staff.uid) return fail(403, 'NO_PERM', 'Майстер призначає роботу лише собі.')
      assignee = selfAssignee(staff)
    } else if (!canManage(staff, sr)) {
      return fail(403, 'NO_PERM', 'Немає права змінювати роботи цієї заявки.')
    } else if (p.assigneeUid) {
      assignee = await loadAssignee(String(p.assigneeUid), sr)
      if (!assignee) return fail(400, 'BAD_ASSIGNEE', 'Виконавця не знайдено або він не має доступу до центру заявки.')
    }
    const id = p.clientKey ? `w-${p.clientKey}` : newId(9)
    const ref = worksCol(sr.id).doc(id)
    return adminDb.runTransaction(async (tx) => {
      const s = await tx.get(ref)
      if (s.exists) return ok({ work: { id, ...s.data() }, created: false })
      const work = newWork(sr, { kind, title, assignee }, staff, nowIso())
      tx.set(ref, work)
      return ok({ work: { id, ...work }, created: true })
    })
  }

  const updateWork = async (staff, p) => {
    const { sr, err } = await loadRequest(staff, p.requestId)
    if (err) return err
    const ref = worksCol(sr.id).doc(String(p.workId))
    const patch = {}
    if (p.status != null) {
      if (!WORK_STATUSES.includes(String(p.status))) return fail(400, 'BAD_STATUS', 'Невідомий стан роботи.')
      patch.status = String(p.status)
    }
    if (p.title != null) {
      const t = clip(p.title, 120).trim()
      if (!t) return fail(400, 'BAD_TITLE', 'Потрібна назва роботи.')
      patch.title = t
    }
    let assignee
    if (p.assigneeUid !== undefined) {
      if (p.assigneeUid === null || p.assigneeUid === '') assignee = null
      else if (staff.role === 'master' && p.assigneeUid !== staff.uid) return fail(403, 'NO_PERM', 'Майстер може взяти роботу лише собі.')
      else {
        assignee = staff.role === 'master' ? selfAssignee(staff) : await loadAssignee(String(p.assigneeUid), sr)
        if (!assignee) return fail(400, 'BAD_ASSIGNEE', 'Виконавця не знайдено або він не має доступу до центру заявки.')
      }
    }
    return adminDb.runTransaction(async (tx) => {
      const s = await tx.get(ref)
      if (!s.exists) return fail(404, 'NO_WORK', 'Роботу не знайдено.')
      const w = s.data()
      if (staff.role === 'master') {
        // Майстер: свою роботу — стан; вільну — взяти собі; чужу — нічого.
        const mine = w.assigneeUid === staff.uid
        const takingFree = !w.assigneeUid && assignee && assignee.uid === staff.uid
        if (!mine && !takingFree) return fail(403, 'NO_PERM', 'Це робота іншого виконавця.')
        if (assignee === null || p.title != null) return fail(403, 'NO_PERM', 'Назву і виконавця змінює власник або директор.')
      } else if (!canManage(staff, sr)) {
        return fail(403, 'NO_PERM', 'Немає права змінювати роботи цієї заявки.')
      }
      const out = { ...patch, updatedAt: nowIso(), updatedBy: staff.email || null }
      if (assignee !== undefined) Object.assign(out, { assigneeUid: assignee ? assignee.uid : null, assigneeName: assignee ? assignee.name : null })
      tx.set(ref, out, { merge: true })
      return ok({ work: { id: ref.id, ...w, ...out } })
    })
  }

  // ---- калькуляция мастера ----

  // from_master: майстер — від себе; власник/директор — може записати рахунок майстра від його імені (performerUid).
  const createFromMaster = async (staff, p) => {
    const { sr, err } = await loadRequest(staff, p.requestId)
    if (err) return err
    const kind = String(p.kind || 'actual')
    if (!ME_KINDS.includes(kind)) return fail(400, 'BAD_KIND', 'Вид калькуляції: попередня або фактична.')
    const norm = normalizeLines(p.lines)
    if (norm.error) return fail(400, 'BAD_LINES', norm.error)
    if (!p.clientKey || !CLIENT_KEY_RE.test(String(p.clientKey))) return fail(400, 'BAD_CLIENT_KEY', 'Потрібен clientKey.')
    let performer
    if (staff.role === 'master') {
      if (p.performerUid && p.performerUid !== staff.uid) return fail(403, 'NO_PERM', 'Майстер складає калькуляцію лише від себе.')
      performer = selfAssignee(staff)
    } else if (!canManage(staff, sr)) {
      return fail(403, 'NO_PERM', 'Немає права на калькуляції цієї заявки.')
    } else {
      performer = p.performerUid ? await loadAssignee(String(p.performerUid), sr) : selfAssignee(staff)
      if (!performer) return fail(400, 'BAD_ASSIGNEE', 'Виконавця не знайдено або він не має доступу до центру заявки.')
    }
    let work = null
    if (p.workId) {
      work = await getWork(sr.id, p.workId)
      if (!work) return fail(404, 'NO_WORK', 'Роботу не знайдено.')
      if (work.assigneeUid && work.assigneeUid !== performer.uid) return fail(409, 'OTHER_PERFORMER', 'Робота призначена іншому виконавцю.')
    }
    const id = `me-${p.clientKey}`
    const ref = col('masterEstimates').doc(id)
    const workRef = work ? worksCol(sr.id).doc(work.id) : worksCol(sr.id).doc(`w-${p.clientKey}`)
    return adminDb.runTransaction(async (tx) => {
      const s = await tx.get(ref)
      if (s.exists) {
        const d = s.data()
        if (d.createdByUid !== staff.uid) return fail(409, 'CLIENT_KEY_REUSED', 'Ключ запиту вже використано — спробуйте ще раз.')
        return ok({ masterEstimate: { id, ...d }, created: false })
      }
      const now = nowIso()
      if (!work) {
        // Без вказаної роботи — створюємо «Ремонт» на виконавця (умовчання брифу §6 п. 4).
        tx.set(workRef, newWork(sr, { kind: 'repair', title: WORK_KINDS.repair, assignee: performer }, staff, now))
      } else if (!work.assigneeUid) {
        tx.set(workRef, { assigneeUid: performer.uid, assigneeName: performer.name, updatedAt: now, updatedBy: staff.email || null }, { merge: true })
      }
      const doc = {
        serviceRequestId: sr.id, requestNo: String(displayNo(sr.id, sr)), serviceCenterId: sr.serviceCenterId || null,
        workId: workRef.id, kind, direction: 'from_master', performerUid: performer.uid, performerName: performer.name,
        lines: norm.lines, total: norm.total, status: 'draft', comment: clip(p.comment, 1000).trim(),
        basedOn: null, derived: [], history: [], createdAt: now, createdBy: staff.email || null, createdByUid: staff.uid,
        updatedAt: now, updatedBy: staff.email || null, via: p.via || 'app',
      }
      tx.set(ref, doc)
      return ok({ masterEstimate: { id, ...doc }, created: true })
    })
  }

  // Кто может править/отправлять: from_master — исполнитель или власник/директор; to_master — власник/директор.
  const canEditMe = (staff, me, sr) => (me.direction === 'from_master' && me.performerUid === staff.uid) || canManage(staff, sr)

  const withMe = async (staff, id, fn) => {
    if (!ID_RE.test(String(id || ''))) return fail(400, 'BAD_ID', 'Некоректний id калькуляції.')
    const ref = col('masterEstimates').doc(String(id))
    const me0 = await getDoc('masterEstimates', id)
    if (!me0) return fail(404, 'NO_ME', 'Калькуляцію майстра не знайдено.')
    const { sr, err } = await loadRequest(staff, me0.serviceRequestId)
    if (err) return err
    return adminDb.runTransaction(async (tx) => {
      const s = await tx.get(ref)
      if (!s.exists) return fail(404, 'NO_ME', 'Калькуляцію майстра не знайдено.')
      return fn(tx, ref, { id: s.id, ...s.data() }, sr)
    })
  }

  const updateMasterEstimate = (staff, p) => withMe(staff, p.id, (tx, ref, me, sr) => {
    if (!canEditMe(staff, me, sr)) return fail(403, 'NO_PERM', 'Немає права змінювати цю калькуляцію.')
    if (!ME_EDITABLE.includes(me.status)) return fail(409, 'NOT_EDITABLE', 'Калькуляцію вже надіслано або прийнято — зміни неможливі.')
    const patch = { updatedAt: nowIso(), updatedBy: staff.email || null }
    if (p.lines !== undefined) {
      const norm = normalizeLines(p.lines)
      if (norm.error) return fail(400, 'BAD_LINES', norm.error)
      patch.lines = norm.lines
      patch.total = norm.total
      patch.history = [...(me.history || []), snapshot(me, staff)].slice(-HISTORY_LIMIT)
    }
    if (p.comment !== undefined) patch.comment = clip(p.comment, 1000).trim()
    if (p.kind !== undefined) {
      if (!ME_KINDS.includes(String(p.kind))) return fail(400, 'BAD_KIND', 'Вид калькуляції: попередня або фактична.')
      patch.kind = String(p.kind)
    }
    tx.set(ref, patch, { merge: true })
    return ok({ masterEstimate: { ...me, ...patch } })
  })

  const submitMasterEstimate = (staff, p) => withMe(staff, p.id, (tx, ref, me, sr) => {
    if (!canEditMe(staff, me, sr)) return fail(403, 'NO_PERM', 'Немає права надсилати цю калькуляцію.')
    if (me.status === 'submitted') return ok({ masterEstimate: me, changed: false })
    if (!ME_EDITABLE.includes(me.status)) return fail(409, 'NOT_EDITABLE', 'Калькуляцію вже прийнято або скасовано.')
    const now = nowIso()
    const patch = { status: 'submitted', submittedAt: now, submittedBy: staff.email || null, updatedAt: now, updatedBy: staff.email || null }
    tx.set(ref, patch, { merge: true })
    return ok({ masterEstimate: { ...me, ...patch }, changed: true })
  })

  // Приняти / повернути з коментарем — власник/директор, лише калькуляцію ВІД майстра.
  const reviewMasterEstimate = (staff, p) => withMe(staff, p.id, (tx, ref, me, sr) => {
    if (!canManage(staff, sr)) return fail(403, 'NO_PERM', 'Приймає калькуляції майстрів власник або директор.')
    if (me.direction !== 'from_master') return fail(409, 'BAD_DIRECTION', 'Це калькуляція, виставлена майстру.')
    const decision = String(p.decision || '')
    if (!['accept', 'return'].includes(decision)) return fail(400, 'BAD_DECISION', 'Рішення: прийняти або повернути.')
    const comment = clip(p.comment, 1000).trim()
    if (decision === 'return' && !comment) return fail(400, 'NEED_COMMENT', 'Напишіть, що виправити.')
    if (me.status !== 'submitted') return fail(409, 'NOT_SUBMITTED', 'Калькуляцію ще не надіслано або вже розглянуто.')
    const now = nowIso()
    const patch = { status: decision === 'accept' ? 'accepted' : 'returned', reviewComment: comment, reviewedAt: now, reviewedBy: staff.email || null, updatedAt: now, updatedBy: staff.email || null }
    tx.set(ref, patch, { merge: true })
    return ok({ masterEstimate: { ...me, ...patch } })
  })

  const cancelMasterEstimate = (staff, p) => withMe(staff, p.id, (tx, ref, me, sr) => {
    if (!canEditMe(staff, me, sr)) return fail(403, 'NO_PERM', 'Немає права скасувати цю калькуляцію.')
    if (me.status === 'cancelled') return ok({ masterEstimate: me, changed: false })
    if (me.status === 'accepted' || (me.derived || []).length) return fail(409, 'IN_USE', 'Калькуляцію прийнято або на її основі вже складено калькуляцію клієнту.')
    const now = nowIso()
    const patch = { status: 'cancelled', cancelledAt: now, updatedAt: now, updatedBy: staff.email || null }
    tx.set(ref, patch, { merge: true })
    return ok({ masterEstimate: { ...me, ...patch }, changed: true })
  })

  // ---- «на основании»: калькуляції майстрів → калькуляція клієнту ----

  const toClient = async (staff, p) => {
    const { sr, err } = await loadRequest(staff, p.requestId)
    if (err) return err
    if (!canManage(staff, sr)) return fail(403, 'NO_PERM', 'Калькуляцію клієнту складає власник або директор.')
    const target = String(p.target || '')
    if (!['variant', 'actual'].includes(target)) return fail(400, 'BAD_TARGET', 'Ціль: варіант пропозиції або факт.')
    if (!p.clientKey || !CLIENT_KEY_RE.test(String(p.clientKey))) return fail(400, 'BAD_CLIENT_KEY', 'Потрібен clientKey.')
    if (sr.status === 'cancelled') return fail(409, 'CANCELLED', 'Заявку скасовано.')
    const markupPct = p.markupPct == null || p.markupPct === '' ? null : Number(p.markupPct)
    if (markupPct != null && (!Number.isFinite(markupPct) || markupPct < -50 || markupPct > 1000)) return fail(400, 'BAD_MARKUP', 'Націнка від −50 до 1000 %.')
    const ids = [...new Set((Array.isArray(p.sourceIds) ? p.sourceIds : []).map(String))]
    if (!ids.length || ids.length > 20 || ids.some((x) => !ID_RE.test(x))) return fail(400, 'NO_SOURCES', 'Оберіть калькуляції майстрів (до 20).')
    const sources = []
    for (const id of ids) {
      const me = await getDoc('masterEstimates', id)
      if (!me || me.serviceRequestId !== sr.id) return fail(404, 'NO_ME', 'Калькуляцію майстра не знайдено в цій заявці.')
      if (me.direction !== 'from_master') return fail(409, 'BAD_DIRECTION', 'Основа — лише калькуляції ВІД майстрів.')
      if (!['submitted', 'accepted'].includes(me.status)) return fail(409, 'NOT_SUBMITTED', `Калькуляцію «${me.performerName}» ще не надіслано.`)
      sources.push(me)
    }
    const center = sr.serviceCenterId ? await getDoc('serviceCenters', sr.serviceCenterId) : null
    const markup = markupPct != null ? markupPct : Number(center && center.markupPct) || 0
    const overrides = p.amounts && typeof p.amounts === 'object' ? p.amounts : {}
    const picks = [] // { me, index, line, clientAmount }
    for (const me of sources) {
      for (const [index, line] of (me.lines || []).entries()) {
        const ref = `${me.id}:${index}`
        if (Array.isArray(p.excludeRefs) && p.excludeRefs.includes(ref)) continue
        const clientAmount = clientAmountFor(line.amount, markup, overrides[ref])
        if (!Number.isFinite(clientAmount) || clientAmount <= 0 || clientAmount > MAX_LINE_AMOUNT) return fail(400, 'BAD_AMOUNT', `Сума клієнту для «${line.title}» від 0.01 до 1 000 000 грн.`)
        picks.push({ me, index, line, clientAmount })
      }
    }
    if (!picks.length) return fail(400, 'NO_LINES', 'Не обрано жодного рядка.')
    const key = String(p.clientKey)
    const marker = { at: nowIso(), by: staff.email || null }

    if (target === 'variant') {
      const offer = sr.offerId ? await getDoc('estimateOffers', sr.offerId) : null
      if (offer && ['chosen', 'locked'].includes(offer.status)) return fail(409, 'OFFER_CLOSED', 'Клієнт уже обрав варіант — новий додати не можна.')
      const variantId = `mv-${key}`
      const offerId = offer ? offer.id : crypto.randomBytes(12).toString('base64url')
      const vRef = col('priceEstimates').doc(variantId)
      const oRef = col('estimateOffers').doc(offerId)
      const srRef = col('serviceRequests').doc(sr.id)
      const r = await adminDb.runTransaction(async (tx) => {
        const vS = await tx.get(vRef)
        if (vS.exists) return ok({ estimateId: variantId, offerId: vS.data().offerId, total: vS.data().total, created: false })
        const oS = await tx.get(oRef)
        const srS = await tx.get(srRef)
        const src = await readSources(tx, ids)
        if (src.err) return src.err
        const cur = srS.exists ? srS.data() : null
        if (!cur) return fail(404, 'NO_SR', 'Заявку не знайдено.')
        const o = oS.exists ? oS.data() : null
        if (o && ['chosen', 'locked'].includes(o.status)) return fail(409, 'OFFER_CLOSED', 'Клієнт уже обрав варіант — новий додати не можна.')
        const now = nowIso()
        const lines = picks.map((x) => clientLineFromMaster({ expId: newId(), ...x }))
        const variantIds = o && Array.isArray(o.variantIds) ? o.variantIds : []
        const base = { title: clip(p.title, 200).trim() || (o && o.title) || 'Пропозиція', complaint: cur.complaint || '', currency: 'UAH', source: 'manual', discount: null, lines: [], total: 0 }
        const est = withLines(base, lines)
        tx.set(vRef, {
          ...est, id: variantId, kind: 'preliminary', stage: 'proposed', status: 'approved', offerId, serviceRequestId: sr.id,
          variantLabel: clip(p.variantLabel, 80).trim() || `Варіант ${variantIds.length + 1}`, variantOrder: variantIds.length,
          parentEstimateId: null, requestId: null, seasonId: null, seasonCoefficient: 1, seasonSurchargeApplied: false, laborRatePerHour: 0,
          createdAt: now, updatedAt: now, createdBy: staff.email || null, lastEditedBy: staff.email || null, lastEditedVia: 'app', history: [],
          fromMasters: ids,
        })
        if (o) {
          tx.set(oRef, { variantIds: [...variantIds, variantId], updatedAt: now }, { merge: true })
        } else {
          tx.set(oRef, { id: offerId, requestId: null, serviceRequestId: sr.id, title: base.title, variantIds: [variantId], selectedVariantId: null, status: 'pending_choice', createdAt: now, createdBy: staff.email || null })
        }
        const srPatch = { updatedAt: now, lastEditedBy: staff.email || null, lastEditedVia: 'app' }
        // Перша пропозиція: заявка → «Запропоновано» (як редактор пропозиції), але не відкочуємо пізніші статуси.
        if (!o) {
          srPatch.offerId = offerId
          if (['new', 'diagnostics', 'offered', undefined, null, ''].includes(cur.status) && !cur.paymentId) Object.assign(srPatch, { status: 'offered' }, statusTimes(cur.status, 'offered', now))
        }
        tx.set(srRef, srPatch, { merge: true })
        for (const me of src.fresh) markDerived(tx, me, { type: 'variant', id: variantId, ...marker }, staff)
        return ok({ estimateId: variantId, offerId, total: est.total, created: true, newOffer: !o, lines: lines.length })
      })
      return r
    }

    // target === 'actual'
    const srRef = col('serviceRequests').doc(sr.id)
    if (sr.actualEstimateId) {
      // Дописати рядки в наявний факт (одна транзакція, порогове погодження — як у редакторі).
      const estRef = col('priceEstimates').doc(String(sr.actualEstimateId))
      const est0 = await getDoc('priceEstimates', sr.actualEstimateId)
      const parent = est0 && est0.parentEstimateId ? await getDoc('priceEstimates', est0.parentEstimateId) : null
      return adminDb.runTransaction(async (tx) => {
        const srS = await tx.get(srRef)
        const eS = await tx.get(estRef)
        const cur = srS.exists ? srS.data() : null
        if (!cur) return fail(404, 'NO_SR', 'Заявку не знайдено.')
        const dup = (cur.extraExpenses || []).find((x) => x && x.masterBatchKey === key)
        if (dup) return ok({ estimateId: dup.appliedToEstimateId, created: false, appended: 0, duplicate: true })
        const src = await readSources(tx, ids)
        if (src.err) return src.err
        if ((cur.actualEstimateId || null) !== sr.actualEstimateId) return fail(409, 'CONFLICT', 'Заявку щойно змінили паралельно — спробуйте ще раз.')
        const e = eS.exists ? { id: eS.id, ...eS.data() } : null
        if (!e) return fail(409, 'NO_ESTIMATE', 'Фактичний кошторис заявки не знайдено.')
        const blocked = estimateBlocked(e)
        if (blocked) return fail(409, blocked.code === 'PAYING' ? 'PAY_IN_PROGRESS' : blocked.code, blocked.message)
        const now = nowIso()
        const journal = picks.map((x) => journalEntry(x, staff, now, key, e.id))
        const newLines = journal.map((j, i) => clientLineFromMaster({ expId: j.id, ...picks[i] }))
        const { patch, next, reapproval, status } = estimatePatch(e, [...(e.lines || []), ...newLines], parent, staff, 'app')
        tx.set(estRef, patch, { merge: true })
        tx.set(srRef, { extraExpenses: [...(cur.extraExpenses || []), ...journal], updatedAt: now, lastEditedBy: staff.email || null, lastEditedVia: 'app' }, { merge: true })
        for (const me of src.fresh) markDerived(tx, me, { type: 'actual', id: e.id, ...marker }, staff)
        return ok({ estimateId: e.id, created: false, appended: newLines.length, prevTotal: round2(e.total || 0), total: next.total, status, reapproval })
      })
    }

    // Нового факту ще немає — складаємо факт «напряму» з рядків майстрів (без варіанта, як «Скласти факт напряму» в порталі).
    const payOptions = payOptionsFromCenter(center)
    if (!payOptions.length) return fail(409, 'NO_FOP', 'Для центру не налаштовано ФОП за способами оплати — складіть факт у порталі.')
    const estId = crypto.randomBytes(12).toString('base64url')
    const estRef = col('priceEstimates').doc(estId)
    return adminDb.runTransaction(async (tx) => {
      const srS = await tx.get(srRef)
      const cur = srS.exists ? srS.data() : null
      if (!cur) return fail(404, 'NO_SR', 'Заявку не знайдено.')
      const dup = (cur.extraExpenses || []).find((x) => x && x.masterBatchKey === key)
      if (dup) return ok({ estimateId: dup.appliedToEstimateId, created: false, appended: 0, duplicate: true })
      const src = await readSources(tx, ids)
      if (src.err) return src.err
      if (cur.actualEstimateId) return fail(409, 'CONFLICT', 'Тим часом склали факт — оновіть картку і спробуйте ще раз.')
      if (cur.status === 'cancelled') return fail(409, 'CANCELLED', 'Заявку скасовано.')
      const now = nowIso()
      const pending = (cur.extraExpenses || []).filter((x) => x && x.id && !x.appliedToEstimateId)
      const journal = picks.map((x) => journalEntry(x, staff, now, key, estId))
      const lines = [...pending.map((x) => extraLine(x)), ...journal.map((j, i) => clientLineFromMaster({ expId: j.id, ...picks[i] }))]
      const base = { title: clip(p.title, 200).trim() || 'Фактична калькуляція', complaint: cur.complaint || '', currency: 'UAH', source: 'manual', discount: null, lines: [], total: 0 }
      const next = withLines(base, lines)
      tx.set(estRef, {
        ...next, id: estId, kind: 'actual', stage: 'actual', status: 'approved', parentEstimateId: null, serviceRequestId: sr.id, requestId: null,
        seasonId: null, seasonCoefficient: 1, seasonSurchargeApplied: false, laborRatePerHour: 0,
        receiptGoods: estimate2goods(next),
        specialistPayouts: (cur.specialists || []).filter((s) => s && s.uid).map((s) => ({ uid: s.uid, name: s.name || '', specialistAmount: 0, centerAdminAmount: 0 })),
        payOptions, fopId: payOptions[0].fopId, createdAt: now, updatedAt: now, createdBy: staff.email || null, lastEditedBy: staff.email || null,
        lastEditedVia: 'app', history: [], createdWithKey: key, fromMasters: ids,
        paymentId: null, paidAt: null, taxUrl: null, fiscalCode: null, payInitiatedAt: null,
      })
      const srPatch = {
        actualEstimateId: estId, updatedAt: now, lastEditedBy: staff.email || null, lastEditedVia: 'app',
        extraExpenses: [...(cur.extraExpenses || []).map((x) => (x && x.id && !x.appliedToEstimateId ? { ...x, appliedToEstimateId: estId } : x)), ...journal],
      }
      if (cur.status !== 'cancelled' && cur.status !== 'done' && !cur.paymentId) Object.assign(srPatch, { status: 'in_work' }, statusTimes(cur.status, 'in_work', now))
      tx.set(srRef, srPatch, { merge: true })
      for (const me of src.fresh) markDerived(tx, me, { type: 'actual', id: estId, ...marker }, staff)
      return ok({ estimateId: estId, created: true, appended: journal.length, total: next.total, status: 'approved', appliedExpenses: pending.length })
    })
  }

  // Запис журналу витрат заявки для рядка з калькуляції майстра (редактор факту портала зберігає такі рядки).
  const journalEntry = (x, staff, now, key, estId) => ({
    id: newId(), title: x.line.qty !== 1 ? `${x.line.title} (${x.line.qty} шт)` : x.line.title, amount: x.clientAmount,
    at: now, by: staff.email || null, byUid: staff.uid, source: 'master', appliedToEstimateId: estId, masterBatchKey: key,
    masterRef: { masterEstimateId: x.me.id, index: x.index, masterAmount: x.line.amount, performerUid: x.me.performerUid },
  })

  // Перечитати калькуляції-основи в транзакції (до першого запису): їх могли скасувати чи повернути паралельно.
  const readSources = async (tx, ids) => {
    const fresh = []
    for (const id of ids) {
      const s = await tx.get(col('masterEstimates').doc(id))
      const me = s.exists ? { id: s.id, ...s.data() } : null
      if (!me || !['submitted', 'accepted'].includes(me.status)) return { err: fail(409, 'CONFLICT', 'Калькуляцію майстра щойно змінили — оновіть картку і спробуйте ще раз.') }
      fresh.push(me)
    }
    return { fresh }
  }

  // Основа використана: калькуляція майстра пам'ятає похідні; надіслану — вважаємо прийнятою.
  const markDerived = (tx, me, entry, staff) => {
    const patch = { derived: [...(me.derived || []), entry], updatedAt: entry.at, updatedBy: staff.email || null }
    if (me.status === 'submitted') Object.assign(patch, { status: 'accepted', reviewedAt: entry.at, reviewedBy: staff.email || null })
    tx.set(col('masterEstimates').doc(me.id), patch, { merge: true })
  }

  // ---- «на основании»: калькуляція клієнту → калькуляція майстру ----

  const fromClient = async (staff, p) => {
    if (!ID_RE.test(String(p.clientEstimateId || ''))) return fail(400, 'BAD_ID', 'Некоректний id калькуляції клієнту.')
    const est = await getDoc('priceEstimates', p.clientEstimateId)
    if (!est || !est.serviceRequestId) return fail(404, 'NO_ESTIMATE', 'Калькуляцію клієнту не знайдено.')
    const { sr, err } = await loadRequest(staff, est.serviceRequestId)
    if (err) return err
    if (!canManage(staff, sr)) return fail(403, 'NO_PERM', 'Калькуляцію майстру виставляє власник або директор.')
    if (!p.clientKey || !CLIENT_KEY_RE.test(String(p.clientKey))) return fail(400, 'BAD_CLIENT_KEY', 'Потрібен clientKey.')
    const performer = await loadAssignee(String(p.performerUid || ''), sr)
    if (!performer) return fail(400, 'BAD_ASSIGNEE', 'Виконавця не знайдено або він не має доступу до центру заявки.')
    const picked = Array.isArray(p.lines) ? p.lines : []
    const raw = []
    for (const x of picked) {
      const idx = Number(x && x.index)
      const src = Number.isInteger(idx) ? (est.lines || [])[idx] : null
      if (!src) return fail(400, 'BAD_LINES', 'Рядок калькуляції клієнту не знайдено.')
      raw.push({ title: clip(x.title, 120).trim() || tName(src.name), qty: src.qty || 1, amount: x.amount, note: x.note, sourceIndex: idx })
    }
    const norm = normalizeLines(raw)
    if (norm.error) return fail(400, 'BAD_LINES', norm.error)
    norm.lines.forEach((l, i) => { l.sourceLineRef = { estimateId: est.id, index: raw[i].sourceIndex } })
    let work = null
    if (p.workId) {
      work = await getWork(sr.id, p.workId)
      if (!work) return fail(404, 'NO_WORK', 'Роботу не знайдено.')
    }
    const kind = ME_KINDS.includes(String(p.kind)) ? String(p.kind) : est.kind === 'actual' ? 'actual' : 'preliminary'
    const id = `me-${p.clientKey}`
    const ref = col('masterEstimates').doc(id)
    const workRef = work ? worksCol(sr.id).doc(work.id) : worksCol(sr.id).doc(`w-${p.clientKey}`)
    return adminDb.runTransaction(async (tx) => {
      const s = await tx.get(ref)
      if (s.exists) {
        const d = s.data()
        if (d.createdByUid !== staff.uid) return fail(409, 'CLIENT_KEY_REUSED', 'Ключ запиту вже використано — спробуйте ще раз.')
        return ok({ masterEstimate: { id, ...d }, created: false })
      }
      const now = nowIso()
      if (!work) tx.set(workRef, newWork(sr, { kind: 'repair', title: WORK_KINDS.repair, assignee: performer }, staff, now))
      const issued = p.issue === true
      const doc = {
        serviceRequestId: sr.id, requestNo: String(displayNo(sr.id, sr)), serviceCenterId: sr.serviceCenterId || null,
        workId: workRef.id, kind, direction: 'to_master', performerUid: performer.uid, performerName: performer.name,
        lines: norm.lines, total: norm.total, status: issued ? 'submitted' : 'draft', comment: clip(p.comment, 1000).trim(),
        basedOn: { type: 'clientEstimate', id: est.id }, derived: [], history: [],
        createdAt: now, createdBy: staff.email || null, createdByUid: staff.uid, updatedAt: now, updatedBy: staff.email || null, via: p.via || 'app',
        ...(issued ? { submittedAt: now, submittedBy: staff.email || null } : {}),
      }
      tx.set(ref, doc)
      return ok({ masterEstimate: { id, ...doc }, created: true })
    })
  }

  return {
    addWork, updateWork, createFromMaster, updateMasterEstimate, submitMasterEstimate, reviewMasterEstimate,
    cancelMasterEstimate, toClient, fromClient,
  }
}

// ---------- HTTP ----------

const err = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } })
const send = (res, r, okStatus = 200) => (r.ok ? res.status(okStatus).json({ success: true, data: r.data }) : err(res, r.status || 500, r.code || 'FAILED', r.message || 'Не вдалося виконати дію'))

// deps: { adminDb, notifyClient?, verifyStaff? (тести), actions? (тести) }
export function registerMasterEstimates(app, deps) {
  const { adminDb, notifyClient } = deps
  const verifyStaff = deps.verifyStaff || ((req) => verifyFirebaseStaff(req, ['owner', 'director', 'master']))
  const actions = deps.actions || (adminDb ? createMasterEstimateActions({ adminDb }) : null)
  const staffOnly = async (req, res, next) => {
    const staff = await verifyStaff(req)
    if (!staff) return err(res, 403, 'FORBIDDEN', 'Доступ лише для власника, директора або майстра')
    req.staff = staff
    next()
  }
  const ready = (req, res, next) => (actions ? next() : err(res, 503, 'NO_DB', 'Firestore не налаштовано'))
  const limiter = rateLimit({ name: 'master-estimates', windowMs: 60 * 1000, max: Number(process.env.MASTER_ESTIMATES_PER_MIN || 60), keyFn: (req) => req.staff.uid, message: 'Забагато змін поспіль — зачекайте хвилину' })
  const guard = (fn, okStatus) => async (req, res) => {
    try {
      const r = await fn(req)
      return send(res, r, okStatus && r.ok && r.data && r.data.created ? okStatus : 200)
    } catch (e) {
      console.error('master-estimates error:', e?.message || e)
      return err(res, 500, 'FAILED', 'Не вдалося виконати дію')
    }
  }
  const idOk = (v) => ID_RE.test(String(v || ''))
  const mw = [ready, staffOnly, limiter]
  const notify = async (serviceRequestId, event, staff) => {
    if (typeof notifyClient !== 'function') return { status: 'skipped' }
    try {
      const rec = await notifyClient({ serviceRequestId, event, by: staff.email || staff.uid })
      return { status: rec?.status || 'failed', channel: rec?.channel || null, skipped: !!rec?.skipped }
    } catch (e) {
      return { status: 'failed', error: e?.message || String(e) }
    }
  }

  app.post('/api/service-requests/:id/works', ...mw, guard((req) => (idOk(req.params.id)
    ? actions.addWork(req.staff, { ...req.body, requestId: req.params.id })
    : fail(400, 'BAD_ID', 'Некоректний id заявки.')), 201))
  app.patch('/api/service-requests/:id/works/:workId', ...mw, guard((req) => (idOk(req.params.id) && idOk(req.params.workId)
    ? actions.updateWork(req.staff, { ...req.body, requestId: req.params.id, workId: req.params.workId })
    : fail(400, 'BAD_ID', 'Некоректний id.'))))
  app.post('/api/master-estimates', ...mw, guard((req) => {
    const b = req.body || {}
    return idOk(b.serviceRequestId) ? actions.createFromMaster(req.staff, { ...b, requestId: b.serviceRequestId }) : fail(400, 'NEED_REQUEST', 'Потрібна заявка.')
  }, 201))
  app.post('/api/master-estimates/to-client', ...mw, async (req, res) => {
    try {
      const b = req.body || {}
      if (!idOk(b.serviceRequestId)) return err(res, 400, 'NEED_REQUEST', 'Потрібна заявка.')
      const r = await actions.toClient(req.staff, { ...b, requestId: b.serviceRequestId })
      if (!r.ok) return send(res, r)
      // Клієнту — як у порталі: перша пропозиція → «offer», новий факт → «actual» (обидва ідемпотентні по заявці).
      let notified = null
      if (r.data.created && b.target === 'variant' && r.data.newOffer) notified = await notify(b.serviceRequestId, 'offer', req.staff)
      if (r.data.created && b.target === 'actual') notified = await notify(b.serviceRequestId, 'actual', req.staff)
      return res.status(r.data.created ? 201 : 200).json({ success: true, data: { ...r.data, notify: notified } })
    } catch (e) {
      console.error('master-estimates to-client error:', e?.message || e)
      return err(res, 500, 'FAILED', 'Не вдалося скласти калькуляцію клієнту')
    }
  })
  app.post('/api/master-estimates/from-client', ...mw, guard((req) => actions.fromClient(req.staff, req.body || {}), 201))
  app.patch('/api/master-estimates/:id', ...mw, guard((req) => actions.updateMasterEstimate(req.staff, { ...req.body, id: req.params.id })))
  app.post('/api/master-estimates/:id/submit', ...mw, guard((req) => actions.submitMasterEstimate(req.staff, { id: req.params.id })))
  app.post('/api/master-estimates/:id/review', ...mw, guard((req) => actions.reviewMasterEstimate(req.staff, { ...req.body, id: req.params.id })))
  app.post('/api/master-estimates/:id/cancel', ...mw, guard((req) => actions.cancelMasterEstimate(req.staff, { id: req.params.id })))

  return { actions }
}

export default registerMasterEstimates
