// Редактор ФАКТИЧЕСКОЙ калькуляции (для мастера/админа).
//
// Мастер собирает смету по РЕАЛЬНО выполненным работам и материалам (из прайса/наборов),
// видит отличие от предварительной (diff план/факт) и нужно ли повторное согласование клиентом,
// выбирает ФОП (тот же выбьет чек), сохраняет фактическую смету и получает ссылку для клиента
// (клиент по ней соглашается при необходимости и оплачивает — чек выбьется автоматически).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, Snackbar, CircularProgress, Divider,
  TextField, Chip, Stack, Checkbox, FormControlLabel, MenuItem,
} from '@mui/material'
import {
  Home as HomeIcon, Save as SaveIcon, ArrowBack as BackIcon,
  ContentCopy as CopyIcon, Payment as PaymentIcon, Receipt as ReceiptIcon,
  Delete as DeleteIcon, Add as AddIcon,
} from '@mui/icons-material'
import { IconButton } from '@mui/material'
import { useAuthStore } from '@/store/authStore'
import { usePricingStore } from '@/store/pricingStore'
import { useAccess } from '@/store/accessStore'
import { useStaffGate, centerVisible } from '@/hooks/useStaffGate'
import { pricingService } from '@/api/pricingService'
import { serviceRequestService } from '@/api/serviceRequestService'
import { serviceCenterService } from '@/api/serviceCenterService'
import { userProfileService } from '@/api/userProfileService'
import { notificationApi } from '@/api/endpoints/notification'
import { notificationService } from '@/api/notificationService'
import type { ClientNotification } from '@/types/notification'
import { paymentsApi, FopPublic } from '@/api/endpoints/payments'
import SpecialistPayoutsEditor from '@/components/SpecialistPayoutsEditor'
import PayOptionsEditor from '@/components/PayOptionsEditor'
import ViewAsButton from '@/components/ViewAsButton'
import SectionsWorksEditor from '@/components/SectionsWorksEditor'
import EstimateSectionsView from '@/components/EstimateSectionsView'
import { PAY_METHOD_KEYS, PAY_METHOD_LABELS } from '@/types/pricing'
import {
  buildMultiEstimate, estimate2goods, compareEstimates, needsReapproval, tName, formatMoney,
  applyEstimateDiscount, appendExtraLines, extraExpenseLine,
} from '@/utils/pricing'
import { estimateToSections, toComplaintSections, type EditableSection } from '@/utils/estimateSections'
import { buildPriceContext } from '@/utils/aiContext'
import { secureId } from '@/utils/id'
import {
  grossExtraLine, unseenLines, requestSeedLines, incomingExtras, vanishedExtras, syncRequestExtras, parentExtraLines,
} from '@/utils/extraExpenseSync'
import type { Estimate, EstimateLine, SpecialistPayout, EstimatePayOption } from '@/types/pricing'
import type { ServiceRequest } from '@/types/serviceRequest'
import { cardVisibility, type ServiceCenter, type ViewRole } from '@/types/access'

export default function ActualEstimateEditorPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { user } = useAuthStore()
  const access = useAccess()
  const gate = useStaffGate((a) => a.can('actual'), 'Потрібне право «фактична калькуляція».')
  const { catalog, indexed, loadFromServer, isLoading } = usePricingStore()

  const parentId = params.get('parent') || ''
  const editId = params.get('edit') || '' // редактировать СУЩЕСТВУЮЩИЙ факт (а не создавать новый)
  const serviceRequestId = params.get('request') || '' // наша заявка на обслуживание
  const [editSrId, setEditSrId] = useState('') // заявка, взята из редактируемой сметы
  const [estNotifs, setEstNotifs] = useState<ClientNotification[]>([]) // журнал оповещений заявки
  const [notifBusy, setNotifBusy] = useState(false)

  const [prelim, setPrelim] = useState<Estimate | null>(null)
  const [editParentId, setEditParentId] = useState<string | null>(null) // id родителя в режиме ?edit=
  const [sections, setSections] = useState<EditableSection[]>([]) // разрезы по требованиям клиента
  // Керовані загальні роботи та знижка фактичного кошторису (рішення власника: майстер може
  // прибрати загальні позиції і дати знижку — вона вшивається в рядки, чек/оплата сходяться).
  const [excludedCommon, setExcludedCommon] = useState<string[]>([])
  const [discountValue, setDiscountValue] = useState<number | ''>('')
  const [discountKind, setDiscountKind] = useState<'pct' | 'uah'>('uah')
  const [title, setTitle] = useState('')
  // Додаткові витрати поза прайсом (доставка, запчастина…): рядки extra=true. Їх вносить
  // Telegram-бот співробітників (на заявку або одразу в цей факт) або майстер тут. Під час
  // пересборки з каталогу вони НЕ губляться — дописуються до зібраного кошторису до знижки.
  const [extraLines, setExtraLines] = useState<EstimateLine[]>([])
  // Доп. витрати, відомі редактору (з факту/журналу заявки при завантаженні або після збереження). Що
  // з'явилося в базі поза цим набором — додано паралельно (бот, застосунок) і не має бути затерте.
  const knownExtraRefs = useRef<Set<string>>(new Set())
  // Стан факту/заявки засіваємо ОДИН раз на id: ефект ?edit= перезапускається при оновленні каталогу
  // (ІІ-підбір викликає refreshSilent) і інакше молча відкочував би правки майстра до даних із бази.
  const seededEditId = useRef('')
  const seededRequestId = useRef('')
  const seededParentId = useRef('')
  // Рядки, перенесені з варіанта-батька: до першого збереження факту їх немає ні в журналі, ні у факті,
  // тому звірка «зникло деінде» їх не стосується.
  const parentExtraRefs = useRef<Set<string>>(new Set())
  // Додати рядки, яких редактор ще не бачив. Відомий, але відсутній у редакторі рядок прибрав майстер —
  // його не повертаємо (інакше пізніше завантаження заявки «воскресило» б видалене).
  const seedExtras = (lines: EstimateLine[]) => {
    const fresh = unseenLines(lines, knownExtraRefs.current)
    if (!fresh.length) return
    fresh.forEach((l) => knownExtraRefs.current.add(l.refId))
    setExtraLines((prev) => [...prev, ...fresh.filter((l) => !prev.some((x) => x.refId === l.refId))])
  }
  const [extraTitle, setExtraTitle] = useState('')
  const [extraAmount, setExtraAmount] = useState<number | ''>('')

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
      // Назву і рядки поза прайсом (калькуляції майстрів у варіанті) беремо з варіанта один раз на parent:
      // повторний запуск (оновлення каталогу) не затирає введене і не повертає прибране майстром.
      if (seededParentId.current !== parentId) {
        seededParentId.current = parentId
        setTitle(est.title || '')
        const fromParent = parentExtraLines(est)
        fromParent.forEach((l) => parentExtraRefs.current.add(l.refId))
        setExtraLines((prev) => [...prev, ...fromParent.filter((l) => !prev.some((x) => x.refId === l.refId))])
      }
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
      // Повторний запуск (догрузився/оновився каталог) — лише розрізи, якщо їх ще немає; решту не чіпаємо.
      if (seededEditId.current === editId) { setSections((prev) => prev.length ? prev : estimateToSections(act, indexed)); return }
      seededEditId.current = editId
      setSavedId(editId)
      setTitle(act.title || '')
      setPayouts(act.specialistPayouts || [])
      setPayOptions(act.payOptions || []) // старые сметы без payOptions — мастер выберет способы заново
      setEditSrId(act.serviceRequestId || '')
      setExcludedCommon(act.excludedCommonCodes || [])
      // Рядки поза прайсом зберігаємо як є (без знижки: grossLineTotal — повна сума, якщо знижка була).
      seedExtras((act.lines || []).filter((l) => l.extra).map(grossExtraLine))
      if (act.discount) { setDiscountValue(act.discount.value); setDiscountKind(act.discount.kind) }
      setSections((prev) => prev.length ? prev : estimateToSections(act, indexed)) // разрезы по требованиям
      if (act.parentEstimateId) {
        setEditParentId(act.parentEstimateId) // помним связь, даже если родитель ещё грузится
        pricingService.loadEstimate(act.parentEstimateId).then((p) => p && setPrelim(p))
      }
    })
  }, [editId, indexed])

  // Заявка (для специалистов/центра). При СОЗДАНИИ факта (без ?edit=) авто-подставляем специалистов
  // заявки в распределение (суммы 0 — мастер заполнит). При редактировании existing факта не трогаем.
  const effRequestId = serviceRequestId || prelim?.serviceRequestId || editSrId || ''
  useEffect(() => {
    if (!effRequestId) return
    serviceRequestService.get(effRequestId).then((r) => {
      if (!r) return
      setRequest(r)
      if (seededRequestId.current === effRequestId) return
      seededRequestId.current = effRequestId
      if (!editId) {
        setPayouts((prev) => prev.length ? prev : (r.specialists || []).map((s) => ({ uid: s.uid, name: s.name, specialistAmount: 0, centerAdminAmount: 0 })))
      }
      // Витрати заявки, що мають бути в цьому кошторисі: ще не застосовані (бот/застосунок записав до факту)
      // і застосовані до ЦЬОГО факту (редагування) або до поточного факту заявки (створення нового факту —
      // вони переходять у новий). Позначаємо відомими лише ПОКАЗАНІ: решту звірка при збереженні побачить.
      seedExtras(requestSeedLines(r, editId))
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
  // Факт БЕЗ позицій прайсу (лише рядки поза прайсом — з калькуляцій майстрів, бота чи застосунку) теж
  // дозволений: тоді загальні роботи не додаються автоматично (вони супроводжують позиції прайсу).
  const actual: Estimate | null = useMemo(() => {
    const cs = toComplaintSections(sections, indexed)
    if (!cs.length && !extraLines.length) return null
    const built = buildMultiEstimate({
      sections: cs,
      catalog: indexed,
      settings: catalog.settings,
      excludeCommonCodes: cs.length ? excludedCommon : (catalog.settings.commonWorkCodes ?? []),
      meta: {
        requestId: prelim?.requestId ?? null, // 1С-ссылка (унаследованная от предложения), если есть
        title: title || (prelim?.title ?? ''),
        source: 'manual',
        createdBy: user?.email ?? null,
      },
    })
    const withDiscount = applyEstimateDiscount(appendExtraLines(built, extraLines),
      discountValue && Number(discountValue) > 0 ? { value: Number(discountValue), kind: discountKind } : null)
    return { ...withDiscount, excludedCommonCodes: excludedCommon }
  }, [sections, indexed, catalog.settings, title, prelim, user, excludedCommon, discountValue, discountKind, extraLines])

  const addExtraLine = () => {
    const t = extraTitle.trim()
    const a = Number(extraAmount)
    if (!t || !(a > 0)) return
    setExtraLines((prev) => [...prev, extraExpenseLine({ id: secureId(8), title: t, amount: a })])
    setExtraTitle(''); setExtraAmount('')
  }
  const removeExtraLine = (refId: string) => setExtraLines((prev) => prev.filter((l) => l.refId !== refId))


  const comparison = useMemo(() => (prelim && actual ? compareEstimates(prelim, actual) : null), [prelim, actual])
  const reapproval = useMemo(() => (prelim && actual ? needsReapproval(prelim, actual) : null), [prelim, actual])
  const goods = useMemo(() => (actual ? estimate2goods(actual, 'uk') : []), [actual])

  // Журнал оповещений заявки — статус «чи надіслали SMS про фактичну калькуляцію».
  useEffect(() => {
    if (!effRequestId) { setEstNotifs([]); return }
    notificationService.listByRequest(effRequestId).then(setEstNotifs).catch(() => setEstNotifs([]))
  }, [effRequestId, savedId])

  const priceCtx = useMemo(() => buildPriceContext(catalog), [catalog])

  const clientLink = savedId ? `${window.location.origin}/estimate/${savedId}` : ''

  // Право «факт» именно по центру заявки; пока заявка (если она есть) не загружена — не сохраняем,
  // чтобы не проскочить окно «центр ещё неизвестен».
  const canActualHere = access.can('actual', request?.serviceCenterId || undefined) && (!effRequestId || !!request)
  const canSave = !!actual && canActualHere && payOptions.length > 0 && payOptions.every((o) => o.fopId)

  // Надіслати клієнту сповіщення про фактичну калькуляцію (канал: Telegram/SMS — обирає сервер).
  // Перший раз — авто-подія 'actual' (ідемпотентна); повторно — та сама фраза як custom.
  const lastActualNotif = useMemo(() => {
    const list = estNotifs.filter((n) => n.event === 'actual').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return list[0] || null
  }, [estNotifs])
  const sendActualNotif = async () => {
    if (!effRequestId) return
    setNotifBusy(true)
    try {
      const already = lastActualNotif?.status === 'sent'
      const res = already
        ? await notificationApi.notify({ serviceRequestId: effRequestId, event: 'custom',
            text: `Роботи по вашому корабликові виконано — готова фактична калькуляція. Деталі та оплата: ${clientLink}` })
        : await notificationApi.notify({ serviceRequestId: effRequestId, event: 'actual' })
      if (res?.status === 'sent') notify(`Надіслано (${res.via === 'sms' ? 'SMS' : res.channel || 'месенджер'})`)
      else notify(res?.error || 'Не вдалося надіслати', 'error')
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не вдалося надіслати', 'error')
    } finally {
      setNotifBusy(false)
      notificationService.listByRequest(effRequestId).then(setEstNotifs).catch(() => {})
    }
  }

  const handleSave = async (): Promise<string | null> => {
    if (!actual) return null
    if (!canActualHere) { notify('Немає права «фактична калькуляція» для центру цієї заявки', 'error'); return null }
    if (!payOptions.length) { notify('Оберіть хоча б один спосіб оплати', 'error'); return null }
    if (payOptions.some((o) => !o.fopId)) { notify('У кожного способу оплати має бути ФОП', 'error'); return null }
    setSaving(true)
    try {
      // Захист від затирання оплаченого кошторису та від правки під час оплати клієнтом перевіряється
      // В ТРАНЗАКЦІЇ збереження (check нижче) — разом зі звіркою витрат, на свіжих даних.
      // Если у факта ЕСТЬ родитель (из ?parent= или из загруженного факта), но предварительная
      // ещё не догрузилась — не сохраняем: иначе потеряем связь план/факт и проверку reapproval.
      const knownParentId = parentId || editParentId || null
      if (knownParentId && !prelim) {
        notify('Зачекайте: завантажується попередній кошторис для звірки план/факт', 'error')
        return null
      }
      const required = reapproval?.required ?? false
      // Заявка факту — з будь-якого джерела (?request=, попередній кошторис, сам факт у режимі ?edit=):
      // інакше факт, відкритий без ?request=, затирав би serviceRequestId і не синхронізував журнал витрат.
      const srId = effRequestId || null
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
      type SaveAbort =
        | { kind: 'paid' } | { kind: 'paying' } | { kind: 'noRequest' }
        | { kind: 'extras'; incoming: EstimateLine[]; vanished: EstimateLine[]; freshReq: ServiceRequest | null }
      const known = knownExtraRefs.current
      const parentExempt = parentExtraRefs.current
      const lines = extraLines
      // Звірка і запис — в одній транзакції: свіжі дані читаються в ній, тож витрата, яку бот/застосунок
      // додав або вилучив посеред збереження, не загубиться і не «воскресне» (SDK перезапустить check).
      const res = await pricingService.saveEstimateWithRequest<SaveAbort>({
        estimate: toSave,
        requestId: srId,
        check: ({ id, freshEst, freshReq }) => {
          if (savedId && freshEst && (freshEst.status === 'paid' || freshEst.paymentId)) return { abort: { kind: 'paid' } }
          if (freshEst?.payInitiatedAt && Date.now() - Date.parse(freshEst.payInitiatedAt) < 3 * 60 * 1000) return { abort: { kind: 'paying' } }
          if (srId && !freshReq) return { abort: { kind: 'noRequest' } }
          const recon = { known, editorLines: lines, freshEst: savedId ? freshEst : null, freshReq }
          const incoming = incomingExtras({ ...recon, estimateId: savedId })
          const vanished = vanishedExtras({ ...recon, exempt: parentExempt })
          if (incoming.length || vanished.length) return { abort: { kind: 'extras', incoming, vanished, freshReq } }
          if (!srId) return { requestPatch: null }
          const journal = freshReq?.extraExpenses
          const extraExpenses = (journal?.length || lines.length)
            ? syncRequestExtras({ existing: journal, editorLines: lines, estimateId: id, by: user?.email ?? null, shown: known })
            : undefined
          // Привязываем факт к заявке и двигаем её в «в роботі».
          return { requestPatch: { actualEstimateId: id, status: 'in_work', ...(extraExpenses ? { extraExpenses } : {}) } }
        },
      })
      if (!res.ok) {
        const a = res.abort
        if (!a) { notify(res.error || 'Не вдалося зберегти кошторис', 'error'); return null }
        if (a.kind === 'paid') { notify('Кошторис уже оплачено — редагування заблоковано', 'error'); return null }
        // Клиент прямо сейчас на оплате (claim на ~3 хв): правка суммы разошлась бы с чеком → недоплата.
        if (a.kind === 'paying') { notify('Клієнт зараз оплачує цей кошторис — зачекайте кілька хвилин перед редагуванням', 'error'); return null }
        if (a.kind === 'noRequest') { notify('Не вдалося завантажити заявку — спробуйте ще раз', 'error'); return null }
        const gone = new Set(a.vanished.map((l) => l.refId))
        a.incoming.forEach((l) => knownExtraRefs.current.add(l.refId))
        gone.forEach((ref) => knownExtraRefs.current.delete(ref))
        setExtraLines((prev) => [...prev.filter((l) => !gone.has(l.refId)), ...a.incoming.filter((l) => !prev.some((x) => x.refId === l.refId))])
        if (a.freshReq) setRequest(a.freshReq)
        const list = (ls: EstimateLine[]) => ls.map((l) => `${tName(l.name, 'uk')} — ${formatMoney(l.lineTotal)}`).join('; ')
        notify('Поки ви редагували, витрати змінили в іншому місці.'
          + (a.incoming.length ? ` Додано: ${list(a.incoming)}.` : '')
          + (a.vanished.length ? ` Вилучено: ${list(a.vanished)}.` : '')
          + ' Кошторис оновлено — перевірте суму і збережіть ще раз.', 'info')
        return null
      }
      setSavedId(res.id)
      // Відомі редактору тепер — рівно показані рядки (журнал після запису = показані + записи чужих фактів).
      knownExtraRefs.current = new Set(lines.map((l) => l.refId))
      parentExtraRefs.current = new Set() // після збереження рядки з варіанта вже в журналі
      if (srId && res.requestPatch) {
        const patch = res.requestPatch
        setRequest((r) => (r ? { ...r, ...patch } : r))
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

  // RBAC 1b: право «фактична калькуляція» (по центру заявки, если она известна)
  if (gate) return gate
  if (request && (!centerVisible(access, request.serviceCenterId) || !access.can('actual', request.serviceCenterId || undefined))) {
    return <Container maxWidth="sm" sx={{ py: 8 }}><Alert severity="error">Ця заявка належить іншому сервісному центру або у вас немає права «фактична калькуляція» для нього.</Alert></Container>
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

      {/* Загальні роботи (можна вимкнути зайві) + знижка на кошторис */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 0.5 }}>Загальні роботи та знижка</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Зніміть галочку, щоб прибрати загальну позицію з цього кошторису. Знижка вшивається
          в рядки пропорційно — оплата і фіскальний чек збігаються копійка в копійку.
          {!toComplaintSections(sections, indexed).length && ' Без позицій прайсу загальні роботи не додаються.'}
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          {(catalog.settings.commonWorkCodes ?? []).map((code) => {
            const w = Object.values(indexed.works).find((x) => x.code === code)
            if (!w || !w.active) return null
            const off = excludedCommon.includes(code)
            return (
              <FormControlLabel key={code} sx={{ mr: 2 }}
                control={<Checkbox size="small" checked={!off}
                  onChange={() => setExcludedCommon((prev) => off ? prev.filter((c) => c !== code) : [...prev, code])} />}
                label={`${tName(w.name, 'uk')} — ${formatMoney(w.laborHours * (catalog.settings.laborRatePerHour || 0))}`} />
            )
          })}
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField label="Знижка" type="number" size="small" sx={{ width: 130 }}
            value={discountValue} onChange={(e) => setDiscountValue(e.target.value === '' ? '' : Number(e.target.value))} />
          <TextField select size="small" sx={{ width: 84 }} value={discountKind}
            onChange={(e) => setDiscountKind(e.target.value as 'pct' | 'uah')}>
            <MenuItem value="uah">грн</MenuItem>
            <MenuItem value="pct">%</MenuItem>
          </TextField>
          {actual?.discount && actual.discount.amount > 0 && (
            <>
              <Chip size="small" color="error" label={`-${formatMoney(actual.discount.amount)}`} />
              <Typography variant="body2" color="text.secondary">
                без знижки {formatMoney(actual.discount.grossTotal)} → разом <b>{formatMoney(actual.total)}</b>
              </Typography>
            </>
          )}
        </Stack>
      </Paper>

      {/* Додаткові витрати поза прайсом (доставка, запчастина, послуга третьої сторони) */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 0.5 }}>Додаткові витрати (поза прайсом)</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Окремі рядки кошторису без сезону (доставка, запчастина, послуга третьої сторони). Їх також
          вносить Telegram-бот співробітників — записи на заявці підставляються сюди автоматично.
        </Typography>
        {extraLines.length > 0 && (
          <Stack spacing={0.5} sx={{ mb: 1.5 }}>
            {extraLines.map((l) => (
              <Stack key={l.refId} direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" sx={{ flex: 1 }}>{tName(l.name, 'uk')}</Typography>
                <Typography variant="body2"><b>{formatMoney(l.lineTotal)}</b></Typography>
                <IconButton size="small" onClick={() => removeExtraLine(l.refId)} aria-label="Прибрати"><DeleteIcon fontSize="small" /></IconButton>
              </Stack>
            ))}
          </Stack>
        )}
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField label="Назва витрати" size="small" sx={{ minWidth: 240, flex: 1 }} value={extraTitle}
            onChange={(e) => setExtraTitle(e.target.value)} placeholder="Доставка Новою Поштою" />
          <TextField label="Сума, грн" type="number" size="small" sx={{ width: 140 }} value={extraAmount}
            onChange={(e) => setExtraAmount(e.target.value === '' ? '' : Number(e.target.value))} />
          <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={addExtraLine}
            disabled={!extraTitle.trim() || !(Number(extraAmount) > 0)}>Додати</Button>
        </Stack>
      </Paper>

      {/* Результат — фактическая смета разрезами по требованиям */}
      {actual && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Фактичний кошторис</Typography>
          <EstimateSectionsView lines={actual.lines} sections={actual.sections} total={actual.total} currency={actual.currency} discount={actual.discount} />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
            <ReceiptIcon fontSize="inherit" sx={{ verticalAlign: 'middle', mr: 0.5 }} />
            У чеку буде {goods.length} позиц. (побудовано за вимогами фіскального чека).
          </Typography>
        </Paper>
      )}

      {/* Сповіщення клієнта про фактичну калькуляцію (SMS/Telegram) + статус відправки */}
      {savedId && effRequestId && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>Сповіщення клієнта</Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            {lastActualNotif ? (
              lastActualNotif.status === 'sent' ? (
                <Chip color="success" size="small"
                  label={`Надіслано (${lastActualNotif.via === 'sms' ? 'SMS' : lastActualNotif.channel || 'месенджер'}) · ${new Date(lastActualNotif.createdAt).toLocaleString('uk-UA')}`} />
              ) : (
                <Chip color="error" size="small" label={`Помилка: ${lastActualNotif.error || 'не надіслано'}`} />
              )
            ) : (
              <Chip size="small" variant="outlined" label="ще не надсилалося" />
            )}
            <Button variant="outlined" size="small" disabled={notifBusy} onClick={sendActualNotif}>
              {lastActualNotif?.status === 'sent' ? 'Надіслати повторно' : 'Надіслати клієнту (SMS/Telegram)'}
            </Button>
            <Typography variant="caption" color="text.secondary">
              Канал обирається автоматично: Telegram, якщо підключений, інакше SMS. Історія — на заявці.
            </Typography>
          </Stack>
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
