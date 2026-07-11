// Панель власника — сводный экран бизнеса: выручка/чеки, заявки по статусам, стоимость ИИ,
// воронка обращение→заявка→оплата. Данные агрегируются на клиенте из уже существующих коллекций
// (payments, serviceRequests, chatSessions). Доступ — админ (developer role, email-gated).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, CircularProgress, Alert, Stack, Divider, Chip,
  ToggleButtonGroup, ToggleButton, Link,
} from '@mui/material'
import {
  Home as HomeIcon, Refresh as RefreshIcon, TrendingUp as RevenueIcon, ReceiptLong as ReceiptIcon,
  Build as WorkIcon, Psychology as AiIcon, Forum as ChatIcon, Payments as PaymentsIcon,
  WarningAmber as WarnIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { serviceRequestService } from '@/api/serviceRequestService'
import { paymentsAdminService, type PaymentRow } from '@/api/paymentsAdminService'
import { chatSessionService } from '@/api/chatSessionService'
import { formatMoney } from '@/utils/pricing'
import { SERVICE_REQUEST_STATUS_LABELS, type ServiceRequest, type ServiceRequestStatus } from '@/types/serviceRequest'
import type { ChatSession } from '@/types/chat'

const PERIODS: { k: number; label: string }[] = [
  { k: 7, label: '7 днів' },
  { k: 30, label: '30 днів' },
  { k: 0, label: 'Увесь час' },
]
const STATUS_ORDER: ServiceRequestStatus[] = ['new', 'diagnostics', 'offered', 'approved', 'in_work', 'done', 'cancelled']

// Цвет полосы по статусу (семантика: активные — синие/фиолетовые, done — зелёный, cancelled — серый)
const STATUS_COLOR: Record<ServiceRequestStatus, string> = {
  new: '#5b8def', diagnostics: '#7c6ff0', offered: '#e0a53b', approved: '#3bb0a8',
  in_work: '#3b82c4', done: '#4caf7d', cancelled: '#9aa4a6',
}

export default function OwnerDashboardPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [requests, setRequests] = useState<ServiceRequest[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const [p, r, s] = await Promise.all([
      paymentsAdminService.list(1000),
      serviceRequestService.list(1000),
      chatSessionService.listRecent(1000),
    ])
    setPayments(p); setRequests(r); setSessions(s)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const cutoff = days ? Date.now() - days * 86400000 : 0
  const inPeriod = useCallback((iso?: string | null) => !cutoff || (!!iso && new Date(iso).getTime() >= cutoff), [cutoff])

  const m = useMemo(() => {
    const paid = payments.filter((p) => p.status === 'paid')
    const paidInPeriod = paid.filter((p) => inPeriod(p.receiptAt || p.createdAt))
    const revenue = paidInPeriod.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
    const receiptsIssued = paidInPeriod.filter((p) => p.receiptId).length
    const unfiscalized = paid.filter((p) => !p.receiptId).length // «гроші є, чек ні» — весь час (алерт)
    const aiCost = sessions
      .filter((s) => inPeriod(s.updatedAt || s.createdAt))
      .reduce((sum, s) => sum + (s.aiUsage?.costUsd || 0), 0)

    const activeReq = requests.filter((r) => r.status !== 'done' && r.status !== 'cancelled').length
    const byStatus = STATUS_ORDER.map((st) => ({ st, n: requests.filter((r) => r.status === st).length }))
    const maxStatus = Math.max(1, ...byStatus.map((x) => x.n))

    // Воронка за период: обращения → заявки → оплачено
    const chats = sessions.filter((s) => inPeriod(s.createdAt)).length
    const reqs = requests.filter((r) => inPeriod(r.createdAt)).length
    const pays = paidInPeriod.length
    const conv = chats ? Math.round((pays / chats) * 100) : 0

    const recentPaid = [...paid]
      .sort((a, b) => (b.receiptAt || b.createdAt || '').localeCompare(a.receiptAt || a.createdAt || ''))
      .slice(0, 6)

    return { revenue, receiptsIssued, unfiscalized, aiCost, activeReq, byStatus, maxStatus, funnel: { chats, reqs, pays, conv }, recentPaid }
  }, [payments, requests, sessions, inPeriod])

  const periodLabel = PERIODS.find((p) => p.k === days)?.label

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для адміністратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }

  const kpi = (icon: React.ReactNode, label: string, value: string, sub?: string, color?: string) => (
    <Paper sx={{ p: 2, flex: '1 1 200px', minWidth: 190 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ color: color || 'text.secondary', mb: 0.5 }}>
        {icon}
        <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</Typography>
      </Stack>
      <Typography variant="h4" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
      {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
    </Paper>
  )

  const funBar = (label: string, n: number, base: number, color: string) => (
    <Box>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.25 }}>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{n}</Typography>
      </Stack>
      <Box sx={{ height: 10, borderRadius: 5, bgcolor: 'action.hover', overflow: 'hidden' }}>
        <Box sx={{ height: '100%', width: `${base ? Math.max(2, (n / base) * 100) : 0}%`, bgcolor: color, borderRadius: 5, transition: 'width .3s' }} />
      </Box>
    </Box>
  )

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Панель власника</Typography>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <ToggleButtonGroup size="small" exclusive value={days} onChange={(_, v) => v !== null && setDays(v)}>
            {PERIODS.map((p) => <ToggleButton key={p.k} value={p.k}>{p.label}</ToggleButton>)}
          </ToggleButtonGroup>
          <Button size="small" startIcon={<RefreshIcon />} onClick={load} disabled={loading}>Оновити</Button>
          <Button size="small" startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>
      ) : (
        <Stack spacing={2}>
          {m.unfiscalized > 0 && (
            <Alert severity="warning" icon={<WarnIcon />} action={<Button color="inherit" size="small" onClick={() => navigate('/payments-admin')}>Розібратися</Button>}>
              Оплат без чека: <b>{m.unfiscalized}</b> — гроші отримано, фіскальний чек не виписано.
            </Alert>
          )}

          {/* KPI */}
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            {kpi(<RevenueIcon fontSize="small" />, 'Виручка (оплачено)', formatMoney(m.revenue), periodLabel, 'success.main')}
            {kpi(<ReceiptIcon fontSize="small" />, 'Чеки виписано', String(m.receiptsIssued), m.unfiscalized ? `без чека: ${m.unfiscalized}` : 'усі виписані')}
            {kpi(<WorkIcon fontSize="small" />, 'Заявки в роботі', String(m.activeReq), 'не завершені / не скасовані', 'primary.main')}
            {kpi(<AiIcon fontSize="small" />, 'Вартість ІІ', `$${m.aiCost.toFixed(2)}`, 'комунікація з клієнтами', 'secondary.main')}
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            {/* Воронка */}
            <Paper sx={{ p: 2, flex: 1 }}>
              <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Воронка ({periodLabel})</Typography>
              <Stack spacing={1.5}>
                {funBar('Звернення (чати)', m.funnel.chats, m.funnel.chats, '#5b8def')}
                {funBar('Заявки', m.funnel.reqs, m.funnel.chats, '#e0a53b')}
                {funBar('Оплачено', m.funnel.pays, m.funnel.chats, '#4caf7d')}
              </Stack>
              <Divider sx={{ my: 1.5 }} />
              <Stack direction="row" alignItems="center" spacing={1}>
                <ChatIcon fontSize="small" color="disabled" />
                <Typography variant="body2" color="text.secondary">Конверсія звернення → оплата:</Typography>
                <Chip size="small" color={m.funnel.conv >= 20 ? 'success' : 'default'} label={`${m.funnel.conv}%`} />
              </Stack>
            </Paper>

            {/* Заявки по статусам */}
            <Paper sx={{ p: 2, flex: 1 }}>
              <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Заявки за статусами (усього)</Typography>
              <Stack spacing={1}>
                {m.byStatus.map(({ st, n }) => (
                  <Box key={st}>
                    <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.25 }}>
                      <Typography variant="body2">{SERVICE_REQUEST_STATUS_LABELS[st]}</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{n}</Typography>
                    </Stack>
                    <Box sx={{ height: 8, borderRadius: 4, bgcolor: 'action.hover', overflow: 'hidden' }}>
                      <Box sx={{ height: '100%', width: `${(n / m.maxStatus) * 100}%`, bgcolor: STATUS_COLOR[st], borderRadius: 4 }} />
                    </Box>
                  </Box>
                ))}
              </Stack>
              <Button size="small" sx={{ mt: 1.5 }} onClick={() => navigate('/service-requests')}>Усі заявки →</Button>
            </Paper>
          </Stack>

          {/* Последние оплаты */}
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="subtitle1">Останні оплати</Typography>
              <Button size="small" startIcon={<PaymentsIcon />} onClick={() => navigate('/payments-admin')}>Оплати та чеки</Button>
            </Stack>
            {m.recentPaid.length === 0 ? (
              <Typography variant="body2" color="text.secondary">Оплат ще немає.</Typography>
            ) : (
              <Stack divider={<Divider flexItem />} spacing={1}>
                {m.recentPaid.map((p) => (
                  <Stack key={p.orderId} direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 100, fontVariantNumeric: 'tabular-nums' }}>{formatMoney(Number(p.amount) || 0)}</Typography>
                    <Chip size="small" variant="outlined" label={p.provider || p.method || 'оплата'} />
                    {p.receiptId
                      ? (p.taxUrl ? <Link href={p.taxUrl} target="_blank" rel="noreferrer" variant="body2">чек</Link> : <Chip size="small" color="success" label="чек" />)
                      : <Chip size="small" color="warning" label="без чека" />}
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                      {p.receiptAt || p.createdAt ? new Date(p.receiptAt || p.createdAt).toLocaleString('uk-UA') : ''}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}
          </Paper>
        </Stack>
      )}
    </Container>
  )
}
