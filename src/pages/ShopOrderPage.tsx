// Карточка заказа с сайта (владелец, директор): что упаковать, кому отправить, что случилось с оплатой, чеком, посылкой и сообщениями.
// Состояние решает сервер: кнопка лишь просит, и после любого ответа карточка читается заново. Отказ остаётся на экране, пока не сделано следующее действие.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Chip, TextField, Dialog, DialogTitle, DialogContent, DialogActions,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Snackbar, Link, Divider, IconButton,
} from '@mui/material'
import { ArrowBack as BackIcon, Refresh as RefreshIcon, ContentCopy as CopyIcon, Edit as EditIcon } from '@mui/icons-material'
import { useStaffGate } from '@/hooks/useStaffGate'
import { shopAdminApi, type ShopFail, type ShopResult } from '@/api/endpoints/shopAdmin'
import NpAddressPicker from '@/components/NpAddressPicker'
import { SkuPhoto, StateChip } from '@/components/ShopOrderBits'
import { formatMoney } from '@/utils/pricing'
import { SHOP_STATE_LABELS, fmtShopDate, type ShopFlag, type ShopOrderCard, type ShopOrderState } from '@/types/shopOrder'
import type { NpAddress } from '@/types/npTemplate'

const NP_TRACK_URL = 'https://novaposhta.ua/tracking/?cargo_number='

const CANCEL_REASON_TEXT: Record<string, string> = {
  owner: 'скасовано тут, на сторінці замовлення',
  buyer: 'скасував покупець',
  superseded: 'покупець оформив нове',
}

const INVOICE_STATUS_TEXT: Record<string, string> = {
  pending: 'чекає оплату',
  paid: 'оплачено',
  removed: 'знято',
  failure: 'не вдалося',
  expired: 'прострочено',
  reversed: 'повернуто',
}

const receiptStatusText = (s?: string | null): string => {
  if (!s) return 'немає'
  if (s === 'DONE' || s === 'done') return 'виписано'
  if (s === 'CREATED') return 'формується'
  if (s === 'ERROR' || s === 'error') return 'помилка'
  if (s === 'CANCELLED') return 'скасовано'
  if (s === 'amount-mismatch') return 'сума не збіглася'
  if (s === 'no-checkbox') return 'ФОП без ПРРО'
  return s
}

const MESSAGE_STATUS: Record<string, { label: string; color: 'success' | 'warning' | 'error' }> = {
  sent: { label: 'надіслано', color: 'success' },
  pending: { label: 'надсилається', color: 'warning' },
  failed: { label: 'не дійшло', color: 'error' },
}

const REFRESH_OUTCOME_TEXT: Record<string, string> = {
  delivered: 'Посилку отримано',
  refused: 'Посилку не отримано, вона повертається',
  back: 'НП більше не знає накладну: замовлення знову чекає накладну',
  'not-handed': 'Посилку ще не здано',
  moving: 'Посилка в дорозі',
  none: 'Статус не змінився',
}

const RECIPIENT_FIELD_TEXT: Record<string, string> = {
  phone: 'телефон +380…',
  lastName: 'прізвище',
  firstName: "ім'я",
  middleName: 'по батькові',
  email: 'e-mail',
  cityRef: 'місто',
  cityName: 'місто',
  warehouseRef: 'відділення',
  warehouseName: 'відділення',
}

// Отказ на экране и что с ним можно сделать прямо сейчас.
type Problem = { text: string; buttons?: { label: string; onClick: () => void; showIf?: (o: ShopOrderCard) => boolean }[] }
type AttachDraft = { number: string; error: string; canForce: boolean }
type RecipientDraft = { lastName: string; firstName: string; middleName: string; phone: string; email: string; address: NpAddress; error: string }
type ResendKind = 'paid' | 'rcpt' | 'ttn'

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <Stack direction="row" spacing={1} sx={{ py: 0.25 }}>
    <Typography variant="body2" color="text.secondary" sx={{ minWidth: 130, flexShrink: 0 }}>{label}</Typography>
    <Typography variant="body2" component="div" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children || '—'}</Typography>
  </Stack>
)

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <Paper sx={{ p: 2 }}>
    <Typography variant="subtitle1" sx={{ mb: 1 }}>{title}</Typography>
    {children}
  </Paper>
)

export default function ShopOrderPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const gate = useStaffGate((a) => a.isOwner || a.role === 'director', 'Доступ лише для власника та директора.')
  const allowed = !gate

  const [order, setOrder] = useState<ShopOrderCard | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFail, setLoadFail] = useState<ShopFail | null>(null)
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState<Problem | null>(null)
  const [attach, setAttach] = useState<AttachDraft | null>(null)
  const [recipient, setRecipient] = useState<RecipientDraft | null>(null)
  const [snack, setSnack] = useState<{ open: boolean; msg: string }>({ open: false, msg: '' })
  const notify = (msg: string) => setSnack({ open: true, msg })

  const load = useCallback(async () => {
    setLoading(true)
    const r = await shopAdminApi.order(id)
    if (r.ok) { setOrder(r.data); setLoadFail(null) } else setLoadFail(r)
    setLoading(false)
  }, [id])
  useEffect(() => { if (allowed) load() }, [allowed, load])

  if (gate) return gate

  if (!order) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        {loading ? <Box sx={{ textAlign: 'center' }}><CircularProgress /></Box> : <Alert severity={loadFail?.code === 'NOT_FOUND' ? 'info' : 'error'}>{loadFail?.error || 'Замовлення не знайдено'}</Alert>}
        <Button startIcon={<BackIcon />} onClick={() => navigate('/shop-orders')} sx={{ mt: 2 }}>До замовлень</Button>
      </Container>
    )
  }

  const act = async <T,>(key: string, work: () => Promise<ShopResult<T>>): Promise<ShopResult<T>> => {
    setBusy(key)
    setProblem(null)
    const r = await work()
    await load()
    setBusy('')
    return r
  }

  const openAttach = (number = '') => setAttach({ number, error: '', canForce: false })

  const markOrder = async (action: 'returned' | 'refund-requested' | 'confirm-payment' | 'check-reversed', okText: string, question?: string) => {
    if (question && !window.confirm(question)) return
    const r = await act(action, () => shopAdminApi.mark(order.id, action))
    if (r.ok) notify(okText)
    else setProblem({ text: r.error })
  }
  const confirmPayment = () => markOrder('confirm-payment', 'Оплату підтверджено', `Звірили ${formatMoney(order.total)} в кабінеті monobank?\n\nЗамовлення стане оплаченим і вийде чек.`)
  const checkReversed = () => markOrder('check-reversed', 'Банк показує повернення: замовлення закрито')

  const createTtn = async (force: string[] = []) => {
    if (!force.length && !window.confirm(`Створити накладну?\n\n${order.sku}: ${order.titleUk}\n${order.clientName}, ${order.clientPhone}\n${order.clientCityName}, ${order.clientWarehouseName}`)) return
    const r = await act('ttn', () => shopAdminApi.createTtn(order.id, force))
    if (r.ok) { notify(`Накладну ${r.data.ttn} створено`); return }
    if (r.code === 'NO_RECEIPT') {
      setProblem({ text: r.error, buttons: [{ label: 'Створити без чека', onClick: () => { if (window.confirm('Відправити посилку без чека? Це буде записано в історію замовлення.')) createTtn([...force, 'NO_RECEIPT']) } }] })
    } else if (r.code === 'TTN_UNKNOWN') {
      // Карточка перечитана: плашка с теми же двумя кнопками уже на экране. Но повтор без видимой перемены выглядел бы как пропавшее нажатие.
      if (force.includes('TTN_UNKNOWN')) setProblem({ text: 'Повторна спроба теж без відповіді, накладна могла створитись. Знову перевірте кабінет Нової Пошти' })
    } else if (r.code === 'TTN_NOT_SAVED' && r.ttn) {
      const { ttn } = r
      setProblem({ text: r.error, buttons: [{ label: `Прив'язати ${ttn}`, onClick: () => openAttach(ttn) }] })
    } else if (r.code === 'PAYMENT_NOT_CONFIRMED') {
      // Банк показал возврат: сервер уже закрыл заказ, подтверждать нечего.
      setProblem({ text: r.error, buttons: [{ label: 'Підтвердити оплату', onClick: confirmPayment, showIf: (o) => o.state === 'paid' }] })
    } else if (r.code === 'NETWORK') {
      setProblem({ text: 'Сервер не відповів, накладна могла створитись. Оновіть сторінку і перевірте кабінет Нової Пошти, перш ніж повторювати' })
    } else setProblem({ text: r.error })
  }

  const submitAttach = async (force: string[] = []) => {
    if (!attach) return
    const r = await act('attach', () => shopAdminApi.attachTtn(order.id, attach.number, force))
    if (r.ok) { setAttach(null); notify(`Накладну ${r.data.ttn} прив'язано`); return }
    if (r.code === 'TTN_NOT_FOUND') { setAttach({ ...attach, error: r.error, canForce: true }); return }
    setAttach(null)
    setProblem({ text: r.error })
  }

  const refreshTtn = async () => {
    const r = await act('refresh', () => shopAdminApi.refreshTtn(order.id))
    if (!r.ok) setProblem({ text: r.error })
    else if (!order.ttnOnClosed) notify(REFRESH_OUTCOME_TEXT[r.data.outcome || 'none'] || 'Статус оновлено')
    else if (r.data.outcome === 'back') notify('НП більше не знає накладну: плашку знято')
    else setProblem({ text: 'Накладна ще є в Новій Пошті: видаліть її в кабінеті і перевірте знову' })
  }

  const cancelOrder = async () => {
    if (!window.confirm(`Скасувати замовлення ${order.orderNo}?\n\nЖивий рахунок буде знято. Якщо покупець усе ж оплатить, замовлення прийде на перевірку оплати.`)) return
    const r = await act('cancel', () => shopAdminApi.cancel(order.id))
    if (r.ok) notify('Замовлення скасовано')
    else setProblem({ text: r.error })
  }

  const receiptRetry = async () => {
    if (!window.confirm('Перевірили кабінет Checkbox і цього чека там немає?\n\nІнакше покупець отримає два чеки на одну оплату.')) return
    const r = await act('receipt', () => shopAdminApi.receiptRetry(order.id))
    if (!r.ok) setProblem({ text: r.error })
    else if (r.data.taxUrl) notify('Чек виписано')
    else if (r.data.receiptStatus === 'error') setProblem({ text: 'Чек не виписано: каса відповіла помилкою. Перевірте кабінет Checkbox' })
    else notify(`Чек: ${receiptStatusText(r.data.receiptStatus)}`)
  }

  const resend = async (kind: ResendKind) => {
    const r = await act(`resend-${kind}`, () => shopAdminApi.resend(order.id, kind))
    if (!r.ok) setProblem({ text: r.error })
    else if (r.data.status === 'failed') setProblem({ text: 'Повідомлення не дійшло: перевірте телефон покупця' })
    else notify(`Повідомлення: ${MESSAGE_STATUS[r.data.status]?.label || r.data.status}`)
  }

  const openRecipient = () => setRecipient({
    lastName: order.lastName || '', firstName: order.firstName || '', middleName: order.middleName || '', phone: order.clientPhone || '', email: order.email || '',
    address: { cityRef: order.clientCityRef || '', cityName: order.clientCityName || '', warehouseRef: order.clientWarehouseRef || '', warehouseName: order.clientWarehouseName || '' },
    error: '',
  })

  const submitRecipient = async () => {
    if (!recipient) return
    const body: Record<string, string> = {}
    const take = (k: string, next: string, prev?: string | null) => { if (next.trim() !== (prev || '')) body[k] = next.trim() }
    take('lastName', recipient.lastName, order.lastName)
    take('firstName', recipient.firstName, order.firstName)
    take('middleName', recipient.middleName, order.middleName)
    take('phone', recipient.phone, order.clientPhone)
    take('email', recipient.email, order.email)
    const a = recipient.address
    if ((a.cityRef || '').toLowerCase() !== (order.clientCityRef || '').toLowerCase() || (a.warehouseRef || '').toLowerCase() !== (order.clientWarehouseRef || '').toLowerCase()) {
      if (!a.cityRef || !a.warehouseRef) { setRecipient({ ...recipient, error: 'Оберіть місто і відділення' }); return }
      Object.assign(body, { cityRef: a.cityRef, cityName: a.cityName || '', warehouseRef: a.warehouseRef, warehouseName: a.warehouseName || '' })
    }
    if (!Object.keys(body).length) { setRecipient(null); return }
    const r = await act('recipient', () => shopAdminApi.updateRecipient(order.id, body))
    if (r.ok) { setRecipient(null); notify('Дані отримувача збережено'); return }
    const fields = [...new Set(r.fields.map((f) => RECIPIENT_FIELD_TEXT[f] || f))]
    setRecipient({ ...recipient, error: `${r.error}${fields.length ? `: ${fields.join(', ')}` : ''}` })
  }

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => notify('Скопійовано'))

  const isBusy = !!busy
  const paying = order.invoices.find((i) => i.paying)
  const paidCard = order.method === 'card' && !!order.paidPaymentId && order.state !== 'reversed'
  const receiptMissing = paidCard && paying?.status === 'paid' && !paying.taxUrl && paying.receiptStatus !== 'amount-mismatch'
  const parcelLocked = !!(order.ttn || order.ttnError || order.ttnCreatingAt)
  const canCancel = order.state === 'awaiting_payment' || order.state === 'phone_pending' || order.state === 'cod_confirmed'
  const needsTtn = order.state === 'paid' && !order.ttn && !order.flags.includes('ttn-unknown')
  const alerts = order.alerts || {}

  const actionButton = (label: string, key: string, onClick: () => void) => (
    <Button key={key} color="inherit" variant="outlined" size="small" disabled={isBusy} onClick={onClick}>{busy === key ? '…' : label}</Button>
  )

  // Что не так и следующий шаг; кнопка рядом с текстом, чтобы не искать её по странице.
  const plaque = (flag: ShopFlag): { text: string; actions?: ReactNode } => {
    switch (flag) {
      case 'payment-review':
        return {
          text: alerts['late-payment'] ? 'Оплата прийшла вже після закриття замовлення. Вирішіть: відправити чи повернути гроші в кабінеті monobank.'
            : 'Дані банку не збігаються із замовленням, чек не виписано. Звірте суму в кабінеті monobank. Гроші повернули: натисніть «Перевірити повернення» в блоці оплати.',
          actions: actionButton('Підтвердити оплату', 'confirm-payment', confirmPayment),
        }
      case 'receipt-failed':
        return { text: 'Гроші отримано, чек не вийшов. Перевірте кабінет Checkbox: випишіть чек ще раз або видайте його вручну.', actions: actionButton('Виписати чек ще раз', 'receipt', receiptRetry) }
      case 'ttn-unknown':
        return {
          text: 'Невідомо, чи створилась накладна. Перевірте кабінет Нової Пошти.',
          actions: <>
            {actionButton('Накладна є: вказати номер', 'attach', () => openAttach())}
            {actionButton('Накладної немає: створити ще раз', 'ttn', () => { if (window.confirm('Перевірили кабінет НП і накладної там немає?')) createTtn(['TTN_UNKNOWN']) })}
          </>,
        }
      case 'ttn-on-closed':
        return { text: `Накладну ${order.ttn} створено на вже закритому замовленні. Посилку не передавайте, видаліть накладну в кабінеті Нової Пошти і перевірте її тут.`, actions: actionButton('Перевірити накладну', 'refresh', refreshTtn) }
      case 'refund-due':
        return {
          text: order.state === 'refused' ? 'Посилку не отримано, вона повертається. Поверніть гроші в кабінеті monobank і оформіть чек повернення в Checkbox. Коли посилка прийде, відмітьте це.'
            : 'Посилка повернулась. Поверніть гроші в кабінеті monobank і оформіть чек повернення в Checkbox, потім натисніть «Перевірити повернення» в блоці оплати.',
          actions: order.state === 'refused' ? actionButton('Посилка прийшла', 'returned', () => markOrder('returned', 'Відмічено: посилка повернулась', 'Посилка вже у вас?')) : undefined,
        }
      case 'sms-failed':
        return { text: 'Покупець не отримав повідомлення. Перевірте телефон і надішліть ще раз у блоці «Повідомлення покупцю».', actions: order.piiPurgedAt ? undefined : actionButton('Змінити телефон', 'recipient', openRecipient) }
      case 'not-handed':
        return { text: 'Накладна створена понад 48 годин тому, а посилку не здано. Здайте її або видаліть накладну в кабінеті Нової Пошти і перевірте статус.', actions: actionButton('Перевірити статус', 'refresh', refreshTtn) }
      default:
        return { text: flag }
    }
  }

  const messages: { kind: string; label: string; resend: ResendKind | null }[] = []
  const sms = order.sms || {}
  const canResendPaid = order.method === 'card' && !!order.paidPaymentId && order.state !== 'reversed'
  if (canResendPaid || sms.paid) messages.push({ kind: 'paid', label: 'Про оплату, зі статусом замовлення', resend: canResendPaid ? 'paid' : null })
  if (paying?.taxUrl || sms.rcpt) messages.push({ kind: 'rcpt', label: 'Із чеком', resend: paying?.taxUrl ? 'rcpt' : null })
  const ttnKinds = new Set([...Object.keys(sms).filter((k) => k.startsWith('ttn-')), ...(order.ttn ? [`ttn-${order.ttn}`] : [])])
  for (const kind of ttnKinds) messages.push({ kind, label: `Накладна ${kind.slice(4)}`, resend: kind === `ttn-${order.ttn}` ? 'ttn' : null })

  const alertRows = Object.entries(alerts).flatMap(([kind, a]) => (a ? [{ kind, ...a }] : [])).sort((a, b) => (a.at < b.at ? 1 : -1))

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <IconButton aria-label="До замовлень" onClick={() => navigate('/shop-orders')}><BackIcon /></IconButton>
        <Typography variant="h5">{order.orderNo}</Typography>
        <StateChip state={order.state} />
        {order.method === 'cod' && <Chip size="small" variant="outlined" label="Післяплата" />}
        <Box sx={{ flexGrow: 1 }} />
        <Button startIcon={<RefreshIcon />} disabled={loading} onClick={load}>Оновити</Button>
      </Stack>

      <Stack spacing={2}>
        {loadFail && <Alert severity="error">Не вдалося оновити: {loadFail.error}. Нижче останні отримані дані.</Alert>}
        {problem && (
          <Alert severity="error" onClose={() => setProblem(null)}>
            {problem.text}
            {problem.buttons && (
              <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                {problem.buttons.filter((b) => !b.showIf || b.showIf(order)).map((b) => <Button key={b.label} size="small" color="inherit" variant="outlined" disabled={isBusy} onClick={b.onClick}>{b.label}</Button>)}
              </Stack>
            )}
          </Alert>
        )}
        {order.flags.map((flag) => {
          const { text, actions } = plaque(flag)
          return (
            <Alert key={flag} severity="error">
              {text}
              {actions && <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>{actions}</Stack>}
            </Alert>
          )
        })}
        {needsTtn && (
          <Alert severity="info">
            Оплачено. Звірте артикул, спакуйте і створіть накладну.
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
              <Button size="small" variant="contained" disabled={isBusy} onClick={() => createTtn()}>{busy === 'ttn' ? 'Створюємо…' : 'Створити накладну'}</Button>
              <Button size="small" disabled={isBusy} onClick={() => openAttach()}>Накладна вже є: вказати номер</Button>
            </Stack>
          </Alert>
        )}

        <Paper sx={{ p: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <SkuPhoto sku={order.sku} size={{ xs: 200, sm: 220 }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h3" sx={{ fontWeight: 800, overflowWrap: 'anywhere' }}>{order.sku}</Typography>
              <Typography variant="h6" sx={{ fontWeight: 400 }}>{order.titleUk}</Typography>
              <Typography variant="body1" sx={{ mt: 0.5 }}><b>{order.qty || 1} шт</b> · {formatMoney(order.total)}</Typography>
              <Typography variant="caption" color="text.secondary">Створено {fmtShopDate(order.createdAt)}{order.offerVersion ? ` · оферта ${order.offerVersion}` : ''}</Typography>
            </Box>
          </Stack>
        </Paper>

        <Section title="Отримувач">
          {order.piiPurgedAt ? (
            <Alert severity="info">Дані покупця стерто {fmtShopDate(order.piiPurgedAt)}.</Alert>
          ) : (
            <>
              <Field label="ПІБ">{order.clientName}</Field>
              <Field label="Телефон">
                {order.clientPhone && <Link href={`tel:${order.clientPhone}`}>{order.clientPhone}</Link>}
                {order.clientPhone && <IconButton size="small" aria-label="Скопіювати телефон" onClick={() => copy(String(order.clientPhone))}><CopyIcon fontSize="inherit" /></IconButton>}
              </Field>
              <Field label="E-mail">{order.email}</Field>
              <Field label="Місто">{order.clientCityName}</Field>
              <Field label="Відділення">{order.clientWarehouseName}</Field>
              {order.addressVerified === false && <Alert severity="warning" sx={{ my: 1 }}>Нова Пошта не підтвердила це відділення, коли його обирали. Звірте його перед відправкою.</Alert>}
              <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                <Button size="small" startIcon={<EditIcon />} disabled={isBusy} onClick={openRecipient}>Змінити дані</Button>
                {order.statusUrl && <Button size="small" startIcon={<CopyIcon />} onClick={() => copy(String(order.statusUrl))}>Посилання на статус для покупця</Button>}
                {canCancel && <Button size="small" color="error" disabled={isBusy} onClick={cancelOrder}>{busy === 'cancel' ? '…' : 'Скасувати замовлення'}</Button>}
              </Stack>
            </>
          )}
          {order.cancelReason && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Причина скасування: {CANCEL_REASON_TEXT[order.cancelReason] || order.cancelReason}</Typography>}
        </Section>

        <Section title="Оплата і чек">
          <Field label="Сума">{formatMoney(order.total)}</Field>
          <Field label="Оплачено">{order.paidAt ? fmtShopDate(order.paidAt) : 'ні'}</Field>
          {order.amountConfirmed && <Field label="Підтвердив">{`${order.amountConfirmed.by || '—'}, ${formatMoney(order.amountConfirmed.amount)}, ${fmtShopDate(order.amountConfirmed.at)}`}</Field>}
          {order.partialRefund && <Field label="Частково повернуто">{`${formatMoney(order.partialRefund.amount)}, ${fmtShopDate(order.partialRefund.at)}. Потрібен чек повернення на різницю в Checkbox`}</Field>}
          {order.refundRequestedAt && <Field label="Заява на повернення">{`${fmtShopDate(order.refundRequestedAt)}. Гроші повернути не пізніше 30-го дня, нагадування на 20-й`}</Field>}
          <Field label="Чек">
            {paying?.taxUrl ? <Link href={paying.taxUrl} target="_blank" rel="noreferrer">Відкрити чек</Link> : receiptStatusText(paying?.receiptStatus)}
          </Field>
          {paying?.receiptError && <Field label="Причина">{paying.receiptError}</Field>}
          {paying?.receiptEmailDropped && (
            <Alert severity="warning" sx={{ my: 1 }}>Лист із чеком не пішов: каса не прийняла адресу покупця, і чек виписано без неї. Посилання на чек покупець отримує повідомленням.</Alert>
          )}

          {paidCard && (
            <Stack direction="row" spacing={1} sx={{ my: 1 }} flexWrap="wrap" useFlexGap>
              {receiptMissing && !order.flags.includes('receipt-failed') && <Button size="small" disabled={isBusy} onClick={receiptRetry}>{busy === 'receipt' ? '…' : 'Виписати чек ще раз'}</Button>}
              {order.state === 'paid' && alerts['amount-unverified'] && !order.amountConfirmed && <Button size="small" disabled={isBusy} onClick={confirmPayment}>{busy === 'confirm-payment' ? '…' : 'Підтвердити суму'}</Button>}
              <Button size="small" disabled={isBusy} onClick={checkReversed}>{busy === 'check-reversed' ? '…' : 'Перевірити повернення'}</Button>
              {!order.refundRequestedAt && (
                <Button size="small" disabled={isBusy} onClick={() => markOrder('refund-requested', 'Заяву на повернення відмічено', 'Покупець подав заяву на повернення? На 20-й день прийде нагадування.')}>
                  {busy === 'refund-requested' ? '…' : 'Покупець просить повернення'}
                </Button>
              )}
            </Stack>
          )}

          {order.invoices.length > 0 && (
            <TableContainer sx={{ mt: 1 }}>
              <Table size="small">
                <TableHead>
                  <TableRow><TableCell>Рахунок</TableCell><TableCell align="right">Сума</TableCell><TableCell>Статус</TableCell><TableCell>Чек</TableCell></TableRow>
                </TableHead>
                <TableBody>
                  {order.invoices.map((i) => (
                    <TableRow key={i.id} selected={i.paying}>
                      <TableCell>{fmtShopDate(i.createdAt)}{i.paying ? ' · цим оплачено' : ''}</TableCell>
                      <TableCell align="right">{formatMoney(i.amount)}</TableCell>
                      <TableCell>{INVOICE_STATUS_TEXT[i.status] || i.status}</TableCell>
                      <TableCell>{i.taxUrl ? <Link href={i.taxUrl} target="_blank" rel="noreferrer">чек</Link> : i.status === 'paid' ? receiptStatusText(i.receiptStatus) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Section>

        <Section title="Доставка">
          {order.ttn ? (
            <>
              <Field label="Накладна">
                <b>{order.ttn}</b>
                <IconButton size="small" aria-label="Скопіювати накладну" onClick={() => copy(String(order.ttn))}><CopyIcon fontSize="inherit" /></IconButton>
                <Link href={`${NP_TRACK_URL}${order.ttn}`} target="_blank" rel="noreferrer" sx={{ ml: 1 }}>Відстежити</Link>
              </Field>
              <Field label="Створено">{fmtShopDate(order.shippedAt)}</Field>
              <Field label="Статус НП">{order.npDelivery?.text ? `${order.npDelivery.text} (код ${order.npDelivery.code})` : 'ще не перевірявся'}</Field>
              {order.npCheckedAt && <Field label="Перевірено">{fmtShopDate(order.npCheckedAt)}</Field>}
              {order.npDelivery?.deliveredAt && <Field label="Отримано">{fmtShopDate(order.npDelivery.deliveredAt)}</Field>}
              {order.npEstimatedDelivery && <Field label="Орієнтовно">{order.npEstimatedDelivery}</Field>}
              {order.npCostOnSite != null && <Field label="Вартість доставки">{`${order.npCostOnSite} грн`}</Field>}
              {order.state === 'shipped' && !order.flags.includes('not-handed') && (
                <Button size="small" sx={{ mt: 1 }} disabled={isBusy} onClick={refreshTtn}>{busy === 'refresh' ? '…' : 'Перевірити статус'}</Button>
              )}
              {order.state === 'refused' && !order.flags.includes('refund-due') && (
                <Button size="small" sx={{ mt: 1 }} disabled={isBusy} onClick={() => markOrder('returned', 'Відмічено: посилка повернулась', 'Посилка вже у вас?')}>{busy === 'returned' ? '…' : 'Посилка прийшла'}</Button>
              )}
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">Накладної ще немає.</Typography>
          )}
          {!!order.ttnHistory?.length && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Попередні накладні: {order.ttnHistory.map((h) => `${h.ttn} (${fmtShopDate(h.at)})`).join(', ')}
            </Typography>
          )}
        </Section>

        <Section title="Повідомлення покупцю">
          {messages.length === 0 ? (
            <Typography variant="body2" color="text.secondary">Повідомлень ще немає.</Typography>
          ) : (
            <Stack divider={<Divider flexItem />} spacing={1}>
              {messages.map((m) => {
                const rec = sms[m.kind]
                const st = rec?.status ? MESSAGE_STATUS[rec.status] : null
                return (
                  <Stack key={m.kind} direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                    <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 180 }}>{m.label}</Typography>
                    <Chip size="small" variant="outlined" color={st?.color || 'default'} label={st?.label || rec?.status || 'ще не надсилалось'} />
                    {rec?.at && <Typography variant="caption" color="text.secondary">{fmtShopDate(rec.at)}</Typography>}
                    {alerts[`sms-${m.kind}`] && <Chip size="small" color="error" label="спроби скінчились" />}
                    {m.resend && <Button size="small" disabled={isBusy || !order.clientPhone} onClick={() => resend(m.resend as ResendKind)}>{busy === `resend-${m.resend}` ? '…' : 'Надіслати ще раз'}</Button>}
                  </Stack>
                )
              })}
            </Stack>
          )}
        </Section>

        {alertRows.length > 0 && (
          <Section title="Алерти власнику">
            <Stack divider={<Divider flexItem />} spacing={1}>
              {alertRows.map((a) => (
                <Box key={a.kind}>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{a.text}</Typography>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="caption" color="text.secondary">{fmtShopDate(a.at)}</Typography>
                    {a.sentAt ? <Chip size="small" variant="outlined" label="Telegram доставив" /> : <Chip size="small" variant="outlined" color="warning" label="Telegram не доставив" />}
                    {a.smsAt && <Chip size="small" variant="outlined" label={`SMS ${fmtShopDate(a.smsAt)}`} />}
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Section>
        )}

        <Section title="Історія">
          {(order.history || []).length === 0 ? (
            <Typography variant="body2" color="text.secondary">Змін стану ще не було.</Typography>
          ) : (
            (order.history || []).map((h, i) => (
              <Typography key={`${h.at}-${i}`} variant="body2" color="text.secondary">
                {fmtShopDate(h.at)}: {SHOP_STATE_LABELS[h.to as ShopOrderState] || h.to}{h.by ? ` · ${h.by}` : ''}{h.note ? ` · ${h.note}` : ''}
              </Typography>
            ))
          )}
          {(order.recipientEdits || []).map((e, i) => (
            <Typography key={`edit-${i}`} variant="body2" color="text.secondary">
              {fmtShopDate(e.at)}: змінено дані отримувача ({e.fields.map((f) => RECIPIENT_FIELD_TEXT[f] || f).join(', ')}){e.by ? ` · ${e.by}` : ''}
            </Typography>
          ))}
        </Section>
      </Stack>

      <Dialog open={!!attach} onClose={() => setAttach(null)} fullWidth maxWidth="xs">
        <DialogTitle>Прив'язати накладну</DialogTitle>
        <DialogContent>
          {attach?.error && <Alert severity="warning" sx={{ mb: 2 }}>{attach.error}</Alert>}
          <TextField autoFocus fullWidth size="small" label="Номер накладної" sx={{ mt: 1 }} value={attach?.number || ''} onChange={(e) => setAttach({ number: e.target.value, error: '', canForce: false })}
            helperText="Покупець отримає цей номер повідомленням" />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAttach(null)}>Закрити</Button>
          {attach?.canForce
            ? <Button color="warning" disabled={isBusy} onClick={() => submitAttach(['TTN_NOT_FOUND'])}>Усе одно прив'язати</Button>
            : <Button variant="contained" disabled={isBusy || !attach?.number.trim()} onClick={() => submitAttach()}>Прив'язати</Button>}
        </DialogActions>
      </Dialog>

      <Dialog open={!!recipient} onClose={() => setRecipient(null)} fullWidth maxWidth="sm">
        <DialogTitle>Дані отримувача</DialogTitle>
        <DialogContent>
          {recipient && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              {recipient.error && <Alert severity="error">{recipient.error}</Alert>}
              {parcelLocked && <Alert severity="info">Накладна вже є, тому ім'я і адресу змінюйте в кабінеті Нової Пошти. Тут можна змінити телефон і e-mail.</Alert>}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField fullWidth size="small" label="Прізвище" disabled={parcelLocked} value={recipient.lastName} onChange={(e) => setRecipient({ ...recipient, lastName: e.target.value })} />
                <TextField fullWidth size="small" label="Ім'я" disabled={parcelLocked} value={recipient.firstName} onChange={(e) => setRecipient({ ...recipient, firstName: e.target.value })} />
                <TextField fullWidth size="small" label="По батькові" disabled={parcelLocked} value={recipient.middleName} onChange={(e) => setRecipient({ ...recipient, middleName: e.target.value })} />
              </Stack>
              <TextField fullWidth size="small" label="Телефон" value={recipient.phone} onChange={(e) => setRecipient({ ...recipient, phone: e.target.value })}
                helperText="Новий номер отримає всі повідомлення заново" />
              <TextField fullWidth size="small" label="E-mail" value={recipient.email} onChange={(e) => setRecipient({ ...recipient, email: e.target.value })} />
              {!parcelLocked && <NpAddressPicker value={recipient.address} onChange={(address) => setRecipient({ ...recipient, address })} />}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRecipient(null)}>Закрити</Button>
          <Button variant="contained" disabled={isBusy} onClick={submitRecipient}>Зберегти</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={6000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity="success" onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
