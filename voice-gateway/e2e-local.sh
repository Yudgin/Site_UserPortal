#!/usr/bin/env bash
# Наскрізна локальна перевірка голосового шлюзу: справжній sip-engine + мозок (gateway.mjs --local) + три pjsua.
# Без Binotel, ElevenLabs і Firestore: усе лише на 127.0.0.1 (шлюз :5092, клієнт :5091, менеджер :5093,
# запасна лінія :5094). Консолі pjsua керуються файлами: tail -n0 -F <name>.ctl | pjsua …  (команди дописуємо в .ctl).
#
# Сценарії:
#   s1  з'єднання: відповідь → привітання → утримання → набір менеджера → картка → REFER/Replaces → connected
#   s2  менеджер не бере (без автовідповіді) → тайм-аут → набір запасної → вона відповідає → картка →
#       REFER/Replaces → connected_fallback (сліпого REFER немає)
#   s3  номер не з білого списку → 486, outcome rejected (типовий список не послаблено)
#   s4  менеджер і запасна відповідають 503 → повтори в межах вікна → голосова пошта: фраза, сигнал, запис голосу
#       клієнта (pjsua грає WAV) до VG_VOICEMAIL_MAX_SEC → outcome voicemail, у файлі > 1 с звуку
#   s5  менеджер і запасна не беруть (тайм-аути) → голосова пошта, клієнт кладе трубку під час запису →
#       запис зупинено й збережено, outcome voicemail
#   s6  менеджер і запасна зайняті (486) за ~1 с → привітання догрує (не обриваємо) → фраза, сигнал, запис →
#       клієнт кладе трубку одразу → outcome voicemail_empty, порожній WAV видалено
#
# Запуск: voice-gateway/e2e-local.sh        Журнали — voice-gateway/.e2e/<сценарій>/ (у git не потрапляють).
# Рушій — VG_ENGINE_PATH (або ENGINE), типово engine/sip-engine. Поки шлюз працює зі старим sip-engine:
#   VG_ENGINE_PATH="$PWD/voice-gateway/engine/sip-engine-next" voice-gateway/e2e-local.sh
# Код виходу: 0 — усі перевірки пройшли; 1 — є помилки; 2 — не вдалося запустити (порти, pjsua, движок).
# Повторний запуск безпечний: на початку прибирає залишки попереднього прогону, при виході — свої процеси.
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/.e2e}"
PJSUA="${PJSUA:-/opt/homebrew/bin/pjsua}"
NODE="${NODE:-node}"
ENGINE="${VG_ENGINE_PATH:-${ENGINE:-$HERE/engine/sip-engine}}" # до unset VG_* нижче
PROMPTS=/Users/yevhenyushchenko/Documents/GitHub/runferry-briefs/telephony/voice-prompts/wav-8k/mila
CARD_SRC="${CARD:-$PROMPTS/05-hold-short.wav}"
VM_PROMPT="$PROMPTS/07-voicemail-no-answer-short.wav"
CLIENT_VOICE="$PROMPTS/04-greeting-unknown.wav" # «голос» клієнта для голосової пошти (pjsua грає по колу)

GW_PORT=5092
CLIENT_PORT=5091
MGR_PORT=5093
FB_PORT=5094
GW_URI="sip:gw@127.0.0.1:$GW_PORT"
MANAGER_URI="sip:mgr@127.0.0.1:$MGR_PORT"
FALLBACK_URI="sip:op@127.0.0.1:$FB_PORT"
# Тестовий номер клієнта: його немає в типовому allowedCallers — пропускаємо лише прапорцем --allow цього прогону
ALLOWED_NUM=0501112233
ALLOWED_E164=+380501112233
DENIED_NUM=0509998877

# Налаштування шлюзу — лише ті, що задає цей скрипт (VG_* з оточення не підхоплюємо)
for v in $(env | sed -n 's/^\(VG_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
unset BINOTEL_LINE_SECRET

TOTAL_PASS=0
TOTAL_FAIL=0
PEERS=""      # «name:pid» через пробіл — pjsua поточного сценарію
GW_PID=""
ENGINE_PID=""

say() { printf '%s\n' "$*"; }

# ---------- прибирання ----------

kill_wait() { # pid [сек] — TERM, чекаємо, потім KILL
  local pid="$1" t="${2:-5}" i=0
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null
  while kill -0 "$pid" 2>/dev/null && [ $i -lt $((t * 10)) ]; do sleep 0.1; i=$((i + 1)); done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
  return 0
}

# Процеси прогону: pjsua (--log-file=$WORK/…), tail -F $WORK/…, шлюз (--card $WORK/card.wav)
kill_leftovers() {
  pkill -f -- "--log-file=$WORK/" 2>/dev/null
  pkill -f -- "--card $WORK/card.wav" 2>/dev/null
  pkill -f -- "tail -n0 -F $WORK/" 2>/dev/null
  return 0
}

cleanup() {
  local p
  for p in $PEERS; do kill_wait "${p#*:}" 2; done
  PEERS=""
  if [ -n "$GW_PID" ]; then kill_wait "$GW_PID" 10; GW_PID=""; fi
  if [ -n "$ENGINE_PID" ]; then kill_wait "$ENGINE_PID" 3; ENGINE_PID=""; fi
  kill_leftovers
}
trap 'cleanup' EXIT
trap 'say ""; say "прервано"; exit 130' INT TERM

# ---------- очікування ----------

wait_until() { # сек команда… — опитуємо кожні 0,1 с
  local t="$1" i=0
  shift
  while [ $i -lt $((t * 10)) ]; do
    "$@" && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}
udp_bound() { lsof -nP -a -iUDP@127.0.0.1:"$1" >/dev/null 2>&1; }
trace_has() { grep -Eq -- "$1" "$SDIR"/data/logs/brain-*.log 2>/dev/null; }
journal_lines() { cat "$SDIR"/data/calls-*.jsonl 2>/dev/null | grep -c . ; }
journal_ge() { [ "$(journal_lines)" -ge "$1" ]; }

# ---------- учасники ----------

start_gateway() { # [VAR=значення …] — додаткові налаштування шлюзу для сценарію
  # VG_TRACE=1 — траса команд/подій (типово вимкнена), за нею й перевіряємо; рівень 4 — тексти SIP у лозі рушія
  env VG_DATA_DIR="$SDIR/data" VG_CACHE_DIR="$SDIR/cache" VG_MANAGER_TIMEOUT_SEC=4 VG_FALLBACK_TIMEOUT_SEC=4 \
    VG_VOICEMAIL_WAV="$VM_PROMPT" VG_VOICEMAIL_MAX_SEC=4 VG_TRACE=1 SIP_ENGINE_LOG_LEVEL=4 "$@" \
    "$NODE" "$HERE/brain/gateway.mjs" --local --bind 127.0.0.1 --port "$GW_PORT" --user gw --engine "$ENGINE" \
      --manager "$MANAGER_URI" --fallback "$FALLBACK_URI" --no-tts --no-lookup \
      --card "$WORK/card.wav" --allow "$ALLOWED_E164" > "$SDIR/gateway.out" 2>&1 &
  GW_PID=$!
  if ! wait_until 10 trace_has '"ev":"reg"'; then
    say "  шлюз не поднялся за 10 с:"; sed 's/^/    | /' "$SDIR/gateway.out"
    return 1
  fi
  ENGINE_PID="$(pgrep -P "$GW_PID" | head -1)"
  return 0
}

stop_gateway() {
  [ -n "$GW_PID" ] || return 0
  kill -TERM "$GW_PID" 2>/dev/null # як Ctrl+C: quit рушію, вихід 0
  local i=0
  while kill -0 "$GW_PID" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$GW_PID" 2>/dev/null; then kill -KILL "$GW_PID" 2>/dev/null; echo "killed" > "$SDIR/gateway.exit"
  else wait "$GW_PID" 2>/dev/null; echo "$?" > "$SDIR/gateway.exit"; fi
  GW_PID=""
  if [ -n "$ENGINE_PID" ]; then kill_wait "$ENGINE_PID" 3; ENGINE_PID=""; fi
}

start_peer() { # name port rtp id [auto-answer] [wav — грати в дзвінок по колу]
  local name="$1" port="$2" rtp="$3" id="$4" aa="$5" play="$6"
  local ctl="$SDIR/$name.ctl"
  : > "$ctl"
  local args=(--null-audio --no-tcp --ip-addr=127.0.0.1 --bound-addr=127.0.0.1 --local-port="$port" --rtp-port="$rtp"
    --no-vad --max-calls=4 --id="$id" --rec-file="$SDIR/$name-rec.wav" --auto-rec
    --log-file="$SDIR/$name.log" --log-level=5 --app-log-level=3)
  [ -n "$aa" ] && args+=(--auto-answer="$aa")
  [ -n "$play" ] && args+=(--play-file="$play" --auto-play)
  tail -n0 -F "$ctl" 2>/dev/null | "$PJSUA" "${args[@]}" > "$SDIR/$name.out" 2>&1 &
  PEERS="$PEERS $name:$!"
  if ! wait_until 5 udp_bound "$port"; then say "  pjsua $name не занял 127.0.0.1:$port"; return 1; fi
  sleep 0.3 # консоль pjsua готова читати stdin
  return 0
}

peer_pid() { local p; for p in $PEERS; do [ "${p%%:*}" = "$1" ] && { echo "${p#*:}"; return; }; done; }
peer_cmd() { # name рядок… — кожен аргумент окремим рядком у консоль pjsua
  local name="$1"
  shift
  printf '%s\n' "$@" >> "$SDIR/$name.ctl"
}
stop_peers() { # покласти всі дзвінки, вийти (pjsua дописує журнал лише при виході)
  local p name pid i
  for p in $PEERS; do peer_cmd "${p%%:*}" ha; done
  sleep 0.5
  for p in $PEERS; do peer_cmd "${p%%:*}" q; done
  for p in $PEERS; do
    pid="${p#*:}"
    i=0
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
  done
  PEERS=""
  pkill -f -- "tail -n0 -F $SDIR/" 2>/dev/null
  return 0
}

# ---------- перевірки (журнал шлюзу, траса команд/подій, SIP-журнали рушія та pjsua, записи WAV) ----------

read -r -d '' CHECK_JS <<'JS'
import fs from 'node:fs'
import path from 'node:path'
const [scn, dir, MGR_URI, FB_URI, ALLOWED, DENIED, GW, CL, MG, FB] = process.argv.slice(1)
const GWA = `127.0.0.1:${GW}`, CLA = `127.0.0.1:${CL}`, MGA = `127.0.0.1:${MG}`, FBA = `127.0.0.1:${FB}`
let pass = 0, fail = 0
const ok = (cond, desc, detail = '') => {
  if (cond) { pass++; console.log(`  ОК      ${desc}`) } else { fail++; console.log(`  ОШИБКА  ${desc}${detail ? ` — ${detail}` : ''}`) }
  return !!cond
}
const read = (f) => { try { return f ? fs.readFileSync(f, 'utf8') : '' } catch { return '' } }
const find = (d, re) => { try { const n = fs.readdirSync(d).filter((x) => re.test(x)).sort()[0]; return n ? path.join(d, n) : null } catch { return null } }
const logs = path.join(dir, 'data', 'logs')
const journal = read(find(path.join(dir, 'data'), /^calls-.*\.jsonl$/)).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const trace = read(find(logs, /^brain-.*\.log$/)).split('\n').map((l) => {
  const m = l.match(/^\S+ (>>|<<) (\{.*\})$/)
  if (!m) return null
  try { return { d: m[1], o: JSON.parse(m[2]) } } catch { return null }
}).filter(Boolean)
const cmds = trace.filter((x) => x.d === '>>').map((x) => x.o)
const evs = trace.filter((x) => x.d === '<<').map((x) => x.o)
const gwOut = read(path.join(dir, 'gateway.out'))
const gwExit = read(path.join(dir, 'gateway.exit')).trim()

// SIP-повідомлення з журналу pjsip: «TX|RX N bytes Request|Response msg X (…) to|from UDP host:port:» … «--end msg--»
function sip(file) {
  const out = []
  let cur = null
  for (const line of read(file).split('\n')) {
    const m = line.match(/\b(TX|RX) \d+ bytes (Request|Response) msg (\S+) \(\S+\) (?:to|from) \S+ (\S+?):$/)
    if (m) {
      const parts = m[3].split('/')
      cur = { dir: m[1], req: m[2] === 'Request', method: m[2] === 'Request' ? parts[0] : parts[1], code: m[2] === 'Request' ? null : Number(parts[0]), peer: m[4], lines: [] }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('--end msg--')) { cur = null; continue }
    cur.lines.push(line)
  }
  for (const b of out) { b.text = b.lines.join('\n'); b.first = b.lines[0] || '' }
  return out
}
const hdr = (b, name) => { const m = b?.text.match(new RegExp(`^${name}:\\s*(.*)$`, 'im')); return m ? m[1].trim() : null }
const callId = (b) => hdr(b, 'Call-ID') || hdr(b, 'i')
const sdpPort = (b) => { const m = b?.text.match(/^m=audio (\d+)/m); return m ? Number(m[1]) : null }
const eng = sip(find(logs, /^engine-.*\.log$/))
const cl = sip(path.join(dir, 'client.log'))
const mg = sip(path.join(dir, 'mgr.log'))
const fb = sip(path.join(dir, 'fb.log'))
const tx = (list, method, peer) => list.filter((b) => b.dir === 'TX' && b.req && b.method === method && (!peer || b.peer === peer))
const rx = (list, method, peer) => list.filter((b) => b.dir === 'RX' && b.req && b.method === method && (!peer || b.peer === peer))
const resp = (list, d, code, method, cid) => list.find((b) => b.dir === d && !b.req && b.code === code && b.method === method && (!cid || callId(b) === cid))

// Формат WAV: {format, channels, rate, bits, dataLen}
function wavHeader(file) {
  let b
  try { b = fs.readFileSync(file) } catch { return {} }
  const h = {}
  let off = 12
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4)
    if (id === 'fmt ') Object.assign(h, { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) })
    if (id === 'data') { h.dataLen = len; break }
    off += 8 + len + (len & 1)
  }
  return h
}
const mode = (f) => { try { return fs.statSync(f).mode & 0o777 } catch { return null } }

// Частка «гучних» 20-мс кадрів у записі pjsua (WAV PCM16) → секунди звуку
function activeSec(file) {
  let b
  try { b = fs.readFileSync(file) } catch { return 0 }
  let off = 12, rate = 8000, dataOff = -1, dataLen = 0
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
    if (id === 'data') { dataOff = off + 8; dataLen = len && off + 8 + len <= b.length ? len : b.length - off - 8; break }
    off += 8 + len + (len & 1)
  }
  if (dataOff < 0) return 0
  const n = Math.floor(dataLen / 2), frame = Math.round(rate * 0.02)
  let active = 0
  for (let i = 0; i + frame <= n; i += frame) {
    let sum = 0
    for (let k = 0; k < frame; k++) { const v = b.readInt16LE(dataOff + 2 * (i + k)); sum += v * v }
    if (Math.sqrt(sum / frame) > 300) active++
  }
  return active * 0.02
}

// Послідовність команд мозку → рушію
function order(desc, steps) {
  let i = -1
  for (const [name, pred] of steps) {
    let j = -1
    for (let k = i + 1; k < cmds.length; k++) if (pred(cmds[k])) { j = k; break }
    if (j < 0) return ok(false, desc, `нет шага «${name}» после #${i}`)
    i = j
  }
  return ok(true, `${desc}: ${steps.map((s) => s[0]).join(' → ')}`)
}

const e = journal[0] || {}
const t = e.t || {}
const s = (k) => (t[k] == null ? '—' : (t[k] / 1000).toFixed(2))
const A = evs.find((x) => x.ev === 'incoming')?.call ?? null
const Bs = evs.filter((x) => x.ev === 'dialing').map((x) => x.call)
const B = Bs[0] ?? null
const down = (c) => evs.some((x) => x.ev === 'state' && x.call === c && x.state === 'DISCONNECTED')
const mgrDials = (e.dials || []).filter((d) => d.to === 'manager')
const fbDials = (e.dials || []).filter((d) => d.to === 'fallback')
const dialB = (uri) => evs.filter((x) => x.ev === 'dialing' && cmds.some((c) => c.cmd === 'dial' && c.ref === x.ref && c.uri === uri)).map((x) => x.call)
// Повтори набору: усі спроби з кодом code, між ними ~interval, остання почалась у межах вікна від першої
function retriesOk(desc, list, code, intervalMs, windowMs) {
  const gaps = list.slice(1).map((d, i) => d.at - list[i].at)
  ok(list.length >= 2 && list.every((d) => d.code === code), `${desc}: ${list.length} наборов, все ${code}`, JSON.stringify(list))
  ok(gaps.every((g) => g >= intervalMs - 50 && g <= intervalMs + 900), `${desc}: повторы через ~${intervalMs} мс (${gaps.join(', ')} мс)`)
  ok(list.length && list.at(-1).at - list[0].at <= windowMs + 100, `${desc}: последний набор начат в окне ${windowMs} мс от первого (${list.length ? list.at(-1).at - list[0].at : '—'} мс)`)
}
// Голосове повідомлення: файл у data/voicemail/<дата>/, права, формат, звук
function voicemailOk(minSec, maxSec, stop) {
  const v = e.voicemail || {}
  const f = v.file || ''
  ok(f.startsWith(path.join(dir, 'data', 'voicemail') + path.sep) && /\/\d{4}-\d{2}-\d{2}\/\d{6}-2233\.wav$/.test(f), `файл сообщения data/voicemail/<дата>/<время>-<4 цифры>.wav`, f)
  ok(v.stop === stop, `запись остановлена: ${stop}`, String(v.stop))
  ok(v.sec >= minSec && v.sec <= maxSec, `длина записи ${v.sec} с (ожидалось ${minSec}–${maxSec})`)
  ok(mode(f) === 0o600 && mode(path.dirname(f)) === 0o700 && mode(path.join(dir, 'data', 'voicemail')) === 0o700, `права: файл ${mode(f)?.toString(8)}, теки ${mode(path.dirname(f))?.toString(8)}/${mode(path.join(dir, 'data', 'voicemail'))?.toString(8)}`)
  const h = wavHeader(f)
  ok(h.format === 1 && h.channels === 1 && h.rate === 8000 && h.bits === 16 && Math.abs(h.dataLen / 16000 - v.sec) < 0.05, `WAV PCM 16 бит моно 8 кГц, длина в заголовке ${(h.dataLen / 16000).toFixed(2)} с`, JSON.stringify(h))
  const a = activeSec(f)
  ok(a > 1, `в записи голос клиента: ${a.toFixed(1)} с звука`)
  const rd = evs.find((x) => x.ev === 'record_done' && x.call === A)
  ok(rd && rd.file === f && rd.final === true, 'событие record_done: файл закрыт движком (заголовок с длиной)', JSON.stringify(rd))
  return rd
}

ok(journal.length === 1, 'в журнале шлюза ровно одна строка', `строк ${journal.length}`)
if (journal.length) {
  console.log(`  журнал: outcome=${e.outcome} reason=${e.reason} number=${e.number} xferCode=${e.xferCode} cardSource=${e.cardSource} dials=${JSON.stringify(e.dials)} retries=${e.retries} errors=${JSON.stringify(e.errors)}`)
  console.log(`  шаги, с от входящего: ${Object.entries(t).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(', ')}`)
}

switch (scn) {
  case 's1': {
    ok(e.outcome === 'connected' && e.reason == null, 'исход connected', `${e.outcome}/${e.reason}`)
    ok(e.number === ALLOWED, `номер клиента ${ALLOWED} (пропущен флагом --allow)`, e.number)
    ok(e.xferCode === 200, 'финальный NOTIFY перевода — 200', String(e.xferCode))
    ok(e.dials?.length === 1 && e.dials[0].code === 200 && e.retries === 0, 'менеджер ответил с первого набора', JSON.stringify(e.dials))
    ok(e.cardSource === 'generic', 'карточка — файл --card (синтез выключен)', e.cardSource)
    ok(t.answer < t.greeting && t.greeting < t.greetingDone && t.greetingDone <= t.hold, 'клиенту: ответ → приветствие до конца → ожидание', `${s('answer')} ${s('greeting')} ${s('greetingDone')} ${s('hold')}`)
    ok(t.dial < t.managerAnswered && t.managerAnswered <= t.card && t.card < t.cardDone && t.cardDone < t.xfer && t.xfer < t.xferFinal, 'менеджеру: набор → ответ → карточка до конца → REFER → NOTIFY 200', `${s('dial')} ${s('managerAnswered')} ${s('card')} ${s('cardDone')} ${s('xfer')} ${s('xferFinal')}`)
    order('команды движку', [
      ['answer', (c) => c.cmd === 'answer' && c.call === A && c.code === 200],
      ['play greeting', (c) => c.cmd === 'play' && c.call === A && c.tag === 'greeting' && !c.loop],
      ['dial менеджера', (c) => c.cmd === 'dial' && c.uri === MGR_URI],
      ['play card менеджеру', (c) => c.cmd === 'play' && c.call === B && c.tag === 'card'],
      ['xfer_replaces', (c) => c.cmd === 'xfer_replaces' && c.call === A && c.dest === B],
    ])
    const iHold = cmds.findIndex((c) => c.cmd === 'play' && c.call === A && c.tag === 'hold' && c.loop === true)
    ok(iHold >= 0 && iHold < cmds.findIndex((c) => c.cmd === 'xfer_replaces'), 'после приветствия клиенту — ожидание по кругу (play hold loop) до перевода')
    ok(evs.some((x) => x.ev === 'play_done' && x.call === A && x.tag === 'greeting') && evs.some((x) => x.ev === 'play_done' && x.call === B && x.tag === 'card'), 'play_done: приветствие у клиента и карточка у менеджера доиграли')
    ok(evs.some((x) => x.ev === 'xfer' && x.call === A && x.final && x.code === 200), 'событие xfer final 200 на ноге клиента')
    ok(A != null && B != null && down(A) && down(B), `обе ноги шлюза закрыты (клиент #${A}, менеджер #${B})`)
    const refer = tx(eng, 'REFER', CLA)[0]
    const rt = hdr(refer, 'Refer-To') || ''
    ok(refer && rt.includes(`mgr@${MGA}`) && /\?Replaces=/.test(rt) && !/Require=replaces/i.test(rt), 'шлюз → клиенту REFER, Refer-To на менеджера с ?Replaces= (без Require=replaces, как консоль pjsua с Binotel)', rt.slice(0, 120))
    ok(rx(cl, 'REFER', GWA).length >= 1, 'клиент получил REFER от шлюза')
    const inv = tx(cl, 'INVITE', MGA).find((b) => b.first.startsWith('INVITE sip:mgr@') && hdr(b, 'Replaces'))
    const repl = hdr(inv, 'Replaces') || ''
    ok(!!inv, 'клиент → менеджеру INVITE с заголовком Replaces', repl.slice(0, 80))
    const cid = callId(inv)
    const ok200 = resp(cl, 'RX', 200, 'INVITE', cid)
    ok(!!ok200, 'менеджер ответил 200 на INVITE с Replaces')
    ok(sdpPort(inv) >= 4100 && sdpPort(inv) < 4200 && sdpPort(ok200) >= 4200 && sdpPort(ok200) < 4300, `голос напрямую клиент↔менеджер (RTP ${sdpPort(inv)} ↔ ${sdpPort(ok200)}, не через порт шлюза)`)
    const mInv = rx(mg, 'INVITE', CLA).find((b) => hdr(b, 'Replaces'))
    const replacedCid = repl.split(';')[0]
    const mBye = tx(mg, 'BYE', GWA).find((b) => callId(b) === replacedCid)
    ok(!!mInv && !!mBye, 'у менеджера старый звонок от шлюза заменён: BYE шлюзу по Call-ID из Replaces', replacedCid)
    ok(tx(cl, 'BYE', MGA).some((b) => callId(b) === cid), 'прямой разговор клиент–менеджер жил до конца теста (BYE клиент → менеджер)')
    const ca = activeSec(path.join(dir, 'client-rec.wav')), ma = activeSec(path.join(dir, 'mgr-rec.wav'))
    ok(ca >= 3, `клиент слышал приветствие и ожидание (${ca.toFixed(1)} с звука)`)
    ok(ma >= 2, `менеджер слышал карточку (${ma.toFixed(1)} с звука)`)
    break
  }
  case 's2': {
    const FB_B = dialB(FB_URI)[0] ?? null
    ok(e.outcome === 'connected_fallback' && e.reason === 'manager_timeout' && e.answeredBy === 'fallback', 'исход connected_fallback (manager_timeout), ответила запасная', `${e.outcome}/${e.reason}/${e.answeredBy}`)
    ok(e.xferCode === 200, 'финальный NOTIFY перевода — 200', String(e.xferCode))
    ok(t.managerAnswered == null && t.card == null && mgrDials.length === 1, 'менеджер не ответил, карточки ему не было')
    const wait = t.fallback - t.dial
    ok(wait >= 3500 && wait <= 5500, `набор запасной через ${(wait / 1000).toFixed(1)} с после набора менеджера (VG_MANAGER_TIMEOUT_SEC=4)`)
    ok(fbDials.length === 1 && fbDials[0].code === 200 && e.fbCardSource === 'generic', 'запасная ответила с первого набора, ей сыграна карточка (--card)', JSON.stringify(fbDials))
    ok(t.fbDial < t.fbAnswered && t.fbAnswered <= t.fbCard && t.fbCard < t.fbCardDone && t.fbCardDone < t.fbXfer && t.fbXfer < t.fbXferFinal, 'запасной: набор → ответ → карточка до конца → REFER → NOTIFY 200', `${s('fbDial')} ${s('fbAnswered')} ${s('fbCard')} ${s('fbCardDone')} ${s('fbXfer')} ${s('fbXferFinal')}`)
    order('команды движку', [
      ['answer', (c) => c.cmd === 'answer' && c.call === A],
      ['dial менеджера', (c) => c.cmd === 'dial' && c.uri === MGR_URI],
      ['hangup менеджера (CANCEL)', (c) => c.cmd === 'hangup' && c.call === B],
      ['dial запасной', (c) => c.cmd === 'dial' && c.uri === FB_URI],
      ['play card запасной', (c) => c.cmd === 'play' && c.call === FB_B && c.tag === 'card'],
      ['xfer_replaces', (c) => c.cmd === 'xfer_replaces' && c.call === A && c.dest === FB_B],
    ])
    ok(!cmds.some((c) => c.cmd === 'xfer'), 'слепого перевода (xfer без Replaces) не было')
    ok(!cmds.some((c) => c.cmd === 'stop' && c.call === A), 'клиент до перевода слушал ожидание (stop не было)')
    ok(evs.some((x) => x.ev === 'xfer' && x.call === A && x.final && x.code === 200), 'событие xfer final 200 на ноге клиента')
    ok(down(A) && down(B) && FB_B != null && down(FB_B), 'все три ноги шлюза закрыты')
    ok(tx(eng, 'CANCEL', MGA).length >= 1 && rx(mg, 'CANCEL', GWA).length >= 1, 'шлюз отменил звонок менеджеру (CANCEL)')
    const refer = tx(eng, 'REFER', CLA)[0]
    const rt = hdr(refer, 'Refer-To') || ''
    ok(refer && rt.includes(`op@${FBA}`) && /\?Replaces=/.test(rt), 'шлюз → клиенту REFER на запасную с ?Replaces=', rt.slice(0, 120))
    const inv = tx(cl, 'INVITE', FBA).find((b) => b.first.startsWith('INVITE sip:op@') && hdr(b, 'Replaces'))
    ok(!!inv, 'клиент → запасной INVITE с Replaces')
    const cid = callId(inv)
    ok(!!resp(cl, 'RX', 200, 'INVITE', cid) && !!resp(fb, 'TX', 200, 'INVITE', cid), 'запасная ответила 200, клиент соединён с ней напрямую')
    const replacedCid = (hdr(inv, 'Replaces') || '').split(';')[0]
    ok(tx(fb, 'BYE', GWA).some((b) => callId(b) === replacedCid), 'у запасной старый звонок от шлюза заменён: BYE шлюзу по Call-ID из Replaces', replacedCid)
    ok(tx(cl, 'BYE', FBA).some((b) => callId(b) === cid), 'разговор с запасной жил до конца теста (BYE клиент → запасная)')
    const fa = activeSec(path.join(dir, 'fb-rec.wav'))
    ok(fa >= 2, `запасная слышала карточку (${fa.toFixed(1)} с звука)`)
    break
  }
  case 's3': {
    ok(e.outcome === 'rejected' && e.reason === 'not_allowed', 'исход rejected (not_allowed)', `${e.outcome}/${e.reason}`)
    ok(e.number === `…${DENIED.slice(-4)}`, `номер ${DENIED} — не из списка, в журнале только последние 4 цифры`, e.number)
    ok(!read(find(path.join(dir, 'data'), /^calls-.*\.jsonl$/)).includes(DENIED.slice(1)) && !gwOut.includes(DENIED.slice(1)), 'полного чужого номера нет ни в журнале, ни в статусе')
    const inc = evs.find((x) => x.ev === 'incoming') || {}
    ok(inc.number === `…${DENIED.slice(-4)}` && !('name' in inc) && !('from' in inc), 'в трассе входящий без имени и URI, номер маской', JSON.stringify(inc))
    ok(cmds.some((c) => c.cmd === 'hangup' && c.call === A && c.code === 486) && !cmds.some((c) => c.cmd === 'answer' || c.cmd === 'dial'), 'шлюз не отвечал и не звонил менеджеру: только hangup 486')
    ok(!!resp(cl, 'RX', 486, 'INVITE'), 'клиент получил 486 Busy Here')
    ok(/разрешены: \+380501112233 \+ внутренние/.test(gwOut), 'по умолчанию разрешённых нет, тестовый номер только добавлен флагом')
    break
  }
  case 's4': {
    ok(e.outcome === 'voicemail' && e.reason === 'manager_503' && e.fallbackReason === 'fallback_503', 'исход voicemail (manager_503, fallback_503)', `${e.outcome}/${e.reason}/${e.fallbackReason}`)
    retriesOk('менеджер', mgrDials, 503, 1000, 3000)
    retriesOk('запасная', fbDials, 503, 1000, 3000)
    ok(e.retries === mgrDials.length - 1 && e.fallbackRetries === fbDials.length - 1, `повторов: менеджеру ${e.retries}, запасной ${e.fallbackRetries}`)
    const refs = cmds.filter((c) => c.cmd === 'dial').map((c) => c.ref)
    ok(new Set(refs).size === refs.length && Bs.length === refs.length, `все наборы с разными ref: ${refs.join(', ')}`)
    ok(new Set(mg.filter((b) => b.dir === 'TX' && !b.req && b.code === 503 && b.method === 'INVITE' && b.peer === GWA).map(callId)).size === mgrDials.length &&
      new Set(fb.filter((b) => b.dir === 'TX' && !b.req && b.code === 503 && b.method === 'INVITE' && b.peer === GWA).map(callId)).size === fbDials.length, 'менеджер и запасная отвечали шлюзу 503 на каждый набор')
    order('команды движку', [
      ['answer', (c) => c.cmd === 'answer' && c.call === A],
      ['dial менеджера', (c) => c.cmd === 'dial' && c.uri === MGR_URI],
      ['dial запасной', (c) => c.cmd === 'dial' && c.uri === FB_URI],
      ['stop ожидания', (c) => c.cmd === 'stop' && c.call === A],
      ['play voicemail', (c) => c.cmd === 'play' && c.call === A && c.tag === 'voicemail' && !c.loop],
      ['play beep', (c) => c.cmd === 'play' && c.call === A && c.tag === 'beep' && !c.loop],
      ['record', (c) => c.cmd === 'record' && c.call === A],
      ['record_stop', (c) => c.cmd === 'record_stop' && c.call === A],
      ['hangup клиента', (c) => c.cmd === 'hangup' && c.call === A],
    ])
    ok(!cmds.some((c) => c.cmd === 'xfer' || c.cmd === 'xfer_replaces'), 'переводов не было')
    ok(evs.some((x) => x.ev === 'play_done' && x.call === A && x.tag === 'voicemail') && evs.some((x) => x.ev === 'play_done' && x.call === A && x.tag === 'beep'), 'фраза голосовой почты и сигнал доиграли')
    const rd = voicemailOk(3.5, 5, 'max')
    ok(rd?.reason === 'stop', 'запись остановлена командой record_stop через VG_VOICEMAIL_MAX_SEC=4', JSON.stringify(rd))
    ok(rx(cl, 'BYE', GWA).length >= 1 && down(A), 'после записи шлюз положил трубку клиента')
    ok(activeSec(path.join(dir, 'client-rec.wav')) >= 5, 'клиент слышал приветствие, ожидание, фразу почты и сигнал')
    break
  }
  case 's5': {
    ok(e.outcome === 'voicemail' && e.reason === 'manager_timeout' && e.fallbackReason === 'fallback_timeout', 'исход voicemail (manager_timeout, fallback_timeout)', `${e.outcome}/${e.reason}/${e.fallbackReason}`)
    ok(mgrDials.length === 1 && fbDials.length === 1, 'по одному набору менеджеру и запасной', JSON.stringify(e.dials))
    ok(t.fallback - t.dial >= 3500 && t.fallback - t.dial <= 5500 && t.voicemail - t.fbDial >= 2500 && t.voicemail - t.fbDial <= 4500,
      `тайм-ауты: менеджер ${((t.fallback - t.dial) / 1000).toFixed(1)} с (4), запасная ${((t.voicemail - t.fbDial) / 1000).toFixed(1)} с (VG_FALLBACK_TIMEOUT_SEC=3)`)
    ok(tx(eng, 'CANCEL', MGA).length >= 1 && rx(mg, 'CANCEL', GWA).length >= 1 && tx(eng, 'CANCEL', FBA).length >= 1 && rx(fb, 'CANCEL', GWA).length >= 1, 'шлюз отменил оба набора (CANCEL менеджеру и запасной)')
    ok(e.managerCode === 487 && e.fallbackCode === 487 && mgrDials[0]?.code === 487 && fbDials[0]?.code === 487, 'коды отменённых наборов в журнале — 487', JSON.stringify(e.dials))
    const rd = voicemailOk(1.5, 4, 'client_hangup')
    ok(rd?.reason === 'hangup', 'запись закрыл движок по отбою клиента', JSON.stringify(rd))
    ok(!cmds.some((c) => c.cmd === 'record_stop') && !cmds.some((c) => c.cmd === 'hangup' && c.call === A), 'record_stop и hangup клиента не понадобились: он положил трубку сам')
    ok(tx(cl, 'BYE', GWA).length >= 1, 'клиент положил трубку (BYE шлюзу)')
    break
  }
  case 's6': {
    const v = e.voicemail || {}
    ok(e.outcome === 'voicemail_empty' && e.reason === 'manager_486' && e.fallbackReason === 'fallback_486', 'исход voicemail_empty (manager_486, fallback_486)', `${e.outcome}/${e.reason}/${e.fallbackReason}`)
    ok(v.empty === true && v.removed === true && v.file === null && v.stop === 'client_hangup' && v.sec >= 0 && v.sec < 1, 'в журнале: сообщения нет, запись < 1 с, пустой файл удалён', JSON.stringify(v))
    const rd = evs.find((x) => x.ev === 'record_done' && x.call === A)
    ok(rd && rd.reason === 'hangup' && rd.sec < 1, 'record_done от движка: отбой во время записи, < 1 с', JSON.stringify(rd))
    ok(rd?.file && !fs.existsSync(rd.file), 'файла пустого сообщения на диске нет', rd?.file)
    const vdir = path.join(dir, 'data', 'voicemail')
    const left = fs.existsSync(vdir) ? fs.readdirSync(vdir).flatMap((d) => fs.readdirSync(path.join(vdir, d))) : []
    ok(left.length === 0, 'в data/voicemail/ ничего не осталось', left.join(', '))
    // привітання не обірвали: play_done привітання прийшов раніше за stop і фразу пошти
    const iGreetDone = trace.findIndex((x) => x.d === '<<' && x.o.ev === 'play_done' && x.o.call === A && x.o.tag === 'greeting')
    const iStop = trace.findIndex((x) => x.d === '>>' && x.o.cmd === 'stop' && x.o.call === A)
    const iPrompt = trace.findIndex((x) => x.d === '>>' && x.o.cmd === 'play' && x.o.call === A && x.o.tag === 'voicemail')
    ok(iGreetDone >= 0 && iStop > iGreetDone && iPrompt > iStop, 'приветствие доиграло до конца, потом stop и фраза почты', `play_done ${iGreetDone}, stop ${iStop}, play voicemail ${iPrompt}`)
    ok(t.fallback - t.dial < 1500 && t.voicemail < t.greetingDone && t.greetingDone <= t.vmPrompt, `оба отказали за ${((t.voicemail - t.dial) / 1000).toFixed(1)} с, почта ждала приветствие (${s('voicemail')} → ${s('greetingDone')} → ${s('vmPrompt')})`)
    ok(!cmds.some((c) => c.cmd === 'play' && c.call === A && c.tag === 'hold'), 'ожидание после отказов не включалось')
    ok(cmds.some((c) => c.cmd === 'record' && c.call === A) && !cmds.some((c) => c.cmd === 'record_stop'), 'запись начата, остановил её отбой клиента')
    break
  }
  default:
    ok(false, `неизвестный сценарий ${scn}`)
}
ok(gwExit === '0' && /шлюз остановлен/.test(gwOut), 'шлюз остановился по SIGTERM с кодом 0', `exit=${gwExit}`)
ok(!/не-JSON/.test(gwOut), 'движок не писал в stdout ничего, кроме JSON')
fs.writeFileSync(path.join(dir, 'result'), `${pass} ${fail}\n`)
JS

check() {
  "$NODE" --input-type=module -e "$CHECK_JS" "$SCN" "$SDIR" "$MANAGER_URI" "$FALLBACK_URI" "$ALLOWED_E164" "$DENIED_NUM" \
    "$GW_PORT" "$CLIENT_PORT" "$MGR_PORT" "$FB_PORT"
  local r p f
  r="$(cat "$SDIR/result" 2>/dev/null)"
  p="${r% *}"; f="${r#* }"
  [ -n "$r" ] || { p=0; f=1; say "  ОШИБКА  проверка не выполнилась"; }
  TOTAL_PASS=$((TOTAL_PASS + p))
  TOTAL_FAIL=$((TOTAL_FAIL + f))
  say "  статус шлюза:"
  sed 's/^/    | /' "$SDIR/gateway.out"
}

scenario() { # id «назва»
  SCN="$1"
  SDIR="$WORK/$1"
  mkdir -p "$SDIR"
  say ""
  say "=== $1: $2 ==="
}

abort_scenario() {
  say "  ОШИБКА  $1"
  TOTAL_FAIL=$((TOTAL_FAIL + 1))
  stop_peers
  stop_gateway
}

# ---------- підготовка ----------

T0=$(date +%s)
# Рушій у теці engine збираємо його власною ціллю make (sip-engine-next не чіпає sip-engine живого шлюзу)
case "$ENGINE" in
  "$HERE"/engine/sip-engine | "$HERE"/engine/sip-engine-next)
    make -C "$HERE/engine" --no-print-directory "$(basename "$ENGINE")" >/dev/null || { say "движок не собрался: make -C voice-gateway/engine $(basename "$ENGINE")"; exit 2; } ;;
  *) [ -x "$ENGINE" ] || { say "нет движка: $ENGINE"; exit 2; } ;;
esac
[ -x "$PJSUA" ] || { say "нет pjsua: $PJSUA"; exit 2; }
for f in "$PROMPTS/04-greeting-unknown-short.wav" "$PROMPTS/05-hold-short.wav" "$CARD_SRC" "$VM_PROMPT" "$CLIENT_VOICE"; do
  [ -r "$f" ] || { say "нет записи: $f"; exit 2; }
done
kill_leftovers
sleep 0.3
for port in $CLIENT_PORT $GW_PORT $MGR_PORT $FB_PORT; do
  if udp_bound "$port"; then say "UDP-порт 127.0.0.1:$port занят:"; lsof -nP -a -iUDP@127.0.0.1:$port; exit 2; fi
done
rm -rf "$WORK"
mkdir -p "$WORK"
cp "$CARD_SRC" "$WORK/card.wav"
say "Локальная проверка шлюза: движок $ENGINE, pjsua $PJSUA, журналы $WORK"
say "шлюз $GW_URI, менеджер $MANAGER_URI, запасная $FALLBACK_URI, клиент sip:$ALLOWED_NUM@127.0.0.1:$CLIENT_PORT"

# ---------- s1: з'єднання ----------

scenario s1 "клиент → шлюз → менеджер, перевод REFER/Replaces"
if start_gateway && start_peer mgr "$MGR_PORT" 4200 "$MANAGER_URI" 200 && start_peer client "$CLIENT_PORT" 4100 "sip:$ALLOWED_NUM@127.0.0.1:$CLIENT_PORT"; then
  peer_cmd client m "$GW_URI"
  if wait_until 30 journal_ge 1; then
    sleep 2 # клієнт і менеджер говорять напряму, шлюзу в розмові вже немає
    peer_cmd client ha
    sleep 0.7
    stop_peers
    stop_gateway
    check
  else abort_scenario "за 30 с в журнале шлюза нет строки"; fi
else abort_scenario "участники не запустились"; fi

# ---------- s2: менеджер не бере → запасна відповідає → картка → REFER/Replaces ----------

scenario s2 "менеджер не отвечает → набор запасной → карточка → REFER/Replaces"
if start_gateway && start_peer mgr "$MGR_PORT" 4200 "$MANAGER_URI" "" && start_peer fb "$FB_PORT" 4300 "$FALLBACK_URI" 200 \
  && start_peer client "$CLIENT_PORT" 4100 "sip:$ALLOWED_NUM@127.0.0.1:$CLIENT_PORT"; then
  peer_cmd client m "$GW_URI"
  if wait_until 30 journal_ge 1; then
    sleep 2 # клієнт і запасна говорять напряму
    peer_cmd client ha
    sleep 0.7
    stop_peers
    stop_gateway
    check
  else abort_scenario "за 30 с в журнале шлюза нет строки"; fi
else abort_scenario "участники не запустились"; fi

# ---------- s3: номер не з білого списку ----------

scenario s3 "номер не из списка разрешённых → 486"
if start_gateway && start_peer client "$CLIENT_PORT" 4100 "sip:$DENIED_NUM@127.0.0.1:$CLIENT_PORT"; then
  peer_cmd client m "$GW_URI"
  if wait_until 10 journal_ge 1; then
    sleep 0.5
    stop_peers
    stop_gateway
    check
  else abort_scenario "за 10 с в журнале шлюза нет строки"; fi
else abort_scenario "участники не запустились"; fi

# ---------- s4: 503 і повтори набору → голосова пошта ----------

scenario s4 "менеджер и запасная отвечают 503 → повторы в окне → голосовая почта до 4 с"
if start_gateway VG_DIAL_RETRY_INTERVAL_MS=1000 VG_DIAL_RETRY_WINDOW_SEC=3 && start_peer mgr "$MGR_PORT" 4200 "$MANAGER_URI" 503 \
  && start_peer fb "$FB_PORT" 4300 "$FALLBACK_URI" 503 && start_peer client "$CLIENT_PORT" 4100 "sip:$ALLOWED_NUM@127.0.0.1:$CLIENT_PORT" "" "$CLIENT_VOICE"; then
  peer_cmd client m "$GW_URI"
  if wait_until 45 journal_ge 1; then
    sleep 0.5
    stop_peers
    stop_gateway
    check
  else abort_scenario "за 45 с в журнале шлюза нет строки"; fi
else abort_scenario "участники не запустились"; fi

# ---------- s5: ніхто не бере → голосова пошта, клієнт кладе трубку під час запису ----------

scenario s5 "менеджер и запасная не берут → голосовая почта, клиент кладёт трубку во время записи"
if start_gateway VG_FALLBACK_TIMEOUT_SEC=3 VG_VOICEMAIL_MAX_SEC=30 && start_peer mgr "$MGR_PORT" 4200 "$MANAGER_URI" "" \
  && start_peer fb "$FB_PORT" 4300 "$FALLBACK_URI" "" && start_peer client "$CLIENT_PORT" 4100 "sip:$ALLOWED_NUM@127.0.0.1:$CLIENT_PORT" "" "$CLIENT_VOICE"; then
  peer_cmd client m "$GW_URI"
  if wait_until 40 trace_has '"cmd":"record","call"'; then
    sleep 2.5 # клієнт «говорить» у запис
    peer_cmd client ha
    if wait_until 10 journal_ge 1; then
      sleep 0.5
      stop_peers
      stop_gateway
      check
    else abort_scenario "за 10 с после отбоя в журнале шлюза нет строки"; fi
  else abort_scenario "за 40 с шлюз не начал запись голосовой почты"; fi
else abort_scenario "участники не запустились"; fi

# ---------- s6: обоє зайняті → пошта після привітання, клієнт кладе одразу після сигналу ----------

scenario s6 "менеджер и запасная заняты (486) → приветствие до конца → почта, клиент кладёт трубку сразу после сигнала"
if start_gateway && start_peer mgr "$MGR_PORT" 4200 "$MANAGER_URI" 486 && start_peer fb "$FB_PORT" 4300 "$FALLBACK_URI" 486 \
  && start_peer client "$CLIENT_PORT" 4100 "sip:$ALLOWED_NUM@127.0.0.1:$CLIENT_PORT" "" "$CLIENT_VOICE"; then
  peer_cmd client m "$GW_URI"
  if wait_until 40 trace_has '"cmd":"record","call"'; then
    peer_cmd client ha # одразу: так часто роблять, почувши «залиште повідомлення»
    if wait_until 10 journal_ge 1; then
      sleep 0.5
      stop_peers
      stop_gateway
      check
    else abort_scenario "за 10 с после отбоя в журнале шлюза нет строки"; fi
  else abort_scenario "за 40 с шлюз не начал запись голосовой почты"; fi
else abort_scenario "участники не запустились"; fi

# ---------- підсумок ----------

cleanup
LEFT="$(pgrep -fl -- "$WORK/" 2>/dev/null)"
say ""
if [ -n "$LEFT" ]; then
  say "ОШИБКА  после теста остались процессы:"; say "$LEFT"
  TOTAL_FAIL=$((TOTAL_FAIL + 1))
else
  say "процессов теста не осталось (pjsua, tail, шлюз, движок)"
fi
say "ИТОГ: проверок $((TOTAL_PASS + TOTAL_FAIL)), прошло $TOTAL_PASS, ошибок $TOTAL_FAIL; $(( $(date +%s) - T0 )) с; журналы: $WORK"
[ "$TOTAL_FAIL" -eq 0 ]
