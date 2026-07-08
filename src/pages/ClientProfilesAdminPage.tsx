import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Chip, Alert, CircularProgress, TextField, InputAdornment, Tooltip,
} from '@mui/material'
import {
  Home as HomeIcon, Person as ProfileIcon, Refresh as RefreshIcon, Search as SearchIcon,
  Google as GoogleIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { clientProfileService } from '@/api/clientProfileService'
import { formatPhone } from '@/utils/phone'
import type { ClientProfile } from '@/types/clientProfile'

export default function ClientProfilesAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [profiles, setProfiles] = useState<ClientProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  const reload = async () => { setLoading(true); setProfiles(await clientProfileService.list()); setLoading(false) }
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
    ? profiles.filter((p) => [p.phone, p.name, p.email].filter(Boolean).join(' ').toLowerCase().includes(term))
    : profiles

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ProfileIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">Профили клиентов</Typography>
          <Chip size="small" variant="outlined" label={`${profiles.length}`} />
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button startIcon={<RefreshIcon />} onClick={reload}>Обновить</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
        </Box>
      </Box>

      <Container maxWidth="lg" sx={{ pb: 6 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Профиль клиента объединяется автоматически по телефону (ключ — нормализованный номер).
          Google-вход связывается через uid. Показаны привязанные кораблики, сессии и задачи.
        </Typography>
        <TextField size="small" fullWidth placeholder="Поиск: телефон, имя, email…" value={q}
          onChange={(e) => setQ(e.target.value)} sx={{ mb: 2 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />

        <Paper sx={{ p: { xs: 1, sm: 2 } }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Телефон</TableCell><TableCell>Имя</TableCell><TableCell>Email</TableCell>
                    <TableCell align="center">Кораблики</TableCell><TableCell align="center">Сессии</TableCell>
                    <TableCell align="center">Задачи</TableCell><TableCell align="center">Google</TableCell>
                    <TableCell>Обновлён</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((p) => (
                    <TableRow key={p.id} hover>
                      <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{formatPhone(p.phone)}</TableCell>
                      <TableCell>{p.name || '—'}</TableCell>
                      <TableCell>{p.email || '—'}</TableCell>
                      <TableCell align="center">{(p.boatIds ?? []).length || '—'}</TableCell>
                      <TableCell align="center">{(p.sessionIds ?? []).length || '—'}</TableCell>
                      <TableCell align="center">{(p.taskIds ?? []).length || '—'}</TableCell>
                      <TableCell align="center">
                        {(p.authUids ?? []).length ? (
                          <Tooltip title={`Привязано Google-аккаунтов: ${(p.authUids ?? []).length}`}>
                            <GoogleIcon fontSize="small" color="success" />
                          </Tooltip>
                        ) : '—'}
                      </TableCell>
                      <TableCell>{new Date(p.updatedAt).toLocaleDateString('ru-RU')}</TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {profiles.length ? 'Ничего не найдено.' : 'Пока нет профилей. Они создаются по телефону из опросника/заявки.'}
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Container>
    </Box>
  )
}
