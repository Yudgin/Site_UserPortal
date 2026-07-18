// Картотека замовлень корабликів (власник): список із фільтром за статусом і пошуком,
// створення нового замовлення та внесення раніше проданого (для історії/допродажів).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Chip, TextField,
} from '@mui/material'
import {
  Home as HomeIcon, Add as AddIcon, Sailing as BoatIcon, History as HistoryIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { boatOrderService } from '@/api/boatOrderService'
import { boatModelService } from '@/api/boatCatalogService'
import {
  BOAT_ORDER_STATUSES, BOAT_ORDER_STATUS_LABELS,
  type BoatModel, type BoatOrder, type BoatOrderStatus,
} from '@/types/boats'

const fmtUah = (n: number) => `${(n || 0).toLocaleString('uk-UA')} грн`
const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('uk-UA') : '')

const statusColor = (s: BoatOrderStatus): 'default' | 'info' | 'warning' | 'success' | 'error' =>
  s === 'lead' ? 'default'
  : s === 'cancelled' ? 'error'
  : s === 'done' || s === 'delivered' ? 'success'
  : s === 'shipped' ? 'info'
  : 'warning'

export default function BoatOrdersPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [orders, setOrders] = useState<BoatOrder[]>([])
  const [models, setModels] = useState<BoatModel[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [statusFilter, setStatusFilter] = useState<BoatOrderStatus | 'all'>('all')
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [o, m] = await Promise.all([boatOrderService.list(), boatModelService.list()])
    setOrders(o); setModels(m)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const modelName = (id?: string | null) => models.find((m) => m.id === id)?.name || ''

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    return orders
      .filter((o) => statusFilter === 'all' || o.status === statusFilter)
      .filter((o) => !query
        || (o.clientName || '').toLowerCase().includes(query)
        || (o.clientPhone || '').toLowerCase().includes(query)
        || modelName(o.modelId).toLowerCase().includes(query))
  }, [orders, statusFilter, q, models])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ заборонено.</Alert>
      </Container>
    )
  }

  // Нове замовлення / раніше проданий кораблик: створюємо мінімальний документ і йдемо в картку.
  const createOrder = async (soldEarlier: boolean) => {
    setCreating(true)
    const now = new Date().toISOString()
    const res = await boatOrderService.save({
      clientName: '', clientPhone: '', lines: [], total: 0,
      status: soldEarlier ? 'done' : 'lead',
      statusHistory: [{ status: soldEarlier ? 'done' : 'lead', at: now }],
      ...(soldEarlier ? { soldAt: now.slice(0, 10) } : {}),
    })
    setCreating(false)
    if (res) navigate(`/boat-orders/${res.id}`)
  }

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <BoatIcon color="primary" />
        <Typography variant="h5" sx={{ flexGrow: 1 }}>Замовлення корабликів</Typography>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Головна</Button>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Button variant="contained" startIcon={<AddIcon />} disabled={creating} onClick={() => createOrder(false)}>
          Нове замовлення
        </Button>
        <Button variant="outlined" startIcon={<HistoryIcon />} disabled={creating} onClick={() => createOrder(true)}>
          Проданий раніше
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        <TextField size="small" placeholder="Пошук: клієнт / телефон / модель" value={q} onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 240 }} />
      </Stack>

      <Stack direction="row" spacing={0.5} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Chip label={`Усі (${orders.length})`} size="small" color={statusFilter === 'all' ? 'primary' : 'default'} onClick={() => setStatusFilter('all')} />
        {BOAT_ORDER_STATUSES.map((s) => {
          const n = orders.filter((o) => o.status === s).length
          return (
            <Chip key={s} label={`${BOAT_ORDER_STATUS_LABELS[s]}${n ? ` (${n})` : ''}`} size="small"
              color={statusFilter === s ? 'primary' : 'default'} onClick={() => setStatusFilter(s)} />
          )
        })}
      </Stack>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : filtered.length === 0 ? (
        <Alert severity="info">Замовлень не знайдено.</Alert>
      ) : (
        <Stack spacing={1}>
          {filtered.map((o) => (
            <Paper key={o.id} sx={{ p: 1.5, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
              onClick={() => navigate(`/boat-orders/${o.id}`)}>
              <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip size="small" color={statusColor(o.status)} label={BOAT_ORDER_STATUS_LABELS[o.status]} />
                <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
                  {o.clientName || '— без імені —'}{o.clientPhone ? ` · ${o.clientPhone}` : ''}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {[modelName(o.modelId), o.color].filter(Boolean).join(' · ')}
                </Typography>
                <Typography variant="subtitle2">{fmtUah(o.total)}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {fmtDate(o.soldAt) || fmtDate(o.createdAt)}
                </Typography>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
    </Container>
  )
}
