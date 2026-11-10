// Метки ключей ФОП на /fops. Цвет — по последней проверке (вручную или ежедневной), а не по типу ключа:
// зелёный — проверка прошла, красный — проблема, оранжевый — проверить не удалось или скоро перестанет работать
// (подписка Checkbox, блокировка, подпись кассира), серый — ещё не проверено.
// Под метками — текст проблем, чтобы их было видно без нажатия «Перевірити ключі».
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material'
import type { FopAdmin, FopKeyCheck, FopSecretsSet, KeyCheckStatus, KeyCheckSummary } from '@/api/endpoints/fopsAdmin'

const CHIPS: { key: keyof FopSecretsSet; label: string; check?: keyof FopKeyCheck }[] = [
  { key: 'liqpay', label: 'LiqPay', check: 'liqpay' },
  { key: 'monoChast', label: 'mono Частини', check: 'monoChast' },
  { key: 'monoAcquire', label: 'mono еквайринг', check: 'monoAcquire' },
  { key: 'privatPaypart', label: 'ПриватБанк Частини' },
  { key: 'checkbox', label: 'Checkbox (чеки)', check: 'checkbox' },
  { key: 'novaPoshtaApiKey', label: 'Нова Пошта', check: 'novaPoshta' },
  // Банки ФОП: остатки и выписки, не приём оплат
  { key: 'monoPersonal', label: 'рахунок monobank', check: 'bankMono' },
  { key: 'privatAutoclient', label: 'рахунок ПриватБанку', check: 'bankPrivat' },
  { key: 'novaPay', label: 'рахунок NovaPay', check: 'bankNovaPay' },
]

const COLOR: Record<KeyCheckStatus, 'success' | 'error' | 'warning' | 'default'> = {
  ok: 'success', bad: 'error', unknown: 'warning', none: 'default',
}

const chipColor = (r?: KeyCheckSummary) => (!r ? 'default' : r.status === 'ok' && r.soon ? 'warning' : COLOR[r.status])
// «Checkbox (чеки): Checkbox: Касу заблоковано» — второе название лишнее.
const plain = (text: string) => text.replace(/^Checkbox:\s*/, '')

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function FopKeyChips({ fop }: { fop: FopAdmin }) {
  const shown = CHIPS.filter((c) => fop.secretsSet[c.key])
  if (!shown.length) return <Typography variant="caption" color="text.secondary">ключі не задані</Typography>
  const results = fop.lastCheck?.results || {}
  const lines = shown.flatMap((c) => {
    const r = c.check ? results[c.check] : undefined
    if (!r) return []
    if (r.status === 'bad') return [{ label: c.label, text: plain(r.message), color: 'error.main' }]
    if (r.status === 'unknown') return [{ label: c.label, text: r.message, color: 'warning.dark' }]
    return r.note ? [{ label: c.label, text: r.note, color: r.soon ? 'warning.dark' : 'text.secondary' }] : []
  })
  return (
    <Box>
      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
        {shown.map((c) => {
          const r = c.check ? results[c.check] : undefined
          const title = !c.check
            ? 'Не перевіряється: пряме підключення ПриватБанку ще не зроблене, частини ПриватБанку йдуть через LiqPay'
            : r ? [r.message, r.note].filter(Boolean).join(' ') : 'Ще не перевірено: натисніть «Перевірити ключі»'
          return (
            <Tooltip key={c.key} title={title}>
              <Chip size="small" label={c.label} color={chipColor(r)} variant={r && r.status !== 'none' ? 'filled' : 'outlined'} />
            </Tooltip>
          )
        })}
      </Stack>
      {lines.map((l) => (
        <Typography key={`${l.label}:${l.text}`} variant="caption" component="div" sx={{ color: l.color, mt: 0.5 }}>
          {l.label}: {l.text}
        </Typography>
      ))}
      {fop.lastCheck?.checkedAt && (
        <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: 0.5 }}>
          Перевірено {when(fop.lastCheck.checkedAt)} · {fop.lastCheck.source === 'daily' ? 'щоденна перевірка' : 'вручну'}
        </Typography>
      )}
    </Box>
  )
}
