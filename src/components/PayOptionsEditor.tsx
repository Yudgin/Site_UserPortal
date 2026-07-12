// Выбор разрешённых способов оплаты фактической калькуляции + ФОП по каждому способу.
// Дефолт (какой способ каким ФОПом) подставляется из настроек сервисного центра; мастер может
// включить/выключить способ и переопределить ФОП. Онлайн-оплата (LiqPay/monobank Частини) идёт
// через сайт; накладений платіж — при отриманні; прочие способы — поки лише налаштування ФОП.
import {
  Paper, Typography, Stack, Checkbox, FormControlLabel, TextField, MenuItem, Alert, Chip, Box,
} from '@mui/material'
import { PAY_METHOD_KEYS, PAY_METHOD_LABELS, ONLINE_PAY_METHODS, type PayMethodKey, type EstimatePayOption } from '@/types/pricing'
import type { FopPublic } from '@/api/endpoints/payments'

export default function PayOptionsEditor({ value, onChange, fops }: {
  value: EstimatePayOption[]
  onChange: (v: EstimatePayOption[]) => void
  fops: FopPublic[]
}) {
  const eligibleFor = (m: PayMethodKey) => fops.filter((f) => (f.methods as Record<string, boolean>)[m])
  const optOf = (m: PayMethodKey) => value.find((o) => o.method === m)

  const toggle = (m: PayMethodKey) => {
    if (optOf(m)) { onChange(value.filter((o) => o.method !== m)); return }
    const elig = eligibleFor(m)
    onChange([...value, { method: m, fopId: elig[0]?.id || '' }])
  }
  const setFop = (m: PayMethodKey, fopId: string) =>
    onChange(value.map((o) => (o.method === m ? { ...o, fopId } : o)))

  return (
    <Paper sx={{ p: 2, mb: 3 }}>
      <Typography variant="subtitle1" sx={{ mb: 0.5 }}>Способи оплати</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
        Чим клієнт зможе оплатити. ФОП по кожному способу підставлено з налаштувань центру — можна змінити.
      </Typography>

      {fops.length === 0 && <Alert severity="warning" sx={{ mb: 1.5 }}>ФОПи не налаштовані — оплату буде вимкнено.</Alert>}

      <Stack spacing={1}>
        {PAY_METHOD_KEYS.map((m) => {
          const elig = eligibleFor(m)
          const opt = optOf(m)
          const online = ONLINE_PAY_METHODS.includes(m)
          return (
            <Box key={m} sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
              <FormControlLabel sx={{ minWidth: 240, m: 0 }}
                control={<Checkbox size="small" checked={!!opt} disabled={elig.length === 0} onChange={() => toggle(m)} />}
                label={<span>{PAY_METHOD_LABELS[m]}{' '}
                  {m === 'cod'
                    ? <Chip size="small" variant="outlined" label="при отриманні" />
                    : !online && <Chip size="small" variant="outlined" color="warning" label="потік не готовий" />}
                </span>} />
              {opt && (
                <TextField select size="small" sx={{ minWidth: 220 }} label="ФОП" value={opt.fopId}
                  onChange={(e) => setFop(m, e.target.value)}
                  helperText={elig.length === 0 ? 'Жоден ФОП не підтримує' : undefined}>
                  {elig.map((f) => <MenuItem key={f.id} value={f.id}>{f.name}{!f.receipts && ' (без чека!)'}</MenuItem>)}
                </TextField>
              )}
            </Box>
          )
        })}
      </Stack>

      {value.length === 0 && <Alert severity="info" sx={{ mt: 1.5 }}>Оберіть хоча б один спосіб оплати.</Alert>}
    </Paper>
  )
}
