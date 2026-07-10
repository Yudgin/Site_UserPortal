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
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, IconButton, TextField,
  Autocomplete, MenuItem, Chip, Stack, ToggleButton, ToggleButtonGroup,
} from '@mui/material'
import {
  Delete as DeleteIcon, Home as HomeIcon, Save as SaveIcon,
  ContentCopy as CopyIcon, Payment as PaymentIcon, Receipt as ReceiptIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { usePricingStore } from '@/store/pricingStore'
import { isAdminEmail } from '@/config/access'
import { pricingService } from '@/api/pricingService'
import { serviceRequestService } from '@/api/serviceRequestService'
import { paymentsApi, FopPublic } from '@/api/endpoints/payments'
import {
  buildEstimate, estimate2goods, compareEstimates, needsReapproval, tName, formatMoney,
  type EstimateWorkInput,
} from '@/utils/pricing'
import { buildPriceContext } from '@/utils/aiContext'
import AiWorkPicker from '@/components/AiWorkPicker'
import type { Estimate, ServiceKind } from '@/types/pricing'

interface WorkRow extends EstimateWorkInput {
  key: string // локальный ключ строки (работа может повторяться)
}

export default function ActualEstimateEditorPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { user } = useAuthStore()
  const { catalog, indexed, loadFromServer, isLoading } = usePricingStore()

  const parentId = params.get('parent') || ''
  const editId = params.get('edit') || '' // редактировать СУЩЕСТВУЮЩИЙ факт (а не создавать новый)
  const serviceRequestId = params.get('request') || '' // наша заявка на обслуживание

  const [prelim, setPrelim] = useState<Estimate | null>(null)
  const [rows, setRows] = useState<WorkRow[]>([])
  const [serviceKind, setServiceKind] = useState<ServiceKind>('repair')
  const [title, setTitle] = useState('')
  const [complaint, setComplaint] = useState('')

  const [fops, setFops] = useState<FopPublic[]>([])
  const [fopId, setFopId] = useState('')

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
      setServiceKind((est.sections?.[0]?.serviceKind as ServiceKind) || 'repair')
      setTitle(est.title || '')
      setComplaint(est.complaint || '')
      // прифилл: работы из labor-строк предварительной (материалы/доп. подтянутся движком)
      const seeded: WorkRow[] = est.lines
        .filter((l) => l.type === 'labor')
        .map((l, i) => ({ key: `p${i}`, workId: l.refId, qty: l.qty }))
      setRows(seeded)
    })
  }, [parentId])

  // Режим РЕДАКТИРОВАНИЯ существующего факта (?edit=<id>): грузим сам факт (savedId=id →
  // пересохранение обновит его, а не создаст дубль), сеем работы, ФОП; для diff — его родителя.
  useEffect(() => {
    if (!editId) return
    pricingService.loadEstimate(editId).then((act) => {
      if (!act) { notify('Кошторис не знайдено', 'error'); return }
      setSavedId(editId)
      setTitle(act.title || '')
      setComplaint(act.complaint || '')
      setServiceKind((act.sections?.[0]?.serviceKind as ServiceKind) || 'repair')
      if (act.fopId) setFopId(act.fopId)
      setRows(act.lines.filter((l) => l.type === 'labor').map((l, i) => ({ key: `e${i}`, workId: l.refId, qty: l.qty })))
      if (act.parentEstimateId) pricingService.loadEstimate(act.parentEstimateId).then((p) => p && setPrelim(p))
    })
  }, [editId])

  const activeWorks = useMemo(() => Object.values(indexed.works).filter((w) => w.active), [indexed])
  const activeKits = useMemo(() => Object.values(indexed.kits).filter((k) => k.active), [indexed])

  // Живой расчёт фактической сметы
  const actual: Estimate | null = useMemo(() => {
    const works = rows.filter((r) => r.workId && indexed.works[r.workId]).map((r) => ({ workId: r.workId, qty: r.qty }))
    if (!works.length) return null
    return buildEstimate({
      works,
      catalog: indexed,
      settings: catalog.settings,
      serviceKind,
      meta: {
        requestId: prelim?.requestId ?? null, // 1С-ссылка (унаследованная от предложения), если есть
        title: title || (prelim?.title ?? ''),
        complaint: complaint || (prelim?.complaint ?? ''),
        source: 'manual',
        createdBy: user?.email ?? null,
      },
    })
  }, [rows, indexed, catalog.settings, serviceKind, title, complaint, prelim, user])

  const comparison = useMemo(() => (prelim && actual ? compareEstimates(prelim, actual) : null), [prelim, actual])
  const reapproval = useMemo(() => (prelim && actual ? needsReapproval(prelim, actual) : null), [prelim, actual])
  const goods = useMemo(() => (actual ? estimate2goods(actual, 'uk') : []), [actual])

  const priceCtx = useMemo(() => buildPriceContext(catalog), [catalog])
  const addRow = (workId: string) => setRows((r) => [...r, { key: `w${Date.now()}${r.length}`, workId, qty: 1 }])
  const addWorks = (works: EstimateWorkInput[]) =>
    setRows((r) => [...r, ...works.map((w, i) => ({ key: `ai${Date.now()}${i}`, workId: w.workId, qty: w.qty }))])
  const addKit = (kitId: string) => {
    const kit = indexed.kits[kitId]
    if (!kit) return
    const items: WorkRow[] = kit.items
      .filter((it) => indexed.works[it.workId]?.active)
      .map((it, i) => ({ key: `k${Date.now()}${i}`, workId: it.workId, qty: it.qty }))
    setRows((r) => [...r, ...items])
  }
  const setQty = (key: string, qty: number) => setRows((r) => r.map((x) => (x.key === key ? { ...x, qty: Math.max(0.1, qty) } : x)))
  const removeRow = (key: string) => setRows((r) => r.filter((x) => x.key !== key))

  const clientLink = savedId ? `${window.location.origin}/estimate/${savedId}` : ''

  const canSave = !!actual && !!user && isAdminEmail(user.email)

  const handleSave = async (): Promise<string | null> => {
    if (!actual) return null
    if (!fopId) { notify('Оберіть ФОП, який прийме оплату та видасть чек', 'error'); return null }
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
      }
      const required = reapproval?.required ?? false
      const srId = serviceRequestId || prelim?.serviceRequestId || null
      const toSave: Estimate = {
        ...actual,
        id: savedId || '', // повторное сохранение перезапишет ту же смету
        kind: 'actual',
        status: required ? 'pending_approval' : 'approved',
        parentEstimateId: prelim?.id ?? null,
        serviceRequestId: srId,
        receiptGoods: estimate2goods(actual, 'uk'),
        fopId,
      }
      const res = await pricingService.saveEstimate(toSave)
      if (!res) { notify('Не вдалося зберегти кошторис', 'error'); return null }
      setSavedId(res.id)
      // Привязываем факт к заявке и двигаем её в «в роботі».
      if (srId) await serviceRequestService.save({ id: srId, actualEstimateId: res.id, status: 'in_work' }).catch(() => {})
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

  const chosenFop = fops.find((f) => f.id === fopId)

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Фактична калькуляція</Typography>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Зберіть кошторис за реально виконаними роботами та матеріалами. З нього виб'ється фіскальний
        чек тим ФОП, який прийме оплату. Клієнт отримає посилання для погодження та оплати.
      </Typography>

      {/* Параметры */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <TextField label="Назва / кораблик" value={title} onChange={(e) => setTitle(e.target.value)} size="small" fullWidth />
          <TextField label="Скарга" value={complaint} onChange={(e) => setComplaint(e.target.value)} size="small" fullWidth />
        </Stack>
        <ToggleButtonGroup
          size="small" exclusive value={serviceKind}
          onChange={(_e, v) => v && setServiceKind(v)}
        >
          <ToggleButton value="repair">Ремонт</ToggleButton>
          <ToggleButton value="upgrade">Апгрейд (без сезонної націнки)</ToggleButton>
        </ToggleButtonGroup>
      </Paper>

      {/* Добавление работ/наборов */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Роботи та матеріали</Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <Autocomplete
            sx={{ flex: 2 }} size="small" options={activeWorks}
            getOptionLabel={(w) => `${w.code} · ${tName(w.name, 'uk')}`}
            onChange={(_e, w) => w && addRow(w.id)}
            renderInput={(p) => <TextField {...p} label="Додати роботу" />}
            value={null} blurOnSelect clearOnBlur
          />
          <Autocomplete
            sx={{ flex: 2 }} size="small" options={activeKits}
            getOptionLabel={(k) => `${k.code} · ${tName(k.name, 'uk')}`}
            onChange={(_e, k) => k && addKit(k.id)}
            renderInput={(p) => <TextField {...p} label="Додати набір (розгорнути)" />}
            value={null} blurOnSelect clearOnBlur
          />
          <AiWorkPicker priceContext={priceCtx} catalog={indexed} onAdd={addWorks} />
        </Stack>

        {rows.length === 0 ? (
          <Alert severity="info">Додайте роботи або набір, щоб зібрати фактичний кошторис.</Alert>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'action.hover' }}>
                  <TableCell>Робота</TableCell>
                  <TableCell width={110}>Кількість</TableCell>
                  <TableCell width={60} />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => {
                  const w = indexed.works[r.workId]
                  return (
                    <TableRow key={r.key}>
                      <TableCell>{w ? `${w.code} · ${tName(w.name, 'uk')}` : r.workId}</TableCell>
                      <TableCell>
                        <TextField
                          type="number" size="small" value={r.qty}
                          onChange={(e) => setQty(r.key, Number(e.target.value))}
                          inputProps={{ min: 0.1, step: 0.5 }} sx={{ width: 90 }}
                        />
                      </TableCell>
                      <TableCell>
                        <IconButton size="small" onClick={() => removeRow(r.key)}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* Результат — фактическая смета построчно */}
      {actual && (
        <Paper sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Фактичний кошторис</Typography>
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
                {actual.lines.map((l, i) => (
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
                  <TableCell colSpan={2}><b>Разом</b></TableCell>
                  <TableCell align="right"><b>{formatMoney(actual.total)}</b></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            <ReceiptIcon fontSize="inherit" sx={{ verticalAlign: 'middle', mr: 0.5 }} />
            У чеку буде {goods.length} позиц. (побудовано за вимогами фіскального чека).
          </Typography>
        </Paper>
      )}

      {/* Diff план/факт */}
      {comparison && reapproval && (
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

      {/* ФОП + сохранение + ссылка клиенту */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Оплата та чек</Typography>
        {fops.length === 0 ? (
          <Alert severity="warning">ФОП не налаштовані (FOPS_CONFIG). Оплату/чек буде увімкнено після налаштування.</Alert>
        ) : (
          <TextField
            select size="small" label="ФОП (прийме оплату та видасть чек)" value={fopId}
            onChange={(e) => setFopId(e.target.value)} sx={{ minWidth: 320, mb: 2 }}
          >
            {fops.map((f) => (
              <MenuItem key={f.id} value={f.id}>
                {f.name}{!f.receipts && ' (без чека!)'}
              </MenuItem>
            ))}
          </TextField>
        )}
        {chosenFop && !chosenFop.receipts && (
          <Alert severity="warning" sx={{ mb: 2 }}>У цього ФОП не налаштований Checkbox — оплата пройде, але фіскальний чек не виб'ється.</Alert>
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
