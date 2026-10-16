// Доступ до Google Cloud без SDK: токен доступу (метадані GCE → інакше gcloud ADC) і Secret Manager через REST.
// Значення секретів і токени ніде не логуємо — лише назви і коди помилок.
import { execFile } from 'node:child_process'

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'

const execText = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (e, stdout) => {
    if (e) reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${e.code ?? e.signal ?? 'failed'}`))
    else resolve(String(stdout).trim())
  })
})

// Токен: на ВМ GCE — сервісного акаунта з метаданих; на Mac — `gcloud auth application-default print-access-token`.
// Кешуємо до закінчення строку (з запасом), щоб не смикати gcloud на кожен секрет.
export function makeTokenSource({ fetchImpl = globalThis.fetch, exec = execText, now = Date.now } = {}) {
  let cached = null
  return async function getAccessToken() {
    if (cached && cached.until > now()) return cached.token
    try {
      const r = await fetchImpl(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1000) })
      if (r.ok) {
        const j = await r.json()
        if (j?.access_token) {
          cached = { token: j.access_token, until: now() + Math.max(60, Number(j.expires_in || 300) - 120) * 1000, source: 'metadata' }
          return cached.token
        }
      }
    } catch { /* не GCE — далі gcloud */ }
    const token = await exec('gcloud', ['auth', 'application-default', 'print-access-token'], 20000)
    if (!token) throw new Error('gcloud: порожній токен (потрібен gcloud auth application-default login)')
    cached = { token, until: now() + 40 * 60 * 1000, source: 'gcloud' }
    return token
  }
}

// Остання (або задана) версія секрету як рядок UTF-8.
export async function accessSecret({ project, name, version = 'latest', getAccessToken, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  const token = await getAccessToken()
  const url = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}:access`
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`Secret Manager ${name}: HTTP ${r.status}`)
  const j = await r.json()
  const data = j?.payload?.data
  if (!data) throw new Error(`Secret Manager ${name}: порожнє значення`)
  return Buffer.from(data, 'base64').toString('utf8')
}
