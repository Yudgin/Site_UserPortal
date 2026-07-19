// Список заявок на обслуживание (для мастера/админа). Заявки создаются из обращений.
// Фильтры: статус (чипы со счётчиками), джерело (портал / 1С6), пошук (імʼя/телефон/номер).
// Сортування — за датою, нові зверху. Великий обсяг (імпорт 1С6) — порційний показ «Показати ще».
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip, Stack, TextField,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material'
import { Home as HomeIcon, Refresh as RefreshIcon } from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { serviceRequestService } from '@/api/serviceRequestService'
import {
  SERVICE_REQUEST_STATUS_LABELS, type ServiceRequest, type ServiceRequestStatus,
} from '@/types/serviceRequest'

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

  const load = useCallback(async () => { setLoading(true); setRows(await serviceRequestService.list(3000)); setLoading(false) }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { setShown(PAGE) }, [statusFilter, sourceFilter, q])

  const is1c6 = (r: ServiceRequest) => r.id.startsWith('sr-1c6-')

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    return rows
      .filter((r) => statusFilter === 'all' || r.status === statusFilter)
      .filter((r) => sourceFilter === 'all' || (sourceFilter === '1c6' ? is1c6(r) : !is1c6(r)))
      .filter((r) => !query
        || (r.clientName || '').toLowerCase().includes(query)
        || (r.clientPhone || '').toLowerCase().includes(query)
        || (r.externalRequestId || '').toLowerCase().includes(query)
        || r.id.toLowerCase().includes(query)
        || (r.complaint || '').toLowerCase().includes(query))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) // нові зверху
  }, [rows, statusFilter, sourceFilter, q])

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
          <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>Оновити</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Box>
      </Box>

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
                  <TableCell>Дата</TableCell>
                  <TableCell>Клієнт</TableCell>
                  <TableCell>Скарга</TableCell>
                  <TableCell>Статус</TableCell>
                  <TableCell>Етапи</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.slice(0, shown).map((r) => (
                  <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/service-request/${r.id}`)}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt)}</TableCell>
                    <TableCell>
                      {r.clientName || '—'}
                      {r.clientPhone && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.clientPhone}</Typography>}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.complaint || '—'}</TableCell>
                    <TableCell>
                      <Chip size="small" color={statusColor(r.status)} label={SERVICE_REQUEST_STATUS_LABELS[r.status]} />
                      {is1c6(r) && <Chip size="small" variant="outlined" label="1С6" sx={{ ml: 0.5 }} />}
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
