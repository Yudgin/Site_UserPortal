// Список заявок на обслуживание (для мастера/админа). Заявки создаются из обращений.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material'
import { Home as HomeIcon, Refresh as RefreshIcon } from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { serviceRequestService } from '@/api/serviceRequestService'
import { SERVICE_REQUEST_STATUS_LABELS, type ServiceRequest, type ServiceRequestStatus } from '@/types/serviceRequest'

const statusColor = (s: ServiceRequestStatus): 'default' | 'success' | 'warning' | 'primary' =>
  s === 'done' ? 'success' : s === 'cancelled' ? 'default' : s === 'in_work' || s === 'approved' ? 'primary' : 'warning'

const fmtDate = (s?: string) => { if (!s) return '—'; const d = new Date(s); return isNaN(d.getTime()) ? '—' : d.toLocaleString('uk-UA') }

export default function ServiceRequestsListPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [rows, setRows] = useState<ServiceRequest[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => { setLoading(true); setRows(await serviceRequestService.list(300)); setLoading(false) }, [])
  useEffect(() => { load() }, [load])

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
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Заявки створюються з обращень (інбокс → «Створити заявку»).</Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
      ) : rows.length === 0 ? (
        <Alert severity="info">Заявок поки немає. Створіть заявку з обращення.</Alert>
      ) : (
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
              {rows.map((r) => (
                <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/service-request/${r.id}`)}>
                  <TableCell>{fmtDate(r.createdAt)}</TableCell>
                  <TableCell>{r.clientName || '—'}{r.clientPhone && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.clientPhone}</Typography>}</TableCell>
                  <TableCell sx={{ maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.complaint || '—'}</TableCell>
                  <TableCell><Chip size="small" color={statusColor(r.status)} label={SERVICE_REQUEST_STATUS_LABELS[r.status]} /></TableCell>
                  <TableCell>
                    {r.offerId && <Chip size="small" variant="outlined" label="пропоз." sx={{ mr: 0.5 }} />}
                    {r.actualEstimateId && <Chip size="small" variant="outlined" label="факт" sx={{ mr: 0.5 }} />}
                    {r.paymentId && <Chip size="small" color="success" variant="outlined" label="оплата" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Container>
  )
}
