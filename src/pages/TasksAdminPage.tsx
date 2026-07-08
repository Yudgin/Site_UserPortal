import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, IconButton, Chip, Alert, CircularProgress, TextField, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions, Snackbar, Stack,
} from '@mui/material'
import {
  Home as HomeIcon, Assignment as TaskIcon, Delete as DeleteIcon, Refresh as RefreshIcon,
  Add as AddIcon, OpenInNew as OpenIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { serviceTaskService } from '@/api/serviceTaskService'
import { TASK_TYPE_LABELS, TASK_STATUS_LABELS } from '@/types/serviceTask'
import type { ServiceTask, ServiceTaskType, ServiceTaskStatus } from '@/types/serviceTask'

const statusColor = (s: ServiceTaskStatus): 'info' | 'warning' | 'success' | 'default' =>
  s === 'new' ? 'info' : s === 'in-progress' ? 'warning' : s === 'done' ? 'success' : 'default'

export default function TasksAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [tasks, setTasks] = useState<ServiceTask[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | ServiceTaskStatus>('all')
  const [newOpen, setNewOpen] = useState(false)
  const [snackbar, setSnackbar] = useState('')

  const reload = async () => { setLoading(true); setTasks(await serviceTaskService.list()); setLoading(false) }
  useEffect(() => { reload() }, [])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ только для администратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На главную</Button>
      </Container>
    )
  }

  const filtered = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)
  const openCount = tasks.filter((t) => t.status === 'new' || t.status === 'in-progress').length

  const setStatus = async (t: ServiceTask, status: ServiceTaskStatus) => {
    await serviceTaskService.update(t.id, { status })
    setTasks((list) => list.map((x) => (x.id === t.id ? { ...x, status } : x)))
  }
  const remove = async (id: string) => {
    if (await serviceTaskService.delete(id)) { setTasks((l) => l.filter((x) => x.id !== id)); setSnackbar('Удалено') }
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TaskIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">Задачи сервиса</Typography>
          <Chip size="small" color={openCount ? 'warning' : 'default'} label={`${openCount} открытых`} />
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button startIcon={<RefreshIcon />} onClick={reload}>Обновить</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>Задача</Button>
        </Box>
      </Box>

      <Container maxWidth="lg" sx={{ pb: 6 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Задачи из консультаций по ремонту и обычных: отправка комплектующих, доп. работа по просьбе клиента,
          перезвон и т.д. Создаются клиентом из чата или вручную.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
          {(['all', 'new', 'in-progress', 'done', 'cancelled'] as const).map((k) => (
            <Chip key={k} size="small" clickable
              label={k === 'all' ? 'Все' : TASK_STATUS_LABELS[k]}
              color={filter === k ? 'primary' : 'default'} variant={filter === k ? 'filled' : 'outlined'}
              onClick={() => setFilter(k)} />
          ))}
        </Box>
        <Paper sx={{ p: { xs: 1, sm: 2 } }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead><TableRow>
                  <TableCell>Тип</TableCell><TableCell>Суть</TableCell><TableCell>Контакт</TableCell>
                  <TableCell>Статус</TableCell><TableCell>Дата</TableCell><TableCell align="right">Действия</TableCell>
                </TableRow></TableHead>
                <TableBody>
                  {filtered.map((t) => (
                    <TableRow key={t.id} sx={{ opacity: t.status === 'done' || t.status === 'cancelled' ? 0.55 : 1 }}>
                      <TableCell><Chip size="small" variant="outlined" label={TASK_TYPE_LABELS[t.type]} /></TableCell>
                      <TableCell>
                        <Typography variant="body2">{t.title}</Typography>
                        {t.details && <Typography variant="caption" color="text.secondary">{t.details.slice(0, 80)}</Typography>}
                      </TableCell>
                      <TableCell>{t.contact?.name || t.contact?.phone || '—'}</TableCell>
                      <TableCell>
                        <TextField select size="small" variant="standard" value={t.status}
                          onChange={(e) => setStatus(t, e.target.value as ServiceTaskStatus)}
                          SelectProps={{ renderValue: (v) => <Chip size="small" color={statusColor(v as ServiceTaskStatus)} label={TASK_STATUS_LABELS[v as ServiceTaskStatus]} /> }}>
                          {(Object.keys(TASK_STATUS_LABELS) as ServiceTaskStatus[]).map((s) => (
                            <MenuItem key={s} value={s}>{TASK_STATUS_LABELS[s]}</MenuItem>
                          ))}
                        </TextField>
                      </TableCell>
                      <TableCell>{new Date(t.createdAt).toLocaleDateString('ru-RU')}</TableCell>
                      <TableCell align="right">
                        {t.sessionId && (
                          <IconButton size="small" title="Открыть диалог" onClick={() => window.open(`/chat/${t.sessionId}`, '_blank')}>
                            <OpenIcon fontSize="small" />
                          </IconButton>
                        )}
                        <IconButton size="small" onClick={() => remove(t.id)}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {tasks.length ? 'Нет задач по фильтру.' : 'Пока нет задач.'}
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Container>

      {newOpen && (
        <NewTaskDialog onClose={() => setNewOpen(false)}
          onCreated={(t) => { setTasks((l) => [t, ...l]); setNewOpen(false); setSnackbar('Задача создана') }} />
      )}
      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  )
}

function NewTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (t: ServiceTask) => void }) {
  const [type, setType] = useState<ServiceTaskType>('extra-work')
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    const contact = (name.trim() || phone.trim())
      ? { ...(name.trim() ? { name: name.trim() } : {}), ...(phone.trim() ? { phone: phone.trim() } : {}) }
      : null
    const res = await serviceTaskService.create({ type, title: title.trim(), details: details.trim(), contact, sessionId: null, origin: 'admin', assignee: null })
    setSaving(false)
    if (res) {
      const now = new Date().toISOString()
      onCreated({ id: res.id, type, status: 'new', title: title.trim(), details: details.trim(), contact, sessionId: null, origin: 'admin', assignee: null, createdAt: now, updatedAt: now, createdBy: null })
    }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Новая задача</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField select size="small" label="Тип" value={type} onChange={(e) => setType(e.target.value as ServiceTaskType)}>
            {(Object.keys(TASK_TYPE_LABELS) as ServiceTaskType[]).map((k) => <MenuItem key={k} value={k}>{TASK_TYPE_LABELS[k]}</MenuItem>)}
          </TextField>
          <TextField size="small" label="Суть" value={title} onChange={(e) => setTitle(e.target.value)} />
          <TextField size="small" multiline minRows={2} label="Подробности" value={details} onChange={(e) => setDetails(e.target.value)} />
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: '1fr 1fr' }}>
            <TextField size="small" label="Имя" value={name} onChange={(e) => setName(e.target.value)} />
            <TextField size="small" label="Телефон" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" onClick={submit} disabled={saving || !title.trim()}>Создать</Button>
      </DialogActions>
    </Dialog>
  )
}
