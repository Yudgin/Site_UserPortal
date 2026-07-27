// Клиентская страница ФАКТИЧЕСКОЙ калькуляции (открывается по ссылке /estimate/:id).
//
// Клиент видит построчный фактический кошторис, отличие от предварительного (если сумма выросла),
// при необходимости соглашается с ростом (погодження), и оплачивает. Оплата идёт через наш движок
// (LiqPay карта/частини або monobank «Частини»), после чего автоматически выбивается фіскальний чек.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Divider,
  Chip, Stack, TextField, MenuItem,
} from '@mui/material'
import {
  Payment as PaymentIcon, Receipt as ReceiptIcon, CheckCircle as CheckIcon, Refresh as RefreshIcon,
} from '@mui/icons-material'
import { paymentsApi, submitLiqpayCheckout, FopPublic, PayMethod, SafeEstimate, EstimateContext } from '@/api/endpoints/payments'
import { compareEstimates, tName, formatMoney } from '@/utils/pricing'
import EstimateSectionsView from '@/components/EstimateSectionsView'
import EstimateHistory from '@/components/EstimateHistory'
import type { Estimate } from '@/types/pricing'

const ORDER_KEY = (id: string) => `rf_pay_order_${id}`

export default function EstimateSharePage() {
  const { id = '' } = useParams<{ id: string }>()
  const [est, setEst] = useState<SafeEstimate | null>(null)
  const [prelim, setPrelim] = useState<SafeEstimate | null>(null)
  const [context, setContext] = useState<EstimateContext | null>(null)
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
      const { estimate, parent, context: ctx } = await paymentsApi.getEstimatePublic(id)
      setEst(estimate)
      setPrelim(parent)
      setContext(ctx || null)
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // ФОП сметы (для старых смет без payMethods — методы берём у него). Метод по умолчанию задаёт
  // отдельный эффект по methodOptions (учитывает и новые payMethods, и старый fop.methods).
  useEffect(() => {
    if (!est?.fopId) return
    paymentsApi.listFops()
      .then((list) => setFop(list.find((x) => x.id === est.fopId) || null))
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

  // Онлайн-способы оплаты: из payMethods сметы (новые сметы — способы задал мастер), иначе — по
  // методам единого ФОП (старые сметы). cod/прочие неонлайн способы сюда не попадают.
  const methodOptions = useMemo(() => {
    const opts: { value: PayMethod; label: string }[] = []
    const pm = est?.payMethods
    const hasCard = pm && pm.length ? pm.includes('liqpayCard') : !!fop?.methods.liqpayCard
    const hasPaypart = pm && pm.length ? pm.includes('liqpayPaypart') : !!fop?.methods.liqpayPaypart
    const hasMono = pm && pm.length ? pm.includes('monoChast') : !!fop?.methods.monoChast
    const hasAcquire = pm && pm.length ? pm.includes('monoAcquire') : !!fop?.methods.monoAcquire
    if (hasCard) opts.push({ value: 'liqpay-card', label: 'Картою (LiqPay)' })
    if (hasPaypart) { opts.push({ value: 'liqpay-paypart', label: 'Частинами (LiqPay)' }); opts.push({ value: 'liqpay-moment', label: 'Миттєва розстрочка (LiqPay)' }) }
    if (hasMono) opts.push({ value: 'mono-chast', label: 'Частинами (monobank)' })
    if (hasAcquire) opts.push({ value: 'mono-acquire', label: 'Картою (monobank)' })
    return opts
  }, [est?.payMethods, fop])

  // Способ по умолчанию — первый доступный (для новых и старых смет).
  useEffect(() => {
    if (methodOptions.length && !methodOptions.some((o) => o.value === method)) setMethod(methodOptions[0].value)
  }, [methodOptions, method])

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
      } else if (res.provider === 'mono-acquire' && res.pageUrl) {
        window.location.href = res.pageUrl // редирект на платёжную страницу monobank
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
  const channelLabel = (c: string) => (({ telegram: 'Telegram', viber: 'Viber', web: 'Сайт', site: 'Сайт', sms: 'SMS' } as Record<string, string>)[c] || c)

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

      {/* Історія звернення: як звертались, що зафіксовано в заявці, діагностика, попередні варіанти */}
      {context && (context.complaint || context.boat || context.channel || context.diagnostics?.text || (context.offer && context.offer.variants.length > 0)) && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Історія вашого звернення</Typography>
          <Stack spacing={1.75}>
            {(context.complaint || context.boat || context.channel) && (
              <Box>
                <Typography variant="subtitle2">Звернення{context.channel ? ` · ${channelLabel(context.channel)}` : ''}</Typography>
                {context.boat && <Typography variant="body2" color="text.secondary">Кораблик: {context.boat}</Typography>}
                {context.complaint && <Typography variant="body2">{context.complaint}</Typography>}
              </Box>
            )}
            {context.diagnostics?.text && (
              <Box>
                <Typography variant="subtitle2">Діагностика{context.diagnostics.at ? ` · ${new Date(context.diagnostics.at).toLocaleDateString('uk-UA')}` : ''}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>{context.diagnostics.text}</Typography>
              </Box>
            )}
            {context.offer && context.offer.variants.length > 0 && (
              <Box>
                <Typography variant="subtitle2">Попередні калькуляції (варіанти)</Typography>
                <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                  {context.offer.variants.map((v) => (
                    <Stack key={v.id} direction="row" spacing={1} alignItems="center">
                      {v.chosen && <Chip size="small" color="success" label="обрано" />}
                      <Typography variant="body2" sx={{ fontWeight: v.chosen ? 500 : 400 }}>{v.label}</Typography>
                      <Typography variant="body2" sx={{ ml: 'auto' }}>{formatMoney(v.total)}</Typography>
                    </Stack>
                  ))}
                </Stack>
              </Box>
            )}
          </Stack>
        </Paper>
      )}

      {/* Позиции — разрезами по требованиям клиента */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Склад робіт за вашими вимогами</Typography>
        <EstimateSectionsView lines={est.lines} sections={est.sections} total={est.total} currency={est.currency} />
        {est.discount && est.discount.amount > 0 && (
          <Alert severity="success" sx={{ mt: 1.5 }}>
            🎁 Вам надано знижку <b>−{formatMoney(est.discount.amount)}</b>
            {est.discount.kind === 'pct' ? ` (${est.discount.value}%)` : ''}: без знижки {formatMoney(est.discount.grossTotal)},
            до сплати — <b>{formatMoney(est.total)}</b>.
          </Alert>
        )}
      </Paper>

      {/* Історія змін кошторису (що і коли редагували) */}
      <EstimateHistory current={est} history={est.history || []} />

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
