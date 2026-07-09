import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Tabs, Tab, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Chip, Alert, CircularProgress, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, Snackbar, Divider, IconButton, Tooltip,
} from '@mui/material'
import {
  Home as HomeIcon, SupportAgent as InboxIcon, Send as SendIcon, NoteAdd as NoteIcon,
  CheckCircle as ResolveIcon, ContentCopy as CopyIcon, Refresh as RefreshIcon,
  NotificationsActive as ReminderIcon, LocalOffer as OfferIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { usePricingStore } from '@/store/pricingStore'
import { isAdminEmail } from '@/config/access'
import { chatSessionService } from '@/api/chatSessionService'
import { messengerApi } from '@/api/endpoints/messenger'
import { pricingService } from '@/api/pricingService'
import { serviceRequestService } from '@/api/serviceRequestService'
import { buildEstimate, aiEstimateToWorkInputs } from '@/utils/pricing'
import { NO_REAPPROVAL_DEVIATION_PCT, OUTCOME_LABELS, CHANNEL_LABELS, TOPIC_LABELS } from '@/types/chat'
import type { ChatSession, ChatMessage, ChatReminder } from '@/types/chat'

const genId = (): string => Math.random().toString(36).slice(2, 10)

const statusChip = (s: ChatSession) => {
  if (s.status === 'escalated') {
    const overdue = s.escalation && !s.escalation.resolvedAt && new Date(s.escalation.dueAt) < new Date()
    return <Chip size="small" color={overdue ? 'error' : 'warning'} label={overdue ? 'просрочено' : 'эскалировано'} />
  }
  if (s.status === 'resolved') return <Chip size="small" color="success" variant="outlined" label="решено" />
  return <Chip size="small" variant="outlined" label="активно" />
}

const lastText = (s: ChatSession) => {
  const visible = s.messages.filter((m) => !m.internal)
  const last = visible[visible.length - 1]
  return last ? `${last.role === 'client' ? '👤' : last.role === 'manager' ? '🧑‍🔧' : '🤖'} ${last.text.slice(0, 60)}` : '—'
}

const usdCost = (s: ChatSession) => s.aiUsage?.costUsd || 0

export default function ManagerInboxPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [tab, setTab] = useState(0)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<ChatSession | null>(null)
  const [snackbar, setSnackbar] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'escalated' | 'resolved' | 'overdue'>('all')
  const [q, setQ] = useState('')

  const reload = async () => {
    setLoading(true)
    setSessions(tab === 0 ? await chatSessionService.listEscalated() : await chatSessionService.listRecent())
    setLoading(false)
  }
  useEffect(() => { reload() }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ только для администратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На главную</Button>
      </Container>
    )
  }

  const isOverdue = (s: ChatSession) => !!(s.status === 'escalated' && s.escalation && !s.escalation.resolvedAt && new Date(s.escalation.dueAt) < new Date())
  const term = q.trim().toLowerCase()
  const filtered = sessions.filter((s) => {
    if (tab === 1) {
      if (statusFilter === 'active' && s.status !== 'active') return false
      if (statusFilter === 'escalated' && s.status !== 'escalated') return false
      if (statusFilter === 'resolved' && s.status !== 'resolved') return false
      if (statusFilter === 'overdue' && !isOverdue(s)) return false
    }
    if (term) {
      const hay = [s.contact?.name, s.contact?.phone, ...s.messages.filter((m) => !m.internal).map((m) => m.text)]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(term)) return false
    }
    return true
  })

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <InboxIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">Обращения клиентов</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Chip variant="outlined" color="secondary"
            label={`ИИ: $${sessions.reduce((a, s) => a + usdCost(s), 0).toFixed(3)} за ${sessions.length} сессий`} />
          <Button startIcon={<RefreshIcon />} onClick={reload}>Обновить</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
        </Box>
      </Box>

      <Container maxWidth="lg" sx={{ pb: 6 }}>
        <Paper sx={{ p: { xs: 1, sm: 2 } }}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1 }}>
            <Tab label="Эскалированные" />
            <Tab label="Все сессии" />
          </Tabs>
          {tab === 1 && (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
              {([
                ['all', 'Все'], ['active', 'Активные'], ['escalated', 'Эскалированные'],
                ['resolved', 'Решённые'], ['overdue', 'Просроченные'],
              ] as const).map(([key, label]) => (
                <Chip key={key} size="small" label={label} clickable
                  color={statusFilter === key ? 'primary' : 'default'}
                  variant={statusFilter === key ? 'filled' : 'outlined'}
                  onClick={() => setStatusFilter(key)} />
              ))}
              <Box sx={{ flex: 1 }} />
              <TextField size="small" placeholder="Поиск: имя, телефон, текст…" value={q}
                onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 220 }} />
            </Box>
          )}
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Статус</TableCell><TableCell>Контакт</TableCell>
                    <TableCell>Последнее сообщение</TableCell><TableCell align="right">ИИ, $</TableCell>
                    <TableCell>Срок / обновлено</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((s) => (
                    <TableRow key={s.id} hover sx={{ cursor: 'pointer' }} onClick={() => setOpen(s)}>
                      <TableCell>
                        {statusChip(s)}
                        {s.outcome && s.outcome !== 'open' && (
                          <Chip size="small" variant="outlined" sx={{ ml: 0.5 }} label={OUTCOME_LABELS[s.outcome]} />
                        )}
                      </TableCell>
                      <TableCell>
                        {s.channel && s.channel !== 'web' && (
                          <Chip size="small" color="info" variant="outlined" sx={{ mr: 0.5 }} label={CHANNEL_LABELS[s.channel]} />
                        )}
                        {s.topic && s.topic !== 'service' && (
                          <Chip size="small" color={s.topic === 'sales' ? 'success' : 'default'} variant="outlined" sx={{ mr: 0.5 }} label={TOPIC_LABELS[s.topic]} />
                        )}
                        {s.contact?.name || '—'}
                        {s.contact?.phone && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>📱 {s.contact.phone}</Typography>
                        )}
                      </TableCell>
                      <TableCell>{lastText(s)}</TableCell>
                      <TableCell align="right">{usdCost(s) ? `$${usdCost(s).toFixed(3)}` : '—'}</TableCell>
                      <TableCell>
                        {s.status === 'escalated' && s.escalation
                          ? `до ${new Date(s.escalation.dueAt).toLocaleString('ru-RU')}`
                          : new Date(s.updatedAt).toLocaleString('ru-RU')}
                      </TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {sessions.length ? 'Ничего не найдено по фильтру.' : (tab === 0 ? 'Нет эскалированных обращений.' : 'Пока нет сессий.')}
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Container>

      {open && (
        <SessionDialog
          session={open}
          managerEmail={user.email}
          onClose={() => setOpen(null)}
          onSaved={(s) => {
            setOpen(s)
            setSessions((list) => list.map((x) => (x.id === s.id ? s : x)))
          }}
          onNotify={setSnackbar}
        />
      )}
      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </Box>
  )
}

function SessionDialog({ session, managerEmail, onClose, onSaved, onNotify }: {
  session: ChatSession
  managerEmail: string
  onClose: () => void
  onSaved: (s: ChatSession) => void
  onNotify: (m: string) => void
}) {
  const [s, setS] = useState<ChatSession>(session)
  const [reply, setReply] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [reminderNote, setReminderNote] = useState('')
  const [reminderAt, setReminderAt] = useState('')
  const [creatingOffer, setCreatingOffer] = useState(false)
  const [existingRequestId, setExistingRequestId] = useState<string | null>(null)
  const navigate = useNavigate()
  const { catalog, indexed, loadFromServer } = usePricingStore()
  useEffect(() => { loadFromServer() }, [loadFromServer])
  // Уже есть заявка по этому обращению? (чтобы предлагать «Відкрити», а не плодить дубли)
  useEffect(() => {
    serviceRequestService.listBySession(s.id).then((rs) => { if (rs.length) setExistingRequestId(rs[0].id) })
  }, [s.id])

  const persist = async (next: ChatSession) => {
    setSaving(true)
    const ok = await chatSessionService.save(next)
    setSaving(false)
    if (ok) { setS(next); onSaved(next) }
    else onNotify('Не удалось сохранить')
    return ok
  }

  // Создать НАШУ заявку на обслуживание из обращения. Если у ИИ была оценка — материализуем её
  // в смету stage='ai' (для последующего засева предложения) и привязываем к заявке.
  const createServiceRequest = async () => {
    setCreatingOffer(true)
    try {
      let aiEstimateId: string | null = null
      if (s.estimate && s.estimate.lines.length) {
        const { works, unmatched } = aiEstimateToWorkInputs(s.estimate.lines, indexed)
        if (works.length) {
          const est = buildEstimate({ works, catalog: indexed, settings: catalog.settings, meta: { title: 'Оцінка ІІ', source: 'ai', createdBy: managerEmail } })
          const saved = await pricingService.saveEstimate({ ...est, kind: 'preliminary', stage: 'ai', status: 'draft' })
          if (saved) aiEstimateId = saved.id
          if (unmatched.length) onNotify(`ІІ не розпізнав: ${unmatched.join(', ')} — додайте в редакторі`)
        }
      }
      const complaint = s.messages.filter((m) => m.role === 'client' && !m.internal).map((m) => m.text)[0] || ''
      const created = await serviceRequestService.save({
        id: `sr-${s.id}`, // детерминированный id по обращению → без дублей при гонке/двойном клике
        sessionId: s.id,
        externalRequestId: s.requestId ?? null,
        clientName: s.contact?.name,
        clientPhone: s.contact?.phone,
        complaint,
        status: 'new',
        aiEstimateId,
        createdBy: managerEmail,
      })
      if (!created) { onNotify('Не вдалося створити заявку'); return }
      navigate(`/service-request/${created.id}`)
    } catch (e) {
      onNotify(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setCreatingOffer(false)
    }
  }

  // Ответ клиенту идёт через backend: доставка в канал (Telegram/Viber) + возврат бота при
  // упоминании («…зараз Клод підкаже…»). Web-клиент видит ответ по поллингу сессии.
  const sendReply = async () => {
    const text = reply.trim()
    if (!text) return
    setSaving(true)
    try {
      const { session, botReply } = await messengerApi.managerReply(s.id, text)
      setS(session); onSaved(session); setReply('')
      onNotify(botReply ? 'Надіслано, бот підключився до діалогу' : 'Ответ отправлен клиенту')
    } catch (e) {
      onNotify(e instanceof Error ? e.message : 'Не удалось отправить')
    } finally {
      setSaving(false)
    }
  }

  const addNote = async () => {
    const text = note.trim()
    if (!text) return
    const msg: ChatMessage = { id: genId(), role: 'manager', text, at: new Date().toISOString(), internal: true }
    const next: ChatSession = { ...s, messages: [...s.messages, msg] }
    if (await persist(next)) { setNote(''); onNotify('Заметка сохранена') }
  }

  const resolve = async () => {
    const next: ChatSession = {
      ...s,
      status: 'resolved',
      escalation: s.escalation
        ? { ...s.escalation, resolvedAt: new Date().toISOString(), managerEmail }
        : null,
    }
    if (await persist(next)) onNotify('Обращение закрыто')
  }

  const addReminder = async () => {
    if (!reminderNote.trim() || !reminderAt) return
    const rem: ChatReminder = { id: genId(), at: new Date(reminderAt).toISOString(), note: reminderNote.trim(), done: false }
    const next: ChatSession = { ...s, reminders: [...s.reminders, rem] }
    if (await persist(next)) { setReminderNote(''); setReminderAt(''); onNotify('Напоминание добавлено') }
  }

  const toggleReminder = async (id: string) => {
    const next: ChatSession = { ...s, reminders: s.reminders.map((r) => (r.id === id ? { ...r, done: !r.done } : r)) }
    persist(next)
  }

  const publicLink = `${window.location.origin}/chat/${s.id}`

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          Обращение {statusChip(s)}
        </Box>
        <Tooltip title="Скопировать ссылку на сессию">
          <Button size="small" startIcon={<CopyIcon />} onClick={() => { navigator.clipboard.writeText(publicLink); onNotify('Ссылка скопирована') }}>
            Ссылка клиента
          </Button>
        </Tooltip>
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity={s.contact?.phone ? 'info' : 'warning'} icon={false} sx={{ mb: 2 }}>
          <b>Клієнт:</b> {s.contact?.name || '—'}
          {s.contact?.phone ? (
            <>
              {' · 📱 '}<b>{s.contact.phone}</b>
              <Button size="small" startIcon={<CopyIcon />} sx={{ ml: 1 }} onClick={() => { navigator.clipboard.writeText(s.contact!.phone!); onNotify('Номер скопійовано') }}>копіювати</Button>
            </>
          ) : (
            <> · <i>номер ще не отримано (бот попросить у клієнта)</i></>
          )}
        </Alert>
        <Box sx={{ mb: 2 }}>
          {existingRequestId ? (
            <Button variant="contained" startIcon={<OfferIcon />} onClick={() => navigate(`/service-request/${existingRequestId}`)}>Відкрити заявку</Button>
          ) : (
            <Button variant="contained" startIcon={<OfferIcon />} disabled={creatingOffer} onClick={createServiceRequest}>
              {creatingOffer ? 'Створюємо…' : 'Створити заявку на обслуговування'}
            </Button>
          )}
        </Box>
        {s.status === 'escalated' && s.escalation && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Эскалировано: {new Date(s.escalation.escalatedAt).toLocaleString('ru-RU')}. Причина: {s.escalation.reason}.
            Срок ответа: <b>{new Date(s.escalation.dueAt).toLocaleString('ru-RU')}</b>.
          </Alert>
        )}
        {s.aiUsage && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Стоимость ИИ по сессии: <b>${s.aiUsage.costUsd.toFixed(4)}</b> · вызовов: {s.aiUsage.calls} ·
            токенов: {s.aiUsage.inputTokens + s.aiUsage.outputTokens}
          </Typography>
        )}
        {s.estimate && s.estimate.lines.length > 0 && (
          <Alert severity="success" icon={false} sx={{ mb: 2 }}>
            <b>Предварительная оценка ИИ</b> ({new Date(s.estimate.at).toLocaleString('ru-RU')}):
            <Box component="ul" sx={{ m: 0.5, pl: 2.5 }}>
              {s.estimate.lines.map((l, i) => (
                <li key={i}>{l.label} — <b>{l.price.toLocaleString('uk-UA')} грн</b></li>
              ))}
            </Box>
            Итого: <b>{s.estimate.total.toLocaleString('uk-UA')} грн</b>
          </Alert>
        )}
        {s.authorization && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <b>Согласование клиента:</b>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              <li>Другие видимые дефекты: {s.authorization.fixOtherVisibleDefects ? 'устранять' : 'только по согласованию'}</li>
              <li>Новые дефекты: {s.authorization.autoApproveNewDefects
                ? `авто до ${s.authorization.newDefectsBoatPctThreshold}% стоимости кораблика`
                : 'по согласованию'}</li>
              <li>Рост сметы: {s.authorization.autoApproveEstimateIncrease
                ? `авто до +${s.authorization.estimateIncreasePctThreshold}%`
                : 'по согласованию'} (без согласования, если отклонение ≤ {NO_REAPPROVAL_DEVIATION_PCT}%)</li>
            </Box>
          </Alert>
        )}

        {/* Переписка */}
        <Box sx={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
          {s.messages.map((m) => (
            <Box key={m.id} sx={{
              alignSelf: m.role === 'client' ? 'flex-end' : 'flex-start', maxWidth: '85%',
              px: 1.5, py: 0.75, borderRadius: 2, whiteSpace: 'pre-line',
              bgcolor: m.internal ? 'warning.light' : m.role === 'client' ? 'primary.main' : m.role === 'manager' ? 'secondary.light' : 'grey.100',
              color: m.role === 'client' && !m.internal ? 'primary.contrastText' : 'text.primary',
            }}>
              <Typography variant="caption" sx={{ display: 'block', opacity: 0.75 }}>
                {m.internal ? '🔒 внутренняя заметка' : m.role === 'client' ? 'Клиент' : m.role === 'manager' ? 'Менеджер' : 'ИИ'}
                {' · '}{new Date(m.at).toLocaleString('ru-RU')}
              </Typography>
              <Typography variant="body2">{m.text}</Typography>
            </Box>
          ))}
        </Box>

        <Divider sx={{ mb: 2 }} />

        {/* Ответ клиенту */}
        <Box sx={{ display: 'flex', gap: 1, mb: 1, alignItems: 'flex-end' }}>
          <TextField fullWidth size="small" multiline maxRows={4} label="Ответ клиенту (виден в диалоге)"
            value={reply} onChange={(e) => setReply(e.target.value)} />
          <Button variant="contained" startIcon={<SendIcon />} onClick={sendReply} disabled={saving || !reply.trim()}>Отправить</Button>
        </Box>

        {/* Внутренняя заметка */}
        <Box sx={{ display: 'flex', gap: 1, mb: 2, alignItems: 'flex-end' }}>
          <TextField fullWidth size="small" multiline maxRows={3} label="Внутренняя заметка (клиент не видит)"
            value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="outlined" startIcon={<NoteIcon />} onClick={addNote} disabled={saving || !note.trim()}>Заметка</Button>
        </Box>

        <Divider sx={{ mb: 2 }} />

        {/* Напоминания */}
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Напоминания</Typography>
        {s.reminders.map((r) => (
          <Box key={r.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <IconButton size="small" onClick={() => toggleReminder(r.id)} color={r.done ? 'success' : 'default'}>
              <ResolveIcon fontSize="small" />
            </IconButton>
            <ReminderIcon fontSize="small" color={r.done ? 'disabled' : 'warning'} />
            <Typography variant="body2" sx={{ textDecoration: r.done ? 'line-through' : 'none', flex: 1 }}>
              {r.note} — {new Date(r.at).toLocaleString('ru-RU')}
            </Typography>
          </Box>
        ))}
        <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <TextField size="small" label="Текст напоминания" value={reminderNote} onChange={(e) => setReminderNote(e.target.value)} sx={{ flex: 1, minWidth: 180 }} />
          <TextField size="small" type="datetime-local" value={reminderAt} onChange={(e) => setReminderAt(e.target.value)}
            InputLabelProps={{ shrink: true }} label="Когда" />
          <Button size="small" onClick={addReminder} disabled={!reminderNote.trim() || !reminderAt}>Добавить</Button>
        </Box>
      </DialogContent>
      <DialogActions>
        {s.status !== 'resolved' && (
          <Button color="success" startIcon={<ResolveIcon />} onClick={resolve} disabled={saving}>Закрыть обращение</Button>
        )}
        <Button onClick={onClose}>Закрыть окно</Button>
      </DialogActions>
    </Dialog>
  )
}
