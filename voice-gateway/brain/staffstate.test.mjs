// Локальний стан ведучих — тимчасові каталоги й підроблений годинник.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeStaffState, STAFF_FILE } from './staffstate.mjs'

const UID = 'fictional-staff'

test('staff: два пропуски по співробітнику з різних номерів → 120 хв паузи, далі новий відлік', () => {
  let now = 1000000
  const s = makeStaffState({ now: () => now })
  assert.equal(s.miss('908', { uid: UID }).misses, 1)
  assert.equal(s.miss('+380500000003', { uid: UID }).paused, true)
  assert.equal(s.isPaused('909', { uid: UID }), true)
  assert.equal(s.pausedUntil('908', { uid: UID }), now + 120 * 60000)
  assert.equal(s.get('908').misses, 0)
  assert.equal(s.isPaused('908', { uid: 'fictional-other' }), false, 'два співробітники на одній лінії не ділять пропуски')
  now += 120 * 60000
  assert.equal(s.isPaused('908', { uid: UID }), false)
  assert.equal(s.miss('908', { uid: UID }).misses, 1)
})

test('staff: 486 не пропуск, answered скидає серію; без uid працює ключ групи', () => {
  const s = makeStaffState({ now: () => 2000000 })
  assert.equal(s.miss('908', { code: 486 }), null)
  assert.equal(s.get('908'), null)
  s.miss('908')
  s.answered('908')
  assert.equal(s.get('908').misses, 0)
  assert.equal(s.miss('908').paused, false)
  assert.equal(s.isPaused('907'), false)
})

test('staff: атомарний файл 0600, каталог 0700, перезапуск зберігає паузу й не лишає tmp', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-staff-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'private')
  const s = makeStaffState({ dataDir, now: () => 3000000 })
  s.miss('908', { uid: UID })
  s.miss('908', { uid: UID })
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(dataDir), [STAFF_FILE])
  assert.equal(makeStaffState({ dataDir, now: () => 3000000 }).isPaused('909', { uid: UID }), true)
  const copy = s.get('908')
  copy.misses = 100
  assert.equal(s.get('908').misses, 0)
})

test('staff: пошкоджений JSON безпечний; старий ключ мігрує на uid без втрати пропуску', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-staff-legacy-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const file = path.join(dataDir, STAFF_FILE)
  fs.writeFileSync(file, '{bad')
  const logs = []
  const s = makeStaffState({ dataDir, now: () => 4000000, log: (m) => logs.push(m) })
  assert.equal(s.isPaused('908'), false)
  assert.match(logs[0], /не JSON/)
  fs.writeFileSync(file, JSON.stringify({ v: 1, staff: { 908: { misses: 1 } } }))
  assert.equal(s.miss('908', { uid: UID }).paused, true)
  assert.equal(s.isPaused('909', { uid: UID }), true)
})
