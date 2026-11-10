// Результат кнопки «Перевірити ключі» на /fops: по каждому провайдеру — вердикт сервера.
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material'
import type { BankAccountInfo, FopKeyCheck, KeyCheckItem, KeyCheckStatus } from '@/api/endpoints/fopsAdmin'

const SEVERITY: Record<KeyCheckStatus, 'success' | 'error' | 'warning' | 'info'> = {
  ok: 'success', bad: 'error', unknown: 'warning', none: 'info',
}

const ROWS: { key: keyof FopKeyCheck; title: string }[] = [
  { key: 'liqpay', title: 'LiqPay' },
  { key: 'monoAcquire', title: 'monobank еквайринг' },
  { key: 'monoChast', title: 'monobank Частини' },
  { key: 'checkbox', title: 'Checkbox (чеки)' },
  { key: 'novaPoshta', title: 'Нова Пошта' },
  { key: 'bankMono', title: 'Рахунок monobank (залишки та виписки)' },
  { key: 'bankPrivat', title: 'Рахунок ПриватБанку (залишки та виписки)' },
  { key: 'bankNovaPay', title: 'Рахунок NovaPay (залишки та виписки)' },
]

// Счёт ФОП, как его показал банк: по нему владелец сверяет, что ключ от нужного ФОП.
const accountLine = (a: BankAccountInfo) => {
  const balance = typeof a.balance === 'number'
    ? `${a.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${a.currency || ''}`.trim()
    : 'залишок невідомий'
  return [a.iban, balance, a.owner].filter(Boolean).join(' · ')
}

const paymentControlLine = (v: KeyCheckItem['paymentControl']) => {
  if (v === true) return 'Контроль оплати (гроші на рахунок ФОП): доступний у цього відправника.'
  if (v === false) return 'Контроль оплати (гроші на рахунок ФОП): не підключений у цього відправника.'
  return v === null ? 'Контроль оплати: Нова Пошта не повідомила, чи він доступний.' : ''
}

const cashRegisterLine = (c: KeyCheckItem['cashRegister']) => {
  if (!c) return ''
  const parts = [c.title, c.fiscalNumber && `ФН ${c.fiscalNumber}`, c.address].filter(Boolean)
  return parts.length ? `Каса: ${parts.join(', ')}` : ''
}

const shiftLine = (v: KeyCheckItem['shift']) => {
  if (!v) return ''
  return v === 'OPENED' ? 'Зміна зараз відкрита.' : 'Зміна зараз не відкрита: відкриється сама з першим чеком.'
}

const uaDate = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' })
}
const dateLine = (iso?: string) => (uaDate(iso) ? `Ключ підпису (КЕП) касира діє до ${uaDate(iso)}.` : '')
// Оплата услуг Checkbox: подписка и состояние оплаты (значение статуса — как его отдал Checkbox).
const billingLine = (r: KeyCheckItem) => {
  const parts = [
    uaDate(r.subscriptionExp) && `підписка до ${uaDate(r.subscriptionExp)}`,
    r.billingStatus && `статус «${r.billingStatus}»`,
    uaDate(r.dateToBlock) && `блокування з ${uaDate(r.dateToBlock)}`,
  ].filter(Boolean)
  return parts.length ? `Оплата Checkbox: ${parts.join(', ')}.` : ''
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
              if (!r) return null
              const lines = [
                cashRegisterLine(r.cashRegister),
                r.cashierName ? `Касир: ${r.cashierName}` : '',
                dateLine(r.certificateEnd),
                billingLine(r),
                shiftLine(r.shift),
                paymentControlLine(r.paymentControl),
              ].filter(Boolean)
              return (
                <Alert key={key} severity={SEVERITY[r.status]}>
                  <Box sx={{ fontWeight: 600 }}>{title}</Box>
                  {r.message}
                  {(r.merchantName || r.edrpou) && <Box sx={{ mt: 0.5 }}>{key === 'checkbox' ? 'Організація в Checkbox' : 'Кабінет'}: {r.merchantName ? <b>{r.merchantName}</b> : 'без назви'}{r.edrpou ? `, код ${r.edrpou}` : ''}</Box>}
                  {r.holderName && <Box sx={{ mt: 0.5 }}>Токен видано на: <b>{r.holderName}</b></Box>}
                  {r.accounts?.map((a, i) => <Box key={`${a.iban}-${i}`} sx={{ mt: 0.5, fontFamily: 'monospace', fontSize: 13 }}>{accountLine(a)}</Box>)}
                  {r.moreAccounts && <Box sx={{ mt: 0.5 }}>Показано не всі рахунки.</Box>}
                  {!!r.personalCards && <Box sx={{ mt: 0.5 }}>Особисті картки цієї людини ({r.personalCards}) портал не читає.</Box>}
                  {lines.map((l) => <Box key={l} sx={{ mt: 0.5 }}>{l}</Box>)}
                  {r.note && <Box sx={{ mt: 0.5 }}>{r.note}</Box>}
                </Alert>
              )
            })}
            <Typography variant="caption" color="text.secondary">
              Гроші не списуються, чеки й накладні не створюються, зміна на касі не відкривається. ПриватБанк «Оплата
              частинами» напряму ця кнопка не перевіряє: такий спосіб ще не підключений, частини ПриватБанку йдуть через LiqPay.
              Рахунки банків портал лише читає: платежів не створює.
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
