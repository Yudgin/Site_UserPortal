// Заявка на обслуживание — страница-ХАБ (для мастера/админа).
//
// Центр всего потока: обращение → заявка → предложение (варианты) → факт → оплата.
// Показывает клиента, жалобу, статус и связанные калькуляции; отсюда мастер запускает
// составление предложения и фактической сметы (с привязкой к этой заявке).
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip, Stack, Divider,
  TextField, MenuItem, Link, Snackbar,
} from '@mui/material'
import {
  Home as HomeIcon, Forum as ChatIcon, LocalOffer as OfferIcon, Build as ActualIcon,
  Payments as PaymentsIcon, Save as SaveIcon, CheckCircle as CheckIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { serviceRequestService } from '@/api/serviceRequestService'
import { pricingService } from '@/api/pricingService'
import { formatMoney } from '@/utils/pricing'
import { SERVICE_REQUEST_STATUS_LABELS, type ServiceRequest, type ServiceRequestStatus } from '@/types/serviceRequest'
import type { EstimateOffer, Estimate } from '@/types/pricing'

const STATUSES = Object.keys(SERVICE_REQUEST_STATUS_LABELS) as ServiceRequestStatus[]

export default function ServiceRequestPage() {
  const navigate = useNavigate()
  const { id = '' } = useParams<{ id: string }>()
  const { user } = useAuthStore()
  const [req, setReq] = useState<ServiceRequest | null>(null)
  const [offer, setOffer] = useState<EstimateOffer | null>(null)
  const [actual, setActual] = useState<Estimate | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [complaint, setComplaint] = useState('')
  const [boat, setBoat] = useState('')
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' = 'success') => setSnack({ open: true, msg, sev })

  const load = useCallback(async () => {
    if (!id) return
    const r = await serviceRequestService.get(id)
    setReq(r)
    if (r) {
      setComplaint(r.complaint || '')
      setBoat(r.boat || '')
      if (r.offerId) pricingService.loadOffer(r.offerId).then(setOffer)
      if (r.actualEstimateId) pricingService.loadEstimate(r.actualEstimateId).then(setActual)
    }
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const patch = async (fields: Partial<ServiceRequest>) => {
    setSaving(true)
    const ok = await serviceRequestService.save({ id, ...fields })
    setSaving(false)
    if (ok) { await load(); return true }
    notify('Не вдалося зберегти', 'error')
    return false
  }

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для адміністратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }
  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>
  if (!req) return <Container maxWidth="sm" sx={{ py: 8 }}><Alert severity="error">Заявку не знайдено.</Alert></Container>

  const selectedVariantId = offer?.selectedVariantId || null
  const offerLink = req.offerId ? `${window.location.origin}/offer/${req.offerId}` : ''
  const actualLink = req.actualEstimateId ? `${window.location.origin}/estimate/${req.actualEstimateId}` : ''

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Заявка на обслуговування</Typography>
        <Stack direction="row" spacing={1}>
          {req.sessionId && <Button startIcon={<ChatIcon />} onClick={() => navigate('/manager-inbox')}>Обращення</Button>}
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>

      {/* Клиент + статус + жалоба */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }} alignItems={{ sm: 'center' }}>
          <Typography variant="subtitle1" sx={{ flex: 1 }}>
            {req.clientName || 'Клієнт'} {req.clientPhone && <>· 📱 {req.clientPhone}</>}
          </Typography>
          <TextField select size="small" label="Статус" value={req.status} onChange={(e) => patch({ status: e.target.value as ServiceRequestStatus })} sx={{ minWidth: 180 }}>
            {STATUSES.map((st) => <MenuItem key={st} value={st}>{SERVICE_REQUEST_STATUS_LABELS[st]}</MenuItem>)}
          </TextField>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Кораблик" value={boat} onChange={(e) => setBoat(e.target.value)} size="small" sx={{ minWidth: 200 }} />
          <TextField label="Скарга / опис" value={complaint} onChange={(e) => setComplaint(e.target.value)} size="small" fullWidth multiline />
          <Button variant="outlined" startIcon={<SaveIcon />} disabled={saving} onClick={() => patch({ complaint, boat })}>Зберегти</Button>
        </Stack>
        {req.externalRequestId && <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>Заявка 1С: {req.externalRequestId}</Typography>}
      </Paper>

      {/* Крок 1: Предложение (предварительные калькуляции) */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>1 · Пропозиція клієнту (варіанти)</Typography>
        {req.offerId ? (
          <Stack spacing={1}>
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip color={offer?.status === 'chosen' || offer?.status === 'locked' ? 'success' : 'warning'}
                label={offer?.status === 'chosen' ? 'клієнт обрав' : offer?.status === 'locked' ? 'зафіксовано' : 'очікує вибору'} />
              <Button size="small" onClick={() => navigate(`/offer-editor?offer=${req.offerId}`)}>Відкрити редактор</Button>
              {offerLink && <Button size="small" onClick={() => { navigator.clipboard.writeText(offerLink); notify('Посилання скопійовано') }}>Посилання клієнту</Button>}
            </Stack>
          </Stack>
        ) : (
          <Button variant="contained" startIcon={<OfferIcon />}
            onClick={() => navigate(`/offer-editor?request=${id}${req.aiEstimateId ? `&parent=${req.aiEstimateId}` : ''}`)}>
            Скласти пропозицію{req.aiEstimateId ? ' (з оцінки ІІ)' : ''}
          </Button>
        )}
      </Paper>

      {/* Крок 2: Фактическая калькуляция */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>2 · Фактична калькуляція</Typography>
        {req.actualEstimateId ? (
          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip color={actual?.status === 'paid' ? 'success' : 'primary'} label={actual?.status === 'paid' ? 'оплачено' : `сума ${actual ? formatMoney(actual.total) : ''}`} />
            <Button size="small" startIcon={<ActualIcon />} onClick={() => navigate(`/actual-estimate?request=${id}&parent=${req.actualEstimateId}`)}>Редагувати</Button>
            {actualLink && <Button size="small" onClick={() => { navigator.clipboard.writeText(actualLink); notify('Посилання скопійовано') }}>Посилання на оплату</Button>}
          </Stack>
        ) : selectedVariantId ? (
          <Button variant="contained" startIcon={<ActualIcon />} onClick={() => navigate(`/actual-estimate?request=${id}&parent=${selectedVariantId}`)}>
            Скласти факт (за обраним варіантом)
          </Button>
        ) : req.offerId ? (
          <Alert severity="info">Клієнт ще не обрав варіант — факт складається після вибору.</Alert>
        ) : (
          <Alert severity="info">Спочатку складіть пропозицію і дочекайтесь вибору клієнта.</Alert>
        )}
      </Paper>

      {/* Крок 3: Оплата */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>3 · Оплата та чек</Typography>
        {actual?.status === 'paid' || req.paymentId ? (
          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip color="success" icon={<CheckIcon />} label="оплачено" />
            {actual?.taxUrl && <Link href={actual.taxUrl} target="_blank" rel="noreferrer">фіскальний чек</Link>}
            <Button size="small" startIcon={<PaymentsIcon />} onClick={() => navigate('/payments-admin')}>Оплати та чеки</Button>
          </Stack>
        ) : (
          <Alert severity="info">Оплата стане доступною клієнту на сторінці фактичного кошторису.</Alert>
        )}
      </Paper>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        Порядок: заявка → пропозиція (варіанти) → клієнт обирає → фактична калькуляція → оплата (авто-чек).
      </Typography>

      <Snackbar open={snack.open} autoHideDuration={5000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
