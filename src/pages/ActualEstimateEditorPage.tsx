// Редактор ФАКТИЧЕСКОЙ калькуляции (для мастера/админа).
//
// Мастер собирает смету по РЕАЛЬНО выполненным работам и материалам (из прайса/наборов),
// видит отличие от предварительной (diff план/факт) и нужно ли повторное согласование клиентом,
// выбирает ФОП (тот же выбьет чек), сохраняет фактическую смету и получает ссылку для клиента
// (клиент по ней соглашается при необходимости и оплачивает — чек выбьется автоматически).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, Snackbar, CircularProgress, Divider,
  TextField, Chip, Stack,
} from '@mui/material'
import {
  Home as HomeIcon, Save as SaveIcon, ArrowBack as BackIcon,
  ContentCopy as CopyIcon, Payment as PaymentIcon, Receipt as ReceiptIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { usePricingStore } from '@/store/pricingStore'
import { isAdminEmail } from '@/config/access'
import { pricingService } from '@/api/pricingService'
import { serviceRequestService } from '@/api/serviceRequestService'
import { serviceCenterService } from '@/api/serviceCenterService'
import { userProfileService } from '@/api/userProfileService'
import { notificationApi } from '@/api/endpoints/notification'
import { paymentsApi, FopPublic } from '@/api/endpoints/payments'
import SpecialistPayoutsEditor from '@/components/SpecialistPayoutsEditor'
import PayOptionsEditor from '@/components/PayOptionsEditor'
import ViewAsButton from '@/components/ViewAsButton'
import SectionsWorksEditor from '@/components/SectionsWorksEditor'
import EstimateSectionsView from '@/components/EstimateSectionsView'
import { PAY_METHOD_KEYS, PAY_METHOD_LABELS } from '@/types/pricing'
import {
  buildMultiEstimate, estimate2goods, compareEstimates, needsReapproval, tName, formatMoney,
} from '@/utils/pricing'
import { estimateToSections, toComplaintSections, type EditableSection } from '@/utils/estimateSections'
import { buildPriceContext } from '@/utils/aiContext'
import type { Estimate, SpecialistPayout, EstimatePayOption } from '@/types/pricing'
import type { ServiceRequest } from '@/types/serviceRequest'
import { cardVisibility, type ServiceCenter, type ViewRole } from '@/types/access'

export default function ActualEstimateEditorPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { user } = useAuthStore()
  const { catalog, indexed, loadFromServer, isLoading } = usePricingStore()

  const parentId = params.get('parent') || ''
  const editId = params.get('edit') || '' // редактировать СУЩЕСТВУЮЩИЙ факт (а не создавать новый)
  const serviceRequestId = params.get('request') || '' // наша заявка на обслуживание

  const [prelim, setPrelim] = useState<Estimate | null>(null)
  const [editParentId, setEditParentId] = useState<string | null>(null) // id родителя в режиме ?edit=
  const [sections, setSections] = useState<EditableSection[]>([]) // разрезы по требованиям клиента
  const [title, setTitle] = useState('')

  const [fops, setFops] = useState<FopPublic[]>([])

  // Заявка (для специалистов/центра) + справочник специалистов + распределение выплат.
  const [request, setRequest] = useState<ServiceRequest | null>(null)
  const [center, setCenter] = useState<ServiceCenter | null>(null) // центр заявки (дефолтные ФОП по способам)
  const [staff, setStaff] = useState<{ uid: string; name: string }[]>([])
  const [payouts, setPayouts] = useState<SpecialistPayout[]>([])
  const [payOptions, setPayOptions] = useState<EstimatePayOption[]>([]) // способы оплаты + ФОП по каждому

  const [viewAs, setViewAs] = useState<ViewRole>('owner') // превью «Показати як…»
  const [savedId, setSavedId] = useState('')
  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' | 'info' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' | 'info' = 'success') => setSnack({ open: true, msg, sev })

  useEffect(() => { loadFromServer() }, [loadFromServer])

  // Список ФОП (кто может принять оплату и выдать чек)
  useEffect(() => {
    paymentsApi.listFops().then(setFops).catch(() => setFops([]))
  }, [])

  // Загрузка предварительной сметы (если задан parent) — как основа факта + для diff
  useEffect(() => {
    if (!parentId) return
    pricingService.loadEstimate(parentId).then((est) => {
      if (!est) { notify('Попередній кошторис не знайдено', 'error'); return }
      setPrelim(est)
      setTitle(est.title || '')
      // Разрезы по требованиям наследуем из предварительной (её секции). Не затираем правки мастера
      // при повторном срабатывании (напр. когда догрузился каталог) — сеем только если ещё пусто.
      setSections((prev) => prev.length ? prev : estimateToSections(est, indexed))
    })
  }, [parentId, indexed])

  // Режим РЕДАКТИРОВАНИЯ существующего факта (?edit=<id>): грузим сам факт (savedId=id →
  // пересохранение обновит его, а не создаст дубль), сеем работы, ФОП; для diff — его родителя.
  useEffect(() => {
    if (!editId) return
    pricingService.loadEstimate(editId).then((act) => {
      if (!act) { notify('Кошторис не знайдено', 'error'); return }
      setSavedId(editId)
      setTitle(act.title || '')
      setPayouts(act.specialistPayouts || [])
      setPayOptions(act.payOptions || []) // старые сметы без payOptions — мастер выберет способы заново
      setSections((prev) => prev.length ? prev : estimateToSections(act, indexed)) // разрезы по требованиям
      if (act.parentEstimateId) {
        setEditParentId(act.parentEstimateId) // помним связь, даже если родитель ещё грузится
        pricingService.loadEstimate(act.parentEstimateId).then((p) => p && setPrelim(p))
      }
    })
  }, [editId, indexed])

  // Заявка (для специалистов/центра). При СОЗДАНИИ факта (без ?edit=) авто-подставляем специалистов
  // заявки в распределение (суммы 0 — мастер заполнит). При редактировании existing факта не трогаем.
  const effRequestId = serviceRequestId || prelim?.serviceRequestId || ''
  useEffect(() => {
    if (!effRequestId) return
    serviceRequestService.get(effRequestId).then((r) => {
      if (!r) return
      setRequest(r)
      if (!editId) {
        setPayouts((prev) => prev.length ? prev : (r.specialists || []).map((s) => ({ uid: s.uid, name: s.name, specialistAmount: 0, centerAdminAmount: 0 })))
      }
    }).catch(() => {})
  }, [effRequestId, editId])

  // Справочник специалистов центра (для добавления в распределение). Фильтр по центру заявки, если задан.
  useEffect(() => {
    userProfileService.listSpecialists(request?.serviceCenterId || null).then(setStaff).catch(() => setStaff([]))
  }, [request?.serviceCenterId])

  // Центр заявки — для дефолтных ФОП по способам оплаты.
  useEffect(() => {
    const cid = request?.serviceCenterId
    if (!cid) { setCenter(null); return }
    serviceCenterService.get(cid).then(setCenter).catch(() => setCenter(null))
  }, [request?.serviceCenterId])

  // Префилл способов оплаты из дефолтов центра (только при СОЗДАНИИ, если ещё не заданы).
  useEffect(() => {
    if (editId) return
    const def = center?.defaultFopByMethod
    if (!def) return
    setPayOptions((prev) => prev.length ? prev : PAY_METHOD_KEYS.filter((m) => def[m]).map((m) => ({ method: m, fopId: def[m]! })))
  }, [center, editId])

  // Живой расчёт фактической сметы из разрезов-требований (мульти-жалобы + авто общие работы).
  const actual: Estimate | null = useMemo(() => {
    const cs = toComplaintSections(sections, indexed)
    if (!cs.length) return null
    return buildMultiEstimate({
      sections: cs,
      catalog: indexed,
      settings: catalog.settings,
      meta: {
        requestId: prelim?.requestId ?? null, // 1С-ссылка (унаследованная от предложения), если есть
        title: title || (prelim?.title ?? ''),
        source: 'manual',
        createdBy: user?.email ?? null,
      },
    })
  }, [sections, indexed, catalog.settings, title, prelim, user])

  const comparison = useMemo(() => (prelim && actual ? compareEstimates(prelim, actual) : null), [prelim, actual])
  const reapproval = useMemo(() => (prelim && actual ? needsReapproval(prelim, actual) : null), [prelim, actual])
  const goods = useMemo(() => (actual ? estimate2goods(actual, 'uk') : []), [actual])

  const priceCtx = useMemo(() => buildPriceContext(catalog), [catalog])

  const clientLink = savedId ? `${window.location.origin}/estimate/${savedId}` : ''

  const canSave = !!actual && !!user && isAdminEmail(user.email) && payOptions.length > 0 && payOptions.every((o) => o.fopId)

  const handleSave = async (): Promise<string | null> => {
    if (!actual) return null
    if (!payOptions.length) { notify('Оберіть хоча б один спосіб оплати', 'error'); return null }
    if (payOptions.some((o) => !o.fopId)) { notify('У кожного способу оплати має бути ФОП', 'error'); return null }
    setSaving(true)
    try {
      // Защита от затирания оплаченной сметы: если её уже оплатили, редактировать нельзя
      // (иначе можно сбросить status=paid/paymentId и открыть двойное списание).
      if (savedId) {
        const fresh = await pricingService.loadEstimate(savedId)
        if (fresh && (fresh.status === 'paid' || fresh.paymentId)) {
          notify('Кошторис уже оплачено — редагування заблоковано', 'error')
          return null
        }
        // Клиент прямо сейчас на оплате (claim на ~3 хв): правка суммы разошлась бы с чеком → недоплата.
        if (fresh && fresh.payInitiatedAt && Date.now() - Date.parse(fresh.payInitiatedAt) < 3 * 60 * 1000) {
          notify('Клієнт зараз оплачує цей кошторис — зачекайте кілька хвилин перед редагуванням', 'error')
          return null
        }
      }
      // Если у факта ЕСТЬ родитель (из ?parent= или из загруженного факта), но предварительная
      // ещё не догрузилась — не сохраняем: иначе потеряем связь план/факт и проверку reapproval.
      const knownParentId = parentId || editParentId || null
      if (knownParentId && !prelim) {
        notify('Зачекайте: завантажується попередній кошторис для звірки план/факт', 'error')
        return null
      }
      const required = reapproval?.required ?? false
      const srId = serviceRequestId || prelim?.serviceRequestId || null
      // Первичный ФОП (для чека по умолчанию/writeback) — ФОП первого способа. При оплате сервер
      // выберет ФОП по конкретному способу из payOptions.
      const primaryFopId = payOptions[0].fopId
      const toSave: Estimate = {
        ...actual,
        id: savedId || '', // повторное сохранение перезапишет ту же смету
        kind: 'actual',
        status: required ? 'pending_approval' : 'approved',
        parentEstimateId: prelim?.id ?? knownParentId,
        serviceRequestId: srId,
        receiptGoods: estimate2goods(actual, 'uk'),
        specialistPayouts: payouts,
        payOptions,
        fopId: primaryFopId,
      }
      const res = await pricingService.saveEstimate(toSave)
      if (!res) { notify('Не вдалося зберегти кошторис', 'error'); return null }
      setSavedId(res.id)
      // Привязываем факт к заявке и двигаем её в «в роботі».
      if (srId) {
        await serviceRequestService.save({ id: srId, actualEstimateId: res.id, status: 'in_work' }).catch(() => {})
        // Авто-оповещение клиента: фактична калькуляція готова (канал выбирает сервер; идемпотентно).
        notificationApi.notify({ serviceRequestId: srId, event: 'actual' }).catch(() => {})
      }
      // Факт собран по выбранному варианту → «замораживаем» предложение: клиент больше не может
      // переизбрать путь (иначе оффер и факт/чек разойдутся).
      if (prelim?.offerId) {
        await pricingService.saveOffer({ id: prelim.offerId, status: 'locked' }).catch(() => {})
      }
      notify(required ? 'Збережено. Потрібне погодження клієнта (перевищено поріг)' : 'Фактичний кошторис збережено та погоджено', required ? 'info' : 'success')
      return res.id
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Помилка збереження', 'error')
      return null
    } finally {
      setSaving(false)
    }
  }

  const copyLink = async () => {
    const id = savedId || (await handleSave())
    if (!id) return
    const link = `${window.location.origin}/estimate/${id}`
    try {
      await navigator.clipboard.writeText(link)
      notify('Посилання для клієнта скопійовано', 'success')
    } catch {
      notify(link, 'info')
    }
  }

  // Гейт админа
  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для адміністратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }
  if (isLoading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
  }

  // ФОПы выбранных способов, у которых не настроен Checkbox (оплата пройдёт, но чек не выбьется).
  const noReceiptFops = payOptions
    .map((o) => fops.find((f) => f.id === o.fopId))
    .filter((f): f is FopPublic => !!f && !f.receipts)

  const vis = cardVisibility(viewAs) // видимость секций для превью «Показати як…»

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Фактична калькуляція</Typography>
        <Stack direction="row" spacing={1}>
          <ViewAsButton value={viewAs} onChange={setViewAs} />
          {(serviceRequestId || prelim?.serviceRequestId) && (
            <Button startIcon={<BackIcon />} onClick={() => navigate(`/service-request/${serviceRequestId || prelim?.serviceRequestId}`)}>До заявки</Button>
          )}
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>
      {viewAs !== 'owner' && (
        <Alert severity="warning" sx={{ mb: 2 }}>Прев'ю очима ролі «{viewAs === 'client' ? 'Клієнт' : viewAs === 'director' ? 'Директор' : viewAs === 'accountant' ? 'Бухгалтер' : 'Спеціаліст'}»: частину полів приховано. Редагування працює у режимі власника.</Alert>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Зберіть кошторис за реально виконаними роботами та матеріалами. З нього виб'ється фіскальний
        чек тим ФОП, який прийме оплату. Клієнт отримає посилання для погодження та оплати.
      </Typography>

      {/* Название калькуляции */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <TextField label="Назва / кораблик" value={title} onChange={(e) => setTitle(e.target.value)} size="small" fullWidth />
      </Paper>

      {/* Разрезы по требованиям клиента */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 0.5 }}>Роботи за вимогами клієнта</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Кожна вимога — окремий розділ зі своїм напрямом (ремонт/апгрейд), роботами та набором. Загальні роботи додаються автоматично.
        </Typography>
        <SectionsWorksEditor sections={sections} onChange={setSections} catalog={indexed} priceContext={priceCtx} />
      </Paper>

      {/* Результат — фактическая смета разрезами по требованиям */}
      {actual && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Фактичний кошторис</Typography>
          <EstimateSectionsView lines={actual.lines} sections={actual.sections} total={actual.total} currency={actual.currency} />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
            <ReceiptIcon fontSize="inherit" sx={{ verticalAlign: 'middle', mr: 0.5 }} />
            У чеку буде {goods.length} позиц. (побудовано за вимогами фіскального чека).
          </Typography>
        </Paper>
      )}

      {/* Diff план/факт */}
      {comparison && reapproval && vis.planFactDiff && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>Порівняння з попереднім кошторисом</Typography>
          <Stack direction="row" spacing={2} sx={{ mb: 1, flexWrap: 'wrap' }}>
            <Chip label={`Попередньо: ${formatMoney(comparison.prelimTotal)}`} />
            <Chip label={`Фактично: ${formatMoney(comparison.actualTotal)}`} color="primary" />
            <Chip
              label={`${comparison.diffTotal >= 0 ? '+' : ''}${formatMoney(comparison.diffTotal)} (${comparison.diffPercent >= 0 ? '+' : ''}${comparison.diffPercent}%)`}
              color={comparison.diffTotal > 0 ? 'warning' : 'success'}
            />
          </Stack>
          {reapproval.required ? (
            <Alert severity="warning">Зростання перевищує поріг {reapproval.thresholdPct}% — потрібне погодження клієнта перед оплатою.</Alert>
          ) : (
            <Alert severity="success">
              {reapproval.reason === 'decrease' ? 'Сума не зросла — погодження не потрібне.'
                : reapproval.reason === 'within-tolerance' ? `Відхилення в межах ${reapproval.thresholdPct}% — погодження не потрібне.`
                : `Зростання в межах заздалегідь погодженого (${reapproval.thresholdPct}%).`}
            </Alert>
          )}
          {(comparison.added.length > 0 || comparison.removed.length > 0 || comparison.changed.length > 0) && (
            <Box sx={{ mt: 1.5 }}>
              {comparison.added.map((d, i) => <Typography key={`a${i}`} variant="body2" color="warning.main">+ {tName(d.name, 'uk')} ({formatMoney(d.delta)})</Typography>)}
              {comparison.changed.map((d, i) => <Typography key={`c${i}`} variant="body2">± {tName(d.name, 'uk')} ({d.delta >= 0 ? '+' : ''}{formatMoney(d.delta)})</Typography>)}
              {comparison.removed.map((d, i) => <Typography key={`r${i}`} variant="body2" color="text.secondary">− {tName(d.name, 'uk')} ({formatMoney(d.delta)})</Typography>)}
            </Box>
          )}
        </Paper>
      )}

      {/* Распределение по специалистам (внутренняя экономика; видно владельцу/директору) */}
      {actual && vis.economics && (
        <SpecialistPayoutsEditor value={payouts} onChange={setPayouts} staff={staff} total={actual.total} />
      )}
      {actual && !vis.economics && vis.ownPayoutOnly && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>Розподіл між спеціалістами</Typography>
          <Alert severity="info">Спеціаліст бачить лише власну винагороду; суми інших спеціалістів та наценку центру приховано.</Alert>
        </Paper>
      )}

      {/* Способы оплаты + ФОП по каждому (дефолт из центра) */}
      {actual && vis.payFop && <PayOptionsEditor value={payOptions} onChange={setPayOptions} fops={fops} />}
      {actual && !vis.payFop && vis.payMethods && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>Способи оплати</Typography>
          {payOptions.length === 0
            ? <Typography variant="body2" color="text.secondary">Не задано.</Typography>
            : <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>{payOptions.map((o) => <Chip key={o.method} label={PAY_METHOD_LABELS[o.method]} />)}</Stack>}
          <Alert severity="info" sx={{ mt: 1 }}>Прив'язку ФОП до способів видно бухгалтеру/директору/власнику.</Alert>
        </Paper>
      )}

      {/* Сохранение + ссылка клиенту */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Збереження та посилання для клієнта</Typography>
        {noReceiptFops.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>Для деяких способів обрано ФОП без Checkbox — оплата пройде, але фіскальний чек не виб'ється.</Alert>
        )}

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Button variant="contained" startIcon={<SaveIcon />} onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Збереження…' : savedId ? 'Оновити кошторис' : 'Зберегти фактичний кошторис'}
          </Button>
          <Button variant="outlined" startIcon={<CopyIcon />} onClick={copyLink} disabled={!canSave || saving}>
            Посилання для клієнта
          </Button>
          {savedId && (
            <Button variant="outlined" startIcon={<PaymentIcon />} onClick={() => window.open(clientLink, '_blank')}>
              Відкрити сторінку клієнта
            </Button>
          )}
        </Stack>
        {clientLink && (
          <Alert severity="success" sx={{ mt: 2 }} icon={<PaymentIcon />}>
            Посилання для клієнта: <a href={clientLink} target="_blank" rel="noreferrer">{clientLink}</a>
          </Alert>
        )}
      </Paper>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        Порядок: зберіть факт → оберіть ФОП → збережіть → надішліть клієнту посилання. Якщо сума
        зросла понад поріг — клієнт спочатку погоджує, потім оплачує. Чек виб'ється автоматично.
      </Typography>

      <Snackbar open={snack.open} autoHideDuration={6000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
