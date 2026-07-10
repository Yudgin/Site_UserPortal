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
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, IconButton, TextField,
  Autocomplete, Chip, Stack, ToggleButton, ToggleButtonGroup, List, ListItem, ListItemText,
} from '@mui/material'
import {
  Delete as DeleteIcon, Home as HomeIcon, ContentCopy as CopyIcon, AddCircle as AddVariantIcon,
  Build as ActualIcon, CheckCircle as CheckIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { usePricingStore } from '@/store/pricingStore'
import { isAdminEmail } from '@/config/access'
import { pricingService } from '@/api/pricingService'
import { serviceRequestService } from '@/api/serviceRequestService'
import { notificationApi } from '@/api/endpoints/notification'
import { secureId } from '@/utils/id'
import { buildEstimate, tName, formatMoney, type EstimateWorkInput } from '@/utils/pricing'
import { buildPriceContext } from '@/utils/aiContext'
import AiWorkPicker from '@/components/AiWorkPicker'
import type { Estimate, EstimateOffer, ServiceKind } from '@/types/pricing'

interface WorkRow extends EstimateWorkInput { key: string }
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
  const [title, setTitle] = useState('')
  const [diagSeed, setDiagSeed] = useState('') // диагностика заявки → засев ИИ-подбора
  const [serviceKind, setServiceKind] = useState<ServiceKind>('repair')
  const [variants, setVariants] = useState<VariantEntry[]>([])
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null)
  const [offerStatus, setOfferStatus] = useState<'pending_choice' | 'chosen' | 'locked' | null>(null)

  // текущий собираемый вариант
  const [label, setLabel] = useState('')
  const [rows, setRows] = useState<WorkRow[]>([])

  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' | 'info' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' | 'info' = 'success') => setSnack({ open: true, msg, sev })

  useEffect(() => { loadFromServer() }, [loadFromServer])

  // Засев работ из существующей сметы (оценка ИИ / вариант) — по labor-строкам
  useEffect(() => {
    if (!parentId) return
    pricingService.loadEstimate(parentId).then((est) => {
      if (!est) return
      setRows(est.lines.filter((l) => l.type === 'labor').map((l, i) => ({ key: `p${i}`, workId: l.refId, qty: l.qty })))
      setLabel((v) => v || 'Варіант 1')
    })
  }, [parentId])

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

  const activeWorks = useMemo(() => Object.values(indexed.works).filter((w) => w.active), [indexed])
  const activeKits = useMemo(() => Object.values(indexed.kits).filter((k) => k.active), [indexed])
  const priceCtx = useMemo(() => buildPriceContext(catalog), [catalog])
  const addWorks = (works: EstimateWorkInput[]) =>
    setRows((r) => [...r, ...works.map((w, i) => ({ key: `ai${Date.now()}${i}`, workId: w.workId, qty: w.qty }))])

  const currentEstimate: Estimate | null = useMemo(() => {
    const works = rows.filter((r) => r.workId && indexed.works[r.workId]).map((r) => ({ workId: r.workId, qty: r.qty }))
    if (!works.length) return null
    return buildEstimate({
      works, catalog: indexed, settings: catalog.settings, serviceKind,
      meta: { title, source: 'manual', createdBy: user?.email ?? null },
    })
  }, [rows, indexed, catalog.settings, serviceKind, title, user])

  const addRow = (workId: string) => setRows((r) => [...r, { key: `w${Date.now()}${r.length}`, workId, qty: 1 }])
  const addKit = (kitId: string) => {
    const kit = indexed.kits[kitId]
    if (!kit) return
    setRows((r) => [...r, ...kit.items.filter((it) => indexed.works[it.workId]?.active).map((it, i) => ({ key: `k${Date.now()}${i}`, workId: it.workId, qty: it.qty }))])
  }
  const setQty = (key: string, qty: number) => setRows((r) => r.map((x) => (x.key === key ? { ...x, qty: Math.max(0.1, qty) } : x)))
  const removeRow = (key: string) => setRows((r) => r.filter((x) => x.key !== key))

  const clientLink = offerId ? `${window.location.origin}/offer/${offerId}` : ''

  // Сохранить текущий вариант и добавить в предложение
  const addVariant = async () => {
    if (!currentEstimate) { notify('Додайте роботи до варіанта', 'error'); return }
    if (!label.trim()) { notify('Вкажіть назву варіанта', 'error'); return }
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
        serviceRequestId: serviceRequestId || null,
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
            serviceRequestId: serviceRequestId || null,
            title: title || currentEstimate.title || 'Пропозиція',
            variantIds: nextVariants.map((v) => v.id),
            selectedVariantId: null,
            status: 'pending_choice',
            createdAt: new Date().toISOString(),
            createdBy: user?.email ?? null,
          }
      await pricingService.saveOffer(offerPatch)
      // При создании предложения привязываем его к заявке и двигаем её статус.
      if (isFirst && serviceRequestId) {
        await serviceRequestService.save({ id: serviceRequestId, offerId: oid, status: 'offered' }).catch(() => {})
        // Авто-оповещение клиента: попередня калькуляція готова (канал выбирает сервер; идемпотентно).
        notificationApi.notify({ serviceRequestId, event: 'offer' }).catch(() => {})
      }
      setOfferId(oid)
      setOfferStatus((s) => s || 'pending_choice')
      // очистить конструктор под следующий вариант
      setRows([])
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
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Зберіть один або кілька варіантів ремонту. Клієнт побачить усі та обере один шлях. За обраним
        варіантом далі складається фактична калькуляція, за якою відбувається оплата.
      </Typography>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <TextField label="Назва пропозиції / кораблик" value={title} onChange={(e) => setTitle(e.target.value)} size="small" fullWidth />
          <ToggleButtonGroup size="small" exclusive value={serviceKind} onChange={(_e, v) => v && setServiceKind(v)}>
            <ToggleButton value="repair">Ремонт</ToggleButton>
            <ToggleButton value="upgrade">Апгрейд</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
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
              <Button color="inherit" size="small" startIcon={<ActualIcon />} onClick={() => navigate(`/actual-estimate?parent=${selectedVariantId}`)}>
                Скласти факт
              </Button>
            }>
              Клієнт обрав: <b>{chosenVariant.label}</b>. Можна складати фактичний кошторис за цим шляхом.
            </Alert>
          )}
        </Paper>
      )}

      {/* Конструктор текущего варианта */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1.5 }}>{variants.length ? 'Наступний варіант' : 'Варіант'}</Typography>
        <TextField label="Назва варіанта" value={label} onChange={(e) => setLabel(e.target.value)} size="small" sx={{ mb: 2, maxWidth: 360 }} fullWidth
          placeholder="напр. Повний ремонт" />
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <Autocomplete sx={{ flex: 2 }} size="small" options={activeWorks} getOptionLabel={(w) => `${w.code} · ${tName(w.name, 'uk')}`}
            onChange={(_e, w) => w && addRow(w.id)} renderInput={(p) => <TextField {...p} label="Додати роботу" />} value={null} blurOnSelect clearOnBlur />
          <Autocomplete sx={{ flex: 2 }} size="small" options={activeKits} getOptionLabel={(k) => `${k.code} · ${tName(k.name, 'uk')}`}
            onChange={(_e, k) => k && addKit(k.id)} renderInput={(p) => <TextField {...p} label="Додати набір" />} value={null} blurOnSelect clearOnBlur />
          <AiWorkPicker priceContext={priceCtx} catalog={indexed} onAdd={addWorks} initialDescription={diagSeed} />
        </Stack>

        {rows.length === 0 ? (
          <Alert severity="info">Додайте роботи або набір до варіанта.</Alert>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'action.hover' }}>
                  <TableCell>Позиція</TableCell>
                  <TableCell align="right">К-сть / Сума</TableCell>
                  <TableCell width={48} />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => {
                  const w = indexed.works[r.workId]
                  return (
                    <TableRow key={r.key}>
                      <TableCell>{w ? `${w.code} · ${tName(w.name, 'uk')}` : r.workId}</TableCell>
                      <TableCell align="right">
                        <TextField type="number" size="small" value={r.qty} onChange={(e) => setQty(r.key, Number(e.target.value))} inputProps={{ min: 0.1, step: 0.5 }} sx={{ width: 80 }} />
                      </TableCell>
                      <TableCell><IconButton size="small" onClick={() => removeRow(r.key)}><DeleteIcon fontSize="small" /></IconButton></TableCell>
                    </TableRow>
                  )
                })}
                {currentEstimate && (
                  <TableRow>
                    <TableCell><b>Разом варіант</b></TableCell>
                    <TableCell align="right"><b>{formatMoney(currentEstimate.total)}</b></TableCell>
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
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
