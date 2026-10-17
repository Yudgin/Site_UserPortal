#!/usr/bin/env node
// Підроблений сервер ElevenLabs Agents для тестів ШІ-співрозмовника: свій WebSocket (RFC 6455) на 127.0.0.1 без
// залежностей, той самий протокол, що й справжній (realtime-elevenlabs.mjs), і сценарій замість LLM:
//   - на conversation_initiation_client_data — conversation_initiation_metadata (pcm_8000) і перша фраза (тон);
//   - голос клієнта (user_audio_chunk, PCM16 8 кГц) — проста VAD за рівнем; кінець репліки (тиша після голосу) —
//     user_transcript і наступний крок сценарію: «сказати» (тон заданої тривалості), викликати інструмент (з відповіддю
//     або без), закрити з'єднання;
//   - клієнт заговорив, поки «звучить» наша фраза (за часом відтворення), — interruption;
//   - ping/pong, запис усього, що прийшло, у JSON (для перевірок).
// Запуск для e2e: node fake-ai-server.mjs --port 5097 --script steps.json --record out.json
//   steps.json: {"firstSec":1.2, "steps":[{"say":1.0,"text":"…"},{"tool":{"name":"get_request_status","expect":true},
//                "then":{"say":0.8}}, {"say":0.6,"tool":{"name":"end_call"}}], "closeAfterMs": null, "refuse": false,
//                "auto": false, "vad": true, "queued": false}
//   auto — кроки за таймером (після першої фрази й після кожного кроку, коли його фразу «дограно», + afterMs кроку), а не
//   за репліками клієнта; vad:false — без реплік і перебивань (лише лічимо гучні шматки голосу клієнта: loudChunks).
//   toolFirst у кроці — client_tool_call ДО звуку фрази кроку (як execution_mode 'immediate': виклик випереджає звук);
//   queued — агент на ліміті з чергою: після metadata queue_status 'waiting' і тон утримання звичайними audio, без
//   першої фрази (справжній сервер так тримає до 180 с); tentative — tentative_user_transcript на початку репліки
//   клієнта. Тексти contextual_update — у contextualTexts.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const RATE = 8000

function toneB64(sec, hz = 700, amp = 7000) {
  const n = Math.round(RATE * sec)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE)), i * 2)
  return b
}

const rmsOf = (b) => {
  const n = Math.floor(b.length / 2)
  let s = 0
  for (let i = 0; i < n; i++) {
    const v = b.readInt16LE(i * 2)
    s += v * v
  }
  return n ? Math.sqrt(s / n) : 0
}

// Один кадр WebSocket від сервера (без маски)
function wsFrame(opcode, payload) {
  const len = payload.length
  let head
  if (len < 126) head = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

export function startFakeElevenLabs({ port = 0, host = '127.0.0.1', script = {}, recordFile = null, log = () => {} } = {}) {
  const rec = { connections: 0, inits: [], toolResults: [], userTurns: 0, interruptions: 0, pongs: 0, audioChunks: 0, loudChunks: 0, closes: [], toolCalls: [], contextualTexts: [], t0: null }
  const save = () => { if (recordFile) fs.writeFileSync(recordFile, JSON.stringify(rec, null, 2)) }
  const sockets = new Set()

  const server = http.createServer((req, res) => {
    // підписана адреса, як справжній get-signed-url
    if (req.url.startsWith('/v1/convai/conversation/get-signed-url')) {
      rec.signedUrlKey = req.headers['xi-api-key'] ? 'present' : 'missing'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ signed_url: `ws://${host}:${server.address().port}/v1/convai/conversation?agent_id=x&conversation_signature=fake` }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  server.on('upgrade', (req, sock) => {
    if (script.refuse) {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
    sockets.add(sock)
    rec.connections++
    session(sock)
  })

  function session(sock) {
    let buf = Buffer.alloc(0)
    let frag = null
    let eventId = 0
    let stepIdx = 0
    let speakingUntil = 0 // до коли «звучить» наша фраза (час відтворення в реальному часі)
    let userSpeech = 0 // мс голосу в поточній репліці
    let silence = 0
    let inTurn = false
    let busy = false // чекаємо client_tool_result
    let pendingTool = null
    let closed = false
    let pingTimer = null
    const send = (o) => { if (!closed) sock.write(wsFrame(1, Buffer.from(JSON.stringify(o)))) }

    function say(sec, text) {
      eventId++
      const id = eventId
      const pcm = toneB64(sec)
      // шматки по 100 мс одразу (сервер віддає швидше, ніж звучить)
      for (let i = 0; i < pcm.length; i += 1600) send({ type: 'audio', audio_event: { audio_base_64: pcm.subarray(i, i + 1600).toString('base64'), event_id: id } })
      if (text) send({ type: 'agent_response', agent_response_event: { agent_response: text, event_id: id } })
      speakingUntil = Math.max(Date.now(), speakingUntil) + sec * 1000
      return id
    }

    const at = () => (rec.t0 == null ? 0 : Date.now() - rec.t0)
    // auto: наступний крок — коли поточну фразу «дограно» (за часом відтворення) + afterMs наступного кроку
    function scheduleNext() {
      if (!script.auto || closed) return
      const next = (script.steps || [])[stepIdx]
      if (!next) return
      setTimeout(() => { if (!closed && !busy) runStep() }, Math.max(0, speakingUntil - Date.now()) + (next.afterMs ?? 500))
    }

    function runStep() {
      const st = (script.steps || [])[stepIdx++]
      if (!st) return
      if (st.close) {
        closeConn(1011, 'scripted close')
        return
      }
      const callTool = () => {
        const callId = `tc-${stepIdx}`
        const expect = st.tool.expect === true
        rec.toolCalls.push({ name: st.tool.name, expect, at: at() })
        send({ type: 'client_tool_call', client_tool_call: { tool_name: st.tool.name, tool_call_id: callId, parameters: st.tool.params || {}, event_id: eventId, expects_response: expect } })
        if (expect) {
          busy = true
          pendingTool = { callId, then: st.then || null }
        }
      }
      if (st.tool && st.toolFirst) callTool()
      if (st.say) say(st.say, st.text || null)
      if (st.tool && !st.toolFirst) callTool()
      if (!busy) {
        send({ type: 'agent_response_complete', agent_response_complete_event: { event_id: eventId } })
        scheduleNext()
      }
    }

    function onUserAudio(pcm) {
      rec.audioChunks++
      const ms = (pcm.length / 2 / RATE) * 1000
      const loud = rmsOf(pcm) > 600
      if (loud) rec.loudChunks++
      if (script.vad === false) return
      if (loud) {
        userSpeech += ms
        silence = 0
        if (!inTurn && userSpeech >= 200) {
          inTurn = true
          // проміжне розпізнавання (client_events tentative_user_transcript; SDK TentativeTranscriptionData)
          if (script.tentative) send({ type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: '…', event_id: eventId + 1 } })
          if (Date.now() < speakingUntil - 150) {
            // клієнт заговорив поверх нашої фрази — перебивання
            rec.interruptions++
            send({ type: 'interruption', interruption_event: { event_id: eventId } })
            speakingUntil = 0
            // справжній сервер може ще надіслати хвіст перебитої відповіді — клієнт має його відкинути
            if (script.lateAudio) send({ type: 'audio', audio_event: { audio_base_64: toneB64(0.2).toString('base64'), event_id: eventId } })
          }
        }
      } else if (inTurn) {
        silence += ms
        if (silence >= 500) {
          inTurn = false
          userSpeech = 0
          silence = 0
          rec.userTurns++
          send({ type: 'user_transcript', user_transcription_event: { user_transcript: `репліка ${rec.userTurns}`, event_id: ++eventId } })
          save()
          if (!busy) runStep()
        }
      } else userSpeech = 0
    }

    function onText(text) {
      let m
      try { m = JSON.parse(text) } catch { return }
      if (m.user_audio_chunk) return onUserAudio(Buffer.from(m.user_audio_chunk, 'base64'))
      switch (m.type) {
        case 'conversation_initiation_client_data': {
          rec.inits.push(m)
          rec.t0 = rec.t0 ?? Date.now()
          save()
          send({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: `conv_fake_${rec.connections}`, agent_output_audio_format: script.format || 'pcm_8000', user_input_audio_format: script.format || 'pcm_8000' } })
          if (script.queued) {
            // QueueStatus: 'waiting' — після metadata і до тону утримання; тон — звичайні audio (клієнт має їх не грати)
            rec.queued = (rec.queued || 0) + 1
            send({ type: 'queue_status', queue_status_event: { status: 'waiting' } })
            const hold = toneB64(0.5, 425)
            for (let i = 0; i < hold.length; i += 1600) send({ type: 'audio', audio_event: { audio_base_64: hold.subarray(i, i + 1600).toString('base64'), event_id: eventId } })
            pingTimer = setInterval(() => send({ type: 'ping', ping_event: { event_id: ++eventId, ping_ms: 30 } }), 1000)
            save()
            return
          }
          const fm = m.conversation_config_override?.agent?.first_message
          if (fm) {
            say(script.firstSec ?? 1.2, fm)
            send({ type: 'agent_response_complete', agent_response_complete_event: { event_id: eventId } })
          }
          pingTimer = setInterval(() => send({ type: 'ping', ping_event: { event_id: ++eventId, ping_ms: 30 } }), 1000)
          if (script.closeAfterMs != null) setTimeout(() => closeConn(1011, 'scripted failure'), script.closeAfterMs)
          if (script.auto) scheduleNext()
          return
        }
        case 'client_tool_result':
          rec.toolResults.push({ id: m.tool_call_id, result: (() => { try { return JSON.parse(m.result) } catch { return m.result } })(), is_error: m.is_error })
          save()
          if (pendingTool && m.tool_call_id === pendingTool.callId) {
            const then = pendingTool.then
            pendingTool = null
            busy = false
            if (then?.say) say(then.say, then.text || null)
            send({ type: 'agent_response_complete', agent_response_complete_event: { event_id: eventId } })
            scheduleNext()
          }
          return
        case 'pong':
          rec.pongs++
          return
        case 'contextual_update':
          rec.contextual = (rec.contextual || 0) + 1
          rec.contextualTexts.push(m.text)
          save()
          return
        default:
      }
    }

    function closeConn(code, reason) {
      if (closed) return
      const p = Buffer.alloc(2 + Buffer.byteLength(reason))
      p.writeUInt16BE(code, 0)
      p.write(reason, 2)
      sock.write(wsFrame(8, p))
      closed = true
      clearInterval(pingTimer)
      rec.closes.push({ by: 'server', code, at: at() })
      save()
      setTimeout(() => sock.destroy(), 100)
    }

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (buf.length < 2) return
        const fin = (buf[0] & 0x80) !== 0
        const op = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        const mlen = masked ? 4 : 0
        if (buf.length < off + mlen + len) return
        const mask = masked ? buf.subarray(off, off + 4) : null
        const payload = Buffer.from(buf.subarray(off + mlen, off + mlen + len))
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
        buf = buf.subarray(off + mlen + len)
        if (op === 8) {
          if (!closed) {
            closed = true
            clearInterval(pingTimer)
            rec.closes.push({ by: 'client', code: payload.length >= 2 ? payload.readUInt16BE(0) : null, at: at() })
            save()
            sock.write(wsFrame(8, payload.subarray(0, 2)))
          }
          sock.end()
          return
        }
        if (op === 9) { sock.write(wsFrame(10, payload)); continue }
        if (op === 10) continue
        if (op === 0) {
          frag = Buffer.concat([frag || Buffer.alloc(0), payload])
          if (fin) { onText(frag.toString('utf8')); frag = null }
          continue
        }
        if (op === 1 || op === 2) {
          if (fin) onText(payload.toString('utf8'))
          else frag = payload
        }
      }
    })
    sock.on('close', () => {
      clearInterval(pingTimer)
      sockets.delete(sock)
      if (!closed) {
        closed = true
        rec.closes.push({ by: 'tcp' })
        save()
      }
    })
    sock.on('error', () => {})
  }

  const ready = new Promise((r) => server.listen(port, host, r))
  return {
    ready,
    rec,
    get port() { return server.address().port },
    get wsUrl() { return `ws://${host}:${server.address().port}/v1/convai/conversation?agent_id=test` },
    get apiBase() { return `http://${host}:${server.address().port}` },
    close() {
      for (const s of sockets) s.destroy()
      server.close()
    },
  }
}

// Окремий процес для e2e-local.sh
if (process.argv[1] && process.argv[1].endsWith('fake-ai-server.mjs')) {
  const arg = (name, def = null) => {
    const i = process.argv.indexOf(name)
    return i > 0 ? process.argv[i + 1] : def
  }
  const script = arg('--script') ? JSON.parse(fs.readFileSync(arg('--script'), 'utf8')) : {}
  const srv = startFakeElevenLabs({ port: Number(arg('--port', '5097')), script, recordFile: arg('--record') })
  srv.ready.then(() => process.stdout.write(`fake-ai: ws://127.0.0.1:${srv.port}\n`))
  process.on('SIGTERM', () => { srv.close(); process.exit(0) })
  process.on('SIGINT', () => { srv.close(); process.exit(0) })
}
