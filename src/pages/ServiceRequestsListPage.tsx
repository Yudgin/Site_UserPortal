// Список заявок на обслуживание (для мастера/админа). Заявки создаются из обращений.
// Фильтры: статус (чипы со счётчиками), джерело (портал / 1С6), пошук (імʼя/телефон/номер).
// Сортування — за датою, нові зверху. Великий обсяг (імпорт 1С6) — порційний показ «Показати ще».
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip, Stack, TextField, MenuItem,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material'
import { Home as HomeIcon, Refresh as RefreshIcon, CloudSync as SyncIcon } from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { serviceRequestService } from '@/api/serviceRequestService'
import { serviceCenterService } from '@/api/serviceCenterService'
import { syncRepairsFrom1C } from '@/api/onecSyncApi'
import { useTtnStatuses, ttnChipColor } from '@/hooks/useTtnStatuses'
import {
  SERVICE_REQUEST_STATUS_LABELS, type ServiceRequest, type ServiceRequestStatus,
} from '@/types/serviceRequest'
import type { ServiceCenter } from '@/types/access'

const STATUS_ORDER = Object.keys(SERVICE_REQUEST_STATUS_LABELS) as ServiceRequestStatus[]

const statusColor = (s: ServiceRequestStatus): 'default' | 'success' | 'warning' | 'primary' =>
  s === 'done' ? 'success' : s === 'cancelled' ? 'default' : s === 'in_work' || s === 'approved' ? 'primary' : 'warning'

const fmtDate = (s?: string) => { if (!s) return '—'; const d = new Date(s); return isNaN(d.getTime()) ? '—' : d.toLocaleString('uk-UA') }

const PAGE = 100

export default function ServiceRequestsListPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [rows, setRows] = useState<ServiceRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<ServiceRequestStatus | 'all'>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'portal' | '1c6'>('all')
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [centers, setCenters] = useState<ServiceCenter[]>([])
  const [centerFilter, setCenterFilter] = useState('') // '' = усі; 'none' = без центру; інакше id

  const load = useCallback(async () => {
    setLoading(true)
    const [reqs, cs] = await Promise.all([serviceRequestService.list(3000), serviceCenterService.list()])
    setRows(reqs); setCenters(cs)
    setLoading(false)
  }, [])
  const centerName = (id?: string | null) => centers.find((c) => c.id === id)?.name || ''

  // Синхронизация картотеки ремонтов из 1С (~1-2 хв на повний прогін).
  const sync1c = async () => {
    setSyncing(true); setSyncMsg(null)
    try {
      const r = await syncRepairsFrom1C()
      setSyncMsg({
        ok: r.success && !r.errors?.length,
        text: `1С: усього ${r.total} · нових ${r.created} · оновлено ${r.updated} · без змін ${r.unchanged}`
          + (r.deferred ? ` · відкладено ${r.deferred} (добере наступний прогін)` : '')
          + (r.errors?.length ? ` · помилок ${r.errors.length} (${r.errors[0].guid}: ${r.errors[0].error})` : ''),
      })
      await load()
    } catch (e: any) {
      setSyncMsg({ ok: false, text: `Синхронізація не вдалася: ${e?.response?.data?.error || e?.message || e}` })
    }
    setSyncing(false)
  }
  useEffect(() => { load() }, [load])
  useEffect(() => { setShown(PAGE) }, [statusFilter, sourceFilter, q, centerFilter])

  const is1c6 = (r: ServiceRequest) => r.id.startsWith('sr-1c6-')

  // Статуси ТТН НП для видимих рядків (батч; кеш на сторінку).
  const visible = useMemo(() => rows.slice(0, 400), [rows])
  const ttnStatuses = useTtnStatuses(visible.flatMap((r) => [r.waybillNumber, r.returnTtn]))
  const ttnChip = (ttn?: string | null, prefix = '') => {
    if (!ttn) return null
    const st = ttnStatuses[String(ttn).replace(/\D/g, '')]
    return (
      <Chip size="small" variant="outlined" color={st ? ttnChipColor(st.status) : 'default'}
        sx={{ maxWidth: 190 }} title={`${ttn}${st ? ` — ${st.status}` : ''}`}
        label={`${prefix}${st ? st.status : '…'}`} />
    )
  }

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    return rows
      .filter((r) => statusFilter === 'all' || r.status === statusFilter)
      .filter((r) => sourceFilter === 'all' || (sourceFilter === '1c6' ? is1c6(r) : !is1c6(r)))
      .filter((r) => !centerFilter || (centerFilter === 'none' ? !r.serviceCenterId : r.serviceCenterId === centerFilter))
      .filter((r) => !query
        || (r.clientName || '').toLowerCase().includes(query)
        || (r.clientPhone || '').toLowerCase().includes(query)
        || (r.externalRequestId || '').toLowerCase().includes(query)
        || (r.onec?.number || '').replace(/^0+/, '').includes(query.replace(/^0+/, '') || ' ')
        || r.id.toLowerCase().includes(query)
        || (r.complaint || '').toLowerCase().includes(query))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) // нові зверху
  }, [rows, statusFilter, sourceFilter, q, centerFilter])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для адміністратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Заявки на обслуговування</Typography>
        <Box>
          <Button startIcon={syncing ? <CircularProgress size={16} /> : <SyncIcon />} onClick={sync1c} disabled={syncing || loading}>
            Синхронізувати з 1С
          </Button>
          <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>Оновити</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Box>
      </Box>
      {syncMsg && <Alert severity={syncMsg.ok ? 'success' : 'warning'} sx={{ mb: 2 }} onClose={() => setSyncMsg(null)}>{syncMsg.text}</Alert>}

      <Stack direction="row" spacing={0.5} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip label={`Усі (${rows.length})`} size="small" color={statusFilter === 'all' ? 'primary' : 'default'} onClick={() => setStatusFilter('all')} />
        {STATUS_ORDER.map((s) => {
          const n = rows.filter((r) => r.status === s).length
          if (!n) return null
          return (
            <Chip key={s} label={`${SERVICE_REQUEST_STATUS_LABELS[s]} (${n})`} size="small"
              color={statusFilter === s ? 'primary' : 'default'} onClick={() => setStatusFilter(s)} />
          )
        })}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip label="Портал" size="small" variant={sourceFilter === 'portal' ? 'filled' : 'outlined'}
          color={sourceFilter === 'portal' ? 'info' : 'default'}
          onClick={() => setSourceFilter(sourceFilter === 'portal' ? 'all' : 'portal')} />
        <Chip label="з 1С6" size="small" variant={sourceFilter === '1c6' ? 'filled' : 'outlined'}
          color={sourceFilter === '1c6' ? 'info' : 'default'}
          onClick={() => setSourceFilter(sourceFilter === '1c6' ? 'all' : '1c6')} />
        {centers.length > 0 && (
          <TextField select size="small" label="Сервісний центр" value={centerFilter}
            onChange={(e) => setCenterFilter(e.target.value)} sx={{ minWidth: 190 }}>
            <MenuItem value="">Усі центри</MenuItem>
            <MenuItem value="none">Без центру</MenuItem>
            {centers.map((c) => {
              const n = rows.filter((r) => r.serviceCenterId === c.id).length
              return <MenuItem key={c.id} value={c.id}>{c.name}{n ? ` (${n})` : ''}</MenuItem>
            })}
          </TextField>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <TextField size="small" placeholder="Пошук: клієнт / телефон / № ремонту / скарга" value={q}
          onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 280 }} />
      </Stack>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
      ) : filtered.length === 0 ? (
        <Alert severity="info">Заявок за фільтром не знайдено.</Alert>
      ) : (
        <>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'action.hover' }}>
                  <TableCell>№</TableCell>
                  <TableCell>Дата</TableCell>
                  <TableCell>Клієнт</TableCell>
                  <TableCell>Скарга</TableCell>
                  <TableCell>Статус</TableCell>
                  <TableCell>ТТН</TableCell>
                  <TableCell>Етапи</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.slice(0, shown).map((r) => (
                  <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/service-request/${r.id}`)}>
                    <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{(r.onec?.number || '').replace(/^0+/, '') || '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt)}</TableCell>
                    <TableCell>
                      {r.clientName || '—'}
                      {r.clientPhone && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.clientPhone}</Typography>}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.complaint || '—'}</TableCell>
                    <TableCell>
                      <Chip size="small" color={statusColor(r.status)} label={SERVICE_REQUEST_STATUS_LABELS[r.status]} />
                      {is1c6(r) && <Chip size="small" variant="outlined" label="1С6" sx={{ ml: 0.5 }} />}
                      {centerName(r.serviceCenterId) && (
                        <Chip size="small" variant="outlined" label={centerName(r.serviceCenterId)} sx={{ ml: 0.5, maxWidth: 140 }} />
                      )}
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.5}>
                        {ttnChip(r.waybillNumber, '→ нам: ')}
                        {ttnChip(r.returnTtn, '→ клієнту: ')}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {r.diagnostics?.text && <Chip size="small" color="info" variant="outlined" label="діагн." sx={{ mr: 0.5 }} />}
                      {r.offerId && <Chip size="small" variant="outlined" label="пропоз." sx={{ mr: 0.5 }} />}
                      {r.actualEstimateId && <Chip size="small" variant="outlined" label="факт" sx={{ mr: 0.5 }} />}
                      {r.paymentId && <Chip size="small" color="success" variant="outlined" label="оплата" />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {filtered.length > shown && (
            <Box sx={{ textAlign: 'center', mt: 2 }}>
              <Button onClick={() => setShown((n) => n + PAGE)}>Показати ще ({filtered.length - shown})</Button>
            </Box>
          )}
        </>
      )}
    </Container>
  )
}
