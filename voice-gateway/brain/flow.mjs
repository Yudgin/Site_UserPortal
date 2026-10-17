// Сценарій вхідного дзвінка голосового шлюзу — чиста машина станів, без I/O. Усе зовнішнє приходить ззовні:
// send(cmd) — команда рушію, clock {now, setTimeout, clearTimeout}, lookup(phone), buildCard(lookup, {number, phone,
// speakNumber}), tts(text) → {file, cached}, voicemailPath({gcid, number}) → шлях WAV голосової пошти (теку створює той,
// хто передав), callbacks — сховище передзвонів (callbacks.mjs: addPending, updatePending, removePending, pickTarget,
// setLastClient, removePendingFor, markAttempt, canDial, noteDial), partyBusy(number) — чи цей номер зараз на іншому
// дзвінку шлюзу ('line' — клієнт на лінії, 'ai' — клієнт говорить із ШІ (або чекає його сесію), 'dialing' — його
// набирає інший передзвін; дає диспетчер), onDone(entry) —
// запис у журнал, log(msg) — рядок статусу для оператора (рос.). Сталі фрази — з config.prompts (готовий WAV або
// нічого: тоді фразу пропускаємо, дзвінок іде далі).
//
// ДЗВІНОК КЛІЄНТА (kind 'client'). Нога A — клієнт (вхідний на лінію), нога B — той, кому зараз дзвонимо: менеджер
// (managerUri), а в режимі fallback — потім запасна лінія (fallbackUri). Порядок:
//   вхідний A → (не з білого списку і не внутрішній → 486) → answer 200 → привітання → утримання (по колу);
//   паралельно: пошук клієнта → текст картки (без номера телефону) → синтез; через ~1 с після відповіді — набір менеджера.
//   Набір: 503/408/480 або помилка рушія до відповіді → повтор через dialRetryIntervalMs, поки наступна спроба
//   починається в межах dialRetryWindowSec від першого набору цієї сторони (Android-софтфон, що спить, кілька секунд
//   відповідає 503); утримання клієнту весь цей час грає по колу.
//   Тайм-аут сторони (managerTimeoutSec / fallbackTimeoutSec) — скільки дзвонить спроба: від її першого 180/183
//   (немає 180 — від її INVITE), тож повтор, що зазвонив на 10-й с, теж дзвонить повний час. Уся сторона разом із
//   повторами — не довше dialRetryWindowSec + тайм-аут від першого набору.
//   B відповів → клієнт стає «останнім клієнтом» цього менеджера (last-clients.json) → картка на B (синтез чекаємо
//   ≤ ttsWaitMs; не вдався — genericCardFile або без картки) → кінець картки + afterCardMs (але не пізніше cardMaxSec
//   від її початку) → фраза підтвердження prompts.confirm: DTMF «1» (і під час картки) → xfer_replaces(A, B);
//   «2» — не може говорити; немає цифри confirmTimeoutSec після кінця фрази — фраза ще раз (confirmRepeats), знову
//   нічого — як не відповів (так і голосова пошта мобільного оператора менеджера не забере клієнта).
//   Фінальний 2xx — з'єднано (АТС гасить обидві ноги; жива через xferClearMs — кладемо);
//   REFER прийнято (202/NOTIFY 100), фінального NOTIFY немає, а АТС поклала обидві ноги — теж успіх Replaces
//   (…_unconfirmed); поклала лише B, а клієнт і через xferTimeoutMs на нашій нозі — переведення не відбулося
//   (…_xfer_unconfirmed → як не відповів): при вдалому Replaces Binotel кладе A одразу за B;
//   невдача — локальний міст A↔B (bridged, не довше bridgeMaxMin). A поклав — кладемо B (client_hangup).
//   Без «1» не переводимо ніколи: рушій без DTMF — цифр не буде, отже «не підтвердив» (gateway.mjs з таким рушієм і не
//   стартує); переводити одразу після картки — лише явне confirmEnabled=false (VG_CONFIRM=0).
//   Клієнта з'єднано (connected / _unconfirmed / bridged, і через запасну) — його відкладені передзвони в цього
//   менеджера знімаємо: він уже говорив із менеджером, передзвонювати не треба.
//   Менеджер не взяв / зайнятий / «2» / без «1» / поклав до переведення / повтори вичерпано → за noAnswerMode:
//     busy (типово) — відкладений передзвін {номер, gcid, заявка, картка, менеджер} у callbacks.json; привітання, якщо
//       ще грає, догрує → стоп утримання → prompts.busy клієнту («лінія зайнята, менеджер передзвонить») → відбій
//       (busy_callback). Клієнта не тримаємо на лінії. Клієнт сам поклав трубку, поки менеджеру вже дзвонили (у
//       менеджера пропущений) — теж відкладений передзвін (missed, callbackOnHangup), підсумок client_hangup; так само
//       в режимі ai, поки ШІ ще не відповідав (перший набір менеджера).
//     fallback — те саме, що з менеджером, із запасною лінією (connected_fallback); не вийшло і з нею або її немає →
//       голосова пошта;
//     voicemail — одразу голосова пошта: привітання, якщо ще грає, догрує → стоп утримання → voicemailPromptFile →
//       сигнал beepFile → запис голосу клієнта (record) до voicemailMaxSec або до його відбою → кладемо (voicemail;
//       запис коротший за voicemailMinSec або файла немає — voicemail_empty, порожній файл видаляє gateway.mjs).
//       Шлюз зупинили під час запису — voicemail з stop 'aborted' і abortReason.
//   Сліпе переведення (REFER без Replaces) — лише fallback + fallbackMode 'blind' (старий шлях, для дослідів): живий
//   Binotel 2026-10-17 відповідав на нього фінальним NOTIFY 200 за ~2 мс, навіть коли запасна була недоступна, і
//   клієнта просто роз'єднувало через 4–5 с. У blind: немає жодної відповіді на REFER за xferTimeoutMs — кладемо A;
//   REFER прийнято — чекаємо BYE від АТС або фінальний NOTIFY до fallbackRingMs.
//
// ШІ-СПІВРОЗМОВНИК (noAnswerMode 'ai', типово вимкнено; ai — фабрика сесій agent.mjs, дає gateway.mjs; ai.available()
// === false — рушій без звуку до мозку: тоді дзвінок іде рівно як busy, менеджеру дзвонимо й уночі). Там, де в busy
// клієнту звучало «лінія зайнята», відповідає ШІ: менеджер не взяв / зайнятий / «2» / без «1» / поклав, а також у
// неробочий час (config.workHours, aiAfterHours) — тоді менеджеру не дзвонимо зовсім. Відкладений передзвін
// зберігається одразу, як у busy (менеджер пропустив дзвінок). Привітання, якщо грає, догрує; утримання грає, доки ШІ не
// заговорить; пошук клієнта чекаємо не довше AI_INFO_WAIT_MS. Сесія: send(ai.start()) — рушій пускає звук ноги A в сокет
// мозку (audio_start). Інструменти моделі виконує сценарій (aiTool): get_request_status — з уже знайденого пошуку за
// правилами приватності (aiprompt.mjs); save_question_for_manager — питання в запис передзвону (note; callback:false —
// запис знято, і ця відмова тримається: ні «лінія зайнята, менеджер передзвонить», ні нового запису, поки клієнт сам не
// попросить менеджера); transfer_to_manager — лише в робочий час і не більше aiTransferMax разів за дзвінок (і з
// повторної сесії transfer_failed): сесію закрито (не платимо за тишу), той самий шлях, що з менеджером уперше (набір
// із повторами — свій ліміт VG_DIAL_RETRIES на раунд, утримання, картка з питанням клієнта, «1», REFER/Replaces); не
// вийшло — передзвін знову (якщо клієнт відмовлявся: він же просив менеджера) і нова сесія ШІ (kind transfer_failed);
// end_call — відбій, коли прощальну фразу дограно. Підсумки: ai_noted (питання записано), ai_answered (без питання),
// ai_client_hangup (клієнт поклав, питання немає), connected (через ШІ — ai.transfers); ШІ не вдався (помилка
// провайдера / рушія) — як busy: «лінія зайнята», busy_callback з ai.error (клієнт відмовився від передзвону — просто
// відбій, ai_noted). Сокет звуку закрився (engine_closed) або провайдер упав (ai_error) — найчастіше це клієнт поклав, а
// DISCONNECTED ноги A приходить трохи пізніше: чекаємо його AI_DOWN_GRACE_MS, і лише якщо A жива — «ШІ не вдався».
// Менеджер передзвонює, поки клієнт говорить із ШІ, — prompts.cbClientBusy менеджеру («передзвоніть за хвилину»),
// callback_no_answer з reason client_with_ai. Розшифровка — у entry.aiTranscript (gateway.mjs зберігає окремо, у журнал
// не пише).
//
// ШІ ОДРАЗУ (answerMode 'ai', VG_ANSWER_MODE=ai; черга A записки ai-first-discussion-join-2026-10-17; без нових змінних
// усе рівно як вище). Дзвінок клієнта: answer → фаза route: вступ 80 (prompts.intro, тег 'intro'; немає — без вступу),
// під нього пошук клієнта (без синтезу картки); рішення — коли вступ догра і дані готові, але не пізніше кінця вступу +
// routeDecideGraceMs (без вступу — AI_INFO_WAIT_MS від відповіді); журнал route {branch, why, dataMs, decidedBy}.
// Неробочий час — ШІ after_hours, як і раніше; інакше ШІ kind 'first' (перша фраза за даними: є відкрита заявка /
// немає / пошук не встиг), без утримання перед ним і БЕЗ перезвону на старті: перезвін ставить save_question_for_manager,
// невдале з'єднання (transfer_failed) або відбій клієнта під час набору менеджера (missed). transfer_to_manager дозволено
// з першої сесії (правила 20/21 — в інструкціях моделі, VG_AI_FIRST_TRANSFER), той самий шлях набору, «1», REFER; поки
// дзвонимо — гудки (holdTone ringback) або 05-hold. ШІ не піднявся, а менеджеру в цьому дзвінку ще не дзвонили → фраза
// 82 (prompts.aiDown) → звичний набір менеджера з карткою і «1»; не взяв → busy_callback («зайнята» — лише після
// справжнього набору). Уночі ШІ не піднявся — менеджеру не дзвонимо, «зайнята» не кажемо: фраза 83 (prompts.aiDownNight,
// «неробочий час, менеджер передзвонить у робочий час»; перезвін after_hours уже стоїть) і відбій (ai_failed_callback).
// Пошук клієнта повернув null (у lookup.mjs це тайм-аут або помилка) — перша фраза «даних немає». Запобіжник (breaker від
// диспетчера): VG_AI_BREAKER збоїв ШІ за вікно → на час шлюз по-старому. Немає фабрики ШІ або рушій без звуку — старий
// режим.
//
// ВСТУП 80 І ЗАПИС (черга B, черновик сегментів 5а): 80 — перша фраза в УСІХ гілках answerMode ai (обговорення, ШІ, ШІ
// не піднявся, запобіжник: там 80, потім 82 замість старого 04-short), уночі повний варіант (prompts.intro), днём короткий
// (prompts.introShort), як у 00; у ньому оголошення про запис з метою. Поки 80 не догра — ні з'єднання з людиною (REFER
// чекає його кінця, фаза xferWait), ні мови ШІ. Не прозвучав — перші слова ШІ AI-FALLBACK-GREETING (aiprompt.mjs).
//
// ОБГОВОРЕННЯ (черга B, VG_DS_SOURCE; route.mjs). Після 80 фаза route чекає ще й обговорення: test — VG_DS_TEST; calls —
// останні дзвінки головної відкритої заявки (appCalls, бюджет dsCallsBudgetMs, не встигли — «обговорення немає»); field /
// auto — поле discussion заявки. routeFor: ніч з обговоренням — ШІ discussion_after_hours (перезвін ведучому, до 18:00
// наступного робочого дня); pending_call / пауза ведучого (staffState) / ведучий зайнятий іншим дзвінком шлюзу (staffBusy) /
// ключа немає в VG_MANAGERS — ШІ discussion_unavailable (ведучому не дзвонимо, пропуск не рахуємо, перезвін ведучому, а без
// ключа — у групу VG_MANAGER; В19: з'єднати з оператором — лише при претензії, гарантії чи небезпеці); інакше — гілка
// discussion: фраза 13/14/15 (тег 'ds'; немає 13/14 — 15; немає жодної — одразу гудки) і ОДНОЧАСНО набір ведучого
// (dsRingSec, повтори при 503, картка MGR-DS-CARD, «1»). Після фрази — гудки; клієнт чекає не довше dsMaxWaitSec. «1» під
// час фрази — REFER після її кінця (не пізніше dsXferWaitMs). Ведучий узяв — пропуски з нуля, перезвони знято, подія
// answered. Не взяв / «2» / без «1» / клієнт чекав довше — пропуск +1 (486 — ні), перезвін у групу ведучого, фраза 16
// (тег 'dsFailed', без відбою) → ШІ discussion_failed (повторно не з'єднує, VG_DS_AI_TRANSFER=0); ШІ недоступний — 17 і
// відбій (ds_callback). missMax пропусків поспіль — пауза pauseMin хв (далі discussion_unavailable з why paused). Клієнт
// поклав під час фрази чи гудків — пропущений перезвін ведучому, без пропуску. Ведучий передзвонив на 901, поки клієнт із
// ШІ чи поки шлюз дзвонить йому, — приєднання (як нижче). Події для сервера режиму — routeEvent (routeevents.mjs, типово
// вимкнено). Перезвін, поставлений у неробочий час, живе щонайменше до 18:00 наступного робочого дня (і в старому режимі).
//
// ПРИЄДНАННЯ МЕНЕДЖЕРА, що передзвонив (joinOnCallback, VG_JOIN_ON_CALLBACK=1). Менеджер (managerCaller без PIN)
// дзвонить на шлюз, а клієнт «чекає саме його» (рішення 16): фаза ai і перезвін у групі менеджера (цього дзвінка або ще
// з попереднього — у callbacks.json), або шлюз зараз набирає цього менеджера для нього. Двоє таких — той, кого цьому
// менеджеру набирали останнім, за рівності — хто чекає довше. Диспетчер віддає ногу менеджера сценарію клієнта
// (adoptManager, фаза joining): answer, набір цього менеджера скасовано, сесію ШІ закрито так, що запізнілі onEnd /
// transfer / end_call ігноруються; коли в нозі менеджера є звук — клієнту 81 (prompts.joinClient; привітання, якщо
// грає, догрує; немає 81 — гудки чи утримання, поки менеджер слухає фрази), менеджеру prompts.mgrJoin (клієнт говорив
// із ШІ; ні — prompts.mgrJoinPlain) і, якщо синтез устиг за JOIN_Q_WAIT_MS, «Питання клієнта: …» (без телефонів), «1»
// не питаємо → міст (bridge; joinMode 'refer' — REFER на нозі клієнта з Replaces ноги менеджера, не вдалося → міст).
// Підсумки: bridged_join / connected_join у клієнта, окремий рядок журналу менеджера callback_joined (onExtra);
// перезвони клієнта в групах обох менеджерів знято. Клієнт поклав під час приєднання (у т. ч. поки REFER приєднання без
// відповіді або не вдався) → менеджеру prompts.mgrJoinGone, відбій (callback_join_gone), перезвін лишається. Менеджер
// поклав до з'єднання → знову ШІ (transfer_failed з failedBy 'join': «менеджер не зміг продовжити розмову»). Клієнта
// вже з'єднують (card / confirm / transferring / bridged із цим менеджером або приєднання триває) → другому дзвінку
// менеджера prompts.mgrJoinBusy (callback_join_busy). Дзвінок менеджера, що приєднується, не рахується в maxCalls; для
// менеджерів межа maxCalls + 1. Прапорець вимкнено — передзвін, як і раніше.
//
// ПЕРЕДЗВІН (kind 'callback'): номер того, хто дзвонить, — із config.managers, порівнюємо ЦІЛКОМ (без підрядка).
// Це менеджер, а не клієнт: його не вважаємо клієнтом і йому ж не дзвонимо (захист від петлі). Внутрішня лінія
// (3–4 цифри без X-BINOTEL-GCID) — одразу передзвін. Зовнішній номер менеджера можна підробити: передзвін із нього —
// лише з managersExternal і managerPin (answer → prompts.pin → PIN цифрами DTMF за pinTimeoutSec; невірний / немає —
// відбій, callback_denied), інакше 486 (rejected, manager_external). Нога A — менеджер, нога B — клієнт. answer →
// prompts.cbConnecting («З'єднуємо з клієнтом.») → утримання; одразу набір клієнта: перший у черзі відкладених
// передзвонів групи менеджера (ще не пробувані — найсвіжіші першими, ті, хто вже не взяв, — у кінці), інакше його
// останній клієнт (без повторів, не довше callbackDialTimeoutSec; не частіше callbackMaxDialsPerDay за 24 год). Ціль
// ще на лінії шлюзу (дослуховує «лінія зайнята…») — менеджер на утриманні, чекаємо до callbackLineWaitSec; її вже
// набирає інший передзвін або вона говорить із ШІ — беремо наступну (інших немає, а перша з ШІ — prompts.cbClientBusy
// менеджеру, client_with_ai). Клієнт відповів → prompts.cbGreeting клієнту → xfer_replaces(A, B):
// REFER на нозі менеджера з Replaces ноги клієнта — та сама форма, що й перевірена A/B (callbackReferOn 'client' —
// навпаки: REFER на нозі клієнта з Replaces ноги менеджера) → connected_callback, відкладені передзвони цього клієнта
// в групи менеджера прибрано. Клієнт не взяв / зайнятий / 4xx/5xx / поклав → prompts.cbNoAnswer менеджеру, відбій,
// передзвін лишається, спроба +1 (callback_no_answer; після callbackMaxAttempts знімається). Передзвонювати нікому →
// prompts.cbNone, відбій (callback_none). Менеджер поклав, поки набираємо, — набір клієнта скасовуємо
// (callback_cancelled).
import { clientDialUri, isInternalKey, managerGroupOf, managerKeyOf, partyKey, resolveManagers, strictPhone } from './callbacks.mjs'
import { validPin } from './config.mjs'
import { requestStatusFor, stripVoiceTags, speakable, CALLBACK_PROMISE, LINK_MANAGER, LINK_ACCEPTED } from './aiprompt.mjs'
import { inHours, callbackUntilMs } from './hours.mjs'
import { hidePhones, dsCardText } from './card.mjs'
import { discussionFor, dsRequestFor, dsNeedsCalls, resolveLead, routeFor, dsJournal } from './route.mjs'

const ok2xx = (c) => Number(c) >= 200 && Number(c) < 300
const NO_ANSWER_MODES = ['busy', 'fallback', 'voicemail', 'ai']

// Внутрішній дзвінок — тризначний номер БЕЗ X-BINOTEL-GCID: дзвінки зі сценарію (клієнти, у т. ч. короткі
// номери операторів) Binotel завжди позначає GCID, внутрішні з 907 — ні.
export const isInternal = (n, gcid = null) => /^\d{3}$/.test(String(n ?? '').trim()) && !gcid
// Внутрішні — усі (або лише з allowedInternal, якщо список задано); інші — лише з allowedCallers (порівнюємо в E.164
// цілком: «+49380500000001» — не +380500000001).
export function isAllowed(number, allowedCallers = [], { gcid = null, allowedInternal = [] } = {}) {
  const n = String(number ?? '').trim()
  if (isInternal(n, gcid)) return !allowedInternal?.length || allowedInternal.map((x) => String(x).trim()).includes(n)
  const p = strictPhone(n)
  return !!p && (allowedCallers || []).map((x) => strictPhone(x)).includes(p)
}
export const callerAllowed = (incoming, config) =>
  isAllowed(incoming?.number, config.allowedCallers, { gcid: incoming?.gcid ?? null, allowedInternal: config.allowedInternal || [] })

// Список менеджерів конфігурації; немає — лише лінія менеджера з managerUri
const managersOf = (config) => config.managers || resolveManagers(config.managersSpec, config.managerUri)
// Хто з менеджерів дзвонить: {key, group, external} або null. Внутрішня лінія (3–4 цифри) — лише без X-BINOTEL-GCID
// (як isInternal: з GCID це дзвінок зі сценарію, тобто клієнт, у т. ч. з коротким номером оператора). Зовнішній номер —
// лише точний збіг (strictPhone). Чи приймати зовнішнього — externalCallbackOn.
export function managerCaller(incoming, config) {
  const k = partyKey(String(incoming?.number ?? '').trim())
  if (!k) return null
  const group = managerGroupOf(k, managersOf(config))
  if (!group) return null
  const external = !isInternalKey(k)
  if (!external && incoming?.gcid) return null
  return { key: group[0], group, external }
}
export const isManagerCaller = (incoming, config) => !!managerCaller(incoming, config)
// Передзвін із зовнішнього номера менеджера (його можна підробити) — лише з явним прапорцем і PIN
export const externalCallbackOn = (config) =>
  config.managersExternal === true && (validPin(config.managerPin) || config.managersExternalNoPin === true)
// Порівняння PIN без раннього виходу (час не підказує, скільки цифр уже правильні)
const pinEqual = (a, b) => {
  const x = String(a ?? '')
  const y = String(b ?? '')
  let d = x.length ^ y.length
  for (let i = 0; i < y.length; i++) d |= (x.charCodeAt(i) || 0) ^ y.charCodeAt(i)
  return d === 0 && y.length > 0
}

// Номер стороннього (не пропущеного) абонента в журналі й статусі — лише останні 4 цифри.
export const maskNumber = (n) => {
  const d = String(n ?? '').replace(/\D/g, '')
  return d ? `…${d.slice(-4)}` : null
}

// Мітки кроків у журналі для кожної сторони: менеджер — як і раніше, запасна — з префіксом fb, клієнт на передзвоні — cb.
const MARKS = {
  manager: { dial: 'dial', ringing: 'managerRinging', answered: 'managerAnswered', ready: 'managerReady', down: 'managerDown', card: 'card', cardDone: 'cardDone', confirm: 'confirm', confirmRepeat: 'confirmRepeat', digit: 'digit', xfer: 'xfer', xferAccepted: 'xferAccepted', xferFinal: 'xferFinal' },
  fallback: { dial: 'fbDial', ringing: 'fbRinging', answered: 'fbAnswered', ready: 'fbReady', down: 'fbDown', card: 'fbCard', cardDone: 'fbCardDone', confirm: 'fbConfirm', confirmRepeat: 'fbConfirmRepeat', digit: 'fbDigit', xfer: 'fbXfer', xferAccepted: 'fbXferAccepted', xferFinal: 'fbXferFinal' },
  client: { dial: 'cbDial', ringing: 'cbRinging', answered: 'cbAnswered', ready: 'cbReady', down: 'cbDown', card: 'cbGreeting', cardDone: 'cbGreetingDone', confirm: 'cbConfirm', confirmRepeat: 'cbConfirmRepeat', digit: 'cbDigit', xfer: 'xfer', xferAccepted: 'xferAccepted', xferFinal: 'xferFinal' },
}
// Рядки статусу (рос.) для кожної сторони
const WHO = {
  manager: { name: 'менеджер', call: 'звоню менеджеру', redial: 'повторный набор менеджера', to: 'менеджеру', noAnswer: 'менеджер не ответил', answered: 'менеджер ответил', with: 'с менеджером', down: 'менеджер положил трубку' },
  fallback: { name: 'запасная линия', call: 'звоню на запасную линию', redial: 'повторный набор запасной линии', to: 'запасной линии', noAnswer: 'запасная линия не ответила', answered: 'запасная линия ответила', with: 'с запасной линией', down: 'запасная линия положила трубку' },
  client: { name: 'клиент', call: 'звоню клиенту', redial: 'повторный набор клиента', to: 'клиенту', noAnswer: 'клиент не ответил', answered: 'клиент ответил', with: 'с клиентом', down: 'клиент положил трубку' },
}
// Таймери етапу дзвінка стороні B — скасовуємо всі, коли переходимо до наступної сторони, пошти чи останньої фрази
const STAGE_TIMERS = ['dial', 'ring', 'stageCap', 'graceB', 'tts', 'cardCap', 'afterCard', 'confirm', 'xfer', 'bothDown', 'bridgeCap', 'cbWait']
const VM_PROMPT_MAX_MS = 30000 // play_done фрази пошти не прийшов — сигнал усе одно
const VM_BEEP_MAX_MS = 3000
const VM_DONE_WAIT_MS = 3000 // record_done після зупинки запису не прийшов — завершуємо без нього
const PROMPT_MAX_MS = 30000 // play_done фрази (підтвердження, «лінія зайнята»…) не прийшов — ідемо далі все одно
const NOTICE_CAP_MS = 60000 // остання фраза: нога A так і не готова / фраза не скінчилась — кладемо все одно
const AI_INFO_WAIT_MS = 1500 // ШІ чекає результат пошуку клієнта не довше (бюджет пошуку — 1,2 с)
const AI_NOTE_MAX = 500 // питання клієнта в записі передзвону — не довше
// Сокет звуку ШІ закрився / провайдер упав, а нога A ще жива: стільки чекаємо її DISCONNECTED (сокет і рядки stdout
// рушія — різні канали, і закриття сокета, коли клієнт поклав, часто приходить раніше за 'state DISCONNECTED')
const AI_DOWN_GRACE_MS = 500
const ROUTE_CAP_MS = 30000 // фаза route: вступ так і не догравали (нога A не готова, play_done загубився) — вирішуємо все одно
const JOIN_ACK_MS = 8000 // приєднання: нога менеджера після answer так і не CONFIRMED — як поклав
const JOIN_CAP_MS = 20000 // приєднання: фрази не скінчились за стільки — з'єднуємо все одно
const JOIN_Q_WAIT_MS = 2000 // питання клієнта менеджеру — лише якщо синтез готовий за стільки від приєднання
const JOIN_TIMERS = ['joinAck', 'joinCap', 'joinGrace', 'joinClient', 'joinMgr', 'joinQ', 'joinGreeting']
const INTRO_XFER_WAIT_MS = 15000 // «1» під час вступу 80 (запобіжник): REFER після нього, але не пізніше
const SUMMARY_MAX = 150 // резюме для менеджера, що приєднується (MGR-JOIN), — коротке, без телефонів
const TIMEOUT = Symbol('timeout')
const AI_KINDS = ['first', 'after_hours', 'discussion_failed', 'discussion_unavailable', 'discussion_after_hours']
// Резюме звернення для MGR-JOIN: без телефонів, ≤ SUMMARY_MAX знаків по межі слова, без розділового знака в кінці
export const joinSummary = (q) => {
  let t = hidePhones(String(q ?? '')).replace(/\s+/g, ' ').trim()
  if (t.length > SUMMARY_MAX) {
    t = t.slice(0, SUMMARY_MAX)
    const i = t.lastIndexOf(' ')
    if (i > SUMMARY_MAX / 2) t = t.slice(0, i)
  }
  return t.replace(/[\s.,;:!?…—–-]+$/, '')
}

// Запобіжник ШІ (режим «ШІ одразу»): fails збоїв за windowMs → offMs шлюз працює по-старому (спершу менеджер). Спільний
// для всіх дзвінків — його тримає диспетчер.
export function makeBreaker(spec, clock, log = () => {}) {
  if (!spec) return null
  const fails = []
  let openUntil = 0
  return {
    get open() { return clock.now() < openUntil },
    fail(why) {
      const now = clock.now()
      fails.push(now)
      while (fails.length && now - fails[0] > spec.windowMs) fails.shift()
      if (fails.length < spec.fails || now < openUntil) return false
      openUntil = now + spec.offMs
      fails.length = 0
      log(`предохранитель ИИ: ${spec.fails} сбоя за ${Math.round(spec.windowMs / 60000)} мин (последний — ${why}) — ${Math.round(spec.offMs / 60000)} мин шлюз работает по-старому (сначала менеджер)`)
      return true
    },
  }
}

// Черга B: staffState — пропуски й пауза ведучих (staffstate.mjs); staffBusy(group) — чи ведучий зараз на іншому дзвінку
// шлюзу (дає диспетчер); appCalls(srId) → дзвінки заявки | null (lookup.mjs recentAppCalls); routeEvent(e) — подія для
// сервера режиму обговорення (routeevents.mjs; null — вимкнено)
export function createFlow({ incoming, config, send, clock, lookup = null, buildCard, tts = null, voicemailPath = null, callbacks = null, partyBusy = null, ai = null, log = () => {}, onDone = () => {}, onExtra = () => {}, rejectReason = null, breaker = null, joinBusy = false, staffState = null, staffBusy = null, appCalls = null, routeEvent = null, resendLink = null }) {
  const A = incoming.call
  const number = String(incoming.number ?? '').trim()
  const gcid = incoming.gcid ?? null
  const internal = isInternal(number, gcid)
  const managers = managersOf(config)
  // Дзвонить менеджер — це передзвін клієнту, а не новий клієнт (і менеджера йому ж самому не набираємо)
  const mc = managerCaller(incoming, config)
  const callerManager = mc?.key ?? null
  const callerGroup = mc?.group ?? null
  const kind = mc ? 'callback' : 'client'
  const callback = kind === 'callback'
  // Зовнішній номер менеджера без VG_MANAGERS_EXTERNAL=1 і PIN — 486: не передзвін (номер міг бути підроблений) і не
  // клієнт (інакше шлюз набрав би менеджера йому ж самому)
  const externalDenied = !!mc?.external && !externalCallbackOn(config)
  const pinRequired = !!mc?.external && !externalDenied && validPin(config.managerPin) // nopin — без PIN
  const allowed = callback ? !externalDenied : callerAllowed(incoming, config) // менеджери — завжди (зовнішні — з PIN)
  const phone = internal ? null : strictPhone(number)
  // Чужий номер (його відхиляємо) у статус і журнал — лише маскою
  const shownNumber = allowed ? phone || number || null : maskNumber(phone || number)
  const who = callback ? `${shownNumber || 'менеджер'}, перезвон` : shownNumber || 'без номера'
  // Номер клієнта на передзвоні: повністю — лише тестовий з allowedCallers, інакше маскою (як для відхилених)
  const clientShown = (n) => (isAllowed(n, config.allowedCallers) ? strictPhone(n) || n : maskNumber(n))
  const t0 = clock.now()
  const fallbackMode = config.fallbackMode === 'blind' ? 'blind' : 'consult'
  const noAnswerMode = NO_ANSWER_MODES.includes(config.noAnswerMode) ? config.noAnswerMode : 'busy'
  // Підтвердження «1» — у дзвінку клієнта завжди, якщо його не вимкнено явно (VG_CONFIRM=0). Рушій без DTMF цифр не
  // повідомить — тоді «не підтвердив», а не переведення наосліп (gateway.mjs з таким рушієм і не стартує).
  const confirmOn = !callback && config.confirmEnabled !== false
  const prompt = (name) => config.prompts?.[name] || null
  // Під цим ключем — відкладені передзвони і «останній клієнт» менеджера, якому дзвонимо; шукаємо — за всією групою.
  // Типово — лінія менеджера (загальна група, «оператор»); у гілці обговорення — ведучий (setTarget)
  const opKey = managerKeyOf(config.managerUri, managers) || partyKey(config.managerUri)
  const opGroup = managerGroupOf(config.managerUri, managers) || (opKey ? [opKey] : [])
  let mgrKey = opKey
  let mgrGroup = opGroup
  const referOnClient = callback && config.callbackReferOn === 'client'
  const targets = {
    manager: { uri: config.managerUri, timeoutSec: config.managerTimeoutSec, prefix: 'mgr', retry: true },
    fallback: { uri: config.fallbackUri || '', timeoutSec: config.fallbackTimeoutSec ?? 20, prefix: 'fb', retry: true },
    client: { uri: null, timeoutSec: config.callbackDialTimeoutSec ?? 30, prefix: 'cb', retry: false },
  }
  const greetTag = callback ? 'cbConnecting' : 'greeting'
  const cardTag = callback ? 'cbGreeting' : 'card'

  let phase = 'new' // new → (pin) → dialing → card → confirm → transferring → connected | bridged | voicemail | notice | fallback (blind) → done
  let target = callback ? 'client' : 'manager' // кому зараз дзвонимо: manager → fallback; на передзвоні — client
  let stageAt = null // clock.now() першого набору поточної сторони
  let done = false
  let outcome = null
  let reason = null // чому не вийшло з менеджером (на передзвоні — з клієнтом; або card_cap / bridge_cap на цьому етапі)
  let fallbackReason = null // те саме для запасної
  let abortReason = null // дзвінок обірвано ззовні: shutdown (зупинка шлюзу) або engine_exit (рушій упав)
  let answeredBy = null
  const marks = {} // крок → мс від вхідного
  const errors = []
  const dials = []
  const dialByCall = new Map() // виклик рушія → запис у dials: код розриву ноги, від якої вже відмовились (487 після CANCEL)
  const retries = { manager: 0, fallback: 0, client: 0 } // повтори поточного раунду набору сторони
  let retriesBefore = 0 // повтори менеджера в попередніх раундах (до наборів на запит ШІ) — у журнал разом із поточними
  const bCodes = { manager: null, fallback: null, client: null } // код розриву ноги B кожної сторони
  const timers = new Set()
  // gone — рушій закрив потік звуку A через її розрив (audio closed, reason hangup; рушій шле його за 'state
  // DISCONNECTED', тож це страховка): команд на A уже не шлемо
  const legA = { call: A, confirmed: false, media: false, grace: false, down: false, gone: false, code: null }
  let legB = null
  let pendingRef = null
  const abandoned = new Set() // ref наборів, які вже не потрібні: запізнілий 'dialing' → одразу кладемо
  let greeting = 'none' // none | playing | done | off (режим «ШІ одразу» — привітання немає)
  let holdOn = false
  let cardStarted = false
  let cardPlaying = false
  let cardSource = null
  let fbCardSource = null
  let cardChars = null
  let cardText = null
  let category = null
  let serviceRequestId = null
  let lookupState = lookup && phone && !callback ? 'pending' : 'off'
  let infoDone = false // текст картки (і заявка) вже відомі
  let infoResolve = () => {}
  const infoP = new Promise((r) => { infoResolve = r })
  let xferCode = null
  let xferFinalCode = null
  let xferAccepted = false // REFER/Replaces прийнято (202 або NOTIFY 1xx)
  let fbAccepted = false // blind: сліпий REFER на запасну прийнято
  let vm = null // голосова пошта: {state: wait|prompt|beep|rec|stopping|done, file, sec, stop, empty}
  let confirm = null // підтвердження поточної сторони: {plays, state: prompt|wait, digit}
  const confirms = {} // сторона → {plays, digit}: у журнал
  let ntc = null // остання фраза на A перед відбоєм: {name, state: wait|playing|done}
  // busy / ai: відкладений передзвін {managerKey, stored, id, why, missed?, removed? — клієнт відмовився (ШІ, callback:false),
  // restored? — поставлено знову після невдалого з'єднання на запит ШІ}
  let pendingCb = null
  let lastClientFor = null // ключ менеджера, якому клієнта записано «останнім»
  let cb = null // передзвін: {managerKey, source: pending|last|null, id, number, gcid, serviceRequestId, removed, attempts, dropped, waitedMs}
  let pin = null // зовнішній менеджер: {state: wait|prompt|entry|ok|fail, buf, result: ok|wrong|timeout}
  let cbWaitFrom = null // передзвін: з якого моменту чекаємо, поки ціль покладе трубку на іншому дзвінку шлюзу
  let cbWaitNumber = null // кого чекаємо (інші передзвони його не беруть)
  let cbDialNumber = null // кого набираємо на передзвоні (інші передзвони його не беруть)
  let cbSettled = false // після очікування — ще 1 с, щоб АТС закінчила попередній дзвінок
  let pendingRemoved = null // скільки відкладених передзвонів клієнта знято, коли його з'єднали
  let servedDone = false
  let xferLeg = A // на якій нозі REFER (на передзвоні з callbackReferOn 'client' — на нозі клієнта)
  let cardP = Promise.resolve(null)
  let lookupRes = null // результат пошуку клієнта (для інструмента ШІ «стан заявки»)
  // ШІ: aiInfo — {kind, why (причина першого раунду), state: wait|live|ending|done, note, transfers, sessions[], endReason,
  // failed, firstRetries, firstXferCode}; aiS — поточна сесія (ending — сесія скінчилась, чекаємо DISCONNECTED A);
  // aiRound — скільки разів ШІ передавав клієнта менеджеру (набір за запитом моделі)
  let aiInfo = null
  let aiS = null
  let aiRound = 0
  let afterHoursUrgent = false
  let resendP = null
  let resendAccepted = false
  // «ШІ одразу»: v2 — цей дзвінок іде в новому режимі (вирішується на старті: answerMode ai, ШІ доступний, запобіжник
  // закритий); route — рішення фази route (у журнал); intro — вступ 80: none | wait | playing | done | failed (рушій не
  // зіграв); aiDownRound — набір менеджера після 82 (ШІ не піднявся); aiDownPlay — фраза 82: playing | done
  let v2 = false
  let route = null
  let intro = 'none'
  let aiDownRound = false
  let aiDownPlay = null
  // Приєднання менеджера, що передзвонив: join — поточне (або останнє) {call, key, group, fromPhase, at, mode, state,
  // result, client, mgr, q, qFile, entryDone, marks}; joinsCount — скільки разів приєднували за дзвінок
  let join = null
  let joinsCount = 0
  // Черга B. ds — обговорення (route.mjs) з ведучим ds.lead; dsWhy — чому його немає / чому ведучому не дзвонили; dsDone —
  // дані обговорення готові (або не потрібні); dsLate — рішення вже без них; dsRound — зараз дзвонимо ведучому; dsPlay —
  // фраза 13/14/15 на A: wait | playing | done; dsPhrase — яка (dsTalked | dsCalled | dsGeneral | none); dsResult — {miss,
  // why, misses, paused}; dsServed — ведучий узяв (пропуски скинуто); xferGate — «1» натиснуто, REFER чекає кінця фрази;
  // pre — проміжна фраза без відбою {name, then, state}; greetIntro — замість 04-short грає 80 (запобіжник); classicDown — після
  // 80 прозвучала 82; routeSent — надіслані події route-event
  const dsOn = config.answerMode === 'ai' && !!config.dsSource && config.dsSource !== 'off'
  let ds = null
  let dsWhy = null
  let dsDone = !dsOn
  let dsLate = false
  let dsRound = false
  let dsPlay = null
  let dsPhrase = null
  let dsResult = null
  let dsServed = false
  let xferGate = null
  let pre = null
  let greetIntro = false
  let classicDown = false
  const routeSent = []
  const tm = {} // іменовані таймери

  const mark = (k) => { if (marks[k] == null) marks[k] = clock.now() - t0 }
  const markT = (k) => mark(MARKS[target][k])
  const W = () => WHO[target]
  const aName = callback ? 'менеджер' : 'клиент' // хто на нозі A
  const setReason = (why) => { if (target === 'fallback') fallbackReason = why; else reason = why }
  // Підсумок для сторони, що відповіла: connected → connected_fallback / connected_callback, bridged → bridged_… тощо
  // (приєднаний менеджер — …_join)
  const won = (base) => (callback ? base.replace(/^(connected|bridged)/, '$1_callback') : legB?.join ? base.replace(/^(connected|bridged)/, '$1_join') : target === 'fallback' ? base.replace(/^(connected|bridged)/, '$1_fallback') : base)
  const err = (where, msg) => { errors.push({ at: clock.now() - t0, where, msg: String(msg ?? '').slice(0, 200) }) }
  const later = (name, ms, fn) => {
    cancel(name)
    const h = clock.setTimeout(() => {
      timers.delete(h)
      if (tm[name] === h) delete tm[name]
      if (!done) fn()
    }, ms)
    timers.add(h)
    tm[name] = h
    return h
  }
  const cancel = (name) => {
    const h = tm[name]
    if (h == null) return
    clock.clearTimeout(h)
    timers.delete(h)
    delete tm[name]
  }
  const say = (msg) => log(`[${who}] ${msg}`)
  const hangup = (call, code) => send(code ? { cmd: 'hangup', call, code } : { cmd: 'hangup', call })
  const bAlive = () => !!legB && !legB.down
  const legReady = (leg) => leg.confirmed && (leg.media || leg.grace)
  // На A вже не граємо привітання/утримання: розмова, пошта, остання фраза або дзвінок скінчився
  const clientBusy = () => phase === 'bridged' || phase === 'connected' || phase === 'voicemail' || phase === 'notice' || phase === 'ai' || phase === 'done' ||
    phase === 'route' || phase === 'joining' || phase === 'joinGone' || phase === 'prelude' || phase === 'xferWait'
  // Що грати клієнту, поки дзвонимо менеджеру: гудки (VG_HOLD_TONE=ringback) — у нових гілках (набір на прохання ШІ, після
  // 82, у тому числі після 80 + 82 запобіжника), інакше — звичне утримання. Ведучому в обговоренні — завжди гудки, якщо файл є
  const holdFileNow = () => (config.ringbackFile && (dsRound || (config.holdTone === 'ringback' && (aiRound > 0 || aiDownRound || classicDown))) ? config.ringbackFile : config.holdFile)
  // Неробочий час за розкладом (для варіанта фраз: уночі повний, днём короткий — як у 00)
  const nightNow = () => !!config.workHours?.length && !inHours(config.workHours, new Date(clock.now()), config.timeZone || 'Europe/Kyiv')
  // Клієнтська фраза з двома варіантами: name — повний (уночі), nameShort — короткий (днём); є лише один — граємо його
  const pickVariant = (name) => (name ? (nightNow() ? prompt(name) || prompt(`${name}Short`) : prompt(`${name}Short`) || prompt(name)) : null)
  // Ціль набору: ведучий обговорення (setTarget) або знову загальна група (setOperator)
  const setTarget = ({ uri, key, group, timeoutSec }) => {
    targets.manager.uri = uri
    targets.manager.timeoutSec = timeoutSec ?? config.managerTimeoutSec
    mgrKey = key
    mgrGroup = group
  }
  const setOperator = () => setTarget({ uri: config.managerUri, key: opKey, group: opGroup, timeoutSec: config.managerTimeoutSec })
  // Клієнт прямо відмовився від передзвону (save_question_for_manager callback:false), і передзвону зараз немає
  const callbackRefused = () => !pendingCb?.stored && (!!pendingCb?.removed || aiInfo?.note?.callback === false)

  // ---------- старт ----------

  function start() {
    if (rejectReason || !allowed) {
      reason = rejectReason || (externalDenied ? 'manager_external' : 'not_allowed')
      hangup(A, 486)
      outcome = 'rejected'
      say(rejectReason === 'busy'
        ? 'отклонён (486): уже идёт максимум звонков'
        : externalDenied
          ? 'отклонён (486): внешний номер менеджера — перезвон с него только с VG_MANAGERS_EXTERNAL=1 и VG_MANAGER_PIN'
          : 'отклонён (486): номера нет в списке разрешённых')
      return finish()
    }
    send({ cmd: 'answer', call: A, code: 200 })
    mark('answer')
    if (pinRequired) return startPin()
    if (joinBusy) {
      // Другий дзвінок менеджера, поки клієнта вже з'єднують (чи приєднують): коротко сказати й покласти
      reason = 'join_busy'
      say('менеджер перезванивает, а клиента уже соединяют — сообщаю и кладу трубку')
      return notice('mgrJoinBusy', 'callback_join_busy')
    }
    if (!callback && config.answerMode === 'ai') {
      v2 = true
      return startRoute()
    }
    // Режим ai задано, але ШІ немає або спрацював запобіжник — старий режим (у журнал — чому)
    if (!callback && config.answerMode === 'ai') route = { branch: 'classic', why: breaker?.open && aiReady() ? 'breaker' : 'no_ai', dataMs: null, decidedBy: null }
    if (!callback && aiAfterHours()) {
      say('принят, нерабочее время — отвечает ИИ')
      cardP = prepareCard({ synth: false })
      return startAi('after_hours')
    }
    phase = 'dialing'
    if (callback) return startCallback()
    say('принят, отвечаю')
    cardP = prepareCard()
    later('dial', config.dialDelayMs, dial)
  }

  // ШІ доступний: режим ai, фабрика сесій є і може дати сесію (ai.available() — рушій зі звуком до мозку; немає методу —
  // так), це дзвінок клієнта і ШІ в цьому дзвінку ще не відмовив. Недоступний — усе як busy (і вночі набір менеджера).
  const aiReady = () => !!ai && ai.available?.() !== false && !callback && !aiInfo?.failed
  const aiOn = () => noAnswerMode === 'ai' && aiReady()
  // «ШІ одразу»: режим задано, ШІ доступний і запобіжник не спрацював
  const firstOn = () => config.answerMode === 'ai' && aiReady() && !breaker?.open
  // Неробочий час (VG_WORK_HOURS) і ШІ відповідає в неробочий час — менеджеру не дзвонимо
  const aiAfterHours = () => (aiOn() || v2) && config.aiAfterHours !== false && !!config.workHours?.length &&
    !inHours(config.workHours, new Date(clock.now()), config.timeZone || 'Europe/Kyiv')

  // ---------- «ШІ одразу»: фаза route — вступ 80, пошук клієнта під нього, рішення ----------

  function startRoute() {
    phase = 'route'
    greeting = 'off' // старе привітання в цьому режимі не звучить ніколи (і коли нога A стане готова вже після рішення)
    route = { branch: null, why: null, dataMs: null, decidedBy: null }
    mark('route')
    say('принят, режим «ИИ сразу»')
    cardP = prepareCard({ synth: false }) // картку синтезуємо, лише коли справді дзвонитимемо менеджеру
    infoP.then(() => maybeDecide())
    loadDiscussion()
    intro = pickVariant('intro') ? 'wait' : 'none'
    // без вступу дані чекаємо AI_INFO_WAIT_MS від відповіді (з дзвінками заявки — ще їх бюджет)
    if (intro === 'none') later('routeData', AI_INFO_WAIT_MS + (dsOn && ['calls', 'auto'].includes(config.dsSource) ? Math.max(0, Number(config.dsCallsBudgetMs ?? 600) || 0) : 0), () => decide('timeout'))
    later('routeCap', ROUTE_CAP_MS, () => (intro === 'playing' || intro === 'wait' ? introFailedClosed() : decide('cap')))
    maybeIntro()
  }

  function maybeIntro() {
    if (phase !== 'route' || intro !== 'wait' || legA.down || !legReady(legA)) return
    intro = 'playing'
    send({ cmd: 'play', call: A, file: pickVariant('intro'), loop: false, tag: 'intro' })
    mark('intro')
  }

  // Обговорення (VG_DS_SOURCE): після пошуку клієнта — дзвінки головної відкритої заявки (лише calls / auto без поля),
  // не довше dsCallsBudgetMs; далі route.mjs. Рішення вже прийняте без них (dsLate) — результат ігноруємо.
  function loadDiscussion() {
    if (!dsOn) return
    infoP.then(async () => {
      const sr = dsRequestFor(lookupState === 'ok' ? lookupRes : null, clock.now())
      let calls = null
      if (dsNeedsCalls(config, sr) && appCalls) {
        const budget = Math.max(0, Number(config.dsCallsBudgetMs ?? 600) || 0)
        calls = await Promise.race([
          Promise.resolve().then(() => appCalls(sr.id)).catch((e) => { err('ds_calls', e?.message); return null }),
          new Promise((resolve) => { later('dsCalls', budget, () => resolve(TIMEOUT)) }),
        ])
        cancel('dsCalls')
        if (calls === TIMEOUT) {
          calls = null
          err('ds_calls', `timeout ${budget} ms`)
        }
        mark('dsCallsDone')
      }
      if (done || dsLate) return
      const r = discussionFor({ lookup: lookupState === 'ok' ? lookupRes : null, appCalls: calls, phone, nowMs: clock.now(), config })
      ds = r.ds
      dsWhy = r.why
      if (ds) ds.lead = resolveLead({ ds, config, managers })
      dsDone = true
      mark('dsDone')
      maybeDecide()
    })
  }

  // failed — рушій не зміг зіграти вступ (файл пошкоджений / недоступний): клієнт його не чув, тож ШІ почне з «Вітаю! Це
  // віртуальний помічник Runferry…», а не з «Я віртуальний помічник…» (intro 'failed', у сесію — intro: false)
  function onIntroDone(failed = false) {
    if (phase !== 'route' || intro !== 'playing') return
    intro = failed ? 'failed' : 'done'
    mark(failed ? 'introFailed' : 'introDone')
    if (infoDone && dsDone) return decide('data')
    later('routeData', Math.max(0, Number(config.routeDecideGraceMs ?? 1000) || 0), () => decide('timeout'))
  }

  function maybeDecide() {
    if (phase !== 'route' || intro === 'wait' || intro === 'playing' || !infoDone || !dsDone) return
    decide('data')
  }

  // Гілка (рішення 2 і п. 3 записки; route.mjs routeFor): неробочий час — after_hours (з обговоренням —
  // discussion_after_hours); обговорення — discussion або discussion_unavailable; інакше ШІ first із першою фразою за даними
  function decide(by) {
    if (phase !== 'route' || done) return
    cancel('routeData')
    cancel('routeCap')
    cancel('dsCalls')
    route.decidedBy = by
    route.dataMs = infoDone ? marks.lookupDone ?? null : null
    if (!dsDone) {
      // дзвінки заявки не встигли до рішення — «обговорення немає» (п. 3: дані не встигли)
      dsDone = true
      dsLate = true
      ds = null
      dsWhy = 'timeout'
    }
    const lead = ds?.lead ?? null
    // Запобіжник і відсутній провайдер теж проходять 80; уночі людям не дзвонимо.
    if (!firstOn() && (!ds || breaker?.open)) {
      route.branch = 'classic'
      route.why = breaker?.open && aiReady() ? 'breaker' : 'no_ai'
      if (intro !== 'done') return introFailedClosed()
      if (nightNow() && config.aiAfterHours !== false) {
        if (ds) dsCallbackTarget()
        savePending()
        return notice(pendingCb?.stored ? 'aiDownNight' : null, 'ai_failed_callback')
      }
      return aiDownConnect(route.why)
    }
    // Без 80 клієнт спершу має почути AI-FALLBACK-GREETING; прямий набір ведучого не починаємо.
    if (ds && intro !== 'done') {
      route.branch = nightNow() ? 'discussion_after_hours' : 'discussion_unavailable'
      route.why = 'recording_notice_missing'
      dsCallbackTarget()
      return startAi(route.branch)
    }
    const paused = !!lead?.key && (isPaused(lead.key) || (ds.suspendedUntil != null && ds.suspendedUntil > clock.now()))
    const busy = !!lead?.group && !!staffBusy?.(lead.group)
    const r = routeFor({ afterHours: aiAfterHours(), ds, lead, paused, busy })
    if (r.branch === 'after_hours') {
      route.branch = 'after_hours'
      say('нерабочее время — отвечает ИИ')
      return startAi('after_hours')
    }
    if (r.branch === 'discussion_after_hours' || r.branch === 'discussion_unavailable') {
      route.branch = r.branch
      route.why = r.why
      dsCallbackTarget()
      say(r.branch === 'discussion_after_hours'
        ? `обсуждение, нерабочее время — отвечает ИИ, перезвон ${lead?.group ? 'ведущему' : 'в общую группу'}`
        : `обсуждение, ведущему не звоню (${{ pending_call: 'он сейчас звонит клиенту из приложения', paused: 'пауза после пропусков', owner_busy: 'он на другом звонке шлюза', no_key: 'неизвестно, кому звонить', not_in_managers: 'его нет в VG_MANAGERS', bad_uri: 'номер непригоден для набора' }[r.why] || r.why}) — отвечает ИИ`)
      return startAi(r.branch)
    }
    if (r.branch === 'discussion') {
      route.branch = 'discussion'
      return startDiscussion(r.opener)
    }
    // Даних немає: пошук не встиг, вимкнений або впав. lookup.mjs на тайм-аут і помилку відповідає null, а «номера немає в
    // базі» — це об'єкт із порожніми списками, тож null (lookupState 'none') — теж «даних немає», а не «заявки немає»
    const noData = !infoDone || ['error', 'off', 'pending', 'none'].includes(lookupState)
    const variant = noData ? 'nodata' : category === 'openRequest' ? 'request' : 'general'
    route.branch = 'ai_first'
    route.variant = variant
    if (variant === 'nodata') route.why = !infoDone ? 'timeout' : 'no_data'
    startAi('first', { variant })
  }

  // ---------- обговорення: фраза 13/14/15 і дзвінок ведучому (черга B) ----------

  const isPaused = (key) => {
    try {
      return !!staffState?.isPaused?.(key, { uid: ds?.lead?.uid ?? null })
    } catch (e) {
      err('staff', e?.message)
      return false
    }
  }
  // Перезвін у гілках ШІ з обговоренням — ведучому (ключ є в VG_MANAGERS), інакше загальній групі VG_MANAGER
  const dsCallbackTarget = () => (ds?.lead?.group ? setTarget({ uri: ds.lead.uri || config.managerUri, key: ds.lead.key, group: ds.lead.group, timeoutSec: config.managerTimeoutSec }) : setOperator())
  // Куди піде перезвін (для інструкцій ШІ): ведучому — 'lead', загальній групі — 'group' (тоді «я передам йому» — неправда)
  const callbackTo = () => (ds?.lead?.group && (pendingCb?.stored ? ds.lead.group.includes(pendingCb.managerKey) : ds.lead.group.includes(mgrKey)) ? 'lead' : 'group')
  // Фраза гілки: 13 talked / 14 called / 15 general; немає 13 чи 14 — 15; немає жодної — null (гудки)
  function dsPhraseFile(kind) {
    const name = { talked: 'dsTalked', called: 'dsCalled' }[kind] || 'dsGeneral'
    const f = pickVariant(name)
    if (f) return { name, file: f }
    const g = name !== 'dsGeneral' ? pickVariant('dsGeneral') : null
    return g ? { name: 'dsGeneral', file: g } : null
  }

  function startDiscussion(kind) {
    const lead = ds.lead
    setTarget({ uri: lead.uri, key: lead.key, group: lead.group, timeoutSec: Math.max(1, Number(config.dsRingSec) || 20) })
    dsRound = true
    target = 'manager'
    phase = 'dialing'
    stageAt = null
    legB = null
    cardStarted = false
    cardPlaying = false
    xferAccepted = false
    xferWaits = 0
    confirm = null
    mark('ds')
    cardP = prepareDsCard(kind)
    const f = dsPhraseFile(kind)
    dsPhrase = f?.name || 'none'
    dsPlay = f ? 'wait' : 'done'
    say(`обсуждение (${kind}${ds.source ? `, ${ds.source}` : ''}): ${f ? `фраза ${{ dsTalked: '13', dsCalled: '14', dsGeneral: '15' }[f.name]} и ` : 'фразы нет — гудки, '}звоню ведущему (${config.dsRingSec ?? 20} с)`)
    emitRoute('route')
    if (f) maybeDsPhrase()
    else {
      startHold()
      dsWaitStart()
    }
    dial() // одразу, одночасно з фразою (рішення 12): REFER — лише після її кінця
  }

  function maybeDsPhrase() {
    if (dsPlay !== 'wait' || legA.down || !legReady(legA)) return
    const f = dsPhraseFile(ds?.kind)
    if (!f) {
      dsPlay = 'done'
      return onDsPlayed(true)
    }
    dsPlay = 'playing'
    send({ cmd: 'play', call: A, file: f.file, loop: false, tag: 'ds' })
    mark('dsPhrase')
    later('dsPlay', PROMPT_MAX_MS, () => onDsPlayed())
  }

  // Фразу 13/14/15 дограно: «1» чекало — REFER; ведучий уже відмовив — 16; інакше гудки й відлік очікування клієнта
  function onDsPlayed(force = false) {
    if (!force && dsPlay !== 'playing') return
    dsPlay = 'done'
    cancel('dsPlay')
    mark('dsPhraseDone')
    if (xferGate?.gate === 'ds') return releaseXferGate()
    if (phase === 'prelude') return maybePre()
    if (phase === 'joining') return maybeJoinClient()
    if (dsRound && ['dialing', 'card', 'confirm'].includes(phase)) {
      startHold()
      dsWaitStart()
    }
  }

  // Клієнт після фрази чекає ведучого не довше dsMaxWaitSec — далі «не вдалося» (пропуск)
  function dsWaitStart() {
    if (!dsRound || tm.dsWait != null) return
    const sec = Math.max(1, Number(config.dsMaxWaitSec) || 30)
    later('dsWait', sec * 1000, () => {
      if (!dsRound || !['dialing', 'card', 'confirm'].includes(phase)) return
      say(`клиент ждёт ведущего после фразы дольше ${sec} с`)
      stageFailed('manager_ds_wait')
    })
  }

  // Картка ведучому: MGR-DS-CARD за причиною + «Заявка {номер}, {ім'я}» + brief.voice (поле обговорення)
  function prepareDsCard(kind) {
    return infoP.then(() => {
      const text = dsCardText({ kind, lookup: lookupRes, srId: ds?.srId || serviceRequestId, voice: ds?.voice })
      if (!tts || !text || done) return null
      return Promise.resolve().then(() => tts(text)).then((r) => (r && r.file ? r : null), (e) => {
        err('tts', e?.message)
        return null
      })
    })
  }

  // Ведучий не прийняв дзвінок: пропуск (крім 486 — зайнятий), перезвін у його групу, фраза 16 без відбою → ШІ
  // discussion_failed; ШІ недоступний — 17 і відбій. noMiss — ведучий приєднався й поклав (не пропуск).
  function dsFailed(why, { noMiss = false } = {}) {
    dsRound = false
    cancel('dsWait')
    // ведучий натиснув «1», а переведення технічно не вдалося, — він узяв, це не пропуск
    const confirmed = confirms.manager?.digit === String(config.confirmDigit ?? '1')
    const miss = !noMiss && !confirmed && !/_486$/.test(String(why))
    let st = null
    if (miss && staffState && ds?.lead?.key) {
      try {
        st = staffState.miss(ds.lead.key, { uid: ds.lead.uid ?? null })
      } catch (e) {
        err('staff', e?.message)
      }
    }
    dsResult = { miss, why, ...(st ? { misses: st.misses } : {}), ...(st?.paused ? { paused: true, pausedUntil: new Date(st.pausedUntil).toISOString() } : {}) }
    if (miss) emitRoute('fallback')
    if (!pendingCb?.stored && !callbackRefused()) savePending()
    say(`ведущий не принял звонок (${why})${miss ? ` — пропуск${st?.paused ? `, ${config.dsMissMax ?? 2} подряд: пауза ${config.dsPauseMin ?? 120} мин` : ''}` : noMiss ? '' : ' — занят, не пропуск'}${pendingCb?.stored ? ', перезвон ведущему сохранён' : ''}`)
    if (holdOn) {
      holdOn = false
      send({ cmd: 'stop', call: A })
    }
    prelude('dsFailed', () => (aiReady() ? startAi('discussion_failed') : notice(pendingCb?.stored ? 'dsNoAi' : null, 'ds_callback')))
  }

  // ---------- проміжна фраза без відбою (16 перед ШІ) ----------

  function prelude(name, then) {
    phase = 'prelude'
    pre = { name, then, state: 'wait' }
    mark('prelude')
    later('preCap', NOTICE_CAP_MS, preDone)
    maybePre()
  }

  function maybePre() {
    if (phase !== 'prelude' || pre?.state !== 'wait' || legA.down || !legReady(legA)) return
    if (dsPlay === 'playing') return // фразу 13/14/15 не обриваємо: onDsPlayed покличе знову
    if (holdOn) {
      holdOn = false
      send({ cmd: 'stop', call: A })
    }
    const f = pickVariant(pre.name)
    if (!f) return preDone()
    pre.state = 'playing'
    send({ cmd: 'play', call: A, file: f, loop: false, tag: pre.name })
    mark('preludePlay')
    later('pre', PROMPT_MAX_MS, preDone)
  }

  function preDone() {
    if (phase !== 'prelude' || !pre || pre.state === 'done') return
    pre.state = 'done'
    cancel('pre')
    cancel('preCap')
    mark('preludeDone')
    pre.then()
  }

  // ---------- REFER лише після фрази на A (80 / 13–15 / 82) ----------

  // Яка фраза на A зараз не дає з'єднати: фраза обговорення, вступ 80 замість привітання (запобіжник), 82
  const gateNow = () => (dsPlay === 'playing' ? 'ds' : greeting === 'playing' && greetIntro ? 'intro' : aiDownPlay === 'playing' ? 'aiDown' : null)

  function releaseXferGate() {
    if (!xferGate) return
    const why = xferGate.why
    xferGate = null
    cancel('xferGate')
    if (phase !== 'xferWait') return
    // межа очікування вийшла, а фраза ще грає (play_done загубився?) — зупиняємо її: далі REFER
    const still = gateNow()
    if (still === 'intro') return introFailedClosed()
    if (still) {
      if (still === 'ds') {
        dsPlay = 'done'
        cancel('dsPlay')
      } else if (still === 'aiDown') {
        aiDownPlay = 'done'
        cancel('aiDownPlay')
      } else greeting = 'done'
      if (!legA.down && !legA.gone) send({ cmd: 'stop', call: A })
    }
    phase = 'confirm'
    transfer(why, { force: true })
  }

  // Немає підтвердження, що 80 дограв: не починаємо записану розмову з людиною.
  function introFailedClosed() {
    outcome = 'intro_failed'
    reason = 'recording_notice_missing'
    say('вступление о записи не прозвучало полностью — завершаю звонок')
    if (pendingRef) { abandoned.add(pendingRef); pendingRef = null }
    clearLegs()
  }

  // ---------- події для сервера режиму обговорення (routeevents.mjs) ----------

  function emitRoute(event, o = {}) {
    if (!routeEvent) return
    const srId = o.srId !== undefined ? o.srId : ds?.srId ?? null
    if (!srId) return
    routeSent.push(event)
    try {
      routeEvent({ serviceRequestId: srId, generalCallID: gcid, event, ownerUid: o.ownerUid !== undefined ? o.ownerUid : ds?.lead?.uid ?? ds?.ownerUid ?? null, at: new Date(clock.now()).toISOString() })
    } catch (e) {
      err('route_event', e?.message)
    }
  }

  // Ведучий говорить із клієнтом (з'єднано чи приєднався): пропуски з нуля, подія answered / joined
  function leadServed() {
    if (dsServed || !ds?.lead?.group) return
    const grp = legB?.join && join ? join.group : mgrGroup
    if (!grp?.some((k) => ds.lead.group.includes(k))) return
    dsServed = true
    try {
      staffState?.answered?.(ds.lead.key, { uid: ds.lead.uid ?? null })
    } catch (e) {
      err('staff', e?.message)
    }
    emitRoute(legB?.join ? 'joined' : 'answered')
  }

  // uid співробітника за ключем менеджера (зворотний VG_DS_STAFF) — для події callback_connected
  const uidOfGroup = (group) => Object.entries(config.dsStaff || {}).find(([, k]) => group?.includes(k))?.[0] ?? null
  // UID стосується того, кому справді набираємо. Передзвін оператору / черговому не скидає паузу ведучого обговорення.
  const ownerUidForTarget = (key) => {
    if (!key) return null
    const group = managerGroupOf(key, managers) || [key]
    return ds?.lead?.group?.some((k) => group.includes(k)) ? ds.lead.uid ?? ds.ownerUid ?? null : uidOfGroup(group)
  }

  // Перезвін, поставлений у неробочий час (і з обіцянкою «у робочий час»), живе щонайменше до 18:00 наступного робочого дня
  const callbackUntil = () => callbackUntilMs(config.workHours, clock.now(), config.timeZone || 'Europe/Kyiv')

  // ---------- PIN менеджера, що передзвонює із зовнішнього номера ----------
  // Фраза prompts.pin (немає — мовчки) → цифри DTMF на нозі A; набрано стільки цифр, скільки в PIN, або «#» —
  // перевіряємо; «*» — почати знову. Немає pinTimeoutSec після кінця фрази або невірний — відбій (callback_denied).
  // Цифри PIN не пишемо ніде (журнал — лише результат, траса рушія — без цифр DTMF).

  function startPin() {
    phase = 'pin'
    pin = { state: 'wait', buf: '', result: null }
    mark('pin')
    say('внешний номер менеджера — жду PIN')
    later('pinCap', Math.max(1, Number(config.pinTimeoutSec) || 10) * 1000 + PROMPT_MAX_MS, () => pinFailed('timeout')) // нога A так і не готова
    maybePin()
  }

  function maybePin() {
    if (phase !== 'pin' || !pin || pin.state !== 'wait' || legA.down || !legReady(legA)) return
    const file = prompt('pin')
    if (!file) return pinWait()
    pin.state = 'prompt'
    send({ cmd: 'play', call: A, file, loop: false, tag: 'pin' })
    mark('pinPrompt')
    later('pin', PROMPT_MAX_MS, pinWait) // play_done загубився
  }

  function pinWait() {
    if (phase !== 'pin' || !pin || (pin.state !== 'wait' && pin.state !== 'prompt')) return
    pin.state = 'entry'
    later('pin', Math.max(1, Number(config.pinTimeoutSec) || 10) * 1000, () => pinFailed('timeout'))
  }

  function onPinDigit(d) {
    if (phase !== 'pin' || !pin || !d) return
    if (d === '*') { pin.buf = ''; return }
    const want = String(config.managerPin ?? '')
    if (d !== '#') pin.buf += d
    if (d !== '#' && pin.buf.length < want.length) return
    if (pin.state === 'prompt') send({ cmd: 'stop', call: A }) // фразу не догравати
    if (pinEqual(pin.buf, want)) return pinOk()
    pinFailed('wrong')
  }

  function pinOk() {
    pin.state = 'ok'
    pin.result = 'ok'
    pin.buf = ''
    cancel('pin')
    cancel('pinCap')
    mark('pinOk')
    say('PIN верный — перезвон')
    phase = 'dialing'
    startCallback()
    maybeGreeting() // нога A вже готова: «З'єднуємо з клієнтом.» і утримання (якщо є кому дзвонити)
    maybeNotice()
  }

  function pinFailed(why) {
    if (phase !== 'pin' || !pin) return
    pin.state = 'fail'
    pin.result = why
    pin.buf = ''
    cancel('pin')
    cancel('pinCap')
    reason = `pin_${why}`
    outcome = 'callback_denied'
    say(why === 'wrong' ? 'неверный PIN — кладу трубку' : 'PIN не введён — кладу трубку')
    if (!legA.down) hangup(A)
    finish()
  }

  // Передзвін: кому дзвонимо — перший у черзі відкладених передзвонів групи менеджера, інакше його останній клієнт.
  // Не набираємо номер, який уже набирає інший передзвін, і понад ліміт наборів за 24 год; ціль ще на лінії шлюзу —
  // чекаємо (менеджер на утриманні), поки покладе, не довше callbackLineWaitSec, далі — наступна ціль. Ціль говорить із
  // ШІ (partyBusy 'ai') — розмова може тривати хвилини: не чекаємо, беремо наступну; інших немає — «Клієнт зараз
  // розмовляє з віртуальним помічником. Передзвоніть за хвилину.» (cbClientBusy), reason client_with_ai.
  function startCallback() {
    if (phase !== 'dialing' || legA.down) return
    const busy = (n) => (partyBusy ? partyBusy(n) : null)
    const capOk = (n) => {
      try {
        return !callbacks?.canDial || callbacks.canDial(n)
      } catch (e) {
        err('callbacks', e?.message)
        return true
      }
    }
    const pick = (skip) => {
      try {
        return callbacks ? callbacks.pickTarget(callerGroup, { skip }) : null
      } catch (e) {
        err('callbacks', e?.message)
        return null
      }
    }
    const top = pick(null) // перший у черзі без жодних обмежень — для причини, якщо набирати нікого
    let t = pick((n) => { const b = busy(n); return b === 'dialing' || b === 'ai' || !capOk(n) })
    if (t && busy(t.number) === 'line') {
      cbWaitFrom ??= clock.now()
      if (clock.now() - cbWaitFrom < Math.max(0, Number(config.callbackLineWaitSec ?? 15) || 0) * 1000) {
        if (cbWaitNumber == null) {
          mark('cbWait')
          say(`клиент ${clientShown(t.number)} ещё на линии шлюза — жду, пока положит трубку`)
        }
        cbWaitNumber = t.number
        later('cbWait', 500, startCallback)
        return
      }
      t = pick((n) => !!busy(n) || !capOk(n))
    }
    if (t && cbWaitFrom != null && !cbSettled) {
      // дочекались (або беремо іншу ціль): ще секунда, щоб АТС закінчила попередній дзвінок цього клієнта
      cbSettled = true
      cbWaitNumber = t.number
      later('cbWait', 1000, startCallback)
      return
    }
    cbWaitNumber = null
    cb = { managerKey: callerManager, source: t?.source ?? null, id: t?.id ?? null, number: t?.number ?? null, gcid: t?.gcid ?? null, serviceRequestId: t?.serviceRequestId ?? null, ownerUid: t?.ownerUid ?? null, removed: false, attempts: t?.attempts ?? null, dropped: false, waitedMs: cbWaitFrom != null ? clock.now() - cbWaitFrom : null }
    serviceRequestId = cb.serviceRequestId
    const uri = t ? clientDialUri(t.number, config.clientUriTemplate, config.sipServer) : null
    if (!uri) {
      if (t) reason = 'bad_number'
      else if (!top) reason = 'no_target'
      else if (busy(top.number) === 'line') reason = 'client_on_line'
      else if (busy(top.number) === 'ai') reason = 'client_with_ai'
      else if (!capOk(top.number)) reason = 'dial_cap'
      else reason = 'target_busy'
      if (!t && top) cb = { ...cb, source: top.source, id: top.id, number: top.number, gcid: top.gcid ?? null, serviceRequestId: top.serviceRequestId ?? null, ownerUid: top.ownerUid ?? null }
      say({
        bad_number: 'менеджер перезванивает, но номер клиента непригоден — сообщаю и кладу трубку',
        no_target: 'менеджер перезванивает, но ждущих клиентов нет — сообщаю и кладу трубку',
        client_on_line: `клиент всё ещё на линии шлюза (${config.callbackLineWaitSec ?? 15} с) — сообщаю менеджеру и кладу трубку`,
        client_with_ai: 'клиент сейчас говорит с ИИ — прошу менеджера перезвонить через минуту и кладу трубку',
        dial_cap: `клиенту уже звонили ${config.callbackMaxDialsPerDay} раз за сутки — больше не набираю`,
        target_busy: 'клиента уже набирает другой перезвон — сообщаю и кладу трубку',
      }[reason])
      // клієнт зайнятий на шлюзі (дослуховує фразу / говорить із ШІ) — спроба не рахується, передзвін лишається
      if (reason === 'client_on_line') return notice('cbNoAnswer', 'callback_no_answer')
      if (reason === 'client_with_ai') return notice('cbClientBusy', 'callback_no_answer')
      return notice('cbNone', 'callback_none')
    }
    targets.client.uri = uri
    cbDialNumber = t.number
    try {
      callbacks?.noteDial?.(t.number)
    } catch (e) {
      err('callbacks', e?.message)
    }
    say(`менеджер перезванивает: ${cb.source === 'pending' ? `клиент ждёт перезвона${cb.attempts ? ` (попыток уже ${cb.attempts})` : ''}` : 'последний клиент менеджера'} ${clientShown(cb.number)}`)
    const f = prompt('cbGreeting')
    cardP = Promise.resolve(f ? { file: f, cached: true } : null)
    dial() // одразу, без dialDelayMs: менеджер уже чекає
  }

  // Пошук → текст → синтез. Ніколи не відхиляється: будь-яка помилка → null (тоді genericCardFile або без картки).
  function prepareCard({ synth = true } = {}) {
    return (async () => {
      let res = null
      if (lookup && phone) {
        try {
          res = await lookup(phone)
          lookupState = res ? 'ok' : 'none'
        } catch (e) {
          lookupState = 'error'
          err('lookup', e?.message)
        }
        mark('lookupDone')
      }
      lookupRes = res
      let card = null
      try {
        card = buildCard(res, { number, phone, speakNumber: config.cardSpeakNumber === true })
      } catch (e) {
        err('card', e?.message)
      }
      category = card?.category ?? null
      serviceRequestId = card?.serviceRequestId ?? null
      cardText = card?.text ?? null
      cardChars = card?.text ? card.text.length : null
      infoDone = true
      infoResolve()
      if (!synth || !tts || !card?.text || done) return null // дзвінок уже скінчився (або ШІ вночі) — синтез не потрібен
      try {
        const r = await tts(card.text)
        mark('ttsDone')
        return r && r.file ? r : null
      } catch (e) {
        err('tts', e?.message)
        return null
      }
    })()
  }

  // ---------- нога A: привітання, утримання ----------

  function maybeGreeting() {
    if (phase === 'pin' || greeting !== 'none' || legA.down || !legReady(legA) || clientBusy()) return
    // «ШІ одразу» по-старому (запобіжник / ШІ не готовий): перша фраза — теж 80 (оголошення про запис з метою), потім 82
    const intro80 = !callback && config.answerMode === 'ai' && route?.branch === 'classic' ? pickVariant('intro') : null
    if (intro80) greetIntro = true
    const file = callback ? prompt('cbConnecting') : intro80 || config.greetingFile
    if (!file) {
      greeting = 'done'
      return startHold()
    }
    greeting = 'playing'
    send({ cmd: 'play', call: A, file, loop: false, tag: greetTag })
    mark('greeting')
  }

  function onGreetingDone() {
    if (greeting === 'done') return
    greeting = 'done'
    mark('greetingDone')
    if (xferGate?.gate === 'intro') {
      classicDownPhrase()
      if (aiDownPlay === 'playing') {
        xferGate.gate = 'aiDown'
        later('xferGate', PROMPT_MAX_MS, releaseXferGate)
        return
      }
      return releaseXferGate()
    }
    if (greetIntro) classicDownPhrase() // після 80 — 82 «з'єднуємо вас з оператором» (набір справді йде)
    startHold() // на голосовій пошті й останній фразі утримання вже не вмикається (clientBusy)
    maybeVoicemail() // пошта чекала, поки привітання догра
    maybeNotice() // остання фраза — теж
    maybeAi() // ШІ — теж
    maybeJoinClient() // 81 менеджера, що приєднався під час привітання, — теж
  }

  // Запобіжник із 80: одразу після вступу — 82 (тег aiDown; утримання / гудки — після неї)
  function classicDownPhrase() {
    if (aiDownPlay || legA.down || !['dialing', 'card', 'confirm', 'xferWait'].includes(phase)) return
    const f = pickVariant('aiDown')
    if (!f) return
    aiDownPlay = 'playing'
    classicDown = true
    send({ cmd: 'play', call: A, file: f, loop: false, tag: 'aiDown' })
    later('aiDownPlay', PROMPT_MAX_MS, onAiDownPlayed)
  }

  function startHold() {
    const file = holdFileNow()
    if (holdOn || legA.down || !file || clientBusy() || aiDownPlay === 'playing' || dsPlay === 'playing' || dsPlay === 'wait') return
    holdOn = true
    send({ cmd: 'play', call: A, file, loop: true, tag: 'hold' })
    mark('hold')
  }

  // ---------- набір сторони B (менеджер, потім запасна; на передзвоні — клієнт): повтори, тайм-аут ----------

  function dial() {
    if (phase !== 'dialing' || legA.down) return
    const t = targets[target]
    const attempt = dials.filter((d) => d.to === target).length + 1
    const ref = `${t.prefix}-${A}-${attempt}`
    pendingRef = ref
    legB = null
    dials.push({ to: target, attempt, ref, at: clock.now() - t0, code: null, ...(aiRound ? { ai: aiRound } : {}) })
    if (stageAt == null) { // перший набір сторони (і перший набір менеджера на запит ШІ)
      stageAt = clock.now()
      markT('dial')
      later('stageCap', stageCapMs(), () => onRingTimeout('cap'))
    }
    // Час дзвінка цієї спроби — від її INVITE; перший 180/183 цієї ноги починає відлік заново (onBRinging)
    later('ring', t.timeoutSec * 1000, () => onRingTimeout('ring'))
    send({ cmd: 'dial', ref, uri: t.uri })
    say(attempt === 1 ? W().call : `${W().redial} (${attempt})`)
  }

  // Межа всієї сторони від її першого набору: вікно повторів + повний час дзвінка останньої спроби. Клієнту на
  // передзвоні не повторюємо — лише його тайм-аут від INVITE.
  const windowMs = () => (targets[target].retry ? Math.max(0, Number(config.dialRetryWindowSec) || 0) * 1000 : 0)
  const stageCapMs = () => windowMs() + targets[target].timeoutSec * 1000

  function onDialing(ev) {
    if (ev.ref !== pendingRef) {
      if (abandoned.has(ev.ref)) hangup(ev.call)
      return
    }
    pendingRef = null
    legB = { call: ev.call, ref: ev.ref, confirmed: false, media: false, grace: false, down: false, ringing: false, code: null }
    const d = dials.find((x) => x.ref === ev.ref)
    if (d) dialByCall.set(ev.call, d)
    if (phase !== 'dialing') hangup(ev.call) // поки набирали, сценарій уже пішов далі
  }

  // B дзвонить (180/183). Тайм-аут сторони рахуємо від цього моменту: повтор після 503 міг початися на 10-й с, а
  // менеджер на Android-софтфоні бере трубку через ~16 с після 180 (живий Binotel 2026-10-17).
  function onBRinging() {
    markT('ringing')
    if (phase !== 'dialing' || legB.ringing) return
    legB.ringing = true
    later('ring', targets[target].timeoutSec * 1000, () => onRingTimeout('ring'))
  }

  // Через скільки повторити набір, або null — повторів більше немає: наступна спроба має початися не пізніше
  // dialRetryWindowSec від першого набору цієї сторони; dialRetries (якщо задано) — ліміт кількості.
  function retryWaitMs() {
    const wait = Math.max(0, Number(config.dialRetryIntervalMs) || 0)
    if (config.dialRetries != null && retries[target] >= config.dialRetries) return null
    const next = clock.now() - stageAt + wait
    if (next > windowMs()) return null
    return wait
  }

  // Набір не вдався до відповіді: повтор (лише 503/408/480 або помилка рушія, і не клієнту на передзвоні) чи далі.
  function dialFailed(code, why) {
    const last = dials[dials.length - 1]
    if (last && last.code == null) last.code = code
    if (phase !== 'dialing') return
    const retryable = targets[target].retry && (why === 'engine' || config.retryCodes.includes(Number(code)))
    const wait = retryable ? retryWaitMs() : null
    if (wait != null) {
      retries[target]++
      say(`${W().name}: ${code || why}, повтор через ${wait} мс`)
      later('dial', wait, dial)
      return
    }
    stageFailed(`${target}_${code || why}`)
  }

  // kind: 'ring' — спроба дзвонила timeoutSec без відповіді; 'cap' — вичерпано межу сторони разом із повторами
  function onRingTimeout(kind) {
    if (phase !== 'dialing') return
    say(kind === 'cap'
      ? `${W().noAnswer} за ${Math.round(stageCapMs() / 1000)} с${windowMs() ? ' вместе с повторами' : ''}`
      : `${W().noAnswer} за ${targets[target].timeoutSec} с звонка`)
    stageFailed(`${target}_timeout`)
  }

  function onBConfirmed() {
    if (phase !== 'dialing') return
    legB.confirmed = true
    const last = dials[dials.length - 1]
    if (last) last.code = 200
    phase = 'card'
    cancel('ring')
    cancel('stageCap')
    cancel('dial')
    markT('answered')
    say(W().answered)
    rememberLastClient()
    if (!legB.media) {
      const leg = legB
      later('graceB', config.mediaGraceMs, () => { leg.grace = true; maybeCard() })
    }
    maybeCard()
  }

  // Дзвінок дійшов до картки — клієнт стає «останнім клієнтом» цього менеджера (для передзвону, коли відкладеного
  // немає). Заявку, якщо пошук ще йде, допишемо, коли він закінчиться.
  function rememberLastClient() {
    if (callback || !callbacks || !phone) return
    const key = target === 'manager' ? mgrKey : managerKeyOf(targets[target].uri, managers)
    if (!key) return
    const save = () => {
      try {
        if (callbacks.setLastClient(key, { number: phone, gcid, srId: serviceRequestId, ownerUid: ownerUidForTarget(key), ts: clock.now() })) lastClientFor = key
      } catch (e) {
        err('callbacks', e?.message)
      }
    }
    save()
    if (!infoDone) infoP.then(() => { if (serviceRequestId) save() })
  }

  // ---------- картка на B (на передзвоні — привітання клієнту) ----------

  function maybeCard() {
    if (phase !== 'card' || cardStarted || !legB || legB.down || !legReady(legB)) return
    cardStarted = true
    markT('ready')
    const waited = new Promise((resolve) => {
      later('tts', config.ttsWaitMs, () => { err('tts', 'wait timeout'); resolve(null) })
      cardP.then((r) => { cancel('tts'); resolve(r) })
    })
    const leg = legB
    waited.then((r) => {
      if (done || phase !== 'card' || !bAlive() || legB !== leg) return
      const file = r?.file || (callback ? null : config.genericCardFile) || null
      const src = callback ? (file ? 'prompt' : 'none') : r?.file ? (r.cached ? 'cache' : 'tts') : file ? 'generic' : 'none'
      if (target === 'fallback') fbCardSource = src
      else cardSource = src
      if (!file) {
        say(callback ? 'фразы для клиента нет — сразу соединяю' : confirmOn ? 'карточки нет — сразу спрашиваю подтверждение' : 'карточки нет — сразу перевожу')
        later('afterCard', config.afterCardMs, () => afterCard('no_card'))
        return
      }
      cardPlaying = true
      send({ cmd: 'play', call: legB.call, file, loop: false, tag: cardTag })
      markT('card')
      say(callback ? `приветствие клиенту (${src})` : `карточка ${W().to} (${src})`)
      later('cardCap', config.cardMaxSec * 1000, () => afterCard('card_cap'))
    })
  }

  function onCardDone() {
    if (!cardPlaying) return
    cardPlaying = false
    markT('cardDone')
    cancel('cardCap')
    later('afterCard', config.afterCardMs, () => afterCard('card_done'))
  }

  // Картку дограно (або обмеження cardMaxSec, або картки немає): підтвердження «1», без нього — одразу переведення
  function afterCard(why) {
    if (phase !== 'card') return
    cancel('cardCap')
    cancel('afterCard')
    cardPlaying = false // card_cap: фраза підтвердження замінить картку, що ще грає
    if (why === 'card_cap') setReason('card_cap')
    if (confirmOn) return startConfirm()
    transfer(why)
  }

  // ---------- підтвердження: «1» — з'єднати, «2» — не може говорити ----------

  function startConfirm() {
    if (legA.down) return clientGone()
    if (!bAlive()) return stageFailed(`${target}_hangup`)
    phase = 'confirm'
    confirm = confirms[target] || { plays: 0, state: null, digit: null }
    confirms[target] = confirm
    confirmPlay()
  }

  function confirmPlay() {
    if (phase !== 'confirm' || !bAlive()) return
    confirm.plays++
    confirm.state = 'prompt'
    markT(confirm.plays === 1 ? 'confirm' : 'confirmRepeat')
    const file = prompt('confirm')
    if (!file) {
      // фрази немає (синтез вимкнено або не вдався): чекаємо цифру мовчки — менеджер знає, що натиснути
      if (confirm.plays === 1) say(`${W().name}: фразы подтверждения нет — жду «${config.confirmDigit ?? '1'}» молча`)
      return confirmWait()
    }
    send({ cmd: 'play', call: legB.call, file, loop: false, tag: 'confirm' })
    say(confirm.plays === 1 ? `${W().name}: жду «1» — соединить, «2» — не может говорить` : `${W().name}: цифры нет — повторяю вопрос`)
    later('confirm', PROMPT_MAX_MS, confirmWait) // play_done загубився
  }

  // Фраза скінчилась — чекаємо цифру confirmTimeoutSec
  function confirmWait() {
    if (phase !== 'confirm' || !confirm || confirm.state !== 'prompt') return
    confirm.state = 'wait'
    later('confirm', Math.max(0, Number(config.confirmTimeoutSec) || 0) * 1000, onConfirmTimeout)
  }

  function onConfirmTimeout() {
    if (phase !== 'confirm') return
    const repeats = Math.max(0, Number(config.confirmRepeats ?? 1) || 0)
    if (confirm.plays <= repeats) return confirmPlay()
    say(`${W().name} не нажал «${config.confirmDigit ?? '1'}» — как не ответил`)
    stageFailed(`${target}_no_confirm`)
  }

  // DTMF на нозі B. «1» приймаємо і під час картки (менеджер знає порядок); інші цифри — не відповідь, пропускаємо.
  function onDtmf(ev) {
    if (!confirmOn || !legB || ev.call !== legB.call || legB.down) return
    if (phase !== 'card' && phase !== 'confirm') return
    const d = String(ev.digit ?? '').trim()
    const yes = String(config.confirmDigit ?? '1')
    const no = String(config.declineDigit ?? '2')
    if (d !== yes && d !== no) return
    const c = confirms[target] || (confirms[target] = { plays: 0, state: null, digit: null })
    c.digit = d
    markT('digit')
    if (d === yes) {
      say(`${W().name} нажал «${d}» — соединяю`)
      if (cardPlaying || c.state === 'prompt') send({ cmd: 'stop', call: legB.call }) // картку / питання не догравати
      cardPlaying = false
      return transfer('confirmed')
    }
    say(`${W().name} нажал «${d}» — не может говорить`)
    stageFailed(`${target}_declined`)
  }

  // ---------- переведення ----------

  let xferWaits = 0
  function transfer(why, { force = false } = {}) {
    if (phase !== 'card' && phase !== 'confirm') return
    if (legA.down) return clientGone()
    if (!bAlive()) return stageFailed(`${target}_hangup`)
    // Фраза на A ще грає (80 / 13–15 / 82): з'єднуємо після неї (рішення 12), але не пізніше dsXferWaitMs (80 — INTRO_XFER_WAIT_MS)
    const gate = force ? null : gateNow()
    if (gate) {
      phase = 'xferWait'
      cancel('cardCap')
      cancel('afterCard')
      cancel('confirm')
      cancel('dsWait')
      const ms = gate === 'intro' ? INTRO_XFER_WAIT_MS : Math.max(0, Number(config.dsXferWaitMs ?? 6000) || 0)
      xferGate = { why, gate, at: clock.now() }
      mark('xferGate')
      say(`${W().name} подтвердил — соединю, когда клиент дослушает фразу (не дольше ${Math.round(ms / 1000)} с)`)
      later('xferGate', ms, releaseXferGate)
      return
    }
    // REFER — лише в підтвердженому діалозі A. На передзвоні клієнт міг узяти раніше, ніж дійшов ACK менеджера:
    // чекаємо CONFIRMED ноги A по 200 мс, але не довше ~5 с (далі пробуємо все одно — помилка REFER → міст)
    if (!legA.confirmed && xferWaits < 25) {
      xferWaits++
      later('afterCard', 200, () => transfer(why))
      return
    }
    phase = 'transferring'
    cancel('cardCap')
    cancel('afterCard')
    cancel('confirm')
    // Типово REFER на нозі A з Replaces ноги B (перевірена на Binotel форма); на передзвоні з callbackReferOn 'client' —
    // навпаки, REFER на нозі клієнта з Replaces ноги менеджера: тоді в Refer-To URI менеджера, а не номер клієнта
    xferLeg = referOnClient ? legB.call : A
    send({ cmd: 'xfer_replaces', call: xferLeg, dest: referOnClient ? A : legB.call })
    markT('xfer')
    say(callback ? `соединяю менеджера с клиентом (REFER/Replaces на ноге ${referOnClient ? 'клиента' : 'менеджера'})` : `соединяю клиента ${W().with} (REFER/Replaces)`)
    later('xfer', config.xferTimeoutMs, onXferTimeout)
  }

  function onXfer(ev) {
    xferCode = ev.code ?? null
    if (ev.final) xferFinalCode = ev.code ?? null
    if (phase === 'transferring') onReplacesXfer(ev)
    else if (phase === 'fallback') onBlindXfer(ev)
  }

  function onReplacesXfer(ev) {
    if (!ev.final) {
      xferAccepted = true
      markT('xferAccepted')
      return
    }
    cancel('xfer')
    cancel('bothDown')
    markT('xferFinal')
    if (ok2xx(ev.code)) {
      phase = 'connected'
      outcome = won('connected')
      answeredBy = target
      if (legB?.join) joinSettled('connected')
      served()
      say('соединены, выхожу из звонка')
      if (legA.down && !bAlive()) return finish()
      later('clear', config.xferClearMs, clearLegs)
    } else {
      err('xfer', `${ev.code} ${ev.reason || ''}`.trim())
      say(`перевод не удался (${ev.code}) — соединяю через себя`)
      bridgeOrRecover()
    }
  }

  // Після REFER/Replaces АТС гасить обидві ноги — це успіх, навіть без фінального NOTIFY.
  const unconfirmed = () => {
    outcome = won('connected_unconfirmed')
    answeredBy = target
    if (legB?.join) joinSettled('connected_unconfirmed')
    served()
    finish()
  }

  function onXferTimeout() {
    if (phase !== 'transferring') return
    err('xfer', xferAccepted ? 'no final NOTIFY' : 'timeout')
    if (!legA.down && bAlive()) {
      say('нет ответа на перевод — соединяю через себя')
      return bridgeOrRecover()
    }
    // REFER/Replaces принят, АТС сняла ногу B, а A всё ещё на нашей ноге. При удачном Replaces Binotel
    // кладёт A сразу за B (вживую 2026-10-17 — через 1 мс после NOTIFY 200), а 202/NOTIFY Binotel о переводе на
    // слово верить нельзя. Раз A жива xferTimeoutMs — никуда не перевели: как не ответил.
    if (xferAccepted && !legA.down) {
      say(`перевод принят, АТС сняла звонок ${W().to}, а ${aName} всё ещё на линии — перевод не состоялся`)
      return stageFailed(`${target}_xfer_unconfirmed`)
    }
    // REFER/Replaces принят, и АТС уже сняла ногу A — так она завершает заменённый диалог после
    // успешного Replaces. Следующая сторона здесь увела бы клиента от того, кто ответил: просто выходим.
    if (xferAccepted) {
      say('перевод принят, итог не пришёл — считаю соединёнными, выхожу из звонка')
      if (bAlive()) hangup(legB.call)
      return unconfirmed()
    }
    if (!legA.down) return stageFailed(`${target}_hangup`)
    if (bAlive()) return clientGone()
    unconfirmed()
  }

  function bridgeOrRecover() {
    if (!legA.down && bAlive()) {
      phase = 'bridged'
      outcome = won('bridged')
      answeredBy = target
      holdOn = false
      if (legB.join) joinSettled(join.mode === 'refer' ? 'refer_failed_bridged' : 'bridged')
      served()
      send({ cmd: 'bridge', a: A, b: legB.call })
      mark('bridged')
      // Страховка від «вічного» моста: BYE міг загубитися (зник інтернет), а RTP рушій не стежить
      if (config.bridgeMaxMin > 0) {
        later('bridgeCap', config.bridgeMaxMin * 60000, () => {
          setReason('bridge_cap')
          say(`разговор через шлюз дольше ${config.bridgeMaxMin} мин — кладу обе ноги`)
          clearLegs()
        })
      }
      return
    }
    if (legA.down) return clientGone()
    return stageFailed(`${target}_hangup`)
  }

  // Клієнт і менеджер говорять (з'єднано, у т. ч. через запасну чи міст): відкладені передзвони цього клієнта в групи
  // менеджера виконано — прибираємо всі (на передзвоні — і той, з якого дзвонили, і, якщо ціллю був «останній
  // клієнт», його старий запис), інакше менеджеру потім набрали б уже обслуженого клієнта.
  function served() {
    if (servedDone) return
    servedDone = true
    const n = callback ? cb?.number : phone
    if (!callback) leadServed()
    else if (cb?.serviceRequestId) {
      const ownerUid = cb.ownerUid || uidOfGroup(callerGroup)
      try { staffState?.answered?.(callerManager, { uid: ownerUid }) } catch (e) { err('staff', e?.message) }
      emitRoute('callback_connected', { srId: cb.serviceRequestId, ownerUid })
    }
    // приєднаний менеджер — і його група (рішення: served() за об'єднанням груп); перезвін ведучому, якщо клієнта з'єднали з
    // оператором (обіцянку «вам передзвонять» виконано)
    const pendGroup = pendingCb?.stored && pendingCb.managerKey ? managerGroupOf(pendingCb.managerKey, managers) || [pendingCb.managerKey] : []
    const keys = callback ? callerGroup : [...new Set([...mgrGroup, ...(legB?.join && join ? join.group : []), ...pendGroup])]
    if (!n || !callbacks?.removePendingFor || !keys?.length) return
    try {
      pendingRemoved = callbacks.removePendingFor(keys, n) || 0
      if (callback && cb) cb.removed = pendingRemoved > 0
    } catch (e) {
      err('callbacks', e?.message)
    }
  }

  // Передзвін не вдався з боку клієнта: спроба +1, запис — у кінець черги (після callbackMaxAttempts — знято)
  function callbackFailed() {
    if (!cb || cb.source !== 'pending' || !cb.id || !callbacks?.markAttempt) return
    try {
      const r = callbacks.markAttempt(cb.id)
      if (r) {
        cb.attempts = r.attempts
        cb.dropped = !!r.dropped
      }
    } catch (e) {
      err('callbacks', e?.message)
    }
  }

  // ---------- далі: менеджер → «лінія зайнята» / запасна / голосова пошта ----------

  // Поточна сторона не взяла, зайнята, відмовилась, не підтвердила, поклала до переведення або повтори вичерпано:
  // кладемо її ногу (чи відмовляємось від набору, що ще йде) і йдемо далі.
  function stageFailed(why) {
    if (done) return
    if (legA.down) return clientGone()
    for (const k of STAGE_TIMERS) cancel(k)
    setReason(why)
    if (pendingRef) {
      abandoned.add(pendingRef)
      pendingRef = null
    }
    if (bAlive()) hangup(legB.call)
    if (callback) {
      callbackFailed()
      say(`${W().noAnswer} (${why}) — сообщаю менеджеру и кладу трубку${cb?.dropped ? `; попыток ${cb.attempts} — перезвон снят` : ''}`)
      return notice('cbNoAnswer', 'callback_no_answer')
    }
    if (legB?.join && join && !join.result) return joinManagerGone(why, { hung: true }) // REFER приєднання не відбувся
    return noManager(why)
  }

  // Менеджер не взяв / не з'єднались: далі за режимом (ШІ, «лінія зайнята», запасна, пошта)
  function noManager(why) {
    if (target === 'manager' && dsRound) return dsFailed(why) // ведучий у режимі обговорення не прийняв дзвінок
    if (target === 'manager' && aiRound > 0) return aiTransferFailed(why) // ШІ передав клієнта, а менеджер не взяв
    if (target === 'manager' && aiDownRound && callbackRefused()) {
      // ШІ не піднявся, набір після 82 не вдався, а клієнт раніше відмовився від передзвону: «передзвонить» було б
      // неправдою, новий запис — проти його волі; просто відбій
      outcome = aiInfo?.note ? 'ai_noted' : 'ai_answered'
      say(`${W().noAnswer} (${why}) — клиент отказался от перезвона, кладу трубку`)
      if (!legA.down && !legA.gone) hangup(A)
      return finish()
    }
    if (target === 'manager' && noAnswerMode === 'ai') return aiOn() ? startAi(why) : busyCallback(why)
    if (target === 'manager' && noAnswerMode === 'busy') return busyCallback(why)
    if (target === 'manager' && noAnswerMode === 'fallback' && targets.fallback.uri) {
      if (fallbackMode === 'blind') return blindFallback(why)
      return startFallback(why)
    }
    return startVoicemail(why)
  }

  // Типово: клієнта не тримаємо — «лінія зайнята, менеджер передзвонить», відбій; передзвін — у callbacks.json
  function busyCallback(why) {
    // після ШІ передзвін уже збережено; клієнт від нього відмовився (ШІ, callback:false) — нового не ставимо
    if (!pendingCb?.stored && !pendingCb?.removed) savePending()
    say(`${W().noAnswer} (${why}) — клиенту «линия занята, менеджер перезвонит»${pendingCb?.stored ? ', перезвон сохранён' : ''}, кладу трубку`)
    notice('busy', 'busy_callback')
  }

  function savePending({ missed = false, note = null } = {}) {
    const until = phone ? callbackUntil() : null // уночі — щонайменше до 18:00 наступного робочого дня (обіцянка «у робочий час»)
    pendingCb = { managerKey: mgrKey, stored: false, id: null, ...(afterHoursUrgent ? { afterHoursUrgent: true } : {}), ...(missed ? { missed: true } : {}), ...(until ? { until: new Date(until).toISOString() } : {}) }
    if (!phone) { pendingCb.why = 'no_number'; return } // внутрішній / без номера — передзвонювати нікуди
    if (!callbacks) { pendingCb.why = 'no_store'; return }
    try {
      const e = callbacks.addPending({ managerKey: mgrKey, clientNumber: phone, gcid, serviceRequestId, card: cardText, missed, note, until, afterHoursUrgent, ownerUid: ownerUidForTarget(mgrKey), ts: clock.now() })
      pendingCb.stored = true
      pendingCb.id = e?.id ?? null
      mark('callbackStored')
    } catch (e) {
      pendingCb.why = 'error'
      err('callbacks', e?.message)
      return
    }
    // Менеджер відмовив раніше, ніж закінчився пошук клієнта: заявку й картку допишемо, коли будуть
    if (!infoDone) {
      const id = pendingCb.id
      infoP.then(() => {
        try { callbacks.updatePending(id, { serviceRequestId, card: cardText }) } catch { /* передзвін уже є, без заявки */ }
      })
    }
  }

  // Запасна — так само, як менеджер: набір із повторами, картка, підтвердження, REFER/Replaces.
  // Клієнт тим часом на утриманні.
  function startFallback(why) {
    target = 'fallback'
    phase = 'dialing'
    stageAt = null
    cardStarted = false
    cardPlaying = false
    xferAccepted = false
    confirm = null
    mark('fallback')
    say(`запасная линия (${why})`)
    dial()
  }

  // Старий шлях (fallbackMode 'blind'): сліпий REFER клієнта на запасну.
  function blindFallback(why) {
    phase = 'fallback'
    outcome = 'fallback'
    send({ cmd: 'xfer', call: A, uri: targets.fallback.uri })
    mark('fallback')
    say(`перевожу на запасную линию вслепую (${why})`)
    later('fallbackXfer', config.xferTimeoutMs, onBlindTimeout) // ни 202, ни NOTIFY — АТС перевод не взяла
  }

  // Сліпий REFER на запасну: 202/NOTIFY 1xx — АТС уже набирає запасну лінію. Фінальний NOTIFY Binotel може
  // надіслати лише після відповіді запасної (так робить pjsua), тому після прийняття чекаємо довше — BYE
  // від АТС (onADown) або фінал до fallbackRingMs. Утримання не зупиняємо: якщо АТС ще тримає клієнта на
  // нашій нозі, краще музика, ніж тиша; якщо вже забрала — звук нікуди не йде.
  function onBlindXfer(ev) {
    if (!ev.final) {
      if (!fbAccepted) {
        fbAccepted = true
        mark('fallbackAccepted')
        say('запасная линия: перевод принят АТС, жду ответа')
        if (config.fallbackRingMs > 0) later('fallbackXfer', config.fallbackRingMs, onBlindTimeout)
      }
      return
    }
    cancel('fallbackXfer')
    mark('fallbackFinal')
    if (ok2xx(ev.code)) {
      say('переведён на запасную линию')
      if (legA.down) return finish()
      later('clear', config.xferClearMs, clearLegs)
    } else {
      err('fallback_xfer', `${ev.code} ${ev.reason || ''}`.trim())
      outcome = 'failed'
      say(`перевод на запасную линию не удался (${ev.code}) — кладу трубку`)
      if (!legA.down) hangup(A)
      finish()
    }
  }

  function onBlindTimeout() {
    if (phase !== 'fallback') return
    if (fbAccepted) {
      err('fallback_xfer', 'no final NOTIFY')
      outcome = 'fallback_unconfirmed'
      say(`запасная линия: нет итога перевода за ${Math.round(config.fallbackRingMs / 1000)} с — кладу трубку`)
    } else {
      err('fallback_xfer', 'timeout')
      outcome = 'failed'
      say('запасная линия: АТС не ответила на перевод — кладу трубку')
    }
    if (!legA.down) hangup(A)
    finish()
  }

  // ---------- ШІ-співрозмовник ----------

  // Менеджер не взяв (там, де в busy звучить «лінія зайнята») або неробочий час: відповідає ШІ. Передзвін — одразу,
  // як у busy: менеджер пропустив дзвінок (ШІ потім допише в нього питання клієнта).
  // «ШІ одразу» (kind first): перезвін на старті НЕ ставимо (рішення 18) — його поставлять питання для менеджера, невдале
  // з'єднання або відбій під час набору; пошук клієнта фаза route уже чекала.
  // Обговорення (черга B): discussion_failed — після 16 (перезвін ведучому вже стоїть), discussion_unavailable — ведучому не
  // дзвонили, discussion_after_hours — ніч; перезвін — ведучому або загальній групі (dsCallbackTarget).
  function startAi(why, { variant = null } = {}) {
    phase = 'ai'
    const kind = AI_KINDS.includes(why) ? why : 'busy'
    aiInfo = { kind, why, state: 'wait', sessionKind: kind, note: null, transfers: 0, joins: 0, sessions: [], endReason: null, failed: false, error: null, transferReason: null, variant }
    if (kind === 'after_hours' || kind === 'discussion_after_hours') reason = 'after_hours'
    if (kind === 'discussion_unavailable') reason = `ds_${route?.why || 'unavailable'}`
    mark('ai')
    if (kind !== 'first' && !pendingCb?.stored && !pendingCb?.removed) savePending()
    say(kind === 'first'
      ? `отвечает ИИ (${{ request: 'есть открытая заявка', general: 'открытой заявки нет', nodata: 'данных о номере нет' }[variant] || variant})`
      : kind.startsWith('discussion_')
        ? `отвечает ИИ (${{ discussion_failed: 'ведущий не принял звонок', discussion_unavailable: 'ведущему не звонили', discussion_after_hours: 'обсуждение, нерабочее время' }[kind]})${pendingCb?.stored ? `, перезвон ${callbackTo() === 'lead' ? 'ведущему' : 'в общую группу'} сохранён` : ''}`
        : `${kind === 'after_hours' ? 'нерабочее время' : `${W().noAnswer} (${why})`} — отвечает ИИ${pendingCb?.stored ? ', перезвон сохранён' : ''}`)
    if (!infoDone && !v2) {
      later('aiInfo', AI_INFO_WAIT_MS, maybeAi)
      infoP.then(() => maybeAi())
    }
    maybeAi()
  }

  // Утримання на час, поки ШІ під'єднується (зупиняє onSpeaking — перший звук моделі)
  function aiHold() {
    if (holdOn || legA.down || !config.holdFile || v2) return // «ШІ одразу»: музики перед ШІ немає
    holdOn = true
    send({ cmd: 'play', call: A, file: config.holdFile, loop: true, tag: 'hold' })
    mark('hold')
  }

  // З'єднати з менеджером: із першої сесії (busy) і з повторної після невдалого з'єднання (transfer_failed), поки не
  // вичерпано aiTransferMax за дзвінок; у неробочий час — ніколи
  // (і з першої сесії режиму «ШІ одразу»; спроба приєднання менеджера, що передзвонив, теж рахується в межу)
  // Обговорення: після «не вдалося» — лише з VG_DS_AI_TRANSFER > 0; ведучому не дзвонили — В19 (з оператором у винятках:
  // претензія, гарантія, небезпека — правило в інструкціях моделі); уночі — ніколи
  const aiKindTransfers = (k) => k === 'busy' || k === 'transfer_failed' || k === 'first' ||
    (k === 'discussion_failed' && Number(config.dsAiTransfer) > 0) ||
    (k === 'discussion_unavailable' && (Number(config.dsAiTransfer) > 0 || config.dsExceptionTransfer !== false))
  const urgentLead = () => config.afterHoursUrgentTo ? resolveLead({ ds: { snapshotKey: config.afterHoursUrgentTo }, config, managers }) : null
  const aiUrgentOnly = () => nightNow() && !!urgentLead()?.uri && !!urgentLead()?.group
  const aiTransferAllowed = () => (aiUrgentOnly() || aiKindTransfers(aiInfo?.sessionKind)) &&
    aiInfo.transfers + (aiInfo.joins || 0) < Math.max(0, Number(config.aiTransferMax ?? 1) || 0) && !!config.managerUri && (!aiAfterHours() || aiUrgentOnly()) && (!v2 || intro === 'done')
  // В19: у discussion_unavailable без VG_DS_AI_TRANSFER — з'єднати лише у винятках
  const aiExceptionsOnly = () => aiInfo?.sessionKind === 'discussion_unavailable' && !(Number(config.dsAiTransfer) > 0)

  // Сесія ШІ: привітання, якщо ще грає, догрує; пошук клієнта — не довше AI_INFO_WAIT_MS
  function maybeAi() {
    if (phase !== 'ai' || !aiInfo || aiInfo.state !== 'wait' || legA.down) return
    if (greeting === 'playing') {
      if (tm.aiGreeting == null) later('aiGreeting', PROMPT_MAX_MS, () => { greeting = 'done'; maybeAi() })
      return
    }
    if (!infoDone && tm.aiInfo != null) return // ще чекаємо пошук клієнта
    cancel('aiGreeting')
    cancel('aiInfo')
    aiHold()
    aiInfo.state = 'live'
    const kind = aiInfo.sessionKind
    let sess = null
    try {
      sess = ai({
        call: A,
        kind,
        category,
        transferAllowed: aiTransferAllowed(),
        note: aiInfo.note,
        callbackStored: !!pendingCb?.stored,
        // неробочий час: повний варіант першої фрази, нічні правила (і в старому режимі)
        afterHours: nightNow(),
        urgentOnly: aiUrgentOnly(),
        needsTerms: category === 'openRequest' && lookupRes?.termsAccepted === false,
        resendAllowed: !!config.aiResendUrl && !!resendLink && category === 'openRequest',
        announced: intro === 'done' || (aiInfo.sessions || []).some((x) => x.spoke),
        // «ШІ одразу»: нові тексти й правила (v2), варіант першої фрази, чи прозвучав вступ 80; черга B — куди перезвін (lead |
        // group), В19 (з'єднати лише у винятках), «друга лінія» підтверджена (pending_call), чому ведучому не дзвонили
        ...(v2 ? { v2: true, variant: aiInfo.variant ?? null, intro: intro === 'done', callbackTo: callbackTo(), exceptionsOnly: aiExceptionsOnly(), secondLineConfirmed: ds?.kind === 'pending', dsWhy: route?.why ?? null } : {}),
        // повторна сесія: чому не з'єднали — dial (ніхто не взяв) чи join (менеджер, що передзвонив, поклав до з'єднання:
        // «з'єднати не вдалося» й «пропущений дзвінок» були б неправдою)
        ...(kind === 'transfer_failed' ? { failedBy: aiInfo.failedBy || 'dial' } : {}),
        onTool: aiTool,
        onSpeaking: () => {
          const rec = aiInfo?.sessions.find((x) => x.s === sess)
          if (rec) rec.spoke = true
          if (holdOn && phase === 'ai' && aiS === sess) {
            holdOn = false
            send({ cmd: 'stop', call: A })
          }
        },
        onEnd: (info) => onAiEnd(sess, info),
      })
    } catch (e) {
      err('ai', e?.message)
    }
    const cmd = sess?.start ? sess.start() : null
    if (!sess || !cmd) return aiFailed('ai_start')
    aiS = sess
    aiInfo.sessions.push({ kind, at: clock.now() - t0, s: sess, end: null })
    send(cmd)
    mark(aiInfo.sessions.length === 1 ? 'aiStart' : 'aiRestart')
    say(kind === 'transfer_failed' ? 'ИИ снова на линии' : 'ИИ на линии')
  }

  // Інструменти моделі. Результат — лише те, що можна сказати по телефону (правила — aiprompt.mjs).
  async function aiTool(name, args) {
    if (done || phase !== 'ai') return { ok: false, error: 'call_over' }
    switch (name) {
      case 'get_request_status':
        mark('aiStatus')
        if (!infoDone) await Promise.race([infoP, new Promise((r) => clock.setTimeout(r, AI_INFO_WAIT_MS))])
        return requestStatusFor(lookupRes, {
          lookupState: lookupState === 'pending' ? 'error' : lookupState,
          detail: config.aiStatusDetail === 'stage' ? 'stage' : 'minimal',
          nowMs: clock.now(),
          ...(v2 ? { v2: true } : {}),
        })
      case 'resend_request_link':
        return aiResendLink()
      case 'save_question_for_manager':
        return aiSaveQuestion(args)
      case 'transfer_to_manager':
        if (!aiTransferAllowed()) {
          return { ok: false, reason: aiInfo.sessionKind === 'after_hours' || aiInfo.sessionKind === 'discussion_after_hours' ? 'after_hours' : 'not_available', note: "З'єднати з людиною зараз не можна. Запропонуй записати питання — вам передзвонять." }
        }
        if (aiUrgentOnly() && (args?.topic || aiInfo.note?.topic) !== 'safety') return { ok: false, reason: 'urgent_only', note: 'Уночі черговий приймає лише небезпечні ситуації. Запропонуй записати питання.' }
        if (!aiUrgentOnly() && aiExceptionsOnly() && !['complaint', 'warranty', 'safety'].includes(args?.topic || aiInfo.note?.topic)) return { ok: false, reason: 'exceptions_only', note: 'Оператор доступний лише при претензії, гарантії чи небезпеці. Запиши питання.' }
        aiInfo.transferReason = String(args?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null
        if (aiUrgentOnly()) {
          afterHoursUrgent = true
          const lead = urgentLead()
          setTarget({ ...lead, timeoutSec: config.managerTimeoutSec })
          aiInfo.note = { ...aiInfo.note, question: aiInfo.note?.question || aiInfo.transferReason || 'Небезпечна ситуація, потрібен черговий.', topic: 'safety', urgent: true, callback: true }
          if (pendingCb?.stored) callbacks?.updatePending?.(pendingCb.id, { note: aiInfo.note, afterHoursUrgent: true })
          else savePending({ note: aiInfo.note })
          if (pendingCb) pendingCb.afterHoursUrgent = true
          say('ночное срочное обращение — пробую соединить с дежурным')
        }
        return { ok: true }
      case 'end_call':
        return { ok: true }
      default:
        return { ok: false, error: 'unknown_tool' }
    }
  }

  async function aiResendLink() {
    if (!config.aiResendUrl || !resendLink) return { ok: false, error: 'disabled', note: LINK_MANAGER }
    if (!infoDone) await infoP
    if (done || phase !== 'ai') return { ok: false, error: 'call_over' }
    if (!serviceRequestId || category !== 'openRequest') return { ok: false, error: 'no_request', note: LINK_MANAGER }
    if (resendAccepted) return { ok: true, accepted: true, note: LINK_ACCEPTED }
    resendP ||= Promise.resolve().then(() => resendLink({ serviceRequestId, gcid })).catch(() => ({ ok: false, error: 'unavailable' }))
    const result = await resendP
    resendP = null
    resendAccepted = result?.ok === true
    return { ok: resendAccepted, ...(resendAccepted ? { accepted: true } : { error: result?.error || 'unavailable' }), note: resendAccepted ? LINK_ACCEPTED : LINK_MANAGER }
  }

  const NOTE_TOPICS = ['repair', 'purchase', 'warranty', 'delivery', 'complaint', 'safety', 'other']
  function aiSaveQuestion(args) {
    const question = stripVoiceTags(args?.question).replace(/\s+/g, ' ').trim().slice(0, AI_NOTE_MAX)
    if (!question) return { ok: false, error: 'empty_question', note: "Спершу з'ясуй суть питання." }
    const note = { question, topic: NOTE_TOPICS.includes(args?.topic) ? args.topic : 'other', urgent: afterHoursUrgent || args?.urgent === true, callback: args?.callback !== false }
    aiInfo.note = note
    mark('aiNote')
    if (!phone) return { ok: true, saved: false, note: 'Номер не визначився, передзвонити не вийде. Скажи, що питання записано і менеджер його побачить.' }
    const stored = { question: note.question, topic: note.topic, urgent: note.urgent }
    try {
      if (!note.callback) {
        // Воля клієнта: знімаємо і перезвін цього дзвінка, і той, що лишився з попереднього в цій групі (callbacks.json)
        let removed = 0
        const groups = [...new Set([...mgrGroup, ...(pendingCb?.managerKey ? managerGroupOf(pendingCb.managerKey, managers) || [pendingCb.managerKey] : [])])]
        if (pendingCb?.stored && pendingCb.id && callbacks?.removePending) {
          if (callbacks.removePending(pendingCb.id)) removed++
          pendingCb.stored = false
          pendingCb.removed = true
        }
        if (callbacks?.removePendingFor && groups.length) removed += callbacks.removePendingFor(groups, phone) || 0
        if (removed) {
          aiInfo.callbackRemoved = (aiInfo.callbackRemoved || 0) + removed
          if (!pendingCb) pendingCb = { managerKey: mgrKey, stored: false, id: null, ...(afterHoursUrgent ? { afterHoursUrgent: true } : {}), removed: true }
          say(`клиент отказался от перезвона — снято ожиданий перезвона: ${removed}`)
        }
        return { ok: true, saved: true, callback: false, note: 'Записано, передзвонювати не будемо.' }
      }
      if (pendingCb?.stored && pendingCb.id) callbacks.updatePending(pendingCb.id, { note: stored, afterHoursUrgent })
      else savePending({ note: stored })
    } catch (e) {
      err('callbacks', e?.message)
    }
    if (!pendingCb?.stored) {
      // «пропущений дзвінок» — лише якщо менеджеру справді дзвонили (у «ШІ одразу» до прохання клієнта — ні)
      const missed = dials.some((d) => d.to === 'manager')
      return { ok: true, saved: false, note: missed ? 'Записати передзвін не вдалося. Скажи, що співробітник побачить пропущений дзвінок.' : 'Записати передзвін не вдалося. Чесно скажи, що зараз записати не вийшло, і попроси передзвонити трохи пізніше.' }
    }
    // «вам передзвонять» без імені й строку (черновик 5а); уночі — «у робочі години»
    return { ok: true, saved: true, callback: true, note: `Записано. ${CALLBACK_PROMISE}` }
  }

  function onAiEnd(sess, info) {
    const rec = aiInfo?.sessions.find((x) => x.s === sess)
    if (rec) rec.end = info || null
    if (sess !== aiS || done) return
    aiInfo.endReason = info?.action || info?.reason || null
    if (phase !== 'ai') return
    if (info?.action === 'transfer') return aiTransfer()
    if (info?.action === 'end' || info?.reason === 'idle' || info?.reason === 'max_duration') return aiDone()
    if (legA.down) return // клієнт поклав — це обробляє onADown
    const why = info?.reason || 'ai_error'
    if (why === 'engine_closed' || why === 'ai_error') {
      // Найчастіше це клієнт поклав: рушій закрив сокет звуку раніше, ніж до нас дійшов 'state DISCONNECTED'. Чекаємо його
      // AI_DOWN_GRACE_MS (тоді onADown → aiClientGone: ai_noted / ai_client_hangup); A жива й після цього — ШІ не вдався.
      // aiS лишається (сесія вже скінчилась) — aiClientGone і abort це витримують.
      aiInfo.state = 'ending'
      later('aiDown', AI_DOWN_GRACE_MS, () => {
        if (phase !== 'ai' || legA.down) return
        if (legA.gone) return aiClientGone() // рушій уже сказав, що A розірвана, — команд на неї не шлемо
        aiFailed(why)
      })
      return
    }
    aiFailed(why)
  }

  // ШІ попрощався (або тиша / межа часу): кладемо трубку
  function aiDone() {
    aiInfo.state = 'done'
    aiS = null
    outcome = aiInfo.note ? 'ai_noted' : 'ai_answered'
    say(`ИИ завершил разговор${aiInfo.note ? ' — вопрос записан' : ''}`)
    if (!legA.down && !legA.gone) hangup(A)
    finish()
  }

  // ШІ не вдався (провайдер, рушій): далі як busy — «лінія зайнята», передзвін уже збережено. Клієнт прямо відмовився від
  // передзвону (save_question_for_manager callback:false) і передзвону зараз немає — «менеджер передзвонить» була б
  // неправдою, а новий запис — проти його волі: просто відбій, підсумок як у розмови з ШІ (ai.error лишається).
  function aiFailed(why) {
    aiInfo.failed = true
    aiInfo.state = 'done'
    aiInfo.error = why
    err('ai', why)
    cancel('aiDown')
    const sess = aiS
    aiS = null
    if (sess && !sess.ended) sess.stop('failed')
    if (v2) breaker?.fail(why)
    // Обговорення: ведучий щойно не прийняв, після 16 ШІ не піднявся — 17 («вам передзвонять», перезвін уже стоїть) і відбій
    if (aiInfo.kind === 'discussion_failed' && !legA.down && !legA.gone) {
      say(`ИИ недоступен (${why}) после «не вдалося» — ${pendingCb?.stored ? '«вам передзвонять» и ' : ''}отбой`)
      return notice(pendingCb?.stored ? 'dsNoAi' : null, 'ds_callback')
    }
    // «ШІ одразу»: менеджеру в цьому дзвінку ще не дзвонили — «лінія зайнята» була б неправдою: 82 і звичний набір
    if (v2 && !dials.some((d) => d.to === 'manager') && config.managerUri && !aiAfterHours() && !legA.down && !legA.gone) return aiDownConnect(why)
    if (!pendingCb?.stored && (pendingCb?.removed || aiInfo.note?.callback === false)) {
      outcome = aiInfo.note ? 'ai_noted' : 'ai_answered'
      say(`ИИ недоступен (${why}) — клиент отказался от перезвона, кладу трубку`)
      if (!legA.down && !legA.gone) hangup(A)
      return finish()
    }
    // «ШІ одразу» в неробочий час: менеджеру не дзвонили і не дзвонитимемо (рішення 23) — «лінія зайнята» була б
    // неправдою (рішення 19). Перезвін after_hours уже стоїть: фраза 83 «неробочий час, менеджер передзвонить у робочий
    // час» (prompts.aiDownNight; немає WAV або перезвону — без неї), відбій
    if (v2 && aiAfterHours() && !dials.some((d) => d.to === 'manager')) {
      if (!pendingCb?.stored) savePending()
      say(`ИИ недоступен (${why}), нерабочее время — менеджеру не звоню, «линия занята» не говорю${pendingCb?.stored ? ', перезвон сохранён' : ''}, кладу трубку`)
      return notice(pendingCb?.stored ? 'aiDownNight' : null, 'ai_failed_callback')
    }
    say(`ИИ недоступен (${why})`)
    busyCallback(why)
  }

  // «ШІ одразу», ШІ не піднявся, менеджеру ще не дзвонили: фраза 82 («з'єднуємо вас із менеджером») → звичний набір
  // менеджера (повтори, картка з питанням клієнта, якщо записане, «1», REFER); поки дзвонимо — утримання / гудки. Не
  // взяв — далі за режимом (busy: «лінія зайнята» — тепер правда, бо набір був).
  function aiDownConnect(why) {
    // Перший шматок аудіо ШІ не доводить, що мета запису вже прозвучала повністю.
    if (v2 && intro !== 'done') return introFailedClosed()
    say(`ИИ недоступен (${why}) — менеджеру ещё не звонили: «соединяем» и набор менеджера`)
    mark('aiDownConnect')
    aiDownRound = true
    // 82 обіцяє оператора — загальна група VG_MANAGER (у discussion_unavailable ведучому дзвонити не можна; перезвін
    // ведучому, якщо вже стоїть, лишається)
    setOperator()
    target = 'manager'
    phase = 'dialing'
    stageAt = null
    legB = null
    cardStarted = false
    cardPlaying = false
    xferAccepted = false
    xferWaits = 0
    confirm = null
    cardP = prepareDownCard()
    const f = pickVariant('aiDown')
    if (f) {
      holdOn = false
      aiDownPlay = 'playing'
      send({ cmd: 'play', call: A, file: f, loop: false, tag: 'aiDown' })
      later('aiDownPlay', PROMPT_MAX_MS, onAiDownPlayed)
    } else startHold()
    dial()
  }

  function onAiDownPlayed() {
    if (aiDownPlay !== 'playing') return
    aiDownPlay = 'done'
    cancel('aiDownPlay')
    if (xferGate?.gate === 'aiDown') return releaseXferGate()
    if (phase === 'dialing') startHold()
    if (phase === 'joining' && join?.client === 'done') joinHold() // менеджер приєднався, 81 немає — після 82 не тиша
    maybeNotice() // менеджер уже відмовив, поки грала 82: «лінія зайнята» / пошта — після неї
    maybeVoicemail()
  }

  // Картка менеджеру після 82: звична картка + питання клієнта, якщо ШІ встиг його записати (номери прибрано)
  function prepareDownCard() {
    return infoP.then(() => {
      const q = aiInfo?.note?.question
      const text = q ? hidePhones(`${cardText || 'Дзвонить клієнт.'} Питання клієнта: ${q}`).slice(0, 300) : cardText
      if (!tts || !text || done) return null
      return Promise.resolve().then(() => tts(text)).then((r) => (r && r.file ? r : null), (e) => {
        err('tts', e?.message)
        return null
      })
    })
  }

  // Модель попросила з'єднати з менеджером і фразу «з'єдную» дограно (сесію закрито): той самий шлях, що вперше —
  // набір із повторами, утримання, картка з питанням клієнта, «1», REFER/Replaces. Не вийшло — aiTransferFailed.
  function aiTransfer() {
    if (legA.down || legA.gone) return aiClientGone() // клієнт уже поклав — менеджеру не дзвонимо
    if (v2 && intro !== 'done') return introFailedClosed()
    aiInfo.transfers++
    aiInfo.state = 'done'
    // підтвердження першого раунду — лише раз (наступні з'єднання на запит ШІ його не затирають)
    if (confirms.manager && aiInfo.transfers === 1) aiInfo.firstConfirm = { plays: confirms.manager.plays, digit: confirms.manager.digit }
    delete confirms.manager
    // Раунд набору на запит ШІ — з чистого аркуша: свій ліміт повторів (VG_DIAL_RETRIES) і вікно, коди REFER першого
    // раунду не змішуємо з новими, reason — лише цього раунду. Перший раунд у журналі: причина — ai.why, повтори —
    // ai.firstRetries, код переведення — ai.firstXferCode; entry.retries — повтори менеджера за весь дзвінок.
    if (aiInfo.transfers === 1) {
      aiInfo.firstRetries = retries.manager
      aiInfo.firstXferCode = xferFinalCode ?? xferCode
    }
    retriesBefore += retries.manager
    retries.manager = 0
    xferCode = null
    xferFinalCode = null
    reason = null
    aiS = null
    aiRound++
    // ШІ з'єднує з оператором (загальна група VG_MANAGER, AI-CONNECTING) — і з гілок обговорення теж
    if (afterHoursUrgent) setTarget({ ...urgentLead(), timeoutSec: config.managerTimeoutSec })
    else setOperator()
    dsRound = false
    target = 'manager'
    phase = 'dialing'
    stageAt = null
    legB = null
    cardStarted = false
    cardPlaying = false
    xferAccepted = false
    xferWaits = 0
    confirm = null
    mark('aiTransfer')
    say('ИИ: клиент просит менеджера — звоню менеджеру')
    cardP = prepareAiCard()
    startHold()
    dial()
  }

  // Картка менеджеру на запит ШІ: звична картка + питання клієнта (номери телефонів прибрано)
  function prepareAiCard() {
    const q = aiInfo?.note?.question
    const extra = q ? `Питання клієнта: ${q}` : aiInfo?.transferReason ? `Клієнт просить менеджера: ${aiInfo.transferReason}` : "Клієнт просить з'єднати з менеджером."
    const text = hidePhones(`${afterHoursUrgent ? 'Термінове звернення в неробочий час. ' : ''}${cardText || 'Дзвонить клієнт.'} ${extra}`).slice(0, 300)
    if (!tts) return Promise.resolve(null)
    return Promise.resolve().then(() => tts(text)).then((r) => (r && r.file ? r : null), (e) => {
      err('tts', e?.message)
      return null
    })
  }

  // Менеджер на запит ШІ не взяв: знову ШІ (нова сесія: менеджер не відповів; з'єднати ще раз — лише якщо aiTransferMax
  // дозволяє). Клієнт сам просив менеджера, а перша фраза цієї сесії (і «лінія зайнята») обіцяє передзвін: якщо його
  // немає (клієнт раніше відмовився — callback:false), ставимо знову, з уже записаним питанням.
  function aiTransferFailed(why, { joined = false } = {}) {
    aiInfo.failedBy = joined ? 'join' : 'dial'
    if (!pendingCb?.stored) {
      const n = aiInfo.note
      savePending({ note: n ? { question: n.question, topic: n.topic, urgent: n.urgent } : null })
      if (pendingCb.stored) {
        pendingCb.restored = true
        if (aiInfo.note) aiInfo.note.callback = true // підсумок «Домовилися» — «менеджер передзвонить», а не «не треба»
        say('клиент просил менеджера — перезвон поставлен снова')
      }
    }
    if (!aiReady()) return busyCallback(why)
    phase = 'ai'
    aiInfo.sessionKind = 'transfer_failed'
    aiInfo.state = 'wait'
    if (holdOn && (v2 || (config.holdTone === 'ringback' && config.ringbackFile))) {
      // гудки після невдалого набору — не «ще дзвонимо»: у «ШІ одразу» тиша, поки ШІ не заговорить; у старому режимі
      // (VG_NO_ANSWER_MODE=ai з гудками) — звичне утримання 05-hold (aiHold), як перед першою сесією
      holdOn = false
      send({ cmd: 'stop', call: A })
    }
    mark('aiBack')
    say(`${W().noAnswer} (${why}) — снова ИИ`)
    maybeAi()
  }

  // Клієнт поклав під час розмови з ШІ (або поки чекали DISCONNECTED після кінця сесії — тоді aiS уже скінчена)
  function aiClientGone() {
    cancel('aiDown')
    const sess = aiS
    aiS = null
    if (sess && !sess.ended) sess.stop('client_hangup')
    aiInfo.state = 'done'
    outcome = aiInfo.note ? 'ai_noted' : 'ai_client_hangup'
    say(`клиент положил трубку во время разговора с ИИ${aiInfo.note ? ' — вопрос записан' : ''}`)
    finish()
  }

  // ---------- приєднання менеджера, що передзвонив (joinOnCallback) ----------

  // Чи клієнт «чекає саме цього менеджера» (рішення 16): {status: 'joinable', lastDialedAt, since} — фаза ai з перезвоном
  // у групі менеджера або шлюз зараз набирає цього менеджера; {status: 'busy'} — клієнта вже з'єднують із ним (картка,
  // «1», REFER, міст) або приєднання триває; null — ні те, ні те.
  function joinableFor(group) {
    if (done || callback || !group?.length || legA.down || legA.gone) return null
    if (v2 && intro !== 'done') return null
    const inGroup = (k) => group.includes(k)
    const mine = mgrGroup.some(inGroup)
    if (join && !join.result) return join.group.some(inGroup) || mine ? { status: 'busy' } : null
    if (['card', 'confirm', 'xferWait', 'transferring', 'bridged'].includes(phase) && (legB?.join ? !!join?.group.some(inGroup) : target === 'manager' && mine)) return { status: 'busy' }
    const lastDial = [...dials].reverse().find((d) => d.to === 'manager')
    const st = { status: 'joinable', lastDialedAt: lastDial ? t0 + lastDial.at : null, since: t0 }
    if (phase === 'dialing' && target === 'manager' && mine) return st
    // ai — розмова з ШІ; prelude — фраза 16 перед ШІ (ведучий щойно не взяв і вже передзвонює)
    if ((phase === 'ai' || phase === 'prelude') && waitsFor(group)) return st
    return null
  }

  // Перезвін цьому клієнту в групі менеджера: поставлений у цьому дзвінку або ще з попереднього (callbacks.json — один
  // запис на пару клієнт + менеджер, живе callbackTtlHours; у «ШІ одразу» на старті перезвону немає, тож старий запис —
  // єдиний слід того, що менеджер не взяв). Клієнт у цьому дзвінку відмовився від передзвону — не чекає.
  function waitsFor(group) {
    if (pendingCb?.stored && group.includes(pendingCb.managerKey)) return true
    if (!phone || !callbacks?.listPending || callbackRefused()) return false
    try {
      return callbacks.listPending(group).some((x) => x.clientNumber === phone)
    } catch (e) {
      err('callbacks', e?.message)
      return false
    }
  }

  // Диспетчер віддав нам вхідну ногу менеджера (mc — managerCaller). Відповідаємо, скасовуємо набір цього менеджера,
  // зупиняємо ШІ (aiS = null раніше за stop: запізнілі onEnd / transfer / end_call ігноруються). Далі — maybeJoinPlay.
  function adoptManager(ev, mc) {
    const st = joinableFor(mc?.group)
    if (!st || st.status !== 'joinable') return false
    const fromPhase = phase
    joinsCount++
    join = {
      call: ev.call, key: mc.key, group: mc.group, gcid: ev.gcid ?? null, number: strictPhone(ev.number) || String(ev.number ?? '').trim() || null,
      internal: !mc.external, fromPhase, at: clock.now(), mode: config.joinMode === 'refer' ? 'refer' : 'bridge',
      state: 'answer', result: null, ms: null, client: 'none', mgr: 'none', q: 'none', qFile: null, tail: false, entryDone: false, marks: {},
      withAi: fromPhase === 'ai' || aiRound > 0, // клієнт говорив із ШІ (з фази ai або набір на прохання ШІ)
    }
    mark('join')
    if (fromPhase === 'dialing') {
      // шлюз саме дзвонив цьому менеджеру — набір скасовуємо (CANCEL), у менеджера не буде двох дзвінків
      for (const k of STAGE_TIMERS) cancel(k)
      if (pendingRef) {
        abandoned.add(pendingRef)
        pendingRef = null
      }
      if (bAlive()) hangup(legB.call)
      // ведучий у режимі обговорення сам передзвонив, поки шлюз дзвонив йому: це не пропуск
      dsRound = false
      cancel('dsWait')
    }
    if (fromPhase === 'prelude') {
      // фраза 16 перед ШІ: далі не ШІ, а приєднання (81 замінить 16)
      cancel('pre')
      cancel('preCap')
      pre = null
    }
    if (fromPhase === 'ai') {
      cancel('aiDown')
      cancel('aiInfo')
      cancel('aiGreeting')
      const sess = aiS
      aiS = null
      aiInfo.state = 'done'
      if (sess && !sess.ended) sess.stop('joined')
    }
    if (aiInfo) aiInfo.joins = (aiInfo.joins || 0) + 1
    // фраза 82, якщо грає, — до 81 (maybeJoinClient): менеджер може покласти раніше, ніж 81 почнеться, і тоді 82 не
    // обриваємо «лінія зайнята» (maybeNotice чекає її кінця)
    phase = 'joining'
    target = 'manager'
    legB = { call: ev.call, ref: null, join: true, confirmed: false, media: false, grace: false, down: false, ringing: false, code: null }
    cardStarted = false
    cardPlaying = false
    xferAccepted = false
    xferWaits = 0
    confirm = null
    send({ cmd: 'answer', call: ev.call, code: 200 })
    later('joinAck', JOIN_ACK_MS, () => joinManagerGone('join_no_ack'))
    later('joinCap', JOIN_CAP_MS, () => joinConnect('cap'))
    // Резюме для менеджера (MGR-JOIN: «Суть звернення: {резюме}. ‖ З’єдную.») — лише якщо синтез устигне за JOIN_Q_WAIT_MS
    // источник: runferry-briefs segments-texts-draft 5а (fe08058)
    // (менеджер уже на лінії, клієнт чекає); резюме коротке, без телефонів
    const q = join.withAi ? joinSummary(aiInfo?.note?.question) : ''
    if (q && tts) {
      const j = join
      j.q = 'pending'
      later('joinQ', JOIN_Q_WAIT_MS, () => {
        if (j.q !== 'pending') return
        j.q = 'late'
        maybeJoinQ()
      })
      Promise.resolve().then(() => tts(speakable(`Суть звернення: ${q}. ‖ ${config.joinPromptTexts?.mgrJoinTail || 'З’єдную.'}`))).then((r) => {
        if (join !== j || j.q !== 'pending') return
        j.q = r?.file ? 'ready' : 'none'
        j.qFile = r?.file || null
        cancel('joinQ')
        maybeJoinQ()
      }, (e) => {
        err('tts', e?.message)
        if (join !== j || j.q !== 'pending') return
        j.q = 'none'
        cancel('joinQ')
        maybeJoinQ()
      })
    }
    say(`менеджер перезвонил — присоединяю к клиенту (${fromPhase === 'dialing' ? 'звонок ему отменён' : 'ИИ остановлен'}; ${join.mode === 'refer' ? 'REFER' : 'мост'})`)
    return true
  }

  function onJoinConfirmed() {
    legB.confirmed = true
    cancel('joinAck')
    join.marks.confirmed = clock.now() - join.at
    if (!legB.media) {
      const leg = legB
      later('joinGrace', config.mediaGraceMs, () => {
        leg.grace = true
        maybeJoinPlay()
        maybeJoinGone()
      })
    }
    maybeJoinPlay()
    maybeJoinGone()
  }

  // У нозі менеджера є звук: клієнту 81, менеджеру MGR-JOIN — одночасно: «Клієнт зараз говорить із віртуальним
  // помічником.», далі «Суть звернення: {резюме}. ‖ З’єдную.» (синтез) або «З’єдную.» (mgrJoinTail). Клієнт із ШІ не говорив
  // (класичний набір, набір після 82, обговорення) — менеджеру «Клієнт на лінії — з'єдную.» (mgrJoinPlain)
  function maybeJoinPlay() {
    if (phase !== 'joining' || !join || join.state !== 'answer' || !bAlive() || !legReady(legB)) return
    join.state = 'phrases'
    join.marks.ready = clock.now() - join.at
    const mf = prompt(join.withAi ? 'mgrJoin' : 'mgrJoinPlain')
    if (mf) {
      join.mgr = 'playing'
      send({ cmd: 'play', call: legB.call, file: mf, loop: false, tag: 'mgrJoin' })
      later('joinMgr', PROMPT_MAX_MS, onJoinMgrDone)
    } else join.mgr = 'done'
    maybeJoinClient()
    maybeJoinQ()
  }

  function maybeJoinClient() {
    if (phase !== 'joining' || !join || join.state !== 'phrases' || join.client !== 'none' || legA.down || legA.gone) return
    if (dsPlay === 'playing') return // фразу 13/14/15 не обриваємо: onDsPlayed покличе знову
    if (greeting === 'playing') {
      // привітання (класичний набір) не обриваємо — 81 після нього (onGreetingDone покличе знову)
      if (tm.joinGreeting == null) later('joinGreeting', PROMPT_MAX_MS, () => { greeting = 'done'; maybeJoinClient() })
      return
    }
    cancel('joinGreeting')
    const cf = prompt('joinClient')
    if (!cf) {
      // 81 немає (WAV ще не зроблені): поки менеджер слухає фрази — гудки чи утримання, а не тиша після обірваного ШІ
      join.client = 'done'
      joinHold()
      return maybeJoinConnect()
    }
    if (aiDownPlay === 'playing') {
      // фразу 82 замінює 81 («Менеджер уже на лінії…»)
      aiDownPlay = 'done'
      cancel('aiDownPlay')
    }
    join.client = 'playing'
    holdOn = false
    send({ cmd: 'play', call: A, file: cf, loop: false, tag: 'join' })
    later('joinClient', PROMPT_MAX_MS, onJoinClientDone)
  }

  function onJoinClientDone() {
    if (!join || join.client !== 'playing') return
    join.client = 'done'
    cancel('joinClient')
    // менеджер ще слухає питання клієнта — клієнту гудки (якщо задано), щоб не було тиші
    joinHold({ ringbackOnly: true })
    maybeJoinConnect()
  }

  // Приєднання: клієнт чекає, поки менеджер дослухає фрази, — гудки (holdTone ringback), інакше утримання (після 81 —
  // лише гудки: «з'єдную вас» уже прозвучало). Не поверх привітання, 82 чи утримання, що вже грає.
  function joinHold({ ringbackOnly = false } = {}) {
    if (phase !== 'joining' || !join || join.mgr === 'finished' || holdOn || legA.down || legA.gone || greeting === 'playing' || aiDownPlay === 'playing' || dsPlay === 'playing') return
    const file = config.holdTone === 'ringback' && config.ringbackFile ? config.ringbackFile : ringbackOnly ? null : config.holdFile
    if (!file) return
    holdOn = true
    send({ cmd: 'play', call: A, file, loop: true, tag: 'hold' })
  }

  function onJoinMgrDone() {
    if (!join || join.mgr !== 'playing') return
    join.mgr = 'done'
    cancel('joinMgr')
    maybeJoinQ()
  }

  // Після першої частини MGR-JOIN — «Суть звернення: {резюме}. ‖ З’єдную.», якщо синтез готовий (чекаємо не довше
  // JOIN_Q_WAIT_MS від приєднання), інакше «З’єдную.» (mgrJoinTail; клієнт говорив із ШІ)
  function maybeJoinQ() {
    if (phase !== 'joining' || !join || join.mgr !== 'done' || join.q === 'pending') return
    if (join.q === 'ready' && bAlive()) {
      join.q = 'playing'
      join.mgr = 'question'
      send({ cmd: 'play', call: legB.call, file: join.qFile, loop: false, tag: 'mgrJoinQ' })
      later('joinMgr', PROMPT_MAX_MS, onJoinQDone)
      return
    }
    const tail = join.withAi && !join.tail ? prompt('mgrJoinTail') : null
    if (tail && bAlive()) {
      join.tail = true
      join.mgr = 'question'
      send({ cmd: 'play', call: legB.call, file: tail, loop: false, tag: 'mgrJoinQ' })
      later('joinMgr', PROMPT_MAX_MS, onJoinQDone)
      return
    }
    join.mgr = 'finished'
    maybeJoinConnect()
  }

  function onJoinQDone() {
    if (!join || join.mgr !== 'question') return
    if (join.q === 'playing') join.q = 'played'
    join.mgr = 'finished'
    cancel('joinMgr')
    maybeJoinConnect()
  }

  function maybeJoinConnect() {
    if (phase === 'joining' && join?.client === 'done' && join.mgr === 'finished') joinConnect('phrases')
  }

  // Фрази дограно (або межа JOIN_CAP_MS): міст через шлюз (типово) або REFER на нозі клієнта з Replaces ноги менеджера
  function joinConnect(by) {
    if (phase !== 'joining' || !join || done) return
    for (const k of JOIN_TIMERS) cancel(k)
    if (legA.down) return joinClientGone()
    if (!bAlive()) return joinManagerGone('join_hangup')
    if ((v2 && intro !== 'done') || (greetIntro && greeting !== 'done')) return introFailedClosed()
    if (by === 'cap') err('join', 'phrases cap')
    join.state = 'connecting'
    if (join.mode === 'refer' && legA.confirmed && legB.confirmed) {
      phase = 'transferring'
      xferLeg = A
      xferAccepted = false
      xferCode = null
      xferFinalCode = null
      send({ cmd: 'xfer_replaces', call: A, dest: legB.call })
      join.marks.xfer = clock.now() - join.at
      say('соединяю клиента с перезвонившим менеджером (REFER/Replaces на ноге клиента)')
      later('xfer', config.xferTimeoutMs, onXferTimeout)
      return
    }
    say('соединяю клиента с перезвонившим менеджером через шлюз (мост)')
    bridgeOrRecover()
  }

  function joinSettled(result) {
    if (!join || join.result) return
    join.result = result
    join.state = 'done'
    join.ms = clock.now() - join.at
  }

  // Менеджер поклав (або не підтвердив відповідь) до з'єднання: знову ШІ (transfer_failed; перезвін — у групу менеджера,
  // якщо його ще немає), без ШІ — як «не взяв»
  function joinManagerGone(why, { hung = false } = {}) {
    if (!join || join.result || done) return
    for (const k of JOIN_TIMERS) cancel(k)
    if (!hung && bAlive()) hangup(legB.call)
    joinSettled('manager_gone')
    emitJoinEntry('callback_cancelled', why)
    reason = why
    legB = null // запізнілі події ноги менеджера вже не наші
    if (legA.down || legA.gone) {
      outcome = 'client_hangup'
      return finish()
    }
    say('менеджер положил трубку до соединения — клиент снова с ИИ')
    if (join.client === 'playing' || holdOn) {
      // 81 / гудки обриваємо: далі знову ШІ (або «не взяв»)
      join.client = 'done'
      holdOn = false
      send({ cmd: 'stop', call: A })
    }
    if (aiInfo && aiReady()) return aiTransferFailed(why, { joined: true })
    // обговорення: ведучий приєднався, поки шлюз йому дзвонив, і поклав до з'єднання — 16 і ШІ (не пропуск: він передзвонив)
    if (!aiInfo && ds?.lead && v2 && route?.branch === 'discussion') return dsFailed(why, { noMiss: true })
    return noManager(why)
  }

  // Клієнт поклав під час приєднання: менеджеру «Клієнт поклав слухавку.», відбій; перезвін лишається (не було — пропущений)
  function joinClientGone() {
    if (!join || join.result) return
    for (const k of JOIN_TIMERS) cancel(k)
    joinSettled('client_gone')
    outcome = 'client_hangup'
    if (!pendingCb?.stored && !callbackRefused()) savePending({ missed: true })
    say(`клиент положил трубку во время присоединения — сообщаю менеджеру${pendingCb?.stored ? ', перезвон остаётся' : ''}`)
    if (!bAlive()) return finish()
    phase = 'joinGone'
    join.gone = 'wait'
    later('joinGone', JOIN_ACK_MS + PROMPT_MAX_MS, joinGoneDone)
    maybeJoinGone()
  }

  function maybeJoinGone() {
    if (phase !== 'joinGone' || join?.gone !== 'wait' || !bAlive() || !legReady(legB)) return
    const f = prompt('mgrJoinGone')
    if (!f) return joinGoneDone()
    join.gone = 'playing'
    send({ cmd: 'play', call: legB.call, file: f, loop: false, tag: 'mgrJoinGone' })
    later('joinGone', PROMPT_MAX_MS, joinGoneDone)
  }

  function joinGoneDone() {
    if (phase !== 'joinGone') return
    cancel('joinGone')
    if (join) join.gone = 'done'
    if (bAlive()) hangup(legB.call)
    finish()
  }

  // Журнал приєднання — без номерів: звідки, скільки тривало до з'єднання, як, чим скінчилось
  const joinInfo = () => (join
    ? { fromPhase: join.fromPhase, ms: join.ms, mode: join.mode, result: join.result, attempts: joinsCount, question: join.q === 'played', ...(join.marks.confirmed != null ? { answerMs: join.marks.confirmed } : {}) }
    : null)

  // Окремий рядок журналу для дзвінка менеджера, що приєднувався (kind callback), — через onExtra (без active.delete)
  function emitJoinEntry(out, why = null) {
    if (!join || join.entryDone) return
    join.entryDone = true
    const now = clock.now()
    onExtra({
      v: 3,
      kind: 'callback',
      startedAt: new Date(join.at).toISOString(),
      endedAt: new Date(now).toISOString(),
      durationMs: now - join.at,
      gcid: join.gcid,
      number: join.number,
      internal: join.internal,
      outcome: out,
      reason: why,
      abortReason,
      noAnswerMode,
      callback: { managerKey: join.key, source: 'join', client: phone ? clientShown(phone) : null, gcid, serviceRequestId, pendingId: pendingCb?.id ?? null, removed: (pendingRemoved || 0) > 0, attempts: null, dropped: false, waitedMs: null, referOn: join.mode === 'refer' ? 'client' : null },
      join: joinInfo(),
      t: { ...join.marks },
      errors: [],
    })
  }

  // ---------- остання фраза на A і відбій ----------

  // «Лінія зайнята…» клієнту, «Клієнт не відповідає.» / «немає клієнтів» менеджеру — і кладемо трубку. Підсумок уже
  // відомий (out). Привітання, якщо ще грає, догрує (не обриваємо на півслові); фрази немає — кладемо одразу.
  function notice(name, out) {
    phase = 'notice'
    outcome = out
    ntc = { name, state: 'wait' }
    mark('notice')
    later('ntcCap', NOTICE_CAP_MS, noticeDone)
    maybeNotice()
  }

  function maybeNotice() {
    if (phase !== 'notice' || !ntc || ntc.state !== 'wait' || legA.down || !legReady(legA)) return
    if (aiDownPlay === 'playing' || dsPlay === 'playing') return // фразу 82 / 13–15 не обриваємо: покличуть знову
    if (greeting === 'playing') {
      if (tm.ntcGreeting == null) later('ntcGreeting', PROMPT_MAX_MS, () => { greeting = 'done'; maybeNotice() })
      return
    }
    cancel('ntcGreeting')
    if (holdOn) {
      holdOn = false
      send({ cmd: 'stop', call: A })
    }
    const file = pickVariant(ntc.name) // клієнтські фрази з повним і коротким варіантом (17, 83…); решта — як є
    if (!file) return noticeDone()
    ntc.state = 'playing'
    send({ cmd: 'play', call: A, file, loop: false, tag: ntc.name })
    mark('noticePlay')
    later('ntc', PROMPT_MAX_MS, noticeDone)
  }

  function noticeDone() {
    if (!ntc || ntc.state === 'done') return
    ntc.state = 'done'
    cancel('ntc')
    cancel('ntcCap')
    mark('noticeDone')
    if (!legA.down) hangup(A)
    finish()
  }

  // ---------- голосова пошта ----------

  function startVoicemail(why) {
    phase = 'voicemail'
    if (config.voicemailEnabled === false || config.recordSupported === false || !voicemailPath) {
      err('voicemail', config.recordSupported === false ? 'engine without record' : 'disabled')
      outcome = 'failed'
      say('никто не ответил, голосовая почта недоступна — кладу трубку')
      hangup(A)
      return finish()
    }
    vm = { state: 'wait', file: null, sec: null, stop: null, startedAt: null }
    mark('voicemail')
    say(`никто не ответил (${why}) — голосовая почта`)
    maybeVoicemail()
  }

  // Утримання зупиняємо, далі: фраза → сигнал → запис. Нога A ще не готова — чекаємо. Привітання ще грає (менеджер і
  // запасна відмовили за 1–2 с) — даємо догратися, щоб не обірвати на півслові: onGreetingDone покличе знову;
  // play_done загубився — не довше VM_PROMPT_MAX_MS.
  function maybeVoicemail() {
    if (phase !== 'voicemail' || !vm || vm.state !== 'wait' || legA.down || !legReady(legA)) return
    if (aiDownPlay === 'playing') return // фразу 82 не обриваємо: onAiDownPlayed покличе знову
    if (greeting === 'playing') {
      if (tm.vmGreeting == null) later('vmGreeting', VM_PROMPT_MAX_MS, () => { greeting = 'done'; maybeVoicemail() })
      return
    }
    cancel('vmGreeting')
    holdOn = false
    send({ cmd: 'stop', call: A })
    if (!config.voicemailPromptFile) return vmBeep()
    vm.state = 'prompt'
    send({ cmd: 'play', call: A, file: config.voicemailPromptFile, loop: false, tag: 'voicemail' })
    mark('vmPrompt')
    later('vmStep', VM_PROMPT_MAX_MS, vmBeep)
  }

  function vmBeep() {
    if (!vm || (vm.state !== 'wait' && vm.state !== 'prompt')) return
    cancel('vmStep')
    if (!config.beepFile) return vmRecord()
    vm.state = 'beep'
    send({ cmd: 'play', call: A, file: config.beepFile, loop: false, tag: 'beep' })
    mark('vmBeep')
    later('vmStep', VM_BEEP_MAX_MS, vmRecord)
  }

  function vmRecord() {
    if (!vm || (vm.state !== 'wait' && vm.state !== 'prompt' && vm.state !== 'beep')) return
    cancel('vmStep')
    let file = null
    try {
      file = voicemailPath({ gcid, number: phone || number || null })
    } catch (e) {
      err('voicemail', e?.message)
    }
    if (!file) return vmFailed('no file')
    vm.state = 'rec'
    vm.file = file
    vm.startedAt = clock.now()
    send({ cmd: 'record', call: A, file })
    mark('vmRecord')
    say(`записываю сообщение (до ${config.voicemailMaxSec} с)`)
    later('vmMax', config.voicemailMaxSec * 1000, () => vmStop('max'))
  }

  // Зупинка запису: рушій закриває WAV і шле record_done; нога A вже розірвана — рушій зупинив запис сам.
  function vmStop(why) {
    if (!vm || vm.state !== 'rec') return
    cancel('vmMax')
    vm.state = 'stopping'
    vm.stop = why
    if (!legA.down) send({ cmd: 'record_stop', call: A })
    later('vmDone', VM_DONE_WAIT_MS, () => onRecordDone(null))
  }

  function onRecordDone(ev) {
    if (!vm || (vm.state !== 'rec' && vm.state !== 'stopping')) return
    cancel('vmMax')
    cancel('vmDone')
    if (vm.state === 'rec') vm.stop = legA.down ? 'client_hangup' : 'engine' // рушій зупинив запис сам
    vm.state = 'done'
    if (ev && Number.isFinite(Number(ev.sec))) vm.sec = Number(ev.sec)
    else {
      vm.sec = null
      err('voicemail', ev ? 'record_done without sec' : 'no record_done')
    }
    mark('vmDone')
    // Порожньо: клієнт поклав одразу після сигналу (так роблять часто), звук не дійшов до запису або файла немає.
    // Окремий підсумок — щоб пропущений дзвінок не виглядав залишеним повідомленням; файл прибирає gateway.mjs.
    const minSec = config.voicemailMinSec != null && Number.isFinite(Number(config.voicemailMinSec)) ? Number(config.voicemailMinSec) : 1
    vm.empty = !!ev && (ev.missing === true || (vm.sec != null && vm.sec < minSec))
    if (vm.empty) {
      outcome = 'voicemail_empty'
      say(`сообщения нет (${ev.missing ? 'файла нет' : `запись ${vm.sec.toFixed(1)} с`}${vm.stop === 'client_hangup' ? ', клиент положил трубку сразу после сигнала' : ''})`)
    } else {
      outcome = 'voicemail'
      say(`сообщение записано${vm.sec != null ? ` (${vm.sec.toFixed(1)} с)` : ''}`)
    }
    if (!legA.down) hangup(A)
    finish()
  }

  function vmFailed(msg) {
    if (msg) err('voicemail', msg)
    if (vm && vm.state === 'rec') vm.file = null // рушій запис не почав
    if (vm) vm.state = 'done'
    outcome = 'failed'
    say('голосовая почта не удалась — кладу трубку')
    if (!legA.down) hangup(A)
    finish()
  }

  // ---------- завершення ----------

  function clearLegs() {
    if (!legA.down) hangup(A)
    if (bAlive()) hangup(legB.call)
    finish()
  }

  // A поклав (клієнт; на передзвоні — менеджер): кладемо B або скасовуємо набір, що ще йде. Приєднання ще не скінчилось
  // (фрази або REFER приєднання, що не вдався чи лишився без відповіді, а нога менеджера жива) — менеджеру mgrJoinGone
  function clientGone() {
    if (legB?.join && join && !join.result && (phase === 'joining' || phase === 'transferring')) return joinClientGone()
    const dialingNow = phase === 'dialing'
    const before = phase
    outcome = callback ? 'callback_cancelled' : 'client_hangup'
    // обговорення: клієнт поклав під час фрази чи гудків — пропущений перезвін ведучому (нижче), пропуску немає
    if (dsRound) {
      dsRound = false
      dsResult = { miss: false, why: 'client_hangup' }
      emitRoute('client_hangup')
    }
    if (pendingRef) {
      abandoned.add(pendingRef)
      pendingRef = null
    }
    if (bAlive()) hangup(legB.call)
    // busy: менеджеру вже дзвонили (у нього пропущений від шлюзу), а клієнт не дочекався — передзвін має дістатися
    // саме цьому клієнту, а не тому, хто чекає з ранку чи був «останнім» тиждень тому. ai — так само, поки ШІ ще не
    // відповідав (перший набір менеджера; потім передзвін ставить сам ШІ). Уже є запис (pendingCb) — другого не робимо.
    const missedMode = noAnswerMode === 'busy' || (noAnswerMode === 'ai' && !aiInfo)
    // «ШІ одразу»: перезвону на старті немає — клієнт поклав, поки менеджеру дзвонили (на прохання ШІ чи після 82), —
    // пропущений у групу того, кому дзвонили (якщо перезвону ще немає і клієнт від нього не відмовлявся)
    const missedNow = v2 ? !pendingCb?.stored && !callbackRefused() : missedMode && !pendingCb
    const missed = !callback && missedNow && config.callbackOnHangup !== false && target === 'manager' &&
      ['dialing', 'card', 'confirm', 'xferWait', 'transferring'].includes(before) && dials.some((d) => d.to === 'manager')
    if (missed) savePending({ missed: true })
    say(callback ? `менеджер положил трубку${dialingNow ? ' — отменяю звонок клиенту' : ''}` : `клиент положил трубку${missed && pendingCb?.stored ? ' — перезвон сохранён (у менеджера пропущенный)' : ''}`)
    finish()
  }

  // ---------- розрив ніг ----------

  function onADown(code) {
    legA.down = true
    legA.code = code ?? null
    mark('clientDown')
    switch (phase) {
      case 'pin':
      case 'route': // поклав під час вступу 80 — без перезвону (менеджеру не дзвонили)
      case 'dialing':
      case 'card':
      case 'confirm':
      case 'xferWait':
        return clientGone()
      case 'prelude':
        // поклав під час фрази 16 — перезвін ведучому вже стоїть
        outcome = 'client_hangup'
        say(`клиент положил трубку${pendingCb?.stored ? ' — перезвон ведущему сохранён' : ''}`)
        return finish()
      case 'joining':
        return joinClientGone()
      case 'transferring':
        // АТС після REFER гасить обидві ноги — це не обов'язково A поклав. Чекаємо NOTIFY або тайм-аут.
        if (!bAlive()) later('bothDown', 1000, unconfirmed)
        return
      case 'bridged':
        if (bAlive()) hangup(legB.call)
        say(`${aName} положил трубку`)
        return finish()
      case 'connected':
        if (!bAlive()) finish()
        return
      case 'fallback':
        return finish()
      case 'notice':
        // поклав під час останньої фрази — підсумок уже є (busy_callback, callback_no_answer…)
        return finish()
      case 'ai':
        return aiClientGone()
      case 'voicemail':
        // Поклав під час запису — запис зберігаємо: рушій сам закриває файл і шле record_done
        if (vm?.state === 'rec') {
          cancel('vmMax')
          vm.state = 'stopping'
          vm.stop = 'client_hangup'
          say('клиент положил трубку — сохраняю запись')
          later('vmDone', VM_DONE_WAIT_MS, () => onRecordDone(null))
          return
        }
        if (vm?.state === 'stopping') return
        return clientGone()
      default:
    }
  }

  function onBDown(code) {
    legB.down = true
    legB.code = code ?? null
    if (!legB.join) bCodes[target] = code ?? null // нога приєднаного менеджера — не код набору
    const d = dialByCall.get(legB.call)
    if (d && d.code == null) d.code = code ?? null
    switch (phase) {
      case 'joining':
        say('менеджер положил трубку до соединения')
        return joinManagerGone('join_hangup', { hung: true })
      case 'joinGone':
        return finish()
      case 'dialing':
        return dialFailed(code, 'hangup')
      case 'card':
      case 'confirm':
      case 'xferWait':
        markT('down')
        say(`${W().down} до перевода`)
        return stageFailed(`${target}_hangup`)
      case 'transferring':
        if (legA.down) later('bothDown', 1000, unconfirmed)
        return
      case 'bridged':
        if (!legA.down) hangup(A)
        say(W().down)
        return finish()
      case 'connected':
        if (legA.down) finish()
        return
      default:
    }
  }

  // ---------- події рушія ----------

  function onError(ev) {
    err(ev.cmd || 'engine', ev.msg)
    switch (ev.cmd) {
      case 'dial':
        if (ev.ref && ev.ref === pendingRef) {
          pendingRef = null
          dialFailed(0, 'engine')
        }
        return
      case 'play':
        if (ev.call === A && dsPlay === 'playing') onDsPlayed() // фраза 13/14/15 не зіграла — далі як дограна
        else if (ev.call === A && phase === 'prelude' && pre?.state === 'playing') preDone()
        else if (ev.call === A && phase === 'route' && intro === 'playing') onIntroDone(true)
        else if (ev.call === A && aiDownPlay === 'playing') onAiDownPlayed()
        else if (ev.call === A && phase === 'joining' && join?.client === 'playing') onJoinClientDone()
        else if (legB?.join && ev.call === legB.call && phase === 'joining' && join?.mgr === 'playing') onJoinMgrDone()
        else if (legB?.join && ev.call === legB.call && phase === 'joining' && join?.mgr === 'question') onJoinQDone()
        else if (legB?.join && ev.call === legB.call && phase === 'joinGone') joinGoneDone()
        else if (ev.call === A && phase === 'voicemail' && (vm?.state === 'prompt' || vm?.state === 'beep')) {
          if (vm.state === 'prompt') vmBeep()
          else vmRecord()
        } else if (ev.call === A && phase === 'notice' && ntc?.state === 'playing') noticeDone()
        else if (ev.call === A && phase === 'pin' && pin?.state === 'prompt') pinWait()
        else if (ev.call === A && greeting === 'playing') (greetIntro ? introFailedClosed() : onGreetingDone())
        else if (legB && ev.call === legB.call && phase === 'confirm' && confirm?.state === 'prompt') confirmWait()
        else if (legB && ev.call === legB.call && cardPlaying) onCardDone()
        return
      case 'record':
        if (ev.call === A && vm?.state === 'rec') vmFailed(null)
        return
      case 'answer':
        // рушій не зміг відповісти менеджеру, що приєднується, — як поклав
        if (legB?.join && ev.call === legB.call && phase === 'joining') joinManagerGone('join_answer_error')
        return
      case 'xfer_replaces':
        if (phase === 'transferring') onXfer({ code: 0, final: true, reason: 'engine error' })
        return
      case 'xfer':
        if (phase === 'fallback') onXfer({ code: 0, final: true, reason: 'engine error' })
        return
      case 'audio_start':
        // рушій не пустив звук до мозку — сесія ШІ без звуку марна: далі як busy
        if (ev.call === A && phase === 'ai' && aiS) aiS.stop('engine_error')
        return
      case 'bridge':
        if (phase === 'bridged') {
          outcome = 'failed'
          if (!legA.down) hangup(A)
          if (bAlive()) hangup(legB.call)
          finish()
        }
        return
      default: // record_stop на вже розірвану ногу тощо: record_done прийде від рушія або спрацює vmDone
    }
  }

  // Нога A стала готова (CONFIRMED + медіа або grace): PIN, привітання, пошта чи остання фраза, що чекали
  const onAReady = () => {
    maybeIntro()
    maybeDsPhrase()
    maybePre()
    maybePin()
    maybeGreeting()
    maybeVoicemail()
    maybeNotice()
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return
    if (done) {
      // Запізнілий набір, від якого ми вже відмовились, — одразу кладемо
      if (ev.ev === 'dialing' && (abandoned.has(ev.ref) || ev.ref === pendingRef)) hangup(ev.call)
      return
    }
    const isA = ev.call === A
    const isB = !!legB && ev.call === legB.call
    switch (ev.ev) {
      case 'dialing':
        return onDialing(ev)
      case 'state':
        if (isA) {
          if (ev.state === 'CONFIRMED' && !legA.confirmed) {
            legA.confirmed = true
            mark('clientConfirmed')
            if (!legA.media) later('graceA', config.mediaGraceMs, () => { legA.grace = true; onAReady() })
            onAReady()
          } else if (ev.state === 'DISCONNECTED' && !legA.down) onADown(ev.code)
        } else if (isB && !legB.down) {
          if (ev.state === 'EARLY') onBRinging()
          else if (ev.state === 'CONFIRMED' && !legB.confirmed) (legB.join ? onJoinConfirmed() : onBConfirmed())
          else if (ev.state === 'DISCONNECTED') onBDown(ev.code)
        } else if (ev.state === 'DISCONNECTED' && dialByCall.has(ev.call)) {
          // нога, яку ми вже поклали (тайм-аут, перехід до запасної): лише код у журнал
          const d = dialByCall.get(ev.call)
          if (d.code == null) d.code = ev.code ?? null
          if (bCodes[d.to] == null) bCodes[d.to] = ev.code ?? null
        }
        return
      case 'media':
        if (isA && ev.active) {
          legA.media = true
          cancel('graceA')
          onAReady()
        } else if (isB && ev.active) {
          legB.media = true // може прийти й у EARLY (183): картку граємо лише після CONFIRMED
          if (legB.join) {
            if (legB.confirmed) cancel('joinGrace')
            maybeJoinPlay()
            maybeJoinGone()
          } else {
            if (legB.confirmed) cancel('graceB')
            maybeCard()
          }
        }
        return
      case 'play_done':
        if (isA && ev.tag === 'ds') onDsPlayed()
        else if (isA && phase === 'prelude' && pre && ev.tag === pre.name) preDone()
        else if (isA && ev.tag === 'intro') onIntroDone()
        else if (isA && ev.tag === 'aiDown') onAiDownPlayed()
        else if (isA && ev.tag === 'join') onJoinClientDone()
        else if (isB && legB.join && ev.tag === 'mgrJoin') onJoinMgrDone()
        else if (isB && legB.join && ev.tag === 'mgrJoinQ') onJoinQDone()
        else if (isB && legB.join && ev.tag === 'mgrJoinGone') joinGoneDone()
        else if (isA && ev.tag === 'pin') pinWait()
        else if (isA && ev.tag === greetTag) onGreetingDone()
        else if (isA && ntc && ev.tag === ntc.name) noticeDone()
        else if (isA && ev.tag === 'voicemail') vmBeep()
        else if (isA && ev.tag === 'beep') vmRecord()
        else if (isB && ev.tag === cardTag) onCardDone()
        else if (isB && ev.tag === 'confirm') confirmWait()
        return
      case 'dtmf':
        if (isB) onDtmf(ev)
        else if (isA && phase === 'pin') onPinDigit(String(ev.digit ?? '').trim())
        return
      case 'record_done':
        if (isA) onRecordDone(ev)
        return
      case 'audio':
        // Рушій закрив потік звуку A, бо нога розірвалась. Рушій шле це за 'state DISCONNECTED' (по stdout порядок
        // гарантований), а закриття сокета ШІ йде іншим каналом і може випередити обидва (onAiEnd чекає
        // AI_DOWN_GRACE_MS) — позначка лише страховка: з цієї миті команд на A не шлемо
        if (isA && ev.state === 'closed' && ev.reason === 'hangup') legA.gone = true
        return
      case 'xfer':
        if (ev.call === xferLeg) onXfer(ev)
        return
      case 'error':
        return onError(ev)
      default:
    }
  }

  // Аварійне завершення без команд рушію (рушій упав, вихід шлюзу). Причини по менеджеру й запасній лишаємо як є,
  // чому обірвали — окремо (abortReason).
  function abort(why) {
    if (done) return
    abortReason = why
    const sess = aiS
    aiS = null
    if (sess && !sess.ended) sess.stop(why)
    if (vm?.file && (vm.state === 'rec' || vm.state === 'stopping')) {
      // Запис уже йшов: файл є (при зупинці шлюзу рушій його закриває, після падіння заголовок лагодить gateway.mjs) —
      // це повідомлення клієнта, а не просто обірваний дзвінок
      if (vm.state === 'rec') vm.stop = 'aborted'
      outcome = 'voicemail'
    } else if (phase !== 'connected' && phase !== 'notice' && phase !== 'joinGone') outcome = 'aborted' // переведення вже вдалося / підсумок останньої фрази вже є
    finish()
  }

  function finish() {
    if (done) return
    done = true
    phase = 'done'
    for (const h of timers) clock.clearTimeout(h)
    timers.clear()
    if (aiS && !aiS.ended) {
      const sess = aiS
      aiS = null
      sess.stop('call_end')
    }
    mark('end')
    const aiRes = (aiInfo?.sessions || []).map((x) => ({ kind: x.kind, at: x.at, r: x.s.result() }))
    // клієнт поговорив із ШІ при відкритому обговоренні — сервер режиму лише продовжить строк (pending_call — ні, вирішує він)
    if (ds && ds.kind !== 'pending' && aiRes.some(({ r }) => r.turns?.some((t) => t.speaker === 'client' && t.text?.trim()))) emitRoute('ai_ended')
    const conf = Object.fromEntries(Object.entries(confirms).map(([k, v]) => [k, { plays: v.plays, digit: v.digit }]))
    const entry = {
      v: 3,
      kind,
      startedAt: new Date(t0).toISOString(),
      endedAt: new Date(clock.now()).toISOString(),
      durationMs: clock.now() - t0,
      gcid,
      number: shownNumber,
      internal,
      outcome,
      reason,
      fallbackReason,
      abortReason,
      answeredBy,
      ...(afterHoursUrgent ? { afterHoursUrgent: true } : {}),
      noAnswerMode,
      fallbackMode,
      category,
      serviceRequestId,
      lookup: lookupState === 'pending' ? 'unfinished' : lookupState,
      cardSource,
      fbCardSource,
      cardChars,
      confirm: Object.keys(conf).length ? conf : null,
      // busy: відкладений передзвін; передзвін: кому й звідки (номер клієнта — за правилами маски)
      callback: callback
        ? { managerKey: cb?.managerKey ?? callerManager, source: cb?.source ?? null, client: cb?.number ? clientShown(cb.number) : null, gcid: cb?.gcid ?? null, serviceRequestId: cb?.serviceRequestId ?? null, pendingId: cb?.id ?? null, removed: !!cb?.removed, attempts: cb?.attempts ?? null, dropped: !!cb?.dropped, waitedMs: cb?.waitedMs ?? null, referOn: referOnClient ? 'client' : 'manager' }
        : pendingCb,
      pendingRemoved, // клієнта з'єднано — стільки його відкладених передзвонів знято
      pin: pin ? pin.result || 'unfinished' : null, // зовнішній менеджер: ok | wrong | timeout (цифр немає)
      lastClientFor,
      dials: dials.map(({ to, attempt, at, code, ai: round }) => ({ to, attempt, at, code, ...(round ? { ai: round } : {}) })), // ai — набір на запит ШІ
      retries: retriesBefore + retries.manager, // повтори набору менеджера за весь дзвінок (з раундами на запит ШІ; перший — ai.firstRetries)
      fallbackRetries: retries.fallback,
      xferCode: xferFinalCode ?? xferCode,
      clientCode: legA.code,
      managerCode: callback ? null : bCodes.manager,
      fallbackCode: bCodes.fallback,
      ...(callback ? { calleeCode: bCodes.client } : {}),
      voicemail: vm && (vm.file || vm.stop) ? { file: vm.file, sec: vm.sec, stop: vm.stop, ...(vm.empty ? { empty: true } : {}) } : null,
      // ШІ: без тексту питання й розшифровки (особисті дані — лише в aiTranscript, gateway.mjs зберігає окремо)
      ai: aiInfo
        ? {
            kind: aiInfo.kind,
            why: aiInfo.why,
            ...(aiInfo.variant ? { variant: aiInfo.variant } : {}),
            ...(aiInfo.joins ? { joins: aiInfo.joins } : {}),
            transfers: aiInfo.transfers,
            error: aiInfo.error,
            endReason: aiInfo.endReason,
            firstConfirm: aiInfo.firstConfirm ?? null,
            firstRetries: aiInfo.firstRetries ?? null, // повтори першого раунду (до з'єднання на запит ШІ); без з'єднання — null
            firstXferCode: aiInfo.firstXferCode ?? null,
            note: aiInfo.note ? { topic: aiInfo.note.topic, urgent: aiInfo.note.urgent, callback: aiInfo.note.callback, chars: aiInfo.note.question.length } : null,
            ...(aiInfo.callbackRemoved ? { callbackRemoved: aiInfo.callbackRemoved } : {}), // callback:false зняв стільки перезвонів
            // costUsd — ОЦІНКА шлюзу лише за голос (VG_AI_PRICE_PER_MIN); фактичну ціну gateway.mjs читає за conversationId
            sessions: aiRes.map(({ kind, at, r }) => ({ kind, at, provider: r.provider, model: r.model, durationMs: r.durationMs, end: r.end, toolCalls: r.toolCalls, usage: r.usage, costUsd: r.costUsd, ...(r.conversationId ? { conversationId: r.conversationId } : {}), turns: r.turns.length, errors: r.errors })),
          }
        : null,
      // Розшифровка: службові теги голосу в репліках ШІ («[slow]», «[laughs]») прибрано — у файл, документ дзвінка й журнал
      // вони не потрапляють
      aiTranscript: aiRes.length
        ? {
            kind: aiInfo.kind,
            note: aiInfo.note,
            turns: aiRes.flatMap(({ at, r }) => r.turns.map((x) => ({ ...x, ...(x.speaker === 'ai' ? { text: stripVoiceTags(x.text) } : {}), start: Math.round((at / 1000 + x.start) * 100) / 100, end: Math.round((at / 1000 + x.end) * 100) / 100 }))).filter((x) => x.text),
            providers: [...new Set(aiRes.map(({ r }) => `${r.provider}/${r.model}`))],
            costUsd: aiRes.reduce((a, { r }) => a + (Number(r.costUsd) || 0), 0),
            conversations: aiRes.map(({ r }) => r.conversationId).filter(Boolean),
          }
        : null,
      t: { ...marks },
      errors,
      // «ШІ одразу» і приєднання — лише коли були (рядок журналу старого режиму — без змін)
      ...(route ? { route: { ...route } } : {}),
      ...(join ? { join: joinInfo() } : {}),
      // обговорення (лише з VG_DS_SOURCE): вид, джерело, вік, ключ ведучого (мобільний — маскою), фраза, підсумок, події
      ...(dsOn && route ? { ds: { ...(dsJournal(ds, ds?.lead, clock.now(), ds ? null : dsWhy) || {}), ...(dsPhrase ? { phrase: dsPhrase } : {}), ...(dsResult ? { result: dsResult } : {}), ...(dsServed ? { served: true } : {}), ...(routeSent.length ? { events: [...routeSent] } : {}) } } : {}),
    }
    const why = [reason, fallbackReason, abortReason].filter(Boolean).join(', ')
    say(`итог: ${outcome}${why ? ` (${why})` : ''}`)
    onDone(entry)
    // Рядок менеджера, що приєднувався (якщо ще не записаний): з'єднано — callback_joined, клієнт поклав під час
    // приєднання — callback_join_gone; міст не вдався — failed; обірвано — aborted
    if (join && !join.entryDone) {
      const r = join.result
      const out = abortReason && (!r || r === 'client_gone') ? 'aborted' : outcome === 'failed' ? 'failed' : r === 'client_gone' ? 'callback_join_gone' : r ? 'callback_joined' : 'callback_cancelled'
      emitJoinEntry(out, r === 'client_gone' ? 'client_hangup' : null)
    }
  }

  return {
    start,
    handle,
    abort,
    get done() { return done },
    get phase() { return phase },
    get target() { return target },
    get kind() { return kind },
    // Номер клієнта цього дзвінка (для диспетчера: чи зайнятий він зараз на шлюзі): клієнт — його номер; передзвін — кого
    // набираємо або чекаємо
    get partyNumber() { return done ? null : callback ? cbDialNumber ?? cbWaitNumber : phone },
    // Клієнт зараз із ШІ (говорить або чекає його сесію, у т. ч. AI_DOWN_GRACE_MS після її кінця) — для partyBusy 'ai'
    get withAi() { return !done && phase === 'ai' },
    get callA() { return A },
    get callB() { return legB?.call ?? null },
    // Група менеджера, з яким цей дзвінок зараз зайнятий (набір, картка, «1», переведення, міст, приєднання; передзвін —
    // сам менеджер на лінії), — для гілки обговорення: ведучий на іншому дзвінку шлюзу не набирається (owner_busy)
    get engagedGroup() {
      if (done) return null
      if (callback) return callerGroup
      if (legB?.join && join) return join.result === 'manager_gone' ? null : join.group
      return ['dialing', 'card', 'confirm', 'xferWait', 'transferring', 'bridged', 'connected'].includes(phase) && target === 'manager' ? mgrGroup : null
    },
    joinableFor,
    adoptManager,
  }
}

// ---------- диспетчер: події рушія → потрібний сценарій ----------
// Вхідний створює сценарій; 'dialing' прив'язує ногу B за ref; решта — за номером виклику (error без call — за ref).
// Подію для ще невідомого виклику тримаємо недовго: рушій міг повідомити стан B раніше за 'dialing'.
export function createDispatcher({ config, send, clock, lookup = null, buildCard, tts = null, voicemailPath = null, callbacks = null, ai = null, log = () => {}, onDone = () => {}, staffState = null, appCalls = null, routeEvent = null, resendLink = null }) {
  const byCall = new Map()
  const byRef = new Map()
  const active = new Set()
  const owned = new Map() // сценарій → {calls, refs}: що прибрати з мап після завершення
  const orphans = new Map() // call → [{ev, at}]
  const ORPHAN_MS = 2000
  // Запобіжник ШІ — один на всі дзвінки (лише в режимі «ШІ одразу»)
  const breaker = config.answerMode === 'ai' ? makeBreaker(config.aiBreaker, clock, log) : null

  // Завершений сценарій ще lateEventsMs відповідає на запізнілі події (напр. 'dialing' набору, від якого відмовились).
  function forget(flow) {
    clock.setTimeout(() => {
      const own = owned.get(flow)
      owned.delete(flow)
      if (!own) return
      for (const c of own.calls) if (byCall.get(c) === flow) byCall.delete(c)
      for (const r of own.refs) if (byRef.get(r) === flow) byRef.delete(r)
    }, config.lateEventsMs)
  }

  // Цей номер зараз на іншому дзвінку шлюзу: 'line' — клієнт на лінії (ще дослуховує фразу, говорить через міст…),
  // 'ai' — клієнт говорить із ШІ (чекати марно, розмова на хвилини), 'dialing' — його набирає (чи чекає) інший передзвін.
  // Передзвін не набирає клієнта двічі й не дзвонить зайнятому.
  function partyBusy(number, self) {
    if (!number) return null
    for (const f of active) {
      if (f === self || f.done || f.partyNumber !== number) continue
      if (f.kind !== 'client') return 'dialing'
      return f.withAi ? 'ai' : 'line'
    }
    return null
  }

  // Приєднання (рішення 15/16): є клієнт, якого вже з'єднують із цим менеджером, — {busy}; інакше серед тих, хто чекає
  // саме його, — той, кого цьому менеджеру набирали останнім, за рівності — хто чекає довше; нікого — null
  function findJoinable(group) {
    let best = null
    let busy = false
    for (const f of active) {
      const st = f.joinableFor?.(group)
      if (!st) continue
      if (st.status === 'busy') busy = true
      else if (st.status === 'joinable') {
        const at = st.lastDialedAt ?? -Infinity
        if (!best || at > best.at || (at === best.at && st.since < best.since)) best = { flow: f, at, since: st.since }
      }
    }
    if (busy) return { busy: true }
    return best ? { flow: best.flow } : null
  }
  // Ведучий обговорення зараз на іншому дзвінку шлюзу (його набирають, з'єднують, він говорить через міст або передзвонює)
  function staffBusy(group, self) {
    if (!group?.length) return false
    for (const f of active) {
      if (f === self || f.done) continue
      const g = f.engagedGroup
      if (g?.some((k) => group.includes(k))) return true
    }
    return false
  }
  // Приєднуємо лише дзвінок менеджера без PIN: внутрішня лінія або зовнішній номер з VG_MANAGERS_EXTERNAL=nopin
  const joinEligible = (mc) => !mc.external || (externalCallbackOn(config) && !validPin(config.managerPin))

  function onIncoming(ev) {
    if (byCall.has(ev.call)) return
    // Спершу — хто дзвонить: менеджер, що приєднується до клієнта, у maxCalls не рахується (нового сценарію немає)
    const mc = managerCaller(ev, config)
    const joinOn = config.joinOnCallback === true && !!mc && joinEligible(mc)
    let joinBusy = false
    if (joinOn) {
      const pick = findJoinable(mc.group)
      if (pick?.flow) {
        byCall.set(ev.call, pick.flow)
        if (pick.flow.adoptManager(ev, mc)) {
          owned.get(pick.flow)?.calls.add(ev.call)
          return
        }
        byCall.delete(ev.call)
      }
      joinBusy = !!pick?.busy
    }
    // Менеджерам (з приєднанням) — допуск +1: 2 сценарії × 2 ноги + 1 = 5, межа лінії
    const limit = config.maxCalls + (config.joinOnCallback === true && mc ? 1 : 0)
    const own = { calls: new Set([ev.call]), refs: new Set() }
    let flow = null
    const flowSend = (cmd) => {
      if (cmd.cmd === 'dial' && cmd.ref) {
        byRef.set(cmd.ref, flow)
        own.refs.add(cmd.ref)
      }
      send(cmd)
    }
    flow = createFlow({
      incoming: ev,
      config,
      send: flowSend,
      clock,
      lookup,
      buildCard,
      tts,
      voicemailPath,
      callbacks,
      ai,
      partyBusy: (n) => partyBusy(n, flow),
      staffBusy: (g) => staffBusy(g, flow),
      staffState,
      appCalls,
      routeEvent,
      resendLink,
      log,
      rejectReason: active.size >= limit ? 'busy' : null,
      breaker,
      joinBusy,
      onDone: (entry) => {
        active.delete(flow)
        forget(flow)
        onDone(entry)
      },
      onExtra: (entry) => onDone(entry), // рядок менеджера, що приєднувався до цього клієнта
    })
    owned.set(flow, own)
    byCall.set(ev.call, flow)
    active.add(flow)
    flow.start()
  }

  function handle(ev) {
    if (!ev || typeof ev.ev !== 'string') return
    if (ev.ev === 'incoming') return onIncoming(ev)
    if (ev.ev === 'dialing') {
      const flow = byRef.get(ev.ref)
      if (!flow) {
        log(`неизвестный набор ${ev.ref} (звонок ${ev.call}) — кладу`)
        send({ cmd: 'hangup', call: ev.call })
        return
      }
      byCall.set(ev.call, flow)
      owned.get(flow)?.calls.add(ev.call)
      flow.handle(ev)
      const queued = orphans.get(ev.call)
      if (queued) {
        orphans.delete(ev.call)
        for (const q of queued) flow.handle(q.ev)
      }
      return
    }
    let flow = ev.call != null ? byCall.get(ev.call) : null
    if (!flow && ev.ref != null) flow = byRef.get(ev.ref)
    if (flow) return flow.handle(ev)
    if (ev.call != null && ev.ev !== 'error') {
      const now = clock.now()
      const q = (orphans.get(ev.call) || []).filter((x) => now - x.at < ORPHAN_MS)
      q.push({ ev, at: now })
      orphans.set(ev.call, q.slice(-20))
      for (const [c, list] of orphans) if (list.every((x) => now - x.at >= ORPHAN_MS)) orphans.delete(c)
    }
  }

  function abortAll(why) {
    for (const f of [...active]) f.abort(why)
  }

  return { handle, abortAll, get active() { return active.size }, get breaker() { return breaker } }
}

export default createFlow
