// ПриватБанк, API «Автоклієнт» (Приват24 для бізнесу): остатки и выписки по счетам ФОП. Портал только читает,
// платежей не создаёт. По документу банка: хост acp.privatbank.ua, заголовки User-Agent, token и Content-Type
// (в старом формате ещё id), не чаще одного запроса в секунду, без acc — все активные счета.
import axios from 'axios'

const BASE = process.env.PRIVAT_AUTOCLIENT_BASE_URL || 'https://acp.privatbank.ua'

const headers = ({ token, id }) => ({
  'User-Agent': 'RunFerry-Backend',
  token,
  ...(id ? { id } : {}),
  'Content-Type': 'application/json;charset=utf8',
})

// Состояние дня банка: при phase не WRK или work_balance = Y запросы остатков банк просит не слать.
export const settings = async (creds) =>
  (await axios.get(`${BASE}/api/statements/settings`, { headers: headers(creds), timeout: 15000 })).data

// Остатки за промежуток «последний закрытый день — сегодня» по всем активным счетам.
export const interimBalances = async (creds, { followId, limit = 100 } = {}) =>
  (await axios.get(`${BASE}/api/statements/balance/interim`, {
    headers: headers(creds), params: { limit, ...(followId ? { followId } : {}) }, timeout: 20000,
  })).data

// «31.12.2026 00:00:00» или «31.12.2026» → число для сравнения; непонятное — 0.
const dayOf = (v) => {
  const m = /^(\d{2})[.-](\d{2})[.-](\d{4})/.exec(String(v || ''))
  return m ? Number(`${m[3]}${m[2]}${m[1]}`) : 0
}

// По каждому счёту — строка самого позднего дня: в ответе interim бывает по строке на день.
export const latestBalances = (rows) => {
  const byAcc = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object' || !r.acc) continue
    const prev = byAcc.get(r.acc)
    if (!prev || dayOf(r.dpd) >= dayOf(prev.dpd)) byAcc.set(r.acc, r)
  }
  return [...byAcc.values()].map((r) => {
    const balance = Number(r.balanceOut)
    return {
      iban: String(r.acc),
      currency: String(r.currency || ''),
      balance: r.balanceOut != null && r.balanceOut !== '' && Number.isFinite(balance) ? balance : null,
      ...(r.nameACC ? { owner: String(r.nameACC) } : {}),
    }
  })
}

export default { settings, interimBalances, latestBalances }
