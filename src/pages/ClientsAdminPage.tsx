import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, IconButton, Chip, Alert, CircularProgress, TextField, InputAdornment,
  Dialog, DialogTitle, DialogContent, DialogActions, Snackbar,
} from '@mui/material'
import {
  Home as HomeIcon, DirectionsBoat as BoatIcon, Delete as DeleteIcon, Refresh as RefreshIcon,
  Search as SearchIcon, OpenInNew as OpenIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { clientBoatService } from '@/api/clientBoatService'
import { ECHO_LABELS, SATISFACTION_LABELS } from '@/types/clientBoat'
import type { ClientBoat } from '@/types/clientBoat'

const autopilotText = (b: ClientBoat): string => {
  if (b.autopilotPresence === 'none') return 'немає'
  if (b.autopilotPresence === 'unknown') return 'не знає'
  const model = b.autopilotModel || 'модель невідома'
  const upd = b.autopilotUpdated ? `оновл. ${b.autopilotUpdateYear || 'так'}` : 'без оновл.'
  return `${model} · ${upd}`
}

export default function ClientsAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [boats, setBoats] = useState<ClientBoat[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [confirmDel, setConfirmDel] = useState<ClientBoat | null>(null)
  const [snackbar, setSnackbar] = useState('')

  const reload = async () => {
    setLoading(true)
    setBoats(await clientBoatService.list())
    setLoading(false)
  }
  useEffect(() => { reload() }, [])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ только для администратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На главную</Button>
      </Container>
    )
  }

  const term = q.trim().toLowerCase()
  const filtered = term
    ? boats.filter((b) => [b.contact?.name, b.contact?.phone, b.contact?.email, b.model, b.year]
        .filter(Boolean).join(' ').toLowerCase().includes(term))
    : boats

  const remove = async () => {
    if (!confirmDel) return
    const ok = await clientBoatService.delete(confirmDel.id)
    if (ok) { setBoats((list) => list.filter((x) => x.id !== confirmDel.id)); setSnackbar('Запись удалена') }
    else setSnackbar('Не удалось удалить')
    setConfirmDel(null)
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <BoatIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">Клиенты и кораблики</Typography>
          <Chip size="small" variant="outlined" label={`${boats.length}`} />
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button startIcon={<RefreshIcon />} onClick={reload}>Обновить</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
        </Box>
      </Box>

      <Container maxWidth="lg" sx={{ pb: 6 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          База наполняется из опросника приёмки. Позже — выгрузка истории продаж из 1С и пополнение
          при продаже (по внешнему id). Записи из 1С будут помечены источником «1С».
        </Typography>

        <TextField size="small" fullWidth placeholder="Поиск: имя, телефон, email, модель, год…"
          value={q} onChange={(e) => setQ(e.target.value)} sx={{ mb: 2 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />

        <Paper sx={{ p: { xs: 1, sm: 2 } }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Контакт</TableCell><TableCell>Модель / год</TableCell><TableCell>Эхолот</TableCell>
                    <TableCell>Автопилот</TableCell><TableCell>Доволен</TableCell><TableCell>Источник</TableCell>
                    <TableCell>Дата</TableCell><TableCell align="right">Действия</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((b) => (
                    <TableRow key={b.id} hover>
                      <TableCell>
                        <Typography variant="body2">{b.contact?.name || '—'}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {[b.contact?.phone, b.contact?.email].filter(Boolean).join(' · ') || 'без контакта'}
                        </Typography>
                      </TableCell>
                      <TableCell>{b.model || '—'}{b.year ? ` · ${b.year}` : ''}</TableCell>
                      <TableCell>{ECHO_LABELS[b.echo] ?? b.echo}</TableCell>
                      <TableCell><Typography variant="caption">{autopilotText(b)}</Typography></TableCell>
                      <TableCell>
                        <Chip size="small" variant="outlined"
                          color={b.satisfaction === 'yes' ? 'success' : b.satisfaction === 'no' ? 'error' : 'default'}
                          label={SATISFACTION_LABELS[b.satisfaction] ?? '—'} />
                      </TableCell>
                      <TableCell><Chip size="small" label={b.source === '1c' ? '1С' : 'опросник'} /></TableCell>
                      <TableCell>{new Date(b.createdAt).toLocaleDateString('ru-RU')}</TableCell>
                      <TableCell align="right">
                        {b.sessionId && (
                          <IconButton size="small" title="Открыть диалог" onClick={() => window.open(`/chat/${b.sessionId}`, '_blank')}>
                            <OpenIcon fontSize="small" />
                          </IconButton>
                        )}
                        <IconButton size="small" onClick={() => setConfirmDel(b)}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {boats.length ? 'Ничего не найдено.' : 'Пока нет записей. Они появятся после заполнения опросника.'}
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Container>

      <Dialog open={!!confirmDel} onClose={() => setConfirmDel(null)}>
        <DialogTitle>Удалить запись?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {confirmDel?.contact?.name || confirmDel?.contact?.phone || 'Запись'} — {confirmDel?.model || 'кораблик'}. Действие необратимо.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDel(null)}>Отмена</Button>
          <Button color="error" onClick={remove}>Удалить</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  )
}
