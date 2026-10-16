// Налаштування голосового шлюзу: типові значення + змінні середовища VG_* (+ прапорці gateway.mjs поверх).
// Секретів тут немає: пароль лінії вводить оператор або він береться з Secret Manager, ключ ElevenLabs — теж звідти.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const GATEWAY_DIR = path.resolve(HERE, '..') // voice-gateway/
const PROMPTS = '/Users/yevhenyushchenko/Documents/GitHub/runferry-briefs/telephony/voice-prompts/wav-8k/mila'

const num = (v, def) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def)
const bool = (v, def) => (v == null || v === '' ? def : !/^(0|false|no|off)$/i.test(String(v).trim()))
const list = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)

// «907» → sip:907@<сервер>;transport=udp; повний SIP URI лишається як є.
export const extUri = (v, server) => {
  const s = String(v || '').trim()
  if (!s) return ''
  if (/^sips?:/i.test(s)) return s
  return `sip:${s}@${server};transport=udp`
}

export function loadConfig(env = process.env) {
  const sipServer = env.VG_SIP_SERVER || 'sip14.binotel.com'
  const allowed = list(env.VG_ALLOWED_CALLERS)
  return {
    sipServer,
    sipExpires: num(env.VG_SIP_EXPIRES, 120), // Binotel приймав перереєстрацію кожні 120 с
    // Звідки рушій приймає INVITE у реальному режимі: порожньо — IP реєстратора (DNS + звідки прийшов 200 на
    // REGISTER); задано (IP через кому) — лише ці адреси. Решті — 403 ще до сценарію.
    sipTrust: list(env.VG_SIP_TRUST).join(','),
    // Внутрішні лінії Binotel: менеджер (картка + переведення) і запасна (сліпе переведення, якщо менеджер не взяв).
    // manager/fallback — як задано (номер лінії або URI); URI збирає gateway.mjs, коли сервер лінії вже відомий.
    manager: env.VG_MANAGER || '907',
    fallback: env.VG_FALLBACK || '906',
    managerUri: extUri(env.VG_MANAGER || '907', sipServer),
    fallbackUri: extUri(env.VG_FALLBACK || '906', sipServer),
    // Кого пропускаємо: лише ці номери (E.164) + внутрішні (тризначні без X-BINOTEL-GCID; якщо задано
    // VG_ALLOWED_INTERNAL — лише ці лінії); решті — 486
    allowedCallers: allowed, // порожньо → усі зовнішні дзвінки відхиляються (486), номери лише з VG_ALLOWED_CALLERS або --allow
    allowedInternal: list(env.VG_ALLOWED_INTERNAL),
    maxCalls: num(env.VG_MAX_CALLS, 2), // одночасних дзвінків; кожен = 2 ноги, ліміт лінії Binotel — 5
    // Записи (WAV PCM 16 біт, моно, 8 кГц). Це внутрішні ТЕСТОВІ тексти — нових клієнтських тут не робимо.
    greetingFile: env.VG_GREETING_WAV || path.join(PROMPTS, '04-greeting-unknown-short.wav'),
    holdFile: env.VG_HOLD_WAV || path.join(PROMPTS, '05-hold-short.wav'),
    genericCardFile: env.VG_GENERIC_CARD_WAV || null, // картка, якщо синтез не вдався; немає — без картки
    // Таймінги сценарію
    dialDelayMs: num(env.VG_DIAL_DELAY_MS, 1000), // дзвонимо менеджеру через ~1 с після відповіді клієнту
    dialRetries: num(env.VG_DIAL_RETRIES, 2), // повтор набору після 503/408/480 до відповіді
    dialRetryDelayMs: num(env.VG_DIAL_RETRY_DELAY_MS, 1000),
    retryCodes: [503, 408, 480],
    managerTimeoutSec: num(env.VG_MANAGER_TIMEOUT_SEC, 25),
    mediaGraceMs: 1000, // CONFIRMED без події media — граємо все одно через стільки
    ttsWaitMs: num(env.VG_TTS_WAIT_MS, 6000), // скільки менеджер чекає синтезу картки
    afterCardMs: num(env.VG_AFTER_CARD_MS, 700),
    cardMaxSec: num(env.VG_CARD_MAX_SEC, 20), // переведення не пізніше за стільки від початку картки
    xferTimeoutMs: num(env.VG_XFER_TIMEOUT_MS, 8000), // немає фінального NOTIFY — вважаємо невдачею
    // Сліпий REFER на запасну прийнято (202/NOTIFY 1xx): фінальний NOTIFY може прийти лише після відповіді запасної
    fallbackRingMs: num(env.VG_FALLBACK_RING_SEC, 90) * 1000,
    xferClearMs: 4000, // після вдалого переведення АТС сама гасить обидві ноги; жива нога після цього — кладемо
    bridgeMaxMin: num(env.VG_BRIDGE_MAX_MIN, 60), // розмова через локальний міст — не довше (BYE міг загубитися)
    lateEventsMs: 60000, // скільки пам'ятаємо завершений дзвінок для запізнілих подій рушія
    // Дані
    lookupEnabled: bool(env.VG_LOOKUP, true),
    lookupBudgetMs: num(env.VG_LOOKUP_BUDGET_MS, 1200), // як у приймача Binotel
    firebaseProject: env.VG_FIREBASE_PROJECT || 'droidmaps-runferry',
    ttsEnabled: bool(env.VG_TTS, true),
    ttsTimeoutMs: num(env.VG_TTS_TIMEOUT_MS, 6000),
    ttsVoiceId: env.VG_TTS_VOICE || 'zDLnIEu0UzYpFE8fq9aq',
    ttsModel: env.VG_TTS_MODEL || 'eleven_multilingual_v2',
    gcpProject: env.VG_GCP_PROJECT || 'droidmaps-runferry', // Secret Manager
    ttsSecret: env.VG_TTS_SECRET || 'elevenlabs-api-key',
    lineSecret: env.BINOTEL_LINE_SECRET || null, // секрет JSON {server,user,password}; немає — питаємо оператора
    // Місця на диску
    enginePath: env.VG_ENGINE || path.join(GATEWAY_DIR, 'engine', 'sip-engine'),
    cacheDir: env.VG_CACHE_DIR || path.join(GATEWAY_DIR, 'cache'),
    dataDir: env.VG_DATA_DIR || path.join(GATEWAY_DIR, 'data'),
    timeZone: env.VG_TZ || 'Europe/Kyiv', // для імен файлів журналу
    // Траса команд/подій рушія (data/logs/brain-*.log) — лише для налагодження, типово вимкнена
    trace: bool(env.VG_TRACE, false),
    // Скільки днів тримати файли (за часом зміни): логи рушія й траси, кеш карток (у них ім'я клієнта голосом), журнал
    retentionDays: { logs: num(env.VG_LOG_DAYS, 14), cache: num(env.VG_CACHE_DAYS, 30), journal: num(env.VG_JOURNAL_DAYS, 90) },
  }
}

export default loadConfig
