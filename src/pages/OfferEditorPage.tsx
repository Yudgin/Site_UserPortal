// Редактор ПРЕДЛОЖЕНИЯ клиенту (стадия 2) — для мастера/админа.
//
// Мастер, отталкиваясь от предварительной оценки ИИ (или с нуля), собирает ОДИН ИЛИ НЕСКОЛЬКО
// вариантов ремонта (напр. «Повний ремонт» / «Бюджетний» / «Заміна вузла»), объединяет их в
// предложение (offer) и получает ссылку для клиента /offer/:id. Клиент выбирает путь. По
// выбранному варианту мастер потом собирает фактическую калькуляцию (кнопка ниже).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, Snackbar, CircularProgress, Divider,
  Chip, Stack, TextField, List, ListItem, ListItemText,
} from '@mui/material'
import {
  Home as HomeIcon, ContentCopy as CopyIcon, AddCircle as AddVariantIcon,
  Build as ActualIcon, CheckCircle as CheckIcon, ArrowBack as BackIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { usePricingStore } from '@/store/pricingStore'
import { isAdminEmail } from '@/config/access'
import { pricingService } from '@/api/pricingService'
import { serviceRequestService } from '@/api/serviceRequestService'
import { notificationApi } from '@/api/endpoints/notification'
import { secureId } from '@/utils/id'
import { buildMultiEstimate, formatMoney } from '@/utils/pricing'
import { estimateToSections, toComplaintSections, type EditableSection } from '@/utils/estimateSections'
import { buildPriceContext } from '@/utils/aiContext'
import ViewAsButton from '@/components/ViewAsButton'
import SectionsWorksEditor from '@/components/SectionsWorksEditor'
import EstimateSectionsView from '@/components/EstimateSectionsView'
import { VIEW_ROLE_LABELS, type ViewRole } from '@/types/access'
import type { Estimate, EstimateOffer } from '@/types/pricing'

interface VariantEntry { id: string; label: string; total: number }

export default function OfferEditorPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { user } = useAuthStore()
  const { catalog, indexed, loadFromServer, isLoading } = usePricingStore()

  const parentId = params.get('parent') || '' // засев из оценки ИИ / существующей сметы
  const loadOfferId = params.get('offer') || '' // открыть существующее предложение
  const serviceRequestId = params.get('request') || '' // привязка к нашей заявке на обслуживание

  const [offerId, setOfferId] = useState('')
  const [viewAs, setViewAs] = useState<ViewRole>('owner') // превью «Показати як…»
  const [title, setTitle] = useState('')
  const [diagSeed, setDiagSeed] = useState('') // диагностика заявки → засев ИИ-подбора
  const [loadedSrId, setLoadedSrId] = useState('') // serviceRequestId, вычитанный из открытого оффера
  const [variants, setVariants] = useState<VariantEntry[]>([])
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null)
  const [offerStatus, setOfferStatus] = useState<'pending_choice' | 'chosen' | 'locked' | null>(null)

  // текущий собираемый вариант — разрезы по требованиям клиента
  const [label, setLabel] = useState('')
  const [sections, setSections] = useState<EditableSection[]>([])

  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' | 'info' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' | 'info' = 'success') => setSnack({ open: true, msg, sev })

  useEffect(() => { loadFromServer() }, [loadFromServer])

  // Засев из существующей сметы (оценка ИИ / вариант) — разрезами по требованиям.
  useEffect(() => {
    if (!parentId) return
    pricingService.loadEstimate(parentId).then((est) => {
      if (!est) return
      setSections((prev) => prev.length ? prev : estimateToSections(est, indexed))
      setLabel((v) => v || 'Варіант 1')
    })
  }, [parentId, indexed])

  // Авто-название предложения из заявки (кораблик + скарга); мастер за потреби відредагує.
  useEffect(() => {
    if (!serviceRequestId) return
    serviceRequestService.get(serviceRequestId).then((sr) => {
      if (!sr) return
      const auto = [sr.boat, sr.complaint ? sr.complaint.slice(0, 60) : ''].filter(Boolean).join(' — ')
      setTitle((t) => t || auto || 'Пропозиція')
      // Диагностика (уточнённые неисправности) — засев для ИИ-подбора позиций.
      if (sr.diagnostics?.text) setDiagSeed(sr.diagnostics.text)
    })
  }, [serviceRequestId])

  // Открыть существующее предложение (посмотреть статус/варианты, собрать факт)
  useEffect(() => {
    if (!loadOfferId) return
    pricingService.loadOffer(loadOfferId).then(async (offer) => {
      if (!offer) { notify('Пропозицію не знайдено', 'error'); return }
      setOfferId(offer.id)
      setLoadedSrId(offer.serviceRequestId || '') // чтобы новые варианты/факт остались привязаны к заявке
      setTitle(offer.title || '')
      setSelectedVariantId(offer.selectedVariantId)
      setOfferStatus(offer.status)
      const loaded: VariantEntry[] = []
      for (const vid of offer.variantIds) {
        const e = await pricingService.loadEstimate(vid)
        if (e) loaded.push({ id: vid, label: e.variantLabel || 'Варіант', total: e.total })
      }
      setVariants(loaded)
    })
  }, [loadOfferId])

  const priceCtx = useMemo(() => buildPriceContext(catalog), [catalog])

  // Текущий вариант считается из разрезов по требованиям (мульти-жалобы + авто общие работы).
  const currentEstimate: Estimate | null = useMemo(() => {
    const cs = toComplaintSections(sections, indexed)
    if (!cs.length) return null
    return buildMultiEstimate({
      sections: cs, catalog: indexed, settings: catalog.settings,
      meta: { title, source: 'manual', createdBy: user?.email ?? null },
    })
  }, [sections, indexed, catalog.settings, title, user])

  const clientLink = offerId ? `${window.location.origin}/offer/${offerId}` : ''

  // Сохранить текущий вариант и добавить в предложение
  const addVariant = async () => {
    if (!currentEstimate) { notify('Додайте роботи до варіанта', 'error'); return }
    if (!label.trim()) { notify('Вкажіть назву варіанта', 'error'); return }
    // К уже выбранному/замороженному предложению вариант добавлять нельзя (клиент его не выберет).
    if (offerStatus === 'chosen' || offerStatus === 'locked') {
      notify('Пропозицію вже обрано/зафіксовано — додавання варіантів недоступне', 'error'); return
    }
    const effectiveSrId = serviceRequestId || loadedSrId // сохраняем привязку к заявке и при ?offer=
    setSaving(true)
    try {
      const oid = offerId || secureId(16)
      const variantEstimate: Estimate = {
        ...currentEstimate,
        id: '',
        kind: 'preliminary',
        stage: 'proposed',
        status: 'approved', // вариант утверждён мастером (это его предложение)
        offerId: oid,
        serviceRequestId: effectiveSrId || null,
        variantLabel: label.trim(),
        variantOrder: variants.length,
        parentEstimateId: parentId || null,
      }
      const saved = await pricingService.saveEstimate(variantEstimate)
      if (!saved) { notify('Не вдалося зберегти варіант', 'error'); return }
      const nextVariants = [...variants, { id: saved.id, label: label.trim(), total: currentEstimate.total }]
      setVariants(nextVariants)
      // upsert предложения. На ПЕРВОМ варианте инициализируем; далее пишем ТОЛЬКО свои поля
      // (title/variantIds) через merge — иначе затрём выбор клиента (selectedVariantId/status/chosenAt).
      const isFirst = !offerId
      const offerPatch: Partial<EstimateOffer> & { id: string } = offerId
        ? { id: oid, title: title || currentEstimate.title || 'Пропозиція', variantIds: nextVariants.map((v) => v.id) }
        : {
            id: oid,
            requestId: currentEstimate.requestId ?? null,
            serviceRequestId: effectiveSrId || null,
            title: title || currentEstimate.title || 'Пропозиція',
            variantIds: nextVariants.map((v) => v.id),
            selectedVariantId: null,
            status: 'pending_choice',
            createdAt: new Date().toISOString(),
            createdBy: user?.email ?? null,
          }
      const savedOffer = await pricingService.saveOffer(offerPatch)
      if (!savedOffer) { notify('Не вдалося зберегти пропозицію', 'error'); return }
      // При создании предложения привязываем его к заявке и двигаем её статус.
      if (isFirst && effectiveSrId) {
        await serviceRequestService.save({ id: effectiveSrId, offerId: oid, status: 'offered' }).catch(() => {})
        // Авто-оповещение клиента: попередня калькуляція готова (канал выбирает сервер; идемпотентно).
        notificationApi.notify({ serviceRequestId: effectiveSrId, event: 'offer' }).catch(() => {})
      }
      setOfferId(oid)
      setOfferStatus((s) => s || 'pending_choice')
      // очистить конструктор под следующий вариант
      setSections([])
      setLabel(`Варіант ${nextVariants.length + 1}`)
      notify('Варіант додано до пропозиції', 'success')
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Помилка', 'error')
    } finally {
      setSaving(false)
    }
  }

  const copyLink = async () => {
    if (!clientLink) return
    try { await navigator.clipboard.writeText(clientLink); notify('Посилання для клієнта скопійовано', 'success') }
    catch { notify(clientLink, 'info') }
  }

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для адміністратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }
  if (isLoading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>

  const chosenVariant = selectedVariantId ? variants.find((v) => v.id === selectedVariantId) : null

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Пропозиція клієнту</Typography>
        <Stack direction="row" spacing={1}>
          <ViewAsButton value={viewAs} onChange={setViewAs} />
          {(serviceRequestId || loadedSrId) && (
            <Button startIcon={<BackIcon />} onClick={() => navigate(`/service-request/${serviceRequestId || loadedSrId}`)}>До заявки</Button>
          )}
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>
      {viewAs !== 'owner' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Прев'ю очима ролі «{VIEW_ROLE_LABELS[viewAs]}». Попередня калькуляція — це і є пропозиція клієнту:
          усі ролі бачать варіанти та суми; внутрішня економіка зʼявляється лише у фактичній калькуляції.
        </Alert>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Зберіть один або кілька варіантів ремонту. Клієнт побачить усі та обере один шлях. За обраним
        варіантом далі складається фактична калькуляція, за якою відбувається оплата.
      </Typography>

      <Paper sx={{ p: 2, mb: 3 }}>
        <TextField label="Назва пропозиції / кораблик" value={title} onChange={(e) => setTitle(e.target.value)} size="small" fullWidth />
      </Paper>

      {/* Уже добавленные варианты */}
      {variants.length > 0 && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>Варіанти пропозиції ({variants.length})</Typography>
          <List dense>
            {variants.map((v) => (
              <ListItem key={v.id} secondaryAction={selectedVariantId === v.id ? <Chip color="success" size="small" icon={<CheckIcon />} label="обрано клієнтом" /> : null}>
                <ListItemText primary={v.label} secondary={formatMoney(v.total)} />
              </ListItem>
            ))}
          </List>
          {clientLink && (
            <Stack direction="row" spacing={2} sx={{ mt: 1, flexWrap: 'wrap' }}>
              <Button variant="outlined" startIcon={<CopyIcon />} onClick={copyLink}>Посилання для клієнта</Button>
              <Button variant="text" onClick={() => window.open(clientLink, '_blank')}>Відкрити сторінку вибору</Button>
            </Stack>
          )}
          {offerStatus === 'chosen' && chosenVariant && (
            <Alert severity="success" sx={{ mt: 2 }} action={
              <Button color="inherit" size="small" startIcon={<ActualIcon />} onClick={() => navigate(`/actual-estimate?parent=${selectedVariantId}${(serviceRequestId || loadedSrId) ? `&request=${serviceRequestId || loadedSrId}` : ''}`)}>
                Скласти факт
              </Button>
            }>
              Клієнт обрав: <b>{chosenVariant.label}</b>. Можна складати фактичний кошторис за цим шляхом.
            </Alert>
          )}
        </Paper>
      )}

      {/* Конструктор текущего варианта — разрезами по требованиям клиента */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1.5 }}>{variants.length ? 'Наступний варіант' : 'Варіант'}</Typography>
        <TextField label="Назва варіанта" value={label} onChange={(e) => setLabel(e.target.value)} size="small" sx={{ mb: 2, maxWidth: 360 }} fullWidth
          placeholder="напр. Повний ремонт" />
        <SectionsWorksEditor sections={sections} onChange={setSections} catalog={indexed} priceContext={priceCtx} aiSeed={diagSeed} />

        {currentEstimate && (
          <Box sx={{ mt: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Попередній перегляд варіанта</Typography>
            <EstimateSectionsView lines={currentEstimate.lines} sections={currentEstimate.sections} total={currentEstimate.total} currency={currentEstimate.currency} />
          </Box>
        )}

        <Button variant="contained" startIcon={<AddVariantIcon />} onClick={addVariant} disabled={!currentEstimate || saving} sx={{ mt: 2 }}>
          {saving ? 'Збереження…' : 'Додати варіант до пропозиції'}
        </Button>
      </Paper>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        Порядок: зберіть варіант(и) → надішліть клієнту посилання → клієнт обирає шлях → за обраним
        варіантом складіть фактичний кошторис (кнопка «Скласти факт») → клієнт оплачує.
      </Typography>

      <Snackbar open={snack.open} autoHideDuration={6000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
