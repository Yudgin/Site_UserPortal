// Результат кнопки «Перевірити ключі» на /fops: по каждому провайдеру — вердикт сервера.
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material'
import type { FopKeyCheck, KeyCheckItem, KeyCheckStatus } from '@/api/endpoints/fopsAdmin'

const SEVERITY: Record<KeyCheckStatus, 'success' | 'error' | 'warning' | 'info'> = {
  ok: 'success', bad: 'error', unknown: 'warning', none: 'info',
}

const ROWS: { key: keyof FopKeyCheck; title: string }[] = [
  { key: 'liqpay', title: 'LiqPay' },
  { key: 'monoAcquire', title: 'monobank еквайринг' },
  { key: 'novaPoshta', title: 'Нова Пошта' },
]

const paymentControlLine = (v: KeyCheckItem['paymentControl']) => {
  if (v === true) return 'Контроль оплати (гроші на рахунок ФОП): доступний у цього відправника.'
  if (v === false) return 'Контроль оплати (гроші на рахунок ФОП): не підключений у цього відправника.'
  return v === null ? 'Контроль оплати: Нова Пошта не повідомила, чи він доступний.' : ''
}

interface Props {
  open: boolean
  fopName?: string
  data?: FopKeyCheck
  error?: string
  onClose: () => void
}

export default function KeyCheckDialog({ open, fopName, data, error, onClose }: Props) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Перевірка ключів · {fopName}</DialogTitle>
      <DialogContent dividers>
        {error ? <Alert severity="error">{error}</Alert> : data && (
          <Stack spacing={1}>
            {ROWS.map(({ key, title }) => {
              const r = data[key]
              const pc = paymentControlLine(r.paymentControl)
              return (
                <Alert key={key} severity={SEVERITY[r.status]}>
                  <Box sx={{ fontWeight: 600 }}>{title}</Box>
                  {r.message}
                  {(r.merchantName || r.edrpou) && <Box sx={{ mt: 0.5 }}>Кабінет: {r.merchantName ? <b>{r.merchantName}</b> : 'без назви'}{r.edrpou ? `, код ${r.edrpou}` : ''}</Box>}
                  {pc && <Box sx={{ mt: 0.5 }}>{pc}</Box>}
                  {r.note && <Box sx={{ mt: 0.5 }}>{r.note}</Box>}
                </Alert>
              )
            })}
            <Typography variant="caption" color="text.secondary">
              Гроші не списуються, чек і накладна не створюються. monobank Частини, ПриватБанк і Checkbox ця кнопка не перевіряє.
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  )
}
