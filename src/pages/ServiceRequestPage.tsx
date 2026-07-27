// Заявка на обслуживание — страница-ХАБ (для мастера/админа).
//
// Центр всего потока: обращение → заявка → предложение (варианты) → факт → оплата.
// Показывает клиента, жалобу, статус и связанные калькуляции; отсюда мастер запускает
// составление предложения и фактической сметы (с привязкой к этой заявке).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip, Stack, Divider,
  TextField, MenuItem, Link, Snackbar, Autocomplete,
} from '@mui/material'
import {
  Home as HomeIcon, Forum as ChatIcon, LocalOffer as OfferIcon, Build as ActualIcon,
  Payments as PaymentsIcon, Save as SaveIcon, CheckCircle as CheckIcon, Psychology as AiIcon,
  Biotech as DiagIcon, NotificationsActive as NotifyIcon, LocalShipping as ShipIcon, Send as SendIcon,
  Telegram as TelegramIcon,
  Group as SpecialistsIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { serviceRequestService } from '@/api/serviceRequestService'
import { userProfileService } from '@/api/userProfileService'
import { chatSessionService } from '@/api/chatSessionService'
import { notificationService } from '@/api/notificationService'
import { notificationApi } from '@/api/endpoints/notification'
import { pricingService } from '@/api/pricingService'
import { formatMoney } from '@/utils/pricing'
import { SERVICE_REQUEST_STATUS_LABELS, type ServiceRequest, type ServiceRequestStatus } from '@/types/serviceRequest'
import type { EstimateOffer, Estimate } from '@/types/pricing'
import type { PreliminaryEstimate, ChatMessage } from '@/types/chat'
import type { AiHistoryEntry } from '@/api/endpoints/ai'
import AiTextEditor from '@/components/common/AiTextEditor'
import { NOTIFICATION_EVENT_LABELS, type ClientNotification } from '@/types/notification'
import { cardVisibility, type ViewRole, type ServiceCenter } from '@/types/access'
import { serviceCenterService } from '@/api/serviceCenterService'
import { telegramLinkApi } from '@/api/endpoints/telegramLink'
import NpAddressPicker from '@/components/NpAddressPicker'
import type { NpAddress } from '@/types/npTemplate'
import CreateTtnDialog from '@/components/CreateTtnDialog'
import ViewAsButton from '@/components/ViewAsButton'

const STATUSES = Object.keys(SERVICE_REQUEST_STATUS_LABELS) as ServiceRequestStatus[]

export default function ServiceRequestPage() {
  const navigate = useNavigate()
  const { id = '' } = useParams<{ id: string }>()
  const { user } = useAuthStore()
  const [req, setReq] = useState<ServiceRequest | null>(null)
  const [offer, setOffer] = useState<EstimateOffer | null>(null)
  const [actual, setActual] = useState<Estimate | null>(null)
  const [aiEstimate, setAiEstimate] = useState<PreliminaryEstimate | null>(null) // оценка ИИ из переписки
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [complaint, setComplaint] = useState('')
  const [boat, setBoat] = useState('')
  const [clientName, setClientName] = useState('')
  const [clientPhone, setClientPhone] = useState('') // нужен для SMS-фолбэка оповещений
  const [diag, setDiag] = useState('') // текст диагностики (выявленные неисправности)
  const [notifs, setNotifs] = useState<ClientNotification[]>([]) // журнал оповещений
  const [notifText, setNotifText] = useState('') // произвольное сообщение клиенту
  const [ttnInput, setTtnInput] = useState('') // номер ТТН для оповещения об отправке
  const [sending, setSending] = useState(false)
  const [ttnDialog, setTtnDialog] = useState(false) // диалог создания ТТН
  const [ttnTemplateId, setTtnTemplateId] = useState<string | undefined>(undefined) // предвыбранный шаблон (из центра)
  const [centers, setCenters] = useState<ServiceCenter[]>([]) // реестр сервисных центров
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' }>({ open: false, msg: '', sev: 'success' })
  const [staff, setStaff] = useState<{ uid: string; name: string }[]>([]) // справочник специалистов центра
  const [viewAs, setViewAs] = useState<ViewRole>('owner') // превью «Показати як…»
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]) // переписка обращения (для ИИ-диагностики)
  const [diagAiHistory, setDiagAiHistory] = useState<AiHistoryEntry[]>([]) // локальная история ИИ-правок диагностики
  const notify = (msg: string, sev: 'success' | 'error' = 'success') => setSnack({ open: true, msg, sev })

  // Telegram deep-link: получить (стабильную) ссылку и скопировать в буфер — отправить клиенту.
  const copyTgLink = async () => {
    if (!req) return
    const r = await telegramLinkApi.create(req.id)
    if (r.ok && r.url) {
      try {
        await navigator.clipboard.writeText(r.url)
        notify('Telegram-посилання скопійовано — надішліть клієнту')
      } catch {
        notify(r.url) // буфер недоступен — покажем ссылку текстом
      }
    } else notify(r.error || 'Не вдалося створити посилання', 'error')
  }

  const load = useCallback(async () => {
    if (!id) return
    const r = await serviceRequestService.get(id)
    setReq(r)
    if (r) {
      setComplaint(r.complaint || '')
      setBoat(r.boat || '')
      setClientName(r.clientName || '')
      setClientPhone(r.clientPhone || '')
      setDiag(r.diagnostics?.text || '')
      if (r.offerId) pricingService.loadOffer(r.offerId).then(setOffer)
      if (r.actualEstimateId) pricingService.loadEstimate(r.actualEstimateId).then(setActual)
      // Предварительная оценка ИИ — из связанного обращения (та, что ИИ показывал в переписке).
      if (r.sessionId) chatSessionService.load(r.sessionId).then((s) => { setAiEstimate(s?.estimate || null); setChatMessages(s?.messages || []) })
      notificationService.listByRequest(id).then(setNotifs)
    }
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  // Справочник специалистов (для назначения на заявку). Фильтр по центру заявки, если задан.
  useEffect(() => {
    userProfileService.listSpecialists(req?.serviceCenterId || null).then(setStaff).catch(() => setStaff([]))
  }, [req?.serviceCenterId])

  const specialists = req?.specialists || []
  const addSpecialist = (opt: { uid: string; name: string } | null) => {
    if (!opt || specialists.some((s) => s.uid === opt.uid)) return
    patch({ specialists: [...specialists, { uid: opt.uid, name: opt.name }] }).then((ok) => { if (ok) notify('Спеціаліста додано') })
  }
  const removeSpecialist = (uid: string) => {
    patch({ specialists: specialists.filter((s) => s.uid !== uid) }).then((ok) => { if (ok) notify('Спеціаліста прибрано') })
  }

  // Справочный контекст для ИИ-диагностики: жалоба + кораблик + переписка с клиентом (без внутренних заметок).
  const diagReference = useMemo(() => {
    const parts: string[] = []
    if (complaint.trim()) parts.push(`Скарга клієнта: ${complaint.trim()}`)
    if (boat.trim()) parts.push(`Кораблик: ${boat.trim()}`)
    const conv = chatMessages
      .filter((m) => !m.internal && m.text?.trim())
      .slice(-30)
      .map((m) => `${m.role === 'client' ? 'Клієнт' : m.role === 'ai' ? 'ІІ' : 'Менеджер'}: ${m.text.trim()}`)
    if (conv.length) parts.push(`Переписка з клієнтом:\n${conv.join('\n')}`)
    return parts.join('\n\n')
  }, [complaint, boat, chatMessages])

  // Реестр сервисных центров (для выбора центра заявки и его шаблонов ТТН).
  useEffect(() => { serviceCenterService.list().then(setCenters).catch(() => setCenters([])) }, [])
  const center = centers.find((c) => c.id === req?.serviceCenterId) || null
  const openTtn = (templateId?: string) => { setTtnTemplateId(templateId); setTtnDialog(true) }

  // Оптимистично обновляем req локально (без полной перезагрузки, чтобы не терять несохранённый
  // ввод в полях і не затирати статус, проставлений webhook). offer/actual не меняются при этом.
  const patch = async (fields: Partial<ServiceRequest>) => {
    setSaving(true)
    const ok = await serviceRequestService.save({ id, ...fields })
    setSaving(false)
    if (ok) { setReq((r) => (r ? { ...r, ...fields } : r)); return true }
    notify('Не вдалося зберегти', 'error')
    return false
  }

  // Сохранить диагностику. Первое сохранение с текстом продвигает статус new → diagnostics.
  const saveDiag = () => {
    const text = diag.trim()
    const fields: Partial<ServiceRequest> = {
      diagnostics: text ? { text, at: new Date().toISOString(), by: user?.email || null } : null,
    }
    if (text && req?.status === 'new' && !req?.paymentId) fields.status = 'diagnostics'
    patch(fields).then((ok) => { if (ok) notify('Діагностику збережено') })
  }

  const reloadNotifs = () => notificationService.listByRequest(id).then(setNotifs)

  // Отправка произвольного оповещения клиенту (канал выбирает сервер: мессенджер / SMS).
  const sendCustom = async () => {
    const text = notifText.trim()
    if (!text) return
    setSending(true)
    const rec = await notificationApi.notify({ serviceRequestId: id, event: 'custom', text })
    setSending(false)
    if (rec?.status === 'sent') { notify(`Надіслано (${rec.via === 'sms' ? 'SMS' : rec.channel})`); setNotifText('') }
    else notify(rec?.error || 'Не вдалося надіслати', 'error')
    reloadNotifs()
  }

  // Оповещение об отправке кораблика (ТТН). Сохраняем номер на заявке и шлём клиенту.
  const sendTtn = async () => {
    const ttn = ttnInput.trim()
    setSending(true)
    if (ttn) await patch({ waybillNumber: ttn })
    const rec = await notificationApi.notify({ serviceRequestId: id, event: 'ttn', ttn: ttn || undefined })
    setSending(false)
    if (rec?.status === 'sent') { notify(`Повідомлення про відправку надіслано (${rec.via === 'sms' ? 'SMS' : rec.channel})`); setTtnInput('') }
    else notify(rec?.error || 'Не вдалося надіслати', 'error')
    reloadNotifs()
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
  const vis = cardVisibility(viewAs) // видимость секций для превью «Показати як…»

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Заявка на обслуговування</Typography>
        <Stack direction="row" spacing={1}>
          <ViewAsButton value={viewAs} onChange={setViewAs} />
          {req.sessionId && <Button startIcon={<ChatIcon />} onClick={() => navigate('/manager-inbox')}>Обращення</Button>}
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>
      {viewAs !== 'owner' && (
        <Alert severity="warning" sx={{ mb: 2 }}>Прев'ю очима ролі «{viewAs === 'client' ? 'Клієнт' : viewAs === 'director' ? 'Директор' : viewAs === 'accountant' ? 'Бухгалтер' : 'Спеціаліст'}»: службові секції приховано.</Alert>
      )}

      {/* Клиент + статус + жалоба */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems={{ sm: 'center' }}>
          <TextField label="Клієнт (ПІБ)" value={clientName} onChange={(e) => setClientName(e.target.value)} size="small" sx={{ flex: 1, minWidth: 180 }} />
          <TextField label="Телефон" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} size="small" sx={{ minWidth: 170 }}
            placeholder="+380…" helperText={!clientPhone.trim() ? 'потрібен для SMS-оповіщень' : undefined} />
          <TextField select size="small" label="Статус" value={req.status} disabled={!!req.paymentId || saving}
            helperText={req.paymentId ? 'оплачено — статус зафіксовано' : undefined}
            onChange={(e) => patch({ status: e.target.value as ServiceRequestStatus })} sx={{ minWidth: 180 }}>
            {STATUSES.map((st) => <MenuItem key={st} value={st}>{SERVICE_REQUEST_STATUS_LABELS[st]}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Сервісний центр" value={req.serviceCenterId || ''} disabled={saving} sx={{ minWidth: 180 }}
            helperText={!req.serviceCenterId ? 'потрібен для ТТН/ФОП/спеціалістів' : undefined}
            onChange={(e) => patch({ serviceCenterId: e.target.value || null })}>
            <MenuItem value=""><em>— не задано —</em></MenuItem>
            {centers.filter((c) => c.active).map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
          </TextField>
        </Stack>
        {/* Адреса НП клієнта (підставляється в ТТН; при переносі з 1С резолвиться автоматично) */}
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Адреса Нової Пошти клієнта {req.clientCityName ? '' : '— не задана (потрібна для ТТН «з ремонту»)'}
          </Typography>
          <NpAddressPicker
            value={{
              cityRef: req.clientCityRef || undefined, cityName: req.clientCityName || undefined,
              warehouseRef: req.clientWarehouseRef || undefined, warehouseName: req.clientWarehouseName || undefined,
            } as NpAddress}
            onChange={(v) => patch({
              clientCityRef: v.cityRef || undefined, clientCityName: v.cityName || undefined,
              clientWarehouseRef: v.warehouseRef || undefined, clientWarehouseName: v.warehouseName || undefined,
            })}
            label="Місто клієнта" warehouseLabel="Відділення НП" />
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Кораблик" value={boat} onChange={(e) => setBoat(e.target.value)} size="small" sx={{ minWidth: 200 }} />
          <TextField label="Скарга / опис" value={complaint} onChange={(e) => setComplaint(e.target.value)} size="small" fullWidth multiline />
          <Button variant="outlined" startIcon={<SaveIcon />} disabled={saving}
            onClick={() => patch({ complaint, boat, clientName: clientName.trim(), clientPhone: clientPhone.trim() }).then((ok) => { if (ok) notify('Збережено') })}>Зберегти</Button>
        </Stack>
        {req.externalRequestId && <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>Заявка 1С: {req.externalRequestId}</Typography>}
      </Paper>

      {/* Предварительная оценка ИИ — та, что клиент видел в переписке (ориентировочная, до диагностики) */}
      {aiEstimate && aiEstimate.lines.length > 0 && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <AiIcon fontSize="small" color="secondary" />
            <Typography variant="subtitle1">Попередня оцінка ІІ (з переписки)</Typography>
          </Stack>
          <Stack spacing={0.5}>
            {aiEstimate.lines.map((l, i) => (
              <Stack key={i} direction="row" justifyContent="space-between" spacing={2}>
                <Typography variant="body2" color="text.secondary">{l.label}</Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>{formatMoney(l.price)}</Typography>
              </Stack>
            ))}
            <Divider sx={{ my: 0.5 }} />
            <Stack direction="row" justifyContent="space-between" spacing={2}>
              <Typography variant="subtitle2">Разом (орієнтовно)</Typography>
              <Typography variant="subtitle2" sx={{ whiteSpace: 'nowrap' }}>{formatMoney(aiEstimate.total)}</Typography>
            </Stack>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Орієнтовна оцінка ІІ до діагностики — уточніть після огляду кораблика.
          </Typography>
        </Paper>
      )}

      {/* Диагностика — выявленные неисправности после получения кораблика (питает предложение) */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <DiagIcon fontSize="small" color="primary" />
          <Typography variant="subtitle1">Діагностика (виявлені несправності)</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Отримали кораблик — опишіть виявлені несправності. Помічник ІІ бачить скаргу та переписку з
          клієнтом і допоможе скласти акуратний текст (напр. «склади діагностику за скаргою та перепискою»).
          Це уточнює попередню калькуляцію: ІІ-підбір позицій у пропозиції засівається цим текстом.
        </Typography>
        <AiTextEditor value={diag} onChange={setDiag} label="Виявлені несправності" context="diagnostics"
          reference={diagReference} history={diagAiHistory} onHistoryChange={setDiagAiHistory} minRows={3}
          placeholder="напр. люфт сервоприводу керма, окислені контакти, тріщина корпусу біля бункера" />
        <Stack direction="row" spacing={2} sx={{ mt: 1.5, flexWrap: 'wrap' }} alignItems="center">
          <Button variant="outlined" startIcon={<SaveIcon />} disabled={saving} onClick={saveDiag}>Зберегти діагностику</Button>
          {req.diagnostics?.at && (
            <Typography variant="caption" color="text.secondary">
              оновлено {new Date(req.diagnostics.at).toLocaleString('uk-UA')}
            </Typography>
          )}
        </Stack>
      </Paper>

      {/* Специалисты, выполняющие сервис (портальные пользователи центра) — служебная секция */}
      {vis.internal && (
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <SpecialistsIcon fontSize="small" color="primary" />
          <Typography variant="subtitle1">Спеціалісти сервісу</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Хто виконує сервіс за заявкою. Під час створення фактичної калькуляції їх буде підставлено для розподілу виплат.
        </Typography>
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
          {specialists.length === 0
            ? <Typography variant="body2" color="text.secondary">Ще не призначено.</Typography>
            : specialists.map((s) => <Chip key={s.uid} label={s.name} onDelete={() => removeSpecialist(s.uid)} />)}
        </Stack>
        <Autocomplete size="small" sx={{ minWidth: 260, maxWidth: 360 }}
          options={staff.filter((o) => !specialists.some((s) => s.uid === o.uid))}
          getOptionLabel={(o) => o.name} isOptionEqualToValue={(a, b) => a.uid === b.uid}
          value={null} onChange={(_, v) => addSpecialist(v)} disabled={saving}
          noOptionsText={staff.length ? 'Усі додані' : 'Немає співробітників (додайте у «Доступ та центри»)'}
          renderInput={(p) => <TextField {...p} label="Додати спеціаліста" />} />
      </Paper>
      )}

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
            <Button size="small" startIcon={<ActualIcon />} disabled={actual?.status === 'paid'} onClick={() => navigate(`/actual-estimate?request=${id}&edit=${req.actualEstimateId}`)}>Редагувати</Button>
            {actualLink && <Button size="small" onClick={() => { navigator.clipboard.writeText(actualLink); notify('Посилання скопійовано') }}>Посилання на оплату</Button>}
          </Stack>
        ) : selectedVariantId ? (
          <Stack spacing={1.5} alignItems="flex-start">
            <Button variant="contained" startIcon={<ActualIcon />} onClick={() => navigate(`/actual-estimate?request=${id}&parent=${selectedVariantId}`)}>
              Скласти факт (за обраним варіантом)
            </Button>
            <Button size="small" onClick={() => navigate(`/actual-estimate?request=${id}`)}>Скласти факт напряму (без варіанта)</Button>
          </Stack>
        ) : (
          <Stack spacing={1.5} alignItems="flex-start">
            {req.offerId && <Alert severity="info" sx={{ width: '100%' }}>Пропозицію виставлено, але клієнт ще не обрав варіант. Можна скласти факт напряму.</Alert>}
            <Button variant="contained" startIcon={<ActualIcon />} onClick={() => navigate(`/actual-estimate?request=${id}`)}>
              Скласти факт{req.offerId ? ' напряму' : ' (без пропозиції)'}
            </Button>
          </Stack>
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

      {/* Информирование клиента — журнал оповещений (канал: мессенджер в окне / иначе SMS) */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <NotifyIcon fontSize="small" color="primary" />
          <Typography variant="subtitle1">Інформування клієнта</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Канал обирається автоматично: месенджер (Telegram — завжди; Viber — до 24 год після
          останнього повідомлення клієнта) або SMS. Попередня/фактична калькуляція та відправлення
          повідомляються автоматично; тут можна надіслати й довільне повідомлення.
        </Typography>

        {/* Telegram deep-link: клієнт відкриває посилання → бот привʼязує чат до заявки */}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" startIcon={<TelegramIcon />} onClick={copyTgLink}>Telegram-посилання</Button>
          {req.tgSessionId ? (
            <Chip size="small" color="success" label="Telegram підключено" />
          ) : (
            <Typography variant="caption" color="text.secondary">
              Клієнт відкриє посилання і натисне Start — бот привʼяже його до заявки, сповіщення підуть у Telegram (безкоштовно, без вікна).
            </Typography>
          )}
        </Stack>

        {/* Произвольное сообщение клиенту */}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1.5 }} alignItems={{ sm: 'flex-start' }}>
          <TextField value={notifText} onChange={(e) => setNotifText(e.target.value)} size="small" fullWidth multiline
            placeholder="Повідомлення клієнту (напр. потрібна доплата, уточнення по ремонту)" />
          <Button variant="contained" startIcon={<SendIcon />} disabled={sending || !notifText.trim()} onClick={sendCustom}>Надіслати</Button>
        </Stack>

        {/* Создание ТТН по направлениям (шаблон центра) + оповещение об отправке */}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1 }} alignItems={{ sm: 'center' }} flexWrap="wrap" useFlexGap>
          <Button variant="contained" startIcon={<ShipIcon />} disabled={!center?.incomingTtnTemplateId}
            onClick={() => openTtn(center?.incomingTtnTemplateId || undefined)}>ТТН: на ремонт</Button>
          <Button variant="contained" startIcon={<ShipIcon />} disabled={!center?.returnTtnTemplateId}
            onClick={() => openTtn(center?.returnTtnTemplateId || undefined)}>ТТН: з ремонту</Button>
          <Button variant="text" startIcon={<ShipIcon />} onClick={() => openTtn(undefined)}>Інший шаблон…</Button>
        </Stack>
        {!req.serviceCenterId ? (
          <Alert severity="info" sx={{ mb: 1.5 }}>Оберіть сервісний центр вище — тоді підтягнуться його шаблони ТТН («на ремонт» / «з ремонту»).</Alert>
        ) : (!center?.incomingTtnTemplateId && !center?.returnTtnTemplateId) ? (
          <Alert severity="info" sx={{ mb: 1.5 }}>У центру не задані шаблони ТТН — налаштуйте їх у «Доступ та центри» → центр.</Alert>
        ) : null}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1.5 }} alignItems={{ sm: 'center' }} flexWrap="wrap" useFlexGap>
          <TextField value={ttnInput} onChange={(e) => setTtnInput(e.target.value)} size="small"
            label="ТТН (номер накладної)" placeholder={req.waybillNumber || 'напр. 20450…'} sx={{ minWidth: 220 }} />
          <Button variant="outlined" startIcon={<ShipIcon />} disabled={sending} onClick={sendTtn}>Повідомити про відправку</Button>
        </Stack>

        {/* История оповещений */}
        {notifs.length > 0 && (
          <Stack spacing={0.75} sx={{ mt: 1 }}>
            <Divider sx={{ mb: 0.5 }} />
            {notifs.map((n) => (
              <Stack key={n.id} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Chip size="small" color={n.status === 'sent' ? 'success' : 'error'}
                  label={n.status === 'sent' ? (n.via === 'sms' ? 'SMS' : n.channel || 'месенджер') : 'помилка'} />
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 130 }}>{NOTIFICATION_EVENT_LABELS[n.event]}</Typography>
                <Typography variant="body2" sx={{ flex: 1, minWidth: 160 }}>{n.text}</Typography>
                <Typography variant="caption" color="text.secondary">{new Date(n.createdAt).toLocaleString('uk-UA')}</Typography>
              </Stack>
            ))}
          </Stack>
        )}
      </Paper>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        Порядок: заявка → пропозиція (варіанти) → клієнт обирає → фактична калькуляція → оплата (авто-чек).
      </Typography>

      <CreateTtnDialog open={ttnDialog} onClose={() => setTtnDialog(false)} serviceRequestId={id}
        clientName={req.clientName} clientPhone={req.clientPhone}
        clientCityRef={req.clientCityRef} clientCityName={req.clientCityName}
        clientWarehouseRef={req.clientWarehouseRef} clientWarehouseName={req.clientWarehouseName}
        presetTemplateId={ttnTemplateId}
        onCreated={(ttn) => { setTtnInput(ttn); setReq((r) => (r ? { ...r, waybillNumber: ttn } : r)); notify(`ТТН створено: ${ttn}`) }} />

      <Snackbar open={snack.open} autoHideDuration={5000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
