import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAiMode, expandSystem, expandUserContent, MODEL_PRICES, AI_MODES } from './aiModes.js'

test('resolveAiMode: unknown or missing mode falls back to the default editor', () => {
  assert.equal(resolveAiMode({}).name, 'default')
  assert.equal(resolveAiMode({ mode: 'weird' }).name, 'default')
  assert.equal(resolveAiMode(null).model, 'claude-opus-4-8')
  assert.equal(resolveAiMode({}).effort, 'low')
})

test('resolveAiMode: expand uses the current Opus with deeper thinking', () => {
  const m = resolveAiMode({ mode: 'expand' })
  assert.equal(m.name, 'expand')
  assert.equal(m.model, AI_MODES.expand.model)
  assert.equal(m.effort, 'high')
  assert.ok(m.maxTokens >= 4096)
  assert.ok(MODEL_PRICES[m.model], 'price table knows the expand model')
})

test('expand prompts: Ukrainian output, no greeting, notes and reference included', () => {
  const sys = expandSystem('Це результати технічної діагностики.')
  assert.match(sys, /УКРАЇНСЬКОЮ/)
  assert.match(sys, /Без звертання/)
  assert.match(sys, /Не вигадуй/)
  const u = expandUserContent({ currentText: 'не працює ехолот', reference: 'Кораблик: Solo V3', userPrompt: '  ' })
  assert.match(u, /Нотатки майстра/)
  assert.match(u, /Solo V3/)
  assert.doesNotMatch(u, /Побажання/)
  assert.match(expandUserContent({ currentText: 'x', userPrompt: 'коротше' }), /Побажання майстра до тексту: коротше/)
})
