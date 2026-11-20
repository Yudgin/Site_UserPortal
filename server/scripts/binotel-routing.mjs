#!/usr/bin/env node
// Перемикач маршрутизації вхідних Binotel без деплою: документ Firestore system/binotelRouting
// (його читає POST /api/binotel/call-settings на кожен дзвінок) + перегляд журналу binotelEvents.
// Креди — ADC (gcloud auth application-default login), проєкт droidmaps-runferry.
//
//   node scripts/binotel-routing.mjs show
//   node scripts/binotel-routing.mjs init                      # створити документ з безпечними дефолтами, якщо нема
//   node scripts/binotel-routing.mjs set mode=route routeId=466367
//   node scripts/binotel-routing.mjs set mode=passthrough      # сценарій лінії, routeData не віддаємо
//   node scripts/binotel-routing.mjs set scope=all             # відповідати ВСІМ (обережно: реальні клієнти)
//   node scripts/binotel-routing.mjs set enabled=false         # аварійно: завжди {} → повністю логіка 1С
//   node scripts/binotel-routing.mjs test-add 0675499555 | test-remove 0675499555
//   node scripts/binotel-routing.mjs override 0675499555 466367 [route|routeWithTime] [force] | override 0675499555 off
//     force — наш маршрут важливіший за Клиенты.Сценарий 1С (заголовок X-Runferry-Route-Priority: override)
//   node scripts/binotel-routing.mjs set mode=byClient         # сценарій за категорією клієнта (categoryRoutes)
//   node scripts/binotel-routing.mjs category openRequest 12345 [route|routeWithTime] | category knownClient off
//   node scripts/binotel-routing.mjs log [N]                   # останні N подій binotelEvents (типово 10)
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue, FieldPath } from 'firebase-admin/firestore'
import { normPhone } from '../phone.js'
import { normalizeRouting } from '../binotelWebhook.js'

const db = getFirestore(initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || 'droidmaps-runferry' }))
const ref = db.collection('system').doc('binotelRouting')
const by = `script:${process.env.USER || 'unknown'}`
const [cmd = 'show', ...args] = process.argv.slice(2)

// Відомі сценарії Binotel (settings/list-of-routes, 2026-10-16) — довідка в документі.
const KNOWN_ROUTES = {
  466367: 'sticky-903 (лінія HAPP)',
  220956: 'нерабочее время',
  270182: 'рабочее время runferry.com.ua',
  73622: 'график 24/7',
}
const INIT = {
  enabled: true,
  scope: 'test',
  testNumbers: [],
  mode: 'passthrough',
  routeId: 466367,
  routeType: 'route',
  overrides: {},
  sendCustomerData: true,
  assignedToEmployeeNumber: 906, // як зараз шле 1С
  mirrorCallEvents: false,
  categoryRoutes: {},
  knownRoutes: KNOWN_ROUTES,
}

const parseVal = (v) => {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '') return null
  if (/^-?\d+$/.test(v)) return Number(v)
  return v
}
const stamp = () => ({ updatedAt: new Date().toISOString(), updatedBy: by })
const show = async () => {
  const s = await ref.get()
  if (!s.exists) return console.log('system/binotelRouting: документа немає → приймач відповідає {} (логіка 1С). Запустіть init.')
  console.log(JSON.stringify(s.data(), null, 2))
  console.log('\nЯк його бачить приймач:', JSON.stringify(normalizeRouting(s.data())))
}

switch (cmd) {
  case 'show':
    await show()
    break
  case 'init': {
    const s = await ref.get()
    if (s.exists) { console.log('Документ уже є — не чіпаю.'); await show(); break }
    await ref.set({ ...INIT, ...stamp() })
    await show()
    break
  }
  case 'set': {
    const patch = {}
    for (const a of args) {
      const i = a.indexOf('=')
      if (i < 1) throw new Error(`очікую ключ=значення, отримав «${a}»`)
      patch[a.slice(0, i)] = parseVal(a.slice(i + 1))
    }
    await ref.set({ ...patch, ...stamp() }, { merge: true })
    await show()
    break
  }
  case 'test-add':
  case 'test-remove': {
    const phones = args.map(normPhone).filter(Boolean)
    if (!phones.length) throw new Error('потрібен номер телефону')
    await ref.set({ testNumbers: cmd === 'test-add' ? FieldValue.arrayUnion(...phones) : FieldValue.arrayRemove(...phones), ...stamp() }, { merge: true })
    await show()
    break
  }
  case 'override': {
    const phone = normPhone(args[0])
    if (!phone) throw new Error('потрібен номер телефону')
    const v = args[1]
    const force = args.includes('force')
    const type = args.slice(2).find((a) => ['route', 'routeWithTime'].includes(a)) || null
    // Тип пишемо лише якщо його задали — інакше приймач візьме routeType документа, як для простого числа.
    const value = v === 'off' || v === undefined ? FieldValue.delete()
      : type || force ? { id: Number(v), ...(type ? { type } : {}), ...(force ? { force: true } : {}) } : Number(v)
    const st = stamp()
    // FieldPath, бо «+» у імені поля ламає рядковий шлях overrides.+380…
    await ref.update(new FieldPath('overrides', phone), value, 'updatedAt', st.updatedAt, 'updatedBy', st.updatedBy).catch((e) => {
      if (e.code === 5) throw new Error('документа немає — спершу init')
      throw e
    })
    await show()
    break
  }
  case 'category': {
    const [cat, v, type] = args
    if (!['openRequest', 'knownClient', 'unknown'].includes(cat)) throw new Error('категорія: openRequest | knownClient | unknown')
    const value = v === 'off' || v === undefined ? FieldValue.delete() : { id: Number(v), type: type || 'routeWithTime' }
    const st = stamp()
    await ref.update(new FieldPath('categoryRoutes', cat), value, 'updatedAt', st.updatedAt, 'updatedBy', st.updatedBy).catch((e) => {
      if (e.code === 5) throw new Error('документа немає — спершу init')
      throw e
    })
    await show()
    break
  }
  case 'log': {
    const n = Number(args[0] || 10)
    const q = await db.collection('binotelEvents').orderBy('at', 'desc').limit(n).get()
    for (const d of q.docs) {
      const x = d.data()
      console.log(`${x.at}  ${x.kind}  via=${x.via}  ${x.category || ''}${x.priority ? ' priority=' + x.priority : ''}  ${x.callType === 1 ? 'OUT' : 'IN '}  ${x.externalNumber || '-'} → ${x.pbxNumber || x.internalNumber || '-'}  ${x.decision}  ${x.latencyMs} мс  ${JSON.stringify(x.response)}`)
    }
    if (!q.size) console.log('binotelEvents порожній')
    break
  }
  default:
    console.log('Команди: show | init | set k=v… | test-add N… | test-remove N… | override N routeId|off [route|routeWithTime] [force] | category openRequest|knownClient|unknown routeId|off [route|routeWithTime] | log [N]')
}

