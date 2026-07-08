import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Tabs, Tab, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Chip, Alert, CircularProgress, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, MenuItem, Switch, FormControlLabel, Snackbar, Divider,
} from '@mui/material'
import {
  Home as HomeIcon, Feedback as FeedbackIcon, Psychology as CorrectionIcon,
  Refresh as RefreshIcon, AddCircle as AddIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { feedbackService, behaviorCorrectionService } from '@/api/feedbackService'
import type { Feedback, FeedbackStatus, BehaviorCorrection, BehaviorScope } from '@/types/feedback'

const KIND_LABEL: Record<string, string> = {
  helpful: 'полезно', 'not-helpful': 'не помогло', inaccuracy: 'неточность', suggestion: 'предложение', error: 'ошибка',
}
const SCOPE_LABEL: Record<BehaviorScope, string> = {
  all: 'везде', estimate: 'оценка', consultation: 'консультация', selfservice: 'самопомощь',
}
const STATUS_COLOR: Record<FeedbackStatus, 'default' | 'info' | 'success'> = {
  new: 'info', reviewed: 'default', resolved: 'success',
}

export default function FeedbackAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [tab, setTab] = useState(0)
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [corrections, setCorrections] = useState<BehaviorCorrection[]>([])
  const [loading, setLoading] = useState(true)
  const [openFb, setOpenFb] = useState<Feedback | null>(null)
  const [newCorr, setNewCorr] = useState<BehaviorCorrection | null>(null)
  const [snackbar, setSnackbar] = useState('')

  const reload = async () => {
    setLoading(true)
    const [fb, corr] = await Promise.all([feedbackService.list(), behaviorCorrectionService.listAll()])
    setFeedback(fb)
    setCorrections(corr)
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

  const notify = (m: string) => setSnackbar(m)

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FeedbackIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">Обратная связь и поведение ИИ</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button startIcon={<RefreshIcon />} onClick={reload}>Обновить</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
        </Box>
      </Box>

      <Container maxWidth="lg" sx={{ pb: 6 }}>
        <Paper sx={{ p: { xs: 1, sm: 2 } }}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1 }}>
            <Tab label={`Отзывы (${feedback.length})`} />
            <Tab label={`Правки поведения ИИ (${corrections.length})`} />
          </Tabs>

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          ) : tab === 0 ? (
            <TableContainer>
              <Table size="small">
                <TableHead><TableRow>
                  <TableCell>Тип</TableCell><TableCell>Текст</TableCell><TableCell>Статус</TableCell><TableCell>Дата</TableCell>
                </TableRow></TableHead>
                <TableBody>
                  {feedback.map((f) => (
                    <TableRow key={f.id} hover sx={{ cursor: 'pointer' }} onClick={() => setOpenFb(f)}>
                      <TableCell>
                        <Chip size="small" label={KIND_LABEL[f.kind] || f.kind}
                          color={f.helpful === false ? 'error' : f.helpful === true ? 'success' : 'default'} variant="outlined" />
                      </TableCell>
                      <TableCell>{f.text ? f.text.slice(0, 70) : <i>без текста</i>}</TableCell>
                      <TableCell><Chip size="small" color={STATUS_COLOR[f.status]} label={f.status} /></TableCell>
                      <TableCell>{new Date(f.createdAt).toLocaleString('ru-RU')}</TableCell>
                    </TableRow>
                  ))}
                  {feedback.length === 0 && (
                    <TableRow><TableCell colSpan={4} align="center" sx={{ py: 4, color: 'text.secondary' }}>Пока нет отзывов.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Box>
              <Button startIcon={<AddIcon />} variant="outlined" sx={{ mb: 2 }}
                onClick={() => setNewCorr({ id: '', instruction: '', scope: 'all', active: true, createdAt: '', createdBy: null, sourceFeedbackId: null })}>
                Добавить правку
              </Button>
              <TableContainer>
                <Table size="small">
                  <TableHead><TableRow>
                    <TableCell>Правило для ИИ</TableCell><TableCell>Область</TableCell><TableCell align="center">Активна</TableCell><TableCell>Дата</TableCell>
                  </TableRow></TableHead>
                  <TableBody>
                    {corrections.map((c) => (
                      <TableRow key={c.id} sx={{ opacity: c.active ? 1 : 0.5 }}>
                        <TableCell>{c.instruction}</TableCell>
                        <TableCell><Chip size="small" variant="outlined" label={SCOPE_LABEL[c.scope]} /></TableCell>
                        <TableCell align="center">
                          <Switch size="small" checked={c.active}
                            onChange={async (e) => { await behaviorCorrectionService.update(c.id, { active: e.target.checked }); reload() }} />
                        </TableCell>
                        <TableCell>{new Date(c.createdAt).toLocaleDateString('ru-RU')}</TableCell>
                      </TableRow>
                    ))}
                    {corrections.length === 0 && (
                      <TableRow><TableCell colSpan={4} align="center" sx={{ py: 4, color: 'text.secondary' }}>Пока нет правок поведения.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}
        </Paper>
      </Container>

      {openFb && (
        <FeedbackDialog feedback={openFb} onClose={() => setOpenFb(null)}
          onSaved={() => { setOpenFb(null); reload(); notify('Сохранено') }}
          onMakeCorrection={(f) => {
            setOpenFb(null)
            setNewCorr({ id: '', instruction: '', scope: 'all', active: true, createdAt: '', createdBy: null, sourceFeedbackId: f.id })
          }} />
      )}
      {newCorr && (
        <CorrectionDialog corr={newCorr} onClose={() => setNewCorr(null)}
          onSaved={() => { setNewCorr(null); reload(); notify('Правка добавлена — ИИ учтёт её в ответах') }} />
      )}
      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  )
}

function FeedbackDialog({ feedback, onClose, onSaved, onMakeCorrection }: {
  feedback: Feedback; onClose: () => void; onSaved: () => void; onMakeCorrection: (f: Feedback) => void
}) {
  const [reply, setReply] = useState(feedback.managerReply || '')
  const [status, setStatus] = useState<FeedbackStatus>(feedback.status)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    await feedbackService.update(feedback.id, { managerReply: reply.trim() || null, status })
    setSaving(false)
    onSaved()
  }

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Отзыв клиента</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
          <Chip size="small" label={KIND_LABEL[feedback.kind] || feedback.kind} />
          {feedback.helpful !== null && <Chip size="small" color={feedback.helpful ? 'success' : 'error'} label={feedback.helpful ? 'помогло' : 'не помогло'} />}
          {feedback.sessionId && (
            <Button size="small" href={`/chat/${feedback.sessionId}`} target="_blank">Открыть сессию</Button>
          )}
        </Box>
        <Typography variant="body2" sx={{ mb: 2, whiteSpace: 'pre-line' }}>
          {feedback.text || <i>Клиент не оставил текст.</i>}
        </Typography>
        <Divider sx={{ mb: 2 }} />
        <TextField fullWidth multiline minRows={2} label="Ответ клиенту" value={reply}
          onChange={(e) => setReply(e.target.value)} sx={{ mb: 2 }} />
        <TextField select fullWidth size="small" label="Статус" value={status}
          onChange={(e) => setStatus(e.target.value as FeedbackStatus)}>
          <MenuItem value="new">новый</MenuItem>
          <MenuItem value="reviewed">просмотрен</MenuItem>
          <MenuItem value="resolved">решён</MenuItem>
        </TextField>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button startIcon={<CorrectionIcon />} onClick={() => onMakeCorrection(feedback)}>Создать правку ИИ</Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" onClick={save} disabled={saving}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}

function CorrectionDialog({ corr, onClose, onSaved }: { corr: BehaviorCorrection; onClose: () => void; onSaved: () => void }) {
  const [c, setC] = useState<BehaviorCorrection>(corr)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    await behaviorCorrectionService.create({
      instruction: c.instruction.trim(), scope: c.scope, active: c.active, sourceFeedbackId: c.sourceFeedbackId,
    })
    setSaving(false)
    onSaved()
  }

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Правка поведения ИИ</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Правило добавляется в системный промпт ИИ (на украинском). Так поведение корректируется по отзывам без переобучения.
        </Typography>
        <TextField fullWidth multiline minRows={3} label="Правило для ИИ (українською)" value={c.instruction}
          onChange={(e) => setC({ ...c, instruction: e.target.value })} sx={{ mb: 2 }}
          placeholder="Напр.: Не пропонуй заміну сервоприводу, поки не уточнив модель кораблика." />
        <TextField select fullWidth size="small" label="Область действия" value={c.scope}
          onChange={(e) => setC({ ...c, scope: e.target.value as BehaviorScope })} sx={{ mb: 2 }}>
          <MenuItem value="all">Везде</MenuItem>
          <MenuItem value="estimate">Только оценка стоимости</MenuItem>
          <MenuItem value="consultation">Только консультации</MenuItem>
          <MenuItem value="selfservice">Только самопомощь</MenuItem>
        </TextField>
        <FormControlLabel control={<Switch checked={c.active} onChange={(e) => setC({ ...c, active: e.target.checked })} />} label="Активна" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" onClick={save} disabled={saving || !c.instruction.trim()}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}
