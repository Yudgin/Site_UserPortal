// Картка замовлення кораблика (власник): клієнт + адреса НП, конфігуратор (модель → ряд →
// колір, глибиномір, сумка, ехолот, аксесуари — опції фільтруються за сумісністю з моделлю),
// вартість (автозбір із каталогу + ручні правки), хід виконання (статуси з історією), дропшип.
// Дії (ТТН / посилання на оплату / чек) — фаза 3.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Chip, Divider,
  TextField, MenuItem, Switch, FormControlLabel, IconButton, Snackbar, ToggleButtonGroup, ToggleButton,
} from '@mui/material'
import {
  ArrowBack as BackIcon, Add as AddIcon, Delete as DeleteIcon, Sailing as BoatIcon,
  Refresh as RecalcIcon, Save as SaveIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { boatOrderService } from '@/api/boatOrderService'
import { boatModelService, boatOptionService, dropshipperService } from '@/api/boatCatalogService'
import NpAddressPicker from '@/components/NpAddressPicker'
import type { NpAddress } from '@/types/npTemplate'
import {
  BOAT_ORDER_STATUSES, BOAT_ORDER_STATUS_LABELS, BOAT_OPTION_KIND_LABELS, optionFitsModel,
  type BoatModel, type BoatOption, type BoatOrder, type BoatOrderLine, type BoatOrderStatus, type Dropshipper,
} from '@/types/boats'
import { secureId } from '@/utils/id'

const fmtUah = (n: number) => `${(n || 0).toLocaleString('uk-UA')} грн`
const lineTotal = (l: BoatOrderLine) => Math.round((l.price * l.qty + Number.EPSILON) * 100) / 100
const sumLines = (lines: BoatOrderLine[]) => Math.round(lines.reduce((s, l) => s + lineTotal(l), 0) * 100) / 100

export default function BoatOrderPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const { user } = useAuthStore()
  const [order, setOrder] = useState<BoatOrder | null>(null)
  const [models, setModels] = useState<BoatModel[]>([])
  const [options, setOptions] = useState<BoatOption[]>([])
  const [droppers, setDroppers] = useState<Dropshipper[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' = 'success') => setSnack({ open: true, msg, sev })

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [o, m, opt, d] = await Promise.all([
      boatOrderService.get(id), boatModelService.list(), boatOptionService.list(), dropshipperService.list(),
    ])
    setOrder(o); setModels(m); setOptions(opt); setDroppers(d)
    setLoading(false)
  }, [id])
  useEffect(() => { load() }, [load])

  const patch = (p: Partial<BoatOrder>) => { setOrder((o) => (o ? { ...o, ...p } : o)); setDirty(true) }

  const model = useMemo(() => models.find((m) => m.id === order?.modelId) || null, [models, order?.modelId])
  const row = useMemo(() => model?.rows?.find((r) => r.id === order?.rowId) || null, [model, order?.rowId])

  // Опції, доступні для обраної моделі (активні + сумісні). Без моделі — нічого не пропонуємо.
  const fitting = useCallback(
    (kind: BoatOption['kind']) =>
      order?.modelId
        ? options.filter((o) => o.kind === kind && o.active !== false && optionFitsModel(o, order.modelId!))
        : [],
    [options, order?.modelId]
  )
  const optName = (oid?: string | null) => options.find((o) => o.id === oid)?.name || ''

  // Автозбір рядків вартості з конфігурації + цін каталогу.
  const buildLines = (): BoatOrderLine[] => {
    if (!order) return []
    const lines: BoatOrderLine[] = []
    if (model && row) lines.push({ id: secureId(8), label: `Кораблик ${model.name} ${row.name}${order.color ? ` (${order.color})` : ''}`, price: row.basePrice, qty: 1 })
    const pushOpt = (oid?: string | null) => {
      const o = options.find((x) => x.id === oid)
      if (o) lines.push({ id: secureId(8), label: `${BOAT_OPTION_KIND_LABELS[o.kind]}: ${o.name}`, price: o.price, qty: 1 })
    }
    if (order.needDepthGauge) pushOpt(order.depthGaugeOptionId)
    pushOpt(order.bagOptionId)
    pushOpt(order.echoOptionId)
    for (const a of order.accessories || []) {
      const o = options.find((x) => x.id === a.optionId)
      if (o) lines.push({ id: secureId(8), label: `${BOAT_OPTION_KIND_LABELS[o.kind]}: ${o.name}`, price: o.price, qty: a.qty || 1 })
    }
    return lines
  }
  const recalc = () => {
    const lines = buildLines()
    patch({ lines, total: sumLines(lines) })
  }

  const patchLine = (idx: number, p: Partial<BoatOrderLine>) => {
    if (!order) return
    const lines = order.lines.map((l, i) => (i === idx ? { ...l, ...p } : l))
    patch({ lines, total: sumLines(lines) })
  }
  const addLine = () => order && patch({ lines: [...order.lines, { id: secureId(8), label: '', price: 0, qty: 1 }] })
  const dropLine = (idx: number) => {
    if (!order) return
    const lines = order.lines.filter((_, i) => i !== idx)
    patch({ lines, total: sumLines(lines) })
  }

  const save = async () => {
    if (!order) return
    setSaving(true)
    const res = await boatOrderService.save(order)
    setSaving(false)
    if (res) { setDirty(false); notify('Збережено') } else notify('Не вдалося зберегти', 'error')
  }

  // Зміна статусу: історія + миттєве збереження (щоб хід виконання не губився без «Зберегти»).
  const setStatus = async (s: BoatOrderStatus) => {
    if (!order || s === order.status) return
    const next: BoatOrder = {
      ...order, status: s,
      statusHistory: [...(order.statusHistory || []), { status: s, at: new Date().toISOString(), by: user?.email || null }],
      ...(s === 'done' && !order.soldAt ? { soldAt: new Date().toISOString().slice(0, 10) } : {}),
    }
    setOrder(next)
    const res = await boatOrderService.save(next)
    if (res) notify(`Статус: ${BOAT_ORDER_STATUS_LABELS[s]}`)
    else notify('Не вдалося зберегти статус', 'error')
  }

  const addr: NpAddress = useMemo(() => ({
    cityRef: order?.clientCityRef || undefined,
    cityName: order?.clientCityName || undefined,
    warehouseRef: order?.clientWarehouseRef || undefined,
    warehouseName: order?.clientWarehouseName || undefined,
  }), [order?.clientCityRef, order?.clientCityName, order?.clientWarehouseRef, order?.clientWarehouseName])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ заборонено.</Alert>
      </Container>
    )
  }
  if (loading) return <Container sx={{ py: 6, textAlign: 'center' }}><CircularProgress /></Container>
  if (!order) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Замовлення не знайдено.</Alert>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/boat-orders')} sx={{ mt: 2 }}>До списку</Button>
      </Container>
    )
  }

  const accessories = order.accessories || []

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/boat-orders')}>Замовлення</Button>
        <BoatIcon color="primary" />
        <Typography variant="h6" sx={{ flexGrow: 1 }}>
          {order.clientName || 'Нове замовлення'}
        </Typography>
        <Button variant="contained" startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />} onClick={save} disabled={saving || !dirty}>
          Зберегти
        </Button>
      </Stack>

      {/* Хід виконання */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Хід виконання</Typography>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {BOAT_ORDER_STATUSES.map((s) => (
            <Chip key={s} label={BOAT_ORDER_STATUS_LABELS[s]} size="small"
              color={order.status === s ? (s === 'cancelled' ? 'error' : 'primary') : 'default'}
              variant={order.status === s ? 'filled' : 'outlined'}
              onClick={() => setStatus(s)} />
          ))}
        </Stack>
        {(order.statusHistory || []).length > 1 && (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
            {(order.statusHistory || []).map((h) => `${BOAT_ORDER_STATUS_LABELS[h.status]} — ${new Date(h.at).toLocaleString('uk-UA')}`).join(' → ')}
          </Typography>
        )}
      </Paper>

      {/* Клієнт */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Клієнт</Typography>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Імʼя клієнта" value={order.clientName} onChange={(e) => patch({ clientName: e.target.value })} size="small" fullWidth />
            <TextField label="Телефон" value={order.clientPhone} onChange={(e) => patch({ clientPhone: e.target.value })} size="small" fullWidth placeholder="+380..." />
          </Stack>
          <NpAddressPicker value={addr} onChange={(v) => patch({
            clientCityRef: v.cityRef || null, clientCityName: v.cityName || null,
            clientWarehouseRef: v.warehouseRef || null, clientWarehouseName: v.warehouseName || null,
          })} label="Місто клієнта" warehouseLabel="Відділення НП" />
          <TextField label="Дата продажу" type="date" value={order.soldAt || ''} onChange={(e) => patch({ soldAt: e.target.value || null })}
            size="small" InputLabelProps={{ shrink: true }} sx={{ maxWidth: 220 }}
            helperText="Для раніше проданих; заповнюється автоматично при «Завершено»" />
        </Stack>
      </Paper>

      {/* Конфігурація */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Конфігурація кораблика</Typography>
        {models.length === 0 && <Alert severity="info" sx={{ mb: 1 }}>Каталог порожній — додайте моделі на сторінці «Каталог корабликів».</Alert>}
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label="Модель" value={order.modelId || ''} size="small" fullWidth
              onChange={(e) => patch({ modelId: e.target.value || null, rowId: null, color: null, bagOptionId: null, echoOptionId: null, depthGaugeOptionId: null, accessories: [] })}>
              <MenuItem value="">—</MenuItem>
              {models.filter((m) => m.active !== false).map((m) => <MenuItem key={m.id} value={m.id}>{m.name}</MenuItem>)}
            </TextField>
            <TextField select label="Модельний ряд (рік)" value={order.rowId || ''} size="small" fullWidth disabled={!model}
              onChange={(e) => patch({ rowId: e.target.value || null })}>
              <MenuItem value="">—</MenuItem>
              {(model?.rows || []).map((r) => <MenuItem key={r.id} value={r.id}>{r.name} · {fmtUah(r.basePrice)}</MenuItem>)}
            </TextField>
            <TextField select label="Колір" value={order.color || ''} size="small" fullWidth disabled={!model}
              onChange={(e) => patch({ color: e.target.value || null })}>
              <MenuItem value="">—</MenuItem>
              {(model?.colors || []).map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
            </TextField>
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            <FormControlLabel control={<Switch checked={!!order.needDepthGauge} onChange={(e) => patch({ needDepthGauge: e.target.checked, ...(e.target.checked ? {} : { depthGaugeOptionId: null }) })} />}
              label="Потрібен глибиномір" />
            {order.needDepthGauge && (
              <TextField select label="Глибиномір" value={order.depthGaugeOptionId || ''} size="small" sx={{ minWidth: 240 }}
                onChange={(e) => patch({ depthGaugeOptionId: e.target.value || null })}>
                <MenuItem value="">—</MenuItem>
                {fitting('depthgauge').map((o) => <MenuItem key={o.id} value={o.id}>{o.name} · {fmtUah(o.price)}</MenuItem>)}
              </TextField>
            )}
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label="Сумка" value={order.bagOptionId || ''} size="small" fullWidth disabled={!model}
              onChange={(e) => patch({ bagOptionId: e.target.value || null })}>
              <MenuItem value="">Без сумки</MenuItem>
              {fitting('bag').map((o) => <MenuItem key={o.id} value={o.id}>{o.name} · {fmtUah(o.price)}</MenuItem>)}
            </TextField>
            <TextField select label="Ехолот" value={order.echoOptionId || ''} size="small" fullWidth disabled={!model}
              onChange={(e) => patch({ echoOptionId: e.target.value || null })}>
              <MenuItem value="">Без ехолота</MenuItem>
              {fitting('echo').map((o) => <MenuItem key={o.id} value={o.id}>{o.name} · {fmtUah(o.price)}</MenuItem>)}
            </TextField>
          </Stack>

          <Divider>Аксесуари</Divider>
          {accessories.map((a, idx) => (
            <Stack key={idx} direction="row" spacing={1} alignItems="center">
              <TextField select label="Аксесуар" value={a.optionId} size="small" sx={{ flex: 1 }}
                onChange={(e) => patch({ accessories: accessories.map((x, i) => (i === idx ? { ...x, optionId: e.target.value } : x)) })}>
                {fitting('accessory').map((o) => <MenuItem key={o.id} value={o.id}>{o.name} · {fmtUah(o.price)}</MenuItem>)}
                {a.optionId && !fitting('accessory').some((o) => o.id === a.optionId) && (
                  <MenuItem value={a.optionId}>{optName(a.optionId) || a.optionId}</MenuItem>
                )}
              </TextField>
              <TextField label="К-сть" type="number" value={a.qty} size="small" sx={{ width: 100 }}
                onChange={(e) => patch({ accessories: accessories.map((x, i) => (i === idx ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)) })} />
              <IconButton size="small" color="error" onClick={() => patch({ accessories: accessories.filter((_, i) => i !== idx) })}><DeleteIcon fontSize="small" /></IconButton>
            </Stack>
          ))}
          <Box>
            <Button size="small" startIcon={<AddIcon />} disabled={!model || fitting('accessory').length === 0}
              onClick={() => patch({ accessories: [...accessories, { optionId: fitting('accessory')[0]?.id || '', qty: 1 }] })}>
              Додати аксесуар
            </Button>
            {model && fitting('accessory').length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                Немає сумісних аксесуарів для цієї моделі.
              </Typography>
            )}
          </Box>
        </Stack>
      </Paper>

      {/* Вартість */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>Вартість</Typography>
          <Button size="small" startIcon={<RecalcIcon />} onClick={recalc}>Перерахувати з каталогу</Button>
        </Stack>
        {order.lines.length === 0 && <Alert severity="info" sx={{ mb: 1 }}>Рядків немає — зберіть конфігурацію і натисніть «Перерахувати з каталогу», або додайте вручну.</Alert>}
        <Stack spacing={1}>
          {order.lines.map((l, idx) => (
            <Stack key={l.id} direction="row" spacing={1} alignItems="center">
              <TextField label="Позиція" value={l.label} size="small" sx={{ flex: 1 }} onChange={(e) => patchLine(idx, { label: e.target.value })} />
              <TextField label="Ціна" type="number" value={l.price || ''} size="small" sx={{ width: 120 }} onChange={(e) => patchLine(idx, { price: Number(e.target.value) || 0 })} />
              <TextField label="К-сть" type="number" value={l.qty} size="small" sx={{ width: 90 }} onChange={(e) => patchLine(idx, { qty: Math.max(1, Number(e.target.value) || 1) })} />
              <Typography variant="body2" sx={{ width: 110, textAlign: 'right' }}>{fmtUah(lineTotal(l))}</Typography>
              <IconButton size="small" color="error" onClick={() => dropLine(idx)}><DeleteIcon fontSize="small" /></IconButton>
            </Stack>
          ))}
        </Stack>
        <Stack direction="row" alignItems="center" sx={{ mt: 1.5 }}>
          <Button size="small" startIcon={<AddIcon />} onClick={addLine}>Додати рядок</Button>
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Разом: {fmtUah(order.total)}</Typography>
        </Stack>
      </Paper>

      {/* Дропшипінг */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Дропшипінг</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <TextField select label="Дропшипер" value={order.dropshipperId || ''} size="small" sx={{ minWidth: 240 }}
            onChange={(e) => patch({ dropshipperId: e.target.value || null, ...(e.target.value ? {} : { payTo: 'us' }) })}>
            <MenuItem value="">— пряме замовлення —</MenuItem>
            {droppers.filter((d) => d.active !== false).map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
          </TextField>
          {order.dropshipperId && (
            <ToggleButtonGroup exclusive size="small" value={order.payTo || 'us'}
              onChange={(_, v) => v && patch({ payTo: v })}>
              <ToggleButton value="us">Оплата нам</ToggleButton>
              <ToggleButton value="dropshipper">Оплата дропшиперу</ToggleButton>
            </ToggleButtonGroup>
          )}
        </Stack>
        {order.dropshipperId && (
          <Alert severity={order.payTo === 'dropshipper' ? 'warning' : 'info'} sx={{ mt: 1.5 }}>
            {order.payTo === 'dropshipper'
              ? 'Гроші отримує дропшипер — ми не генеруємо посилання на оплату і не видаємо чек (чек — на стороні дропшипера). Сума фіксується для взаєморозрахунків.'
              : 'Гроші отримуємо ми — наші посилання на оплату і наш чек; частка дропшипера накопичується для взаєморозрахунків.'}
          </Alert>
        )}
      </Paper>

      {/* Нотатка */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <TextField label="Нотатка" value={order.note || ''} onChange={(e) => patch({ note: e.target.value })} size="small" fullWidth multiline minRows={2} />
      </Paper>

      <Stack direction="row" spacing={1} sx={{ mb: 4 }}>
        <Box sx={{ flexGrow: 1 }} />
        <Button variant="contained" startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />} onClick={save} disabled={saving || !dirty}>
          Зберегти
        </Button>
      </Stack>

      <Snackbar open={snack.open} autoHideDuration={3000} onClose={() => setSnack((s) => ({ ...s, open: false }))}>
        <Alert severity={snack.sev} onClose={() => setSnack((s) => ({ ...s, open: false }))}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
