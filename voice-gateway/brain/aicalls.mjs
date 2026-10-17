// Розмова з ШІ — у конвеєр дзвінків порталу: serviceRequests/{srId}/calls/ai-<generalCallID> (kind 'ai'), поруч із
// дзвінками originate (server/binotelCalls.js, контракт runferry-briefs/telephony/call-bridge-contract-2026-10-15.md),
// і картка callEvents/ai-<gcid> для операторської дошки. Формат погоджено з сесією «Соединение клиента с сотрудником,
// транскрипция, резюме» 2026-10-17: розшифровка й підсумок уже готові (зі шлюзу); є generalCallID — status 'finished',
// recordingOnly: true, nextCheckAt = зараз: конвеєр лише забирає запис Binotel (кнопка «Прослухати») і закриває документ
// як summarized, не чіпаючи transcript/summary; немає GCID — одразу 'summarized'. Поля блокування (lockUntil, lockToken,
// attempts) пише лише конвеєр. Репліки: speaker 'client' | 'ai'. Документ дзвінка — лише коли заявку знайдено; дзвінків
// без заявки поки не пишемо (окрема колекція задач на перезвон — домовленість із сесією «Анализ: свои SIP-клиенты…»).
// Лише з VG_AI_SAVE=firestore. firebase-admin — із server/node_modules, креди ADC (як lookup.mjs).
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { summaryText } from './aiprompt.mjs'
import { strictPhone } from './callbacks.mjs'

function openFirestore(projectId) {
  const req = createRequire(new URL('../../server/package.json', import.meta.url))
  const { initializeApp, applicationDefault, getApps } = req('firebase-admin/app')
  const { getFirestore } = req('firebase-admin/firestore')
  const app = getApps()[0] || initializeApp({ credential: applicationDefault(), projectId })
  return getFirestore(app)
}

const AI_NAME = 'ШІ-помічник' // українською «ШІ» (штучний інтелект), не «ІІ»
const SPEAKER_UK = { client: 'Клієнт', ai: AI_NAME }
const EVENT_SUMMARY_MAX = 300
// Розмова з ШІ справді була (а не клієнт поклав у перші секунди): так вирішуємо, чи потрібна картка на дошці
export const aiTalked = (entry) => (entry.ai?.sessions || []).some((x) => (x.durationMs || 0) >= 8000 || (x.toolCalls || []).length > 0)
const OUTCOME_AI = { ai_noted: 'noted', ai_answered: 'ended', ai_client_hangup: 'client_hangup', connected: 'transferred', busy_callback: 'failed', ai_failed_callback: 'failed' }
// Клієнт говорив із менеджером: переведення (connected…) або міст через шлюз (bridged…, у т. ч. приєднання менеджера, що
// передзвонив, — bridged_join / connected_join)
export const wasTransferred = (entry) => /^(connected|bridged)/.test(entry?.outcome || '')
// Перезвін справді чекає: записаний і не знятий, коли клієнта з'єднали (served → pendingRemoved)
export const callbackPending = (entry) => !!entry?.callback?.stored && !(entry.pendingRemoved > 0)

// Документ дзвінка з журнального запису шлюзу (entry) і розшифровки (entry.aiTranscript). Чиста функція — для тестів.
export function buildAiCallDoc({ entry, transcript, sr = null, now = new Date() }) {
  const startedAt = entry.startedAt
  const nowIso = now.toISOString()
  const callId = entry.gcid ? `ai-${String(entry.gcid).replace(/[^0-9A-Za-z_-]/g, '')}` : `ai-${Date.parse(startedAt).toString(36)}-${crypto.randomBytes(2).toString('hex')}`
  const turns = (transcript?.turns || []).map((t) => ({ speaker: t.speaker, start: t.start, end: t.end, text: t.text }))
  const transferred = wasTransferred(entry)
  const callbackStored = callbackPending(entry)
  const note = transcript?.note || null
  const aiStart = entry.t?.aiStart ?? entry.t?.ai ?? 0
  return {
    callId,
    doc: {
      id: callId,
      kind: 'ai',
      provider: 'voice-gateway',
      method: 'ai',
      generalCallID: entry.gcid || null,
      direction: 'inbound',
      serviceRequestId: entry.serviceRequestId,
      serviceCenterId: sr?.serviceCenterId || null,
      clientPhone: sr?.clientPhone || null,
      clientName: sr?.clientName || null,
      // є GCID — конвеєр забере запис Binotel і сам закриє документ як summarized; немає — запису не буде
      status: entry.gcid ? 'finished' : 'summarized',
      recordingOnly: !!entry.gcid,
      statusAt: nowIso,
      createdAt: startedAt,
      startedAt,
      answeredAt: new Date(Date.parse(startedAt) + aiStart).toISOString(),
      finishedAt: entry.endedAt,
      durationSec: Math.round((entry.durationMs || 0) / 1000),
      transcript: {
        engine: (transcript?.providers || []).join(', ') || null,
        lang: 'uk',
        durationSec: Math.round((entry.ai?.sessions || []).reduce((a, x) => a + (x.durationMs || 0), 0) / 1000),
        turns,
        text: turns.map((t) => `${SPEAKER_UK[t.speaker] || t.speaker}: ${t.text}`).join('\n'),
        createdAt: nowIso,
      },
      summary: {
        text: summaryText({ note, transferred, callbackStored }),
        lang: 'uk',
        model: 'voice-gateway',
        createdAt: nowIso,
      },
      ai: {
        outcome: OUTCOME_AI[entry.outcome] || entry.outcome,
        kind: entry.ai?.kind || null,
        note,
        callbackStored,
        transfers: entry.ai?.transfers || 0,
        toolCalls: (entry.ai?.sessions || []).flatMap((x) => x.toolCalls || []).map(({ name, at, ok }) => ({ name, at, ok })),
      },
      cost: { aiUsd: Math.round((Number(transcript?.costUsd) || 0) * 10000) / 10000, pbxLegs: 1 },
      recordingStatus: '',
      recording: null,
      error: null,
      nextCheckAt: entry.gcid ? nowIso : null,
      updatedAt: nowIso,
    },
  }
}

// Картка для операторської дошки (callEvents/ai-<gcid>) — у тій самій формі, що дзеркало originate
export function buildAiCallEvent({ entry, transcript, callId, sr = null, now = new Date() }) {
  const nowIso = now.toISOString()
  const summary = summaryText({ note: transcript?.note || null, transferred: wasTransferred(entry), callbackStored: callbackPending(entry) }).replace(/\n/g, ' ')
  return {
    callId,
    sourceCallId: entry.gcid || null,
    source: 'voice-gateway',
    kind: 'ai',
    phone: strictPhone(entry.number) || sr?.clientPhone || null,
    clientName: sr?.clientName || null,
    employee: AI_NAME,
    serviceRequestId: entry.serviceRequestId || null,
    direction: 'inbound',
    at: entry.startedAt,
    lastType: 'call.ai',
    updatedAt: nowIso,
    summary: summary.length > EVENT_SUMMARY_MAX ? `${summary.slice(0, EVENT_SUMMARY_MAX - 1)}…` : summary,
  }
}

export function makeAiCallStore({ projectId = 'droidmaps-runferry', db = null, log = () => {} } = {}) {
  let adminDb = db
  const fs = () => (adminDb = adminDb || openFirestore(projectId))
  return {
    // → {path?, event?, skipped?}: документ дзвінка — якщо заявку знайдено; картка дошки — якщо розмова з ШІ була
    async save(entry) {
      const transcript = entry.aiTranscript
      if (!transcript) return { skipped: 'no_transcript' }
      const d = fs()
      let sr = null
      let srRef = null
      if (entry.serviceRequestId) {
        srRef = d.collection('serviceRequests').doc(entry.serviceRequestId)
        const snap = await srRef.get()
        sr = snap.exists ? snap.data() : null
      }
      const { callId, doc } = buildAiCallDoc({ entry, transcript, sr })
      const out = {}
      if (sr) {
        await srRef.collection('calls').doc(callId).set(doc, { merge: true })
        out.path = `serviceRequests/${entry.serviceRequestId}/calls/${callId}`
        log(`ИИ: разговор записан в заявку (${out.path})`)
      } else out.skipped = entry.serviceRequestId ? 'request_missing' : 'no_request'
      if (aiTalked(entry)) {
        await d.collection('callEvents').doc(callId).set(buildAiCallEvent({ entry, transcript, callId, sr }), { merge: true })
        out.event = `callEvents/${callId}`
      }
      return out
    },
  }
}

export default makeAiCallStore
