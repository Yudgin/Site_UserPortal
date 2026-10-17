// Розмова з ШІ — у конвеєр дзвінків порталу: serviceRequests/{srId}/calls/ai-<generalCallID> (kind 'ai'), поруч із
// дзвінками originate (server/binotelCalls.js, контракт runferry-briefs/telephony/call-bridge-contract-2026-10-15.md).
// Пишемо лише коли заявку знайдено за номером і VG_AI_SAVE=firestore (формат погоджується з сесією «Соединение
// клиента с сотрудником, транскрипция, резюме»). Розшифровка й підсумок уже готові (зі шлюзу) — status 'summarized',
// nextCheckAt null: конвеєр їх не обробляє. firebase-admin — із server/node_modules, креди ADC (як lookup.mjs).
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { summaryText } from './aiprompt.mjs'

function openFirestore(projectId) {
  const req = createRequire(new URL('../../server/package.json', import.meta.url))
  const { initializeApp, applicationDefault, getApps } = req('firebase-admin/app')
  const { getFirestore } = req('firebase-admin/firestore')
  const app = getApps()[0] || initializeApp({ credential: applicationDefault(), projectId })
  return getFirestore(app)
}

const SPEAKER_UK = { client: 'Клієнт', ai: 'ШІ-помічник' }
const OUTCOME_AI = { ai_noted: 'noted', ai_answered: 'ended', ai_client_hangup: 'client_hangup', connected: 'transferred', busy_callback: 'failed' }

// Документ дзвінка з журнального запису шлюзу (entry) і розшифровки (entry.aiTranscript). Чиста функція — для тестів.
export function buildAiCallDoc({ entry, transcript, sr = null, now = new Date() }) {
  const startedAt = entry.startedAt
  const nowIso = now.toISOString()
  const callId = entry.gcid ? `ai-${String(entry.gcid).replace(/[^0-9A-Za-z_-]/g, '')}` : `ai-${Date.parse(startedAt).toString(36)}-${crypto.randomBytes(2).toString('hex')}`
  const turns = (transcript?.turns || []).map((t) => ({ speaker: t.speaker, start: t.start, end: t.end, text: t.text }))
  const transferred = entry.outcome === 'connected' || /^connected/.test(entry.outcome || '')
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
      status: 'summarized',
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
        text: summaryText({ note, transferred, callbackStored: !!entry.callback?.stored }),
        lang: 'uk',
        model: 'voice-gateway',
        createdAt: nowIso,
      },
      ai: {
        outcome: OUTCOME_AI[entry.outcome] || entry.outcome,
        kind: entry.ai?.kind || null,
        note,
        callbackStored: !!entry.callback?.stored,
        transfers: entry.ai?.transfers || 0,
        toolCalls: (entry.ai?.sessions || []).flatMap((x) => x.toolCalls || []).map(({ name, at, ok }) => ({ name, at, ok })),
      },
      cost: { aiUsd: Math.round((Number(transcript?.costUsd) || 0) * 10000) / 10000, pbxLegs: 1 },
      recordingStatus: '',
      recording: null,
      error: null,
      nextCheckAt: null,
      lockUntil: null,
      attempts: 0,
      updatedAt: nowIso,
    },
  }
}

export function makeAiCallStore({ projectId = 'droidmaps-runferry', db = null, log = () => {} } = {}) {
  let adminDb = db
  const fs = () => (adminDb = adminDb || openFirestore(projectId))
  return {
    // → {path} | {skipped}
    async save(entry) {
      const transcript = entry.aiTranscript
      if (!transcript) return { skipped: 'no_transcript' }
      if (!entry.serviceRequestId) return { skipped: 'no_request' }
      const d = fs()
      const srRef = d.collection('serviceRequests').doc(entry.serviceRequestId)
      const snap = await srRef.get()
      if (!snap.exists) return { skipped: 'request_missing' }
      const { callId, doc } = buildAiCallDoc({ entry, transcript, sr: snap.data() })
      await srRef.collection('calls').doc(callId).set(doc, { merge: true })
      log(`ИИ: разговор записан в заявку (serviceRequests/${entry.serviceRequestId}/calls/${callId})`)
      return { path: `serviceRequests/${entry.serviceRequestId}/calls/${callId}` }
    },
  }
}

export default makeAiCallStore
