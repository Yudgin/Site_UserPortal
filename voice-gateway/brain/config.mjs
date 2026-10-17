// Налаштування голосового шлюзу: типові значення + змінні середовища VG_* (+ прапорці gateway.mjs поверх).
// Секретів тут немає: пароль лінії вводить оператор або він береться з Secret Manager, ключ ElevenLabs — теж звідти.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveManagers, strictPhone, partyKey } from './callbacks.mjs'
import { parseHours } from './hours.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const GATEWAY_DIR = path.resolve(HERE, '..') // voice-gateway/
const PROMPTS = '/Users/yevhenyushchenko/Documents/GitHub/runferry-briefs/telephony/voice-prompts/wav-8k/mila'

const num = (v, def) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def)
const bool = (v, def) => (v == null || v === '' ? def : !/^(0|false|no|off)$/i.test(String(v).trim()))
const list = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
// «без запасної лінії»: VG_FALLBACK=none (або off, no, -, 0) / --fallback none
export const isOff = (v) => /^(none|off|no|-|0)$/i.test(String(v ?? '').trim())

// Фрази підтвердження й передзвону — ТЕСТОВІ тексти (для менеджера — внутрішні). Синтезуються при старті тим самим
// голосом ElevenLabs (кеш за текстом, cache/prompt-<sha1>.wav); замість синтезу — свій WAV із VG_*_WAV. Фрази немає
// (синтез вимкнено або не вдався) — її пропускаємо, дзвінок іде далі.
export const PROMPT_TEXTS = {
  confirm: "Натисніть один, щоб з'єднатися з клієнтом, або два — якщо не можете говорити.", // менеджеру після картки
  busy: 'На жаль, лінія менеджера зараз зайнята. Менеджер побачить ваш дзвінок і передзвонить вам.', // клієнту
  cbConnecting: "З'єднуємо з клієнтом.", // менеджеру, що передзвонює
  cbNone: 'Зараз немає клієнтів, які чекають на дзвінок.', // менеджеру: передзвонювати нікому
  cbGreeting: "Вітаємо! З вами з'єднується менеджер Runferry.", // клієнту, якому передзвонюють
  cbNoAnswer: 'Клієнт не відповідає.', // менеджеру
  pin: 'Введіть пін-код.', // менеджеру, що передзвонює із зовнішнього номера (VG_MANAGERS_EXTERNAL=1)
  // менеджеру, що передзвонює, поки клієнт говорить із ШІ (лише режим ai; синтезується лише в ньому)
  cbClientBusy: 'Клієнт зараз розмовляє з віртуальним помічником. Передзвоніть за хвилину.',
}
export const PROMPT_ENV = {
  confirm: 'VG_CONFIRM_WAV',
  busy: 'VG_BUSY_WAV',
  cbConnecting: 'VG_CB_CONNECTING_WAV',
  cbNone: 'VG_CB_NONE_WAV',
  cbGreeting: 'VG_CB_GREETING_WAV',
  cbNoAnswer: 'VG_CB_NO_ANSWER_WAV',
  pin: 'VG_PIN_WAV',
  cbClientBusy: 'VG_CB_CLIENT_BUSY_WAV',
}
// Режим «ШІ одразу» і приєднання менеджера, що передзвонив (записка runferry-briefs/telephony/
// ai-first-discussion-join-2026-10-17.md, черги A і B). Фрази менеджеру — внутрішні: синтез дозволено, як у cb*. Окремий
// словник, щоб без нових прапорців набір фраз (і їх синтез при старті) лишався рівно тим самим. Тексти — черновик сесії
// «Голосові заглушки» (runferry-briefs segments-texts-draft 5а (fe08058)); «‖» — пауза диктора, синтез її прибирає.
export const JOIN_PROMPT_TEXTS = {
  // MGR-JOIN, перша частина (далі — «Суть звернення: {резюме}. ‖ З’єдную.», синтез на льоту, або mgrJoinTail)
  // источник: runferry-briefs segments-texts-draft 5а (fe08058)
  mgrJoin: 'Клієнт зараз говорить із віртуальним помічником.',
  // MGR-JOIN, кінець без резюме (ШІ ще нічого не записав або синтез не встиг) — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  mgrJoinTail: 'З’єдную.',
  // клієнт із ШІ не говорив (класичний набір, набір після 82): «з віртуальним помічником» було б неправдою. У черновику
  // такої фрази немає — внутрішній текст черги A
  mgrJoinPlain: "Клієнт на лінії — з'єдную.",
  mgrJoinBusy: 'Клієнта вже з’єднують з колегою.', // MGR-JOIN-BUSY — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  mgrJoinGone: 'Клієнт поклав слухавку.', // MGR-JOIN-GONE — источник: runferry-briefs segments-texts-draft 5а (fe08058)
}
// Клієнтські фрази (80–83, 13–17) — ПРОБНІ тексти черновика 5а. Шлюз їх сам НЕ синтезує (правило власника «аудіо лише
// після погодження текстів»): лише свій WAV (VG_*_WAV) або VG_CLIENT_SYNTH=trial за непорожнього VG_ALLOWED_CALLERS (проба
// на тестових номерах). Немає файла — фразу пропускаємо. Повний варіант (ключ без Short) — уночі, короткий (…Short) —
// днём, як у 00; є лише один — граємо його.
export const CLIENT_TRIAL_TEXTS = {
  // 80-line-intro, повний — источник: runferry-briefs segments-texts-draft 5а (fe08058). Перша фраза ВСІХ гілок режиму ai;
  // оголошення про запис з метою — тут (Правила №761)
  intro: 'Вітаємо! Це багатоканальна лінія компанії Runferry. ‖ Зверніть увагу: ми записуємо розмову, щоб точно опрацювати ваше звернення й контролювати якість обслуговування.',
  // 80-line-intro, короткий — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  introShort: 'Вітаємо! Це багатоканальна лінія компанії Runferry. ‖ Ми записуємо розмову, щоб опрацювати звернення й контролювати якість.',
  joinClient: 'Менеджер уже на лінії — з’єдную вас.', // 81-join-client — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  // 82-ai-down-connect, повний / короткий — источник: runferry-briefs segments-texts-draft 5а (fe08058). ШІ не піднявся
  // (або запобіжник): після 80 — набір загальної групи
  aiDown: 'Залишайтеся, будь ласка, на лінії — з’єднуємо вас з оператором.',
  aiDownShort: 'Залишайтеся на лінії — з’єднуємо з оператором.',
  // 83: уночі ШІ не піднявся — менеджеру не дзвонимо, «лінія зайнята» була б неправдою; перезвін уже стоїть. У черновику
  // такої фрази немає: складено з AI-AFTER-HOURS і 17-ds-no-ai — на погодження власнику
  // 83-ai-down-night — источник: runferry-briefs segments-texts-draft 5а (fe08058), textsNeedingOwner.
  aiDownNight: 'Зараз неробочий час: ми працюємо з понеділка до п’ятниці, з дев’ятої до вісімнадцятої. ‖ Ми вже повідомили про ваш дзвінок — вам передзвонять. ‖ Дякуємо, що зателефонували!',
  // 13-ds-talked — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  dsTalked: 'Ми з вами нещодавно розмовляли. ‖ Залишайтеся, будь ласка, на лінії — з’єднуємо вас із менеджером, який займається вашим зверненням.',
  dsTalkedShort: 'Ми з вами нещодавно розмовляли. ‖ Залишайтеся на лінії — з’єднуємо вас із менеджером.',
  // 14-ds-called — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  dsCalled: 'Ми нещодавно вам телефонували. ‖ Залишайтеся, будь ласка, на лінії — з’єднуємо вас із менеджером, який займається вашим зверненням.',
  dsCalledShort: 'Ми нещодавно вам телефонували. ‖ Залишайтеся на лінії — з’єднуємо вас із менеджером.',
  // 15-ds-general — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  dsGeneral: 'Залишайтеся, будь ласка, на лінії — з’єднуємо вас із менеджером, який займається вашим зверненням.',
  dsGeneralShort: 'Залишайтеся на лінії — з’єднуємо вас із менеджером, який займається вашим зверненням.',
  dsFailed: 'На жаль, з’єднати вас не вдалося.', // 16-ds-failed (повний = короткий) — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  // 17-ds-no-ai — источник: runferry-briefs segments-texts-draft 5а (fe08058)
  dsNoAi: 'Ми вже повідомили про ваш дзвінок — вам передзвонять. ‖ Дякуємо, що зателефонували!',
  dsNoAiShort: 'Вам передзвонять. ‖ Дякуємо, що зателефонували!',
}
export const AI_FIRST_PROMPT_ENV = {
  mgrJoin: 'VG_MGR_JOIN_WAV',
  mgrJoinTail: 'VG_MGR_JOIN_TAIL_WAV',
  mgrJoinPlain: 'VG_MGR_JOIN_PLAIN_WAV',
  mgrJoinBusy: 'VG_MGR_JOIN_BUSY_WAV',
  mgrJoinGone: 'VG_MGR_JOIN_GONE_WAV',
  intro: 'VG_INTRO_WAV',
  introShort: 'VG_INTRO_SHORT_WAV',
  joinClient: 'VG_JOIN_CLIENT_WAV',
  aiDown: 'VG_AI_DOWN_WAV',
  aiDownShort: 'VG_AI_DOWN_SHORT_WAV',
  aiDownNight: 'VG_AI_DOWN_NIGHT_WAV',
  dsTalked: 'VG_DS_TALKED_WAV',
  dsTalkedShort: 'VG_DS_TALKED_SHORT_WAV',
  dsCalled: 'VG_DS_CALLED_WAV',
  dsCalledShort: 'VG_DS_CALLED_SHORT_WAV',
  dsGeneral: 'VG_DS_GENERAL_WAV',
  dsGeneralShort: 'VG_DS_GENERAL_SHORT_WAV',
  dsFailed: 'VG_DS_FAILED_WAV',
  dsNoAi: 'VG_DS_NO_AI_WAV',
  dsNoAiShort: 'VG_DS_NO_AI_SHORT_WAV',
}
// Фрази гілки обговорення (13–17) — потрібні лише з VG_DS_SOURCE (синтез і перевірка WAV)
export const DS_PROMPT_KEYS = ['dsTalked', 'dsTalkedShort', 'dsCalled', 'dsCalledShort', 'dsGeneral', 'dsGeneralShort', 'dsFailed', 'dsNoAi', 'dsNoAiShort']
export const CLIENT_PROMPT_KEYS = Object.keys(CLIENT_TRIAL_TEXTS)

// Запобіжник ШІ (лише VG_ANSWER_MODE=ai): «сбоїв/за хвилин/вимкнено хвилин», типово 3/10/30 — 3 збої ШІ за 10 хв →
// 30 хв шлюз працює по-старому (спершу менеджер). 0 / off — без запобіжника.
export function parseBreaker(v) {
  const s = String(v ?? '').trim()
  if (isOff(s)) return null
  const m = s.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (!m || Number(m[1]) < 1) return { fails: 3, windowMs: 10 * 60000, offMs: 30 * 60000 }
  return { fails: Number(m[1]), windowMs: Number(m[2]) * 60000, offMs: Number(m[3]) * 60000 }
}

export const NO_ANSWER_MODES = ['busy', 'fallback', 'voicemail', 'ai']

// Обговорення (route.mjs): звідки воно і які види бувають
export const DS_SOURCES = ['off', 'test', 'calls', 'field', 'auto']
export const DS_KINDS = ['talked', 'called', 'general', 'pending']
// Номер у попередженнях — лише останні 4 цифри (репозиторій і консоль не для чужих номерів)
const maskDigits = (s) => String(s ?? '').replace(/\d(?=(?:\D*\d){4})/g, '•')
// VG_DS_TEST: «+380500000001=talked,0500000002=called» → {map: Map(E.164 → вид), bad: [замасковані хибні частини]}
export function parseDsTest(spec) {
  const map = new Map()
  const bad = []
  for (const part of String(spec ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([^=]+)=([A-Za-z]+)$/)
    const phone = m ? strictPhone(m[1]) : null
    const kind = m ? m[2].toLowerCase() : null
    if (!phone || !DS_KINDS.includes(kind)) bad.push(maskDigits(part))
    else map.set(phone, kind)
  }
  return { map, bad }
}
// VG_DS_STAFF: «uid=907,uid2=0500000003» → {map: {uid: ключ}, bad}. Ключ — внутрішня лінія або телефон (partyKey).
// uid «test» — ведучий тестових обговорень VG_DS_TEST (без нього — лінія менеджера VG_MANAGER).
export function parseDsStaff(spec) {
  const map = {}
  const bad = []
  for (const part of String(spec ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z0-9_.:-]{1,128})=(.+)$/)
    const key = m ? partyKey(m[2]) : null
    if (!key) bad.push(maskDigits(part))
    else map[m[1]] = key
  }
  return { map, bad }
}
// PIN менеджера для передзвону із зовнішнього номера: 4–8 цифр; інше — PIN не задано (зовнішні номери отримують 486)
export const validPin = (v) => /^\d{4,8}$/.test(String(v ?? '').trim())

// Дані шлюзу (журнал, логи, голосові повідомлення клієнтів) — поза репозиторієм: worktree після злиття гілки
// видаляють разом із усім, що в ньому лежить, а доставки повідомлень менеджерам ще немає (тут їх єдина копія).
// macOS: ~/Library/Application Support/runferry-voice-gateway/data; Linux (ВМ): $XDG_DATA_HOME або ~/.local/share.
export function defaultDataDir(env = process.env, platform = process.platform) {
  const home = env.HOME || os.homedir()
  const base = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return path.join(base, 'runferry-voice-gateway', 'data')
}

// «907» → sip:907@<сервер>;transport=udp; повний SIP URI лишається як є.
export const extUri = (v, server) => {
  const s = String(v || '').trim()
  if (!s) return ''
  if (/^sips?:/i.test(s)) return s
  return `sip:${s}@${server};transport=udp`
}

// Робочий час (для ШІ): помилку розбору не кидаємо — gateway.mjs покаже її й не стартує в режимі ai
function hoursOf(spec) {
  try {
    return { workHours: parseHours(spec), workHoursError: null }
  } catch (e) {
    return { workHours: [], workHoursError: e.message }
  }
}

export function loadConfig(env = process.env) {
  const sipServer = env.VG_SIP_SERVER || 'sip14.binotel.com'
  const allowed = list(env.VG_ALLOWED_CALLERS)
  const managerUri = extUri(env.VG_MANAGER || '907', sipServer)
  const noAnswer = String(env.VG_NO_ANSWER_MODE || '').trim().toLowerCase()
  const dsSource = String(env.VG_DS_SOURCE || '').trim().toLowerCase()
  const dsTest = parseDsTest(env.VG_DS_TEST)
  const dsStaff = parseDsStaff(env.VG_DS_STAFF)
  return {
    sipServer,
    sipExpires: num(env.VG_SIP_EXPIRES, 120), // Binotel приймав перереєстрацію кожні 120 с
    // Звідки рушій приймає INVITE у реальному режимі: порожньо — IP реєстратора (DNS + звідки прийшов 200 на
    // REGISTER); задано (IP через кому) — лише ці адреси. Решті — 403 ще до сценарію.
    sipTrust: list(env.VG_SIP_TRUST).join(','),
    // Внутрішні лінії Binotel: менеджер (картка + переведення) і запасна (так само: набір, картка, REFER/Replaces,
    // якщо менеджер не взяв). manager/fallback — як задано (номер лінії або URI); URI збирає gateway.mjs, коли
    // сервер лінії вже відомий. VG_FALLBACK=none — без запасної: одразу голосова пошта.
    manager: env.VG_MANAGER || '907',
    fallback: isOff(env.VG_FALLBACK) ? '' : env.VG_FALLBACK || '906',
    managerUri,
    fallbackUri: isOff(env.VG_FALLBACK) ? '' : extUri(env.VG_FALLBACK || '906', sipServer),
    // consult (типово) — запасній дзвонимо самі й переводимо REFER/Replaces, як менеджеру; blind — старе сліпе
    // переведення REFER без Replaces (лише для дослідів: живий Binotel відповідає на нього фінальним NOTIFY 200
    // за ~2 мс, навіть коли запасна недоступна, і клієнта просто роз'єднує через 4–5 с)
    fallbackMode: String(env.VG_FALLBACK_MODE || '').trim().toLowerCase() === 'blind' ? 'blind' : 'consult',
    // Кого пропускаємо: лише ці номери (E.164) + внутрішні (тризначні без X-BINOTEL-GCID; якщо задано
    // VG_ALLOWED_INTERNAL — лише ці лінії); решті — 486
    allowedCallers: allowed, // порожньо → усі зовнішні дзвінки відхиляються (486), номери лише з VG_ALLOWED_CALLERS або --allow
    allowedInternal: list(env.VG_ALLOWED_INTERNAL),
    // Менеджер не взяв / зайнятий / натиснув 2 / не натиснув 1 / поклав до переведення (повтори вичерпано):
    //   busy (типово) — клієнту «лінія зайнята, менеджер передзвонить», відбій і відкладений передзвін у callbacks.json;
    //   fallback — старий шлях: запасна лінія (набір, картка, підтвердження, REFER/Replaces), далі голосова пошта;
    //   voicemail — одразу голосова пошта.
    //   ai — ШІ-співрозмовник (ElevenLabs Agents): стан заявки, питання для менеджера, з'єднати, завершити; у неробочий
    //        час (VG_WORK_HOURS) — одразу ШІ, без набору менеджера (VG_AI_AFTER_HOURS=0 — ні). Типово вимкнено.
    noAnswerMode: NO_ANSWER_MODES.includes(noAnswer) ? noAnswer : 'busy',
    // Підтвердження після картки: «1» — переводимо (REFER/Replaces), «2» — не може говорити. Немає цифри
    // confirmTimeoutSec після кінця фрази — фраза ще раз (confirmRepeats), знову нічого — як не відповів (так і
    // голосова пошта мобільного оператора не забере клієнта). VG_CONFIRM=0 — переводити одразу після картки, як раніше.
    // Рушій без DTMF (старий engine/sip-engine) з увімкненим підтвердженням: шлюз не стартує (gateway.mjs), а сценарій
    // без «1» не переводить ніколи — голосова пошта мобільного оператора не забере клієнта навіть так.
    confirmEnabled: bool(env.VG_CONFIRM, true),
    confirmTimeoutSec: num(env.VG_CONFIRM_TIMEOUT_SEC, 10),
    confirmRepeats: num(env.VG_CONFIRM_REPEATS, 1),
    confirmDigit: '1',
    declineDigit: '2',
    dtmfSupported: null, // чи повідомляє рушій DTMF: gateway.mjs ставить за подією ready (false + підтвердження — не стартує)
    // Хто з дзвінків на шлюз — менеджер (передзвін клієнту, а не новий клієнт): VG_MANAGERS (номери / внутрішні лінії
    // через кому, номери однієї людини — через «=») + завжди лінія менеджера з managerUri. Типово — лише вона.
    // Номер звонящего порівнюємо ЦІЛКОМ (strictPhone), без пошуку підрядка.
    managersSpec: env.VG_MANAGERS || '',
    managers: resolveManagers(env.VG_MANAGERS, managerUri),
    // Передзвін приймаємо з внутрішніх ліній менеджерів (3–4 цифри без X-BINOTEL-GCID — приходять зсередини АТС).
    // Зовнішній номер можна підробити (caller ID spoofing): з нього — лише з VG_MANAGERS_EXTERNAL=1 І VG_MANAGER_PIN
    // (4–8 цифр, менеджер набирає після відповіді); інакше такий дзвінок отримує 486 (не клієнт і не передзвін).
    managersExternal: bool(env.VG_MANAGERS_EXTERNAL, false),
    // VG_MANAGERS_EXTERNAL=nopin — рішення власника 2026-10-17: передзвін із мобільного менеджера без PIN (ризик підробки номера прийнято)
    managersExternalNoPin: String(env.VG_MANAGERS_EXTERNAL ?? '').trim().toLowerCase() === 'nopin',
    managerPin: validPin(env.VG_MANAGER_PIN) ? String(env.VG_MANAGER_PIN).trim() : null,
    managerPinInvalid: env.VG_MANAGER_PIN != null && env.VG_MANAGER_PIN !== '' && !validPin(env.VG_MANAGER_PIN),
    pinTimeoutSec: num(env.VG_PIN_TIMEOUT_SEC, 10), // скільки чекаємо PIN після фрази «Введіть пін-код.»
    callbackTtlHours: num(env.VG_CALLBACK_TTL_HOURS, 24), // скільки чекає відкладений передзвін
    lastClientTtlDays: num(env.VG_LAST_CLIENT_DAYS, 30), // скільки пам'ятаємо останнього клієнта менеджера
    callbackDialTimeoutSec: num(env.VG_CALLBACK_DIAL_TIMEOUT_SEC, 30), // скільки дзвонимо клієнту на передзвоні
    // Клієнт не взяв на передзвоні — запис у кінець черги; після стількох невдалих спроб знімаємо (0 — не знімати)
    callbackMaxAttempts: num(env.VG_CALLBACK_MAX_ATTEMPTS, 3),
    // Не частіше за стільки наборів одного клієнта на передзвоні за 24 год (0 — без ліміту)
    callbackMaxDialsPerDay: num(env.VG_CALLBACK_MAX_DIALS_DAY, 5),
    // Клієнт, якому передзвонюють, ще на лінії шлюзу (дослуховує «лінія зайнята…») — чекаємо, поки покладе, не довше
    callbackLineWaitSec: num(env.VG_CALLBACK_LINE_WAIT_SEC, 15),
    // busy: клієнт поклав, поки менеджеру дзвонили (у менеджера пропущений) — теж відкладений передзвін (missed)
    callbackOnHangup: bool(env.VG_CALLBACK_ON_HANGUP, true),
    // На передзвоні REFER/Replaces: manager (типово, рішення власника) — REFER на нозі менеджера з Replaces ноги клієнта
    // (у Refer-To — URI клієнта, тобто його номер); client — REFER на нозі клієнта з Replaces ноги менеджера (у Refer-To —
    // URI менеджера). Що з цього бачить менеджер на телефоні, перевіряється лише на живому Binotel.
    callbackReferOn: String(env.VG_CALLBACK_REFER_ON || '').trim().toLowerCase() === 'client' ? 'client' : 'manager',
    // Як набирати клієнта на передзвоні: {national} 0XXXXXXXXX, {e164}, {digits}, {server} — сервер лінії
    clientUriTemplate: env.VG_CLIENT_URI || 'sip:{national}@{server};transport=udp',
    // Картка вголос НЕ каже номер клієнта (частина менеджерів не має його знати); VG_CARD_SPEAK_NUMBER=1 — як раніше
    cardSpeakNumber: bool(env.VG_CARD_SPEAK_NUMBER, false),
    promptTexts: { ...PROMPT_TEXTS },
    promptFiles: Object.fromEntries(Object.entries(PROMPT_ENV).map(([k, v]) => [k, env[v] || null])), // свої WAV
    prompts: {}, // готові файли фраз: gateway.mjs заповнює (свій WAV або синтез); немає — фразу пропускаємо
    maxCalls: num(env.VG_MAX_CALLS, 2), // одночасних дзвінків; кожен = 2 ноги, ліміт лінії Binotel — 5
    // Записи (WAV PCM 16 біт, моно, 8 кГц). Це внутрішні ТЕСТОВІ тексти — нових клієнтських тут не робимо.
    greetingFile: env.VG_GREETING_WAV || path.join(PROMPTS, '04-greeting-unknown-short.wav'),
    holdFile: env.VG_HOLD_WAV || path.join(PROMPTS, '05-hold-short.wav'),
    genericCardFile: env.VG_GENERIC_CARD_WAV || null, // картка, якщо синтез не вдався; немає — без картки
    // Таймінги сценарію
    dialDelayMs: num(env.VG_DIAL_DELAY_MS, 1000), // дзвонимо менеджеру через ~1 с після відповіді клієнту
    // Повтор набору після 503/408/480 (і помилки рушія) до відповіді: Android-софтфон, що спить, кілька секунд
    // відповідає 503, поки його будить push. Повторюємо через dialRetryIntervalMs, поки наступна спроба
    // починається не пізніше dialRetryWindowSec від першого набору цієї сторони.
    dialRetryWindowSec: num(env.VG_DIAL_RETRY_WINDOW_SEC, 12),
    dialRetryIntervalMs: num(env.VG_DIAL_RETRY_INTERVAL_MS, num(env.VG_DIAL_RETRY_DELAY_MS, 2000)), // стара назва — VG_DIAL_RETRY_DELAY_MS
    dialRetries: num(env.VG_DIAL_RETRIES, null), // необов'язковий ліміт кількості повторів (типово — лише вікно)
    retryCodes: [503, 408, 480],
    // Скільки дзвонить спроба, що зазвонила: від її першого 180/183 (без 180 — від її INVITE). Повтор, що зазвонив
    // на 10-й с, дзвонить повний час (менеджер на Android бере через ~16 с після 180). Уся сторона з повторами —
    // не довше dialRetryWindowSec + тайм-аут від першого набору.
    managerTimeoutSec: num(env.VG_MANAGER_TIMEOUT_SEC, 25),
    fallbackTimeoutSec: num(env.VG_FALLBACK_TIMEOUT_SEC, 20),
    mediaGraceMs: 1000, // CONFIRMED без події media — граємо все одно через стільки
    ttsWaitMs: num(env.VG_TTS_WAIT_MS, 6000), // скільки менеджер чекає синтезу картки
    afterCardMs: num(env.VG_AFTER_CARD_MS, 700),
    cardMaxSec: num(env.VG_CARD_MAX_SEC, 20), // переведення не пізніше за стільки від початку картки
    xferTimeoutMs: num(env.VG_XFER_TIMEOUT_MS, 8000), // немає фінального NOTIFY — вважаємо невдачею
    // Лише fallbackMode 'blind': сліпий REFER на запасну прийнято (202/NOTIFY 1xx) — стільки чекаємо фінальний NOTIFY
    fallbackRingMs: num(env.VG_FALLBACK_RING_SEC, 90) * 1000,
    // Голосова пошта (noAnswerMode fallback / voicemail), якщо не взяли ні менеджер, ні запасна: фраза (ТЕСТОВИЙ
    // текст) → сигнал → запис голосу клієнта у <dataDir>/voicemail/YYYY-MM-DD/<gcid або час>-<4 цифри>.wav,
    // не довше voicemailMaxSec
    voicemailEnabled: bool(env.VG_VOICEMAIL, true),
    voicemailPromptFile: env.VG_VOICEMAIL_WAV || path.join(PROMPTS, '07-voicemail-no-answer-short.wav'),
    voicemailMaxSec: num(env.VG_VOICEMAIL_MAX_SEC, 60),
    // Запис коротший (або файла немає) — повідомлення немає: підсумок voicemail_empty, порожній файл видаляється
    voicemailMinSec: num(env.VG_VOICEMAIL_MIN_SEC, 1),
    beepFile: env.VG_BEEP_WAV || null, // немає — gateway.mjs один раз генерує cache/beep-1000hz-400ms.wav
    // ШІ-співрозмовник (noAnswerMode 'ai'). Перші фрази й інструкції — aiprompt.mjs (ТЕСТОВІ тексти до погодження).
    aiProvider: String(env.VG_AI_PROVIDER || 'elevenlabs').trim().toLowerCase(),
    workHoursSpec: env.VG_WORK_HOURS ?? 'mon-fri 09:00-18:00', // Київ; порожньо — завжди робочий
    ...hoursOf(env.VG_WORK_HOURS ?? 'mon-fri 09:00-18:00'),
    aiAfterHours: bool(env.VG_AI_AFTER_HOURS, true), // неробочий час — одразу ШІ, менеджеру не дзвонимо
    aiMaxSec: num(env.VG_AI_MAX_SEC, 300), // розмова з ШІ — не довше (за 30 с до кінця — «час спливає»)
    aiIdleSec: num(env.VG_AI_IDLE_SEC, 20), // тиша: ElevenLabs перепитує сам, через 2 такі проміжки — відбій
    aiWrapSec: num(env.VG_AI_WRAP_SEC, 30),
    // скільки разів ШІ може передати клієнта менеджеру за дзвінок (> 1 — і з повторної сесії після невдалого з'єднання)
    aiTransferMax: num(env.VG_AI_TRANSFER_MAX, 1),
    // Що ШІ каже про заявку: minimal — є/немає, скільки, номер; stage — ще й етап (рішення власника)
    aiStatusDetail: String(env.VG_AI_STATUS_DETAIL || '').trim().toLowerCase() === 'stage' ? 'stage' : 'minimal',
    // Черга C: нічний черговий — лише ключ зі списку власника VG_MANAGERS; порожньо — вимкнено.
    afterHoursUrgentTo: partyKey(env.VG_AFTER_HOURS_URGENT_TO) || null,
    // Відмітка угоди: явний шлях у заявці або onec/snapshot.raw.*; без прапорця додаткових читань немає.
    termsField: String(env.VG_TERMS_FIELD || '').trim(),
    // Попередній контракт повторного посилання (адаптер resend.mjs); типово інструмента немає.
    aiResendUrl: env.VG_AI_RESEND_URL || null,
    aiResendSecret: env.VG_AI_RESEND_SECRET || null,
    aiResendTimeoutMs: num(env.VG_AI_RESEND_TIMEOUT_MS, 3000),
    // Куди зберігати розшифровку й підсумок: local — <data>/ai/<дата>/*.json (0600); firestore — ще й
    // serviceRequests/{id}/calls/ai-<gcid> (kind 'ai'), якщо заявку знайдено (формат погоджується з конвеєром дзвінків)
    aiSave: String(env.VG_AI_SAVE || '').trim().toLowerCase() === 'firestore' ? 'firestore' : 'local',
    aiElAgent: env.VG_AI_EL_AGENT || null, // agent_id ElevenLabs; немає — з <data>/ai-elevenlabs.json (ai-setup-elevenlabs.mjs)
    aiElApi: env.VG_AI_EL_API || 'https://api.elevenlabs.io',
    aiElUrl: env.VG_AI_EL_URL || null, // готова адреса WebSocket (локальна перевірка з fake-ai-server.mjs)
    aiElLlm: env.VG_AI_EL_LLM || 'claude-sonnet-5-5', // LLM агента (ai-setup-elevenlabs.mjs; у журнал)
    aiVoiceId: env.VG_AI_VOICE || env.VG_TTS_VOICE || 'zDLnIEu0UzYpFE8fq9aq', // той самий голос, що й фрази шлюзу
    aiPricePerMin: num(env.VG_AI_PRICE_PER_MIN, 0.08), // оцінка вартості в журнал, $/хв без LLM
    // «ШІ одразу» (черга A записки 2026-10-17; усе типово вимкнено, без цих змінних шлюз працює рівно як раніше):
    //   manager (типово) — спершу менеджер, як і було; ai — у робочий час трубку бере ШІ одразу: вступ 80 (VG_INTRO_WAV,
    //   немає — без вступу), пошук клієнта під нього, перша фраза ШІ за даними; перезвін на старті не ставиться. Потрібен
    //   агент (без нього — попередження і старий режим). Неробочий час — як і раніше (after_hours).
    answerMode: String(env.VG_ANSWER_MODE || '').trim().toLowerCase() === 'ai' ? 'ai' : 'manager',
    // Скільки чекати пошук клієнта після кінця вступу (без вступу — AI_INFO_WAIT_MS від відповіді); не встиг — «даних немає»
    routeDecideGraceMs: num(env.VG_ROUTE_DECIDE_GRACE_MS, 1000),
    // Перевід на прохання клієнта в режимі ai: ask — правила 20/21 (відкрита заявка — спершу раз «сторінка заявки»,
    // з'єднуємо у винятках або на повторне прохання; без заявки — одразу); always — одразу на перше прохання
    aiFirstTransfer: String(env.VG_AI_FIRST_TRANSFER || '').trim().toLowerCase() === 'always' ? 'always' : 'ask',
    aiBreaker: parseBreaker(env.VG_AI_BREAKER ?? '3/10/30'),
    // Що чує клієнт, поки шлюз дзвонить менеджеру на прохання ШІ (і після 82): phrase — як і було (05-hold);
    // ringback — гудки 425 Гц (1 с звук / 4 с тиша), gateway.mjs генерує cache/ringback-425hz.wav (або VG_RINGBACK_WAV)
    holdTone: String(env.VG_HOLD_TONE || '').trim().toLowerCase() === 'ringback' ? 'ringback' : 'phrase',
    ringbackFile: env.VG_RINGBACK_WAV || null,
    // Клієнтські фрази 80–83 і 13–17: off — лише свої WAV; trial — пробний синтез CLIENT_TRIAL_TEXTS (лише з VG_ALLOWED_CALLERS)
    clientSynth: String(env.VG_CLIENT_SYNTH || '').trim().toLowerCase() === 'trial' ? 'trial' : 'off',
    // Менеджер передзвонив на 901, поки клієнт чекає саме його (із ШІ з перезвоном у його групі або шлюз зараз йому
    // дзвонить), — приєднуємо: ШІ стоп, клієнту 81, менеджеру «Клієнт на лінії…», далі міст (bridge) або REFER клієнта з
    // Replaces ноги менеджера (refer; не вдалося — міст). Звонок менеджера, що приєднується, не рахується в maxCalls.
    joinOnCallback: bool(env.VG_JOIN_ON_CALLBACK, false),
    joinMode: String(env.VG_JOIN_MODE || '').trim().toLowerCase() === 'refer' ? 'refer' : 'bridge',
    joinPromptTexts: { ...JOIN_PROMPT_TEXTS },
    clientTrialTexts: { ...CLIENT_TRIAL_TEXTS },
    aiFirstPromptFiles: Object.fromEntries(Object.entries(AI_FIRST_PROMPT_ENV).map(([k, v]) => [k, env[v] || null])),
    // Обговорення (черга B записки 2026-10-17, розд. 3, 6, 11; усе типово вимкнено). Звідки воно: off | test | calls |
    // field | auto (route.mjs). Ведучому дзвонимо лише якщо його ключ є в VG_MANAGERS; пропуски й пауза — по співробітнику
    // (staff-state.json). Фрази 13–17 — VG_DS_*_WAV або пробний синтез; немає — гудки (механіка без тексту).
    dsSource: DS_SOURCES.includes(dsSource) ? dsSource : 'off',
    dsTest: dsTest.map, // VG_DS_TEST «номер=talked|called|general|pending» — лише локальний env, номери з VG_ALLOWED_CALLERS
    dsTestBad: dsTest.bad,
    dsStaff: dsStaff.map, // VG_DS_STAFF «uid=ключ» — ведучий за uid (у т. ч. test=ключ для VG_DS_TEST)
    dsStaffBad: dsStaff.bad,
    dsTalkedH: num(env.VG_DS_TALKED_H, 24), // 13 «нещодавно розмовляли» — розмова не старша
    dsCalledH: num(env.VG_DS_CALLED_H, 48), // 14 «нещодавно телефонували» — недодзвін не старший (строк обговорення — ще й до 18:00 2-го робочого дня)
    dsPendingMin: num(env.VG_DS_PENDING_MIN, 30), // дзвінок із застосунку почато не раніше — ведучий зайнятий (pending_call)
    dsCallsBudgetMs: num(env.VG_DS_CALLS_BUDGET_MS, 600), // скільки чекаємо дзвінки заявки; не встигли — «обговорення немає»
    dsRingSec: num(env.VG_DS_RING_SEC, 20), // скільки дзвонимо ведучому (звичайному менеджеру — VG_MANAGER_TIMEOUT_SEC)
    dsMaxWaitSec: num(env.VG_DS_MAX_WAIT_SEC, 30), // клієнт після фрази чекає ведучого не довше — далі «не вдалося»
    dsXferWaitMs: 6000, // «1» натиснуто, а фраза 13/14/15 ще грає: REFER — після неї, але не пізніше
    dsMissMax: num(env.VG_DS_MISS_MAX, 2), // пропусків поспіль → пауза (0 — без паузи)
    dsPauseMin: num(env.VG_DS_PAUSE_MIN, 120),
    dsAiTransfer: num(env.VG_DS_AI_TRANSFER, 0), // ШІ після «не вдалося» з'єднує ще раз (з оператором) — типово ні
    // В19: ведучому не дзвонили (пауза, ключа немає, зайнятий) — ШІ може з'єднати з оператором лише при претензії,
    // гарантії чи небезпеці (типово так; 0 — ні)
    dsExceptionTransfer: bool(env.VG_DS_EXCEPTION_TRANSFER, true),
    // Як набирати ведучого-мобільного (ключ не лінія менеджера): {national} {e164} {digits} {server}; лінія — sip:NNN@сервер
    dsLeadUriTemplate: env.VG_DS_LEAD_URI || 'sip:{national}@{server};transport=udp',
    // Події для сервера режиму (routeevents.mjs): адреса й ім'я секрету токена в Secret Manager; типово вимкнено
    dsEventsUrl: env.VG_DS_EVENTS_URL || null,
    dsEventsSecret: env.VG_DS_EVENTS_SECRET || null,
    dsEventsTimeoutMs: num(env.VG_DS_EVENTS_TIMEOUT_MS, 3000),
    // Фактична ціна розмови з ШІ (GET /v1/convai/conversations/{id}) після її кінця, у фоні; типово так, якщо ШІ
    // увімкнено. З локальним підробленим ElevenLabs (VG_AI_EL_URL) — лише з явним VG_AI_EL_API: справжній API не чіпаємо
    aiCostFetch: bool(env.VG_AI_COST_FETCH, true) && (!env.VG_AI_EL_URL || !!env.VG_AI_EL_API),
    recordSupported: null, // чи вміє рушій record: gateway.mjs ставить за подією ready (false — пошти немає)
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
    // Рушій: VG_ENGINE_PATH (стара назва — VG_ENGINE) або прапорець --engine; рушій із записом голосової пошти —
    // engine/sip-engine-next, поки працює старий шлюз (його engine/sip-engine не перезбирати)
    enginePath: env.VG_ENGINE_PATH || env.VG_ENGINE || path.join(GATEWAY_DIR, 'engine', 'sip-engine'),
    // Абсолютні шляхи: рушій пише запис лише за абсолютним шляхом (VG_DATA_DIR=data інакше зламав би пошту)
    cacheDir: path.resolve(env.VG_CACHE_DIR || path.join(GATEWAY_DIR, 'cache')),
    dataDir: path.resolve(env.VG_DATA_DIR || defaultDataDir(env)),
    timeZone: env.VG_TZ || 'Europe/Kyiv', // для імен файлів журналу
    // Траса команд/подій рушія (data/logs/brain-*.log) — лише для налагодження, типово вимкнена
    trace: bool(env.VG_TRACE, false),
    // Скільки днів тримати файли (за часом зміни): логи рушія й траси, кеш карток (у них ім'я клієнта голосом), журнал,
    // голосові повідомлення клієнтів
    retentionDays: {
      logs: num(env.VG_LOG_DAYS, 14),
      cache: num(env.VG_CACHE_DAYS, 30),
      journal: num(env.VG_JOURNAL_DAYS, 90),
      voicemail: num(env.VG_VOICEMAIL_DAYS, 90),
      ai: num(env.VG_AI_DAYS, 90), // розшифровки розмов із ШІ
    },
  }
}

export default loadConfig
