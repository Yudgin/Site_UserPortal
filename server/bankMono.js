// monobank, личный API (api.monobank.ua): только чтение. Токен выдаёт человек в своём приложении, он открывает
// и личные карты, и счета его ФОП. Портал берёт ТОЛЬКО счета ФОП: личные карты не читаем и не храним.
// Банк принимает не больше одного запроса client-info в минуту на токен (429 при превышении).
import axios from 'axios'

const BASE = process.env.MONO_PERSONAL_BASE_URL || 'https://api.monobank.ua'

export const clientInfo = async (token) =>
  (await axios.get(`${BASE}/personal/client-info`, { headers: { 'X-Token': token }, timeout: 15000 })).data

const CURRENCY = { 980: 'UAH', 840: 'USD', 978: 'EUR' }
const kopToUah = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) / 100 : null)
const account = (a, owner) => ({
  id: String(a.id || ''),
  iban: String(a.iban || ''),
  currency: CURRENCY[a.currencyCode] || String(a.currencyCode || ''),
  balance: kopToUah(a.balance),
  ...(owner ? { owner } : {}),
})

// Счета ФОП из ответа client-info: свои (type 'fop') и счета клиентов, которыми управляет владелец токена
// (managedClients — так банк отдаёт ФОП в части кабинетов). personal — сколько личных счетов мы пропустили.
export const fopAccounts = (info) => {
  const own = Array.isArray(info?.accounts) ? info.accounts.filter((a) => a && typeof a === 'object') : []
  const managed = Array.isArray(info?.managedClients) ? info.managedClients.filter((c) => c && typeof c === 'object') : []
  const accounts = [
    ...own.filter((a) => a.type === 'fop').map((a) => account(a)),
    ...managed.flatMap((c) => (Array.isArray(c.accounts) ? c.accounts : [])
      .filter((a) => a && typeof a === 'object')
      .map((a) => account(a, [c.name, c.tin && `код ${c.tin}`].filter(Boolean).join(', ')))),
  ]
  return { accounts, personal: own.filter((a) => a.type !== 'fop').length }
}

export default { clientInfo, fopAccounts }
