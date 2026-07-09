// Клиентская страница ФАКТИЧЕСКОЙ калькуляции (открывается по ссылке /estimate/:id).
//
// Клиент видит построчный фактический кошторис, отличие от предварительного (если сумма выросла),
// при необходимости соглашается с ростом (погодження), и оплачивает. Оплата идёт через наш движок
// (LiqPay карта/частини або monobank «Частини»), после чего автоматически выбивается фіскальний чек.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Divider,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Chip, Stack, TextField, MenuItem,
} from '@mui/material'
import {
  Payment as PaymentIcon, Receipt as ReceiptIcon, CheckCircle as CheckIcon, Refresh as RefreshIcon,
} from '@mui/icons-material'
import { paymentsApi, submitLiqpayCheckout, FopPublic, PayMethod, SafeEstimate } from '@/api/endpoints/payments'
import { compareEstimates, tName, formatMoney } from '@/utils/pricing'
import type { Estimate } from '@/types/pricing'

const ORDER_KEY = (id: string) => `rf_pay_order_${id}`

export default function EstimateSharePage() {
  const { id = '' } = useParams<{ id: string }>()
  const [est, setEst] = useState<SafeEstimate | null>(null)
  const [prelim, setPrelim] = useState<SafeEstimate | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [fop, setFop] = useState<FopPublic | null>(null)
  const [method, setMethod] = useState<PayMethod>('liqpay-card')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    try {
      const { estimate, parent } = await paymentsApi.getEstimatePublic(id)
      setEst(estimate)
      setPrelim(parent)
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // Определить методы оплаты у ФОП сметы
  useEffect(() => {
    if (!est?.fopId) return
    paymentsApi.listFops()
      .then((list) => {
        const f = list.find((x) => x.id === est.fopId) || null
        setFop(f)
        if (f) setMethod(f.methods.liqpayCard ? 'liqpay-card' : f.methods.monoChast ? 'mono-chast' : 'liqpay-card')
      })
      .catch(() => setFop(null))
  }, [est?.fopId])

  // После инициации оплаты — опрашиваем статус (webhook проставит paid + чек), пока не оплачено
  useEffect(() => {
    if (!est || est.paid || est.status === 'rejected') return
    const initiated = localStorage.getItem(ORDER_KEY(id))
    if (!initiated) return
    let n = 0
    const t = setInterval(async () => {
      n += 1
      try {
        const { estimate } = await paymentsApi.getEstimatePublic(id)
        if (estimate && estimate.paid) { setEst(estimate); localStorage.removeItem(ORDER_KEY(id)); clearInterval(t) }
      } catch { /* временная ошибка сети — продолжаем опрос */ }
      if (n > 20) clearInterval(t) // ~2 хв
    }, 6000)
    return () => clearInterval(t)
  }, [est, id])

  const comparison = useMemo(
    () => (prelim && est ? compareEstimates(prelim as unknown as Estimate, est as unknown as Estimate) : null),
    [prelim, est]
  )

  const methodOptions = useMemo(() => {
    if (!fop) return [] as { value: PayMethod; label: string }[]
    const opts: { value: PayMethod; label: string }[] = []
    if (fop.methods.liqpayCard) opts.push({ value: 'liqpay-card', label: 'Картою (LiqPay)' })
    if (fop.methods.liqpayPaypart) opts.push({ value: 'liqpay-paypart', label: 'Частинами (LiqPay)' })
    if (fop.methods.liqpayPaypart) opts.push({ value: 'liqpay-moment', label: 'Миттєва розстрочка (LiqPay)' })
    if (fop.methods.monoChast) opts.push({ value: 'mono-chast', label: 'Частинами (monobank)' })
    return opts
  }, [fop])

  const approve = async () => {
    setBusy(true); setErr('')
    try { await paymentsApi.approveEstimate(id); await load() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Помилка') }
    finally { setBusy(false) }
  }
  const reject = async () => {
    setBusy(true); setErr('')
    try { await paymentsApi.rejectEstimate(id); await load() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Помилка') }
    finally { setBusy(false) }
  }

  const pay = async () => {
    setBusy(true); setErr('')
    try {
      if (method === 'mono-chast' && !phone.trim()) { setErr('Вкажіть номер телефону для розстрочки monobank'); setBusy(false); return }
      const res = await paymentsApi.payEstimate({
        estimateId: id, method,
        clientPhone: method === 'mono-chast' ? phone.trim() : undefined,
        resultUrl: window.location.href,
      })
      localStorage.setItem(ORDER_KEY(id), res.orderId)
      if (res.provider === 'liqpay') {
        submitLiqpayCheckout(res, '_self') // редирект на LiqPay Checkout
      } else {
        // monobank Частини — клиент подтверждает рассрочку в приложении; статус придёт по webhook
        setErr('')
        await load()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не вдалося створити оплату')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>
  if (notFound || !est) {
    return <Container maxWidth="sm" sx={{ py: 8 }}><Alert severity="error">Кошторис не знайдено.</Alert></Container>
  }

  const paid = est.paid
  const rejected = est.status === 'rejected'
  const needsApproval = est.status === 'pending_approval'
  const canPay = !paid && !rejected && !needsApproval && est.status === 'approved'

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" gutterBottom>Кошторис на ремонт</Typography>
      {est.title && <Typography variant="subtitle1" color="text.secondary">{est.title}</Typography>}
      {est.complaint && <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Скарга: {est.complaint}</Typography>}

      {/* Статус */}
      {paid && (
        <Alert severity="success" icon={<CheckIcon />} sx={{ mb: 3 }}>
          Оплачено. {est.taxUrl
            ? <>Фіскальний чек: <a href={est.taxUrl} target="_blank" rel="noreferrer">переглянути</a></>
            : 'Фіскальний чек формується…'}
        </Alert>
      )}
      {rejected && <Alert severity="info" sx={{ mb: 3 }}>Ви відхилили цей кошторис. Зв'яжіться з майстром для уточнення.</Alert>}
      {needsApproval && <Alert severity="warning" sx={{ mb: 3 }}>Обсяг робіт змінився — перегляньте зміни та погодьте кошторис, щоб перейти до оплати.</Alert>}

      {/* Позиции */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Склад робіт і матеріалів</Typography>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: 'action.hover' }}>
                <TableCell>Позиція</TableCell>
                <TableCell align="right">К-сть</TableCell>
                <TableCell align="right">Сума</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {est.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell>
                    {tName(l.name, 'uk')}
                    {l.type !== 'labor' && <Chip size="small" label={l.type === 'material' ? 'матеріал' : 'послуга'} sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell align="right">{l.qty}</TableCell>
                  <TableCell align="right">{formatMoney(l.lineTotal)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={2}><b>Разом до сплати</b></TableCell>
                <TableCell align="right"><b>{formatMoney(est.total)}</b></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Что изменилось (diff) */}
      {comparison && (comparison.added.length > 0 || comparison.changed.length > 0 || comparison.removed.length > 0) && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>Що змінилося порівняно з попередньою оцінкою</Typography>
          <Stack direction="row" spacing={2} sx={{ mb: 1, flexWrap: 'wrap' }}>
            <Chip label={`Було: ${formatMoney(comparison.prelimTotal)}`} />
            <Chip label={`Стало: ${formatMoney(comparison.actualTotal)}`} color="primary" />
            <Chip
              label={`${comparison.diffTotal >= 0 ? '+' : ''}${formatMoney(comparison.diffTotal)}`}
              color={comparison.diffTotal > 0 ? 'warning' : 'success'}
            />
          </Stack>
          {comparison.added.map((d, i) => <Typography key={`a${i}`} variant="body2" color="warning.main">+ {tName(d.name, 'uk')} ({formatMoney(d.delta)})</Typography>)}
          {comparison.changed.map((d, i) => <Typography key={`c${i}`} variant="body2">± {tName(d.name, 'uk')} ({d.delta >= 0 ? '+' : ''}{formatMoney(d.delta)})</Typography>)}
          {comparison.removed.map((d, i) => <Typography key={`r${i}`} variant="body2" color="text.secondary">− {tName(d.name, 'uk')} ({formatMoney(d.delta)})</Typography>)}
        </Paper>
      )}

      {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

      {/* Погодження */}
      {needsApproval && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="body2" sx={{ mb: 2 }}>Погоджуєте оновлений обсяг робіт і суму?</Typography>
          <Stack direction="row" spacing={2}>
            <Button variant="contained" onClick={approve} disabled={busy}>Погодити кошторис</Button>
            <Button variant="outlined" color="inherit" onClick={reject} disabled={busy}>Відхилити</Button>
          </Stack>
        </Paper>
      )}

      {/* Оплата */}
      {canPay && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Оплата</Typography>
          {!fop ? (
            <Alert severity="info">Спосіб оплати готується. Оновіть сторінку за хвилину.</Alert>
          ) : methodOptions.length === 0 ? (
            <Alert severity="warning">У обраного ФОП не налаштовано способів оплати.</Alert>
          ) : (
            <Stack spacing={2}>
              <TextField select size="small" label="Спосіб оплати" value={method} onChange={(e) => setMethod(e.target.value as PayMethod)} sx={{ maxWidth: 360 }}>
                {methodOptions.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
              </TextField>
              {method === 'mono-chast' && (
                <TextField
                  size="small" label="Номер телефону (для monobank)" value={phone}
                  onChange={(e) => setPhone(e.target.value)} placeholder="+380..." sx={{ maxWidth: 360 }}
                />
              )}
              <Box>
                <Button variant="contained" size="large" startIcon={<PaymentIcon />} onClick={pay} disabled={busy}>
                  {busy ? 'Створюємо оплату…' : `Оплатити ${formatMoney(est.total)}`}
                </Button>
              </Box>
              {!fop.receipts && <Alert severity="info">Фіскальний чек за цим ФОП не формується автоматично.</Alert>}
            </Stack>
          )}
        </Paper>
      )}

      {/* Ожидание подтверждения (после инициации) */}
      {!paid && !rejected && !needsApproval && localStorage.getItem(ORDER_KEY(id)) && (
        <Alert severity="info" icon={<RefreshIcon />} sx={{ mb: 2 }}>
          Очікуємо підтвердження оплати… Сторінка оновиться автоматично.
          <Button size="small" onClick={load} sx={{ ml: 1 }}>Оновити</Button>
        </Alert>
      )}

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        <ReceiptIcon fontSize="inherit" sx={{ verticalAlign: 'middle', mr: 0.5 }} />
        Після оплати фіскальний чек буде видано автоматично та доступний за посиланням на цій сторінці.
      </Typography>
    </Container>
  )
}
