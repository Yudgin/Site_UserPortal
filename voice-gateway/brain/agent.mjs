// ШІ-співрозмовник одного дзвінка: міст між потоком звуку рушія (audiosock.mjs) і голосовою моделлю в реальному часі
// (провайдер — realtime-*.mjs). Тут: перетворення звуку, перебивання (співрозмовник заговорив — скидаємо чергу рушія і
// кажемо моделі, скільки її відповіді прозвучало), інструменти (їх виконує сценарій дзвінка через onTool), дії «після
// фрази» (з'єднати / завершити — коли фразу перед ними дограно до кінця), розшифровка, межі часу й тиші.
//
// Сценарій (flow.mjs) бачить лише:
//   const s = createAgent({...}); const cmd = s.start()   — команда audio_start для рушія (сценарій її шле)
//   s.stop(reason)          — кінець (клієнт поклав, помилка рушія, зупинка шлюзу); повторно — нічого
//   s.result()              — розшифровка, інструменти, токени, вартість (оцінка — лише голос), conversationId провайдера
//                             (за ним gateway.mjs після кінця читає фактичну ціну ElevenLabs) — для журналу і документа дзвінка
// Колбеки: onSpeaking() — перший звук моделі пішов у дзвінок (сценарій зупиняє музику утримання);
// onEnd({reason, action?}) — рівно один раз: action 'transfer' (модель попросила з'єднати з менеджером, фразу «з'єдную»
// дограно — сесію закрито, щоб не платити за тишу під час набору) або 'end' (попрощалась, фразу дограно); без action —
// reason 'ai_error' | 'max_duration' | 'idle' | 'engine_closed' | те, що передав stop().
// Тиша — лише з боку співрозмовника: його репліки, події провайдера про його голос і власна проста VAD на звуку рушія.
// Звук моделі тишу не перериває (ElevenLabs сам перепитує кожні кілька секунд — інакше дзвінок не скінчився б ніколи).
import { Resampler, encodeG711, decodeG711, pcmMs, rms } from './pcm.mjs'
import { cleanAiTranscript } from './transcript.mjs'

// Інструменти, після яких модель більше не говорить: дію виконуємо, коли поточну фразу дограно
const AFTER_SPEECH = { transfer_to_manager: 'transfer', end_call: 'end' }
const ACTION_WAIT_MS = 15000 // фраза перед дією не закінчилась (мітка загубилась) — діємо все одно
// Після інструмента дії: стільки без нового звуку моделі (і без відповіді, що триває) — фразу вважаємо надісланою
// повністю й ставимо мітку. Звук фрази може прийти й після виклику інструмента, тож мітку одразу не ставимо.
const ACTION_SETTLE_MS = 1500
const EARLY_AUDIO_MAX_MS = 30000 // звук моделі до під'єднання рушія (привітання) — тримаємо не більше
// Проста VAD на голосі співрозмовника (звук рушія): гучних кадрів (RMS вище порога) набралось у вікні стільки — він
// говорить, відлік тиші заново. Відлік перезапускаємо не частіше за VAD_THROTTLE_MS.
const VAD_RMS = 600
const VAD_WINDOW_MS = 1000
const VAD_MIN_MS = 200
const VAD_THROTTLE_MS = 250

function makeConverter(fromFmt, toFmt) {
  // fmt: {encoding: 'pcm16'|'ulaw'|'alaw', rate}
  const rs = new Resampler(fromFmt.rate, toFmt.rate)
  return (buf) => {
    let pcm = fromFmt.encoding === 'pcm16' ? buf : decodeG711(buf, fromFmt.encoding)
    pcm = rs.process(pcm)
    return toFmt.encoding === 'pcm16' ? pcm : encodeG711(pcm, toFmt.encoding)
  }
}

export function createAgent({ call, server, provider, connectOpts, onTool, onSpeaking = () => {}, onEnd = () => {}, clock, log = () => {}, limits = {} }) {
  const maxMs = (Number(limits.maxSec) || 300) * 1000
  const wrapMs = Math.max(0, maxMs - (Number(limits.wrapSec) || 30) * 1000)
  const idleMs = (Number(limits.idleSec) || 20) * 1000
  const t0 = clock.now()
  let state = 'new' // new → connecting → live → ended
  let conn = null
  let token = null
  let p = null // сеанс провайдера
  let providerReady = false
  let greeted = false
  let ended = false
  let endInfo = null
  let toIn = null // рушій → модель
  let toOut = null // модель → рушій
  let markSeq = 1
  let pendingAction = null // {action, markId, ready — мітку пора ставити, але рушій ще не під'єднався}
  let responding = false
  let doneCount = 0 // скільки response_done прийшло (чи закінчилась відповідь, поки виконувався інструмент дії)
  let idleCount = 0
  let wrapped = false
  let spoke = false
  let early = [] // звук моделі, що прийшов до під'єднання рушія
  let earlyMs = 0
  const vad = [] // гучні кадри співрозмовника за останнє VAD_WINDOW_MS: {t, ms}
  let vadMs = 0
  let vadLast = -Infinity // коли VAD востаннє перезапустила відлік тиші
  const timers = {}
  const items = new Map() // itemId → {start — номер семпла в потоці до рушія, samples, t — мс від початку}
  let curItem = null
  // Перебиті відповіді, що чекають 'K' свого скидання, коли попереднє скидання ще без 'K': їхні start — у координатах до
  // вирівнювання, тож кожна 'K' попереднього скидання зсуває й їх (інакше обрізання другої відповіді — не на тому місці)
  const awaitingTrunc = new Set()
  const turns = [] // {speaker: 'client'|'ai', start, end, text}
  const toolCalls = [] // {name, at, ok, ms}
  const usage = { inputAudio: 0, outputAudio: 0, inputText: 0, outputText: 0, cachedInput: 0 }
  const errors = []

  const now = () => clock.now() - t0
  const later = (name, ms, fn) => {
    cancel(name)
    timers[name] = clock.setTimeout(() => { delete timers[name]; if (!ended) fn() }, ms)
  }
  const cancel = (name) => {
    if (timers[name] != null) clock.clearTimeout(timers[name])
    delete timers[name]
  }
  const err = (where, e) => { errors.push({ at: now(), where, msg: String(e?.message ?? e ?? '').slice(0, 200) }) }
  const safe = (where, fn) => {
    try {
      return fn()
    } catch (e) {
      err(where, e)
      return null
    }
  }

  function finish(info) {
    if (ended) return
    ended = true
    state = 'ended'
    endInfo = { ...info, at: now() }
    for (const k of Object.keys(timers)) cancel(k)
    safe('close', () => p?.close())
    if (conn) conn.close()
    if (token) server.cancel?.(token)
    onEnd(endInfo)
  }

  // Активність співрозмовника (говорить або щойно говорив) — відлік тиші заново. Звук моделі й інструменти — не
  // активність співрозмовника. До привітання відлік не починаємо (його запускає maybeGreet).
  function callerActive() {
    idleCount = 0
    if (state === 'live' && greeted) later('idle', idleMs, onIdle)
  }

  function onIdle() {
    if (state !== 'live') return
    // Фраза перед дією (з'єднати / завершити) ще грає — тишу не рахуємо: дію виконає мітка або ACTION_WAIT_MS
    if (pendingAction) return later('idle', idleMs, onIdle)
    idleCount++
    if (idleCount >= 2) {
      log('ИИ: клиент молчит — завершаю')
      return finish({ reason: 'idle' })
    }
    // ElevenLabs сам перепитує на тиші (turn timeout) — тоді лише рахуємо
    if (!provider.selfPrompt) safe('respond', () => p.respond({ instructions: "Співрозмовник мовчить. Коротко запитай українською, чи він на зв'язку." }))
    later('idle', idleMs, onIdle)
  }

  // ---------- звук ----------

  function onEngineAudio(pcm) {
    if (state !== 'live') return
    if (greeted) localVad(pcm)
    if (!providerReady) return
    safe('send_audio', () => p.sendAudio(toIn(pcm)))
  }

  // Голос співрозмовника за рівнем: гучного (RMS > VAD_RMS) у вікні VAD_WINDOW_MS набралось VAD_MIN_MS — активність.
  // Не залежить від провайдера: ElevenLabs про голос без репліки не повідомляє, а тиша рахується саме від клієнта.
  function localVad(pcm) {
    const t = now()
    while (vad.length && t - vad[0].t >= VAD_WINDOW_MS) vadMs -= vad.shift().ms
    if (rms(pcm) <= VAD_RMS) return
    const ms = pcmMs(pcm.length, conn?.rate || provider.engineRate)
    vad.push({ t, ms })
    vadMs += ms
    if (vadMs >= VAD_MIN_MS && t - vadLast >= VAD_THROTTLE_MS) {
      vadLast = t
      callerActive()
    }
  }

  function playModel(itemId, pcm) {
    let it = items.get(itemId)
    if (!it) {
      it = { start: conn.sentSamples, samples: 0, t: now() }
      items.set(itemId, it)
    }
    curItem = itemId
    it.samples += Math.floor(pcm.length / 2)
    conn.play(pcm)
    if (!spoke) {
      spoke = true
      onSpeaking()
    }
  }

  function onModelAudio({ data, itemId }) {
    if (ended) return
    const pcm = toOut(data)
    if (!pcm.length) return
    // Чекаємо, поки фраза перед дією прийде вся: кожен шматок звуку моделі — вікно ACTION_SETTLE_MS заново
    if (pendingAction && pendingAction.markId == null) later('settle', ACTION_SETTLE_MS, onSettle)
    if (!conn || conn.closed) {
      // рушій ще не під'єднався (привітання прийшло раніше) — тримаємо, але не безмежно
      if (state === 'connecting' && earlyMs < EARLY_AUDIO_MAX_MS) {
        early.push({ itemId, pcm })
        earlyMs += pcmMs(pcm.length, provider.engineRate)
      }
      return
    }
    playModel(itemId, pcm)
    // Мітку вже поставлено, а звук фрази ще йде (друге речення після response_done) — мітку переносимо в новий кінець
    // черги: стара повернеться з іншим id і буде пропущена
    if (pendingAction && pendingAction.markId != null) {
      pendingAction.markId = null
      placeActionMark()
    }
  }

  // Співрозмовник заговорив: скинути чергу рушія; коли рушій скаже, скільки прозвучало, обрізати відповідь моделі на
  // цьому місці (модель «знатиме», чого клієнт не почув). Нічого не грало — рушій скине 0, обрізати нічого.
  // truncate=false — перебивання помітив сам провайдер і обрізає сам (ElevenLabs, Gemini): лише скидаємо чергу.
  function bargeIn({ truncate = true } = {}) {
    callerActive()
    // Адаптер на перебивання response_done не шле: перебита відповідь уже не триває (інакше наступна дія чекала б
    // response_done, якого не буде, аж до ACTION_WAIT_MS)
    responding = false
    if (truncate) turns.push({ speaker: 'client', start: now(), end: null, text: '', pending: true })
    if (!conn || conn.closed) return
    if (pendingAction) {
      log('ИИ: клиент перебил фразу перед действием — действие отменено, модель ответит снова')
      cancel('action')
      cancel('settle')
      pendingAction = null
    }
    const itemId = curItem
    const it = itemId ? items.get(itemId) : null
    if (it) awaitingTrunc.add(it)
    items.clear()
    curItem = null
    conn.clear((played, dropped, delta) => {
      if (it) awaitingTrunc.delete(it)
      // відповіді, що почались уже після скидання (і перебиті до цієї 'K'), — у координатах до вирівнювання
      for (const x of items.values()) x.start += delta
      for (const x of awaitingTrunc) x.start += delta
      if (!truncate || !it || !dropped) return
      let rel = (played - it.start) >>> 0
      if (rel > 0x7fffffff) rel = 0 // відповідь ще й не почала звучати
      if (rel >= it.samples) return // дограно повністю
      safe('truncate', () => p.truncate({ itemId, audioEndMs: Math.round(pcmMs(rel * 2, conn.rate)) }))
    })
  }

  // ---------- інструменти ----------

  async function onToolCall({ callId, name, args }) {
    const started = now()
    const doneAtCall = doneCount
    let output
    let ok = true
    try {
      output = await onTool(name, args || {})
    } catch (e) {
      ok = false
      err(`tool:${name}`, e)
      output = { ok: false, error: 'internal_error', say: 'Сталася технічна помилка. Запропонуй записати питання для менеджера.' }
    }
    const accepted = ok && output?.ok !== false
    toolCalls.push({ name, at: started, ok: accepted, ms: now() - started })
    if (ended) return
    const action = AFTER_SPEECH[name]
    if (action && accepted && pendingAction?.action === 'transfer' && action === 'end') {
      // З'єднання важливіше за відбій: модель буває, що одразу після transfer_to_manager викликає ще й end_call (жива
      // проба 17.10 — клієнт попросив менеджера, а дзвінок поклали). end_call лише підтверджуємо, з'єднання лишається
      toolCalls[toolCalls.length - 1].ignored = 'transfer_pending'
      safe('tool_result', () => p.toolResult({ callId, name, output, continue: false }))
      return
    }
    if (action && accepted) {
      // Модель уже сказала фразу перед дією або скаже в цій самій відповіді (звук буває й після виклику): діємо, коли
      // дограно, нової відповіді не просимо. Мітку ставимо, коли відповідь закінчилась: response_done після виклику
      // (зокрема поки виконувався інструмент) або ACTION_SETTLE_MS без нового звуку й без відповіді, що триває.
      pendingAction = { action, markId: null, ready: false }
      safe('tool_result', () => p.toolResult({ callId, name, output, continue: false }))
      later('action', ACTION_WAIT_MS, () => fireAction('timeout'))
      if (doneCount > doneAtCall && !responding) placeActionMark()
      else later('settle', ACTION_SETTLE_MS, onSettle)
      return
    }
    safe('tool_result', () => p.toolResult({ callId, name, output, continue: true }))
  }

  // Вікно ACTION_SETTLE_MS минуло без нового звуку моделі. Відповідь ще триває — мітку поставить її response_done
  // (не прийде — спрацює ACTION_WAIT_MS).
  function onSettle() {
    if (!pendingAction || pendingAction.markId != null || responding) return
    placeActionMark()
  }

  // Мітка в кінці черги рушія: коли рушій її поверне, фразу дограно. Ставиться один раз на дію.
  function placeActionMark() {
    if (!pendingAction || pendingAction.markId != null) return
    cancel('settle')
    if (state === 'connecting') {
      pendingAction.ready = true // рушій ще не під'єднався: мітку поставимо після раннього звуку
      return
    }
    if (!conn || conn.closed) return fireAction('no_audio')
    pendingAction.markId = markSeq++
    conn.mark(pendingAction.markId)
  }

  function fireAction(why) {
    if (!pendingAction || ended) return
    const { action } = pendingAction
    pendingAction = null
    log(`ИИ: ${action === 'transfer' ? 'клиент просит менеджера' : 'завершаю разговор'} (${why})`)
    finish({ reason: 'tool', action })
  }

  // ---------- провайдер ----------

  function wireProvider() {
    p.on('ready', () => {
      providerReady = true
      maybeGreet()
    })
    p.on('audio', onModelAudio)
    p.on('speech_started', () => bargeIn())
    p.on('interrupted', () => bargeIn({ truncate: false }))
    p.on('user_activity', () => callerActive())
    p.on('response_started', () => { responding = true })
    p.on('response_done', () => {
      responding = false
      doneCount++
      if (pendingAction) placeActionMark()
    })
    p.on('tool_call', (tc) => { onToolCall(tc) })
    p.on('transcript', ({ role, text, itemId, correction = false }) => {
      const t = String(text || '').trim()
      if (!t) return
      if (role === 'user') {
        callerActive()
        const open = turns.find((x) => x.speaker === 'client' && x.pending)
        if (open) {
          open.text = t
          open.end = now()
          delete open.pending
        } else turns.push({ speaker: 'client', start: now(), end: now(), text: t })
      } else if (correction) {
        // перебили: провайдер повідомив, що з відповіді справді прозвучало
        const last = [...turns].reverse().find((x) => x.speaker === 'ai')
        if (last) last.text = t
      } else {
        const it = itemId ? items.get(itemId) : null
        turns.push({ speaker: 'ai', start: it?.t ?? now(), end: now(), text: t })
      }
    })
    p.on('usage', (u) => { for (const k of Object.keys(usage)) usage[k] += Number(u?.[k]) || 0 })
    p.on('error', (e) => {
      err('provider', e)
      log(`ИИ: ошибка провайдера: ${e?.message || e}`)
      if (e?.fatal) finish({ reason: 'ai_error' })
    })
    p.on('close', (info) => {
      if (ended) return
      err('provider', `closed ${info?.code ?? ''} ${info?.reason ?? ''}`.trim())
      finish({ reason: 'ai_error' })
    })
  }

  function wireConn(c) {
    conn = c
    c.on('audio', onEngineAudio)
    c.on('mark', ({ id }) => { if (pendingAction && pendingAction.markId === id) fireAction('played') })
    c.on('close', () => {
      if (conn !== c) return
      conn = null
      if (state === 'live') finish({ reason: 'engine_closed' })
    })
  }

  function maybeGreet() {
    if (greeted || !providerReady || state !== 'live') return
    greeted = true
    idleCount = 0
    later('idle', idleMs, onIdle)
    later('max', maxMs, onMax)
    if (wrapMs > 0) {
      later('wrap', wrapMs, () => {
        wrapped = true
        safe('respond', () => p.respond({ instructions: 'Час розмови спливає. Коротко підсумуй, за потреби запиши питання для менеджера, попрощайся і заверши дзвінок.' }))
      })
    }
    safe('greet', () => p.greet())
  }

  // Межа часу. Модель уже попросила з'єднати / попрощалась і фраза ще грає — виконуємо дію одразу: перевід на менеджера
  // важливіший за недограну фразу, а не max_duration (тоді сценарій не з'єднав би)
  function onMax() {
    if (pendingAction) return fireAction('max')
    finish({ reason: 'max_duration' })
  }

  function audioCmd() {
    token = server.token()
    server.expect(token).then((c) => {
      if (ended) return c.close()
      token = null
      wireConn(c)
      state = 'live'
      for (const e of early) playModel(e.itemId, e.pcm)
      early = []
      earlyMs = 0
      maybeGreet()
      if (pendingAction?.ready) placeActionMark()
    }, (e) => {
      if (ended) return
      err('audio', e)
      finish({ reason: 'engine_closed' })
    })
    return { cmd: 'audio_start', call, sock: server.path, token, rate: provider.engineRate }
  }

  // ---------- для сценарію ----------

  function start() {
    if (state !== 'new') return null
    state = 'connecting'
    toIn = makeConverter({ encoding: 'pcm16', rate: provider.engineRate }, provider.inputFormat)
    toOut = makeConverter(provider.outputFormat, { encoding: 'pcm16', rate: provider.engineRate })
    try {
      p = provider.connect(connectOpts)
    } catch (e) {
      err('connect', e)
      clock.setTimeout(() => finish({ reason: 'ai_error' }), 0)
      return null
    }
    wireProvider()
    return audioCmd()
  }

  function stop(reason) {
    finish({ reason })
  }

  function result() {
    const durationMs = ended ? endInfo.at : now() // після кінця — застиглі тривалість і вартість
    const ordered = turns.filter((t) => t.text).sort((a, b) => a.start - b.start)
    return cleanAiTranscript({
      provider: provider.name,
      model: provider.model,
      startedAt: new Date(t0).toISOString(),
      durationMs,
      end: endInfo,
      turns: ordered.map(({ speaker, start, end, text }) => ({ speaker, start: start / 1000, end: (end ?? start) / 1000, text })),
      toolCalls,
      usage,
      costUsd: provider.cost ? provider.cost(usage, durationMs) : null,
      conversationId: p?.conversationId ?? null,
      wrapped,
      errors,
    })
  }

  return {
    start,
    stop,
    result,
    get state() { return state },
    get ended() { return ended },
  }
}

export default createAgent
