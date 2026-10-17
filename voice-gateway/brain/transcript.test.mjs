import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { stripVoiceTags, cleanAiTranscript } from './transcript.mjs'
import { makeJournal } from './journal.mjs'
import { createAgent } from './agent.mjs'

test('голосові теги: звичайний текст без тегів зберігає пробіли й переноси, клієнт — навіть латинські дужки', () => {
  const ordinary = '  Заявка [12]\n  [уточнення] готова.  '
  assert.equal(stripVoiceTags(ordinary), ordinary)
  const record = { note: { question: '[slow] Статус?' }, turns: [
    { speaker: 'ai', text: '[slow] Вітаю [laughs]!' },
    { speaker: 'client', text: '  [laughs] [12] [уточнення]\n  ' },
    { speaker: 'ai', text: '[sighs softly]' },
  ] }
  const cleaned = cleanAiTranscript(record)
  assert.deepEqual(cleaned.turns.map((x) => x.text), ['Вітаю!', record.turns[1].text])
  assert.equal(cleaned.note.question, 'Статус?')
  assert.equal(record.note.question, '[slow] Статус?')
  assert.equal(record.turns[0].text, '[slow] Вітаю [laughs]!')
})

test('журнал: захист очищає лише репліки ШІ та його питання, не змінюючи переданий запис', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-journal-tags-'))
  const entry = {
    ai: { note: { question: '[slow] Статус?' } },
    aiTranscript: { turns: [{ speaker: 'ai', text: '[laughs] Готово.' }, { speaker: 'client', text: '[slow] так [12]' }] },
  }
  try {
    const file = makeJournal({ dataDir: dir })(entry)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(stored.ai.note.question, 'Статус?')
    assert.deepEqual(stored.aiTranscript.turns.map((x) => x.text), ['Готово.', '[slow] так [12]'])
    assert.equal(entry.aiTranscript.turns[0].text, '[laughs] Готово.')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('агент: result очищає репліки й виправлення ШІ; клієнтські дужки лишаються', () => {
  const session = new EventEmitter()
  session.close = () => {}
  const provider = {
    name: 'fake', model: 'fake', engineRate: 8000,
    inputFormat: { encoding: 'pcm16', rate: 8000 }, outputFormat: { encoding: 'pcm16', rate: 8000 },
    connect: () => session,
  }
  const server = { path: '/fake', token: () => 'fake', expect: () => new Promise(() => {}), cancel: () => {} }
  const agent = createAgent({ call: 1, server, provider, clock: { now: () => 1000, setTimeout, clearTimeout }, onTool: async () => ({ ok: true }) })
  agent.start()
  session.emit('transcript', { role: 'assistant', text: '[slow] Перше.' })
  session.emit('transcript', { role: 'assistant', text: '[laughs] Виправлено [12].', correction: true })
  session.emit('transcript', { role: 'user', text: '[slow] Клієнт [12].' })
  session.emit('transcript', { role: 'assistant', text: '[sighs]' })
  agent.stop('test')
  assert.deepEqual(agent.result().turns.map((x) => x.text), ['Виправлено [12].', '[slow] Клієнт [12].'])
})
