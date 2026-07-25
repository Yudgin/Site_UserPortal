// «Дзвінки» (власник): канбан + журнал. Два рівні обробки (рішення власника):
//  1) оператор фіксує резюме розмови в Telegram-боті → картка АВТОМАТИЧНО переходить у
//     «Оброблені оператором»;
//  2) власник переглядає СВОЮ ЧЕРГУ — це і «Нові» (без резюме, напр. пропущені), і
//     «Оброблені» — додає свою дію/коментар і відправляє в «Архів».
// Джерела подій: 1С через операторський бот (зеркало) + прямий вебхук Kyivstar FMC.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip, Stack, TextField, MenuItem,
  Tabs, Tab, IconButton, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material'
import {
  Home as HomeIcon, Refresh as RefreshIcon, Call as CallIcon, CheckCircle as ReviewedIcon,
  Archive as ArchiveIcon, Unarchive as UnarchiveIcon, AddComment as NoteIcon, ArrowForward as FwdIcon,
  AssignmentTurnedIn as TaskDoneIcon, Assignment as TaskIcon, Add as AddIcon, Done as DoneIcon,
  History as HistoryIcon, Sailing as BoatIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import {
  callsService, type BotTask, type CallEvent, type CallResult, type CallNote, type CallWorkflowStatus,
} from '@/api/callsService'
import { callsAdminApi } from '@/api/endpoints/callsAdmin'
import { boatOrderService } from '@/api/boatOrderService'
import { serviceApi } from '@/api/endpoints/service'

const PAGE = 50

const fmtDT = (s?: string | null) => {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d.getTime()) ? '' : d.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
}

// Рядок канбану/журналу: подія дзвінка з результатами оператора, або «сирітський» результат.
type Row = {
  key: string
  kind: 'event' | 'result' // де живе workflowStatus/notes (callEvents чи callResults)
  docId: string
  event: CallEvent | null
  results: CallResult[]
  at: string
  phone: string
  clientName: string
  status: CallWorkflowStatus
  notes: CallNote[]
}

const COLUMNS: { key: CallWorkflowStatus; title: string; hint: string }[] = [
  { key: 'new', title: 'Нові', hint: 'без резюме оператора (в т.ч. пропущені)' },
  { key: 'processed', title: 'Оброблені оператором', hint: 'є резюме — додайте дію і в архів' },
  { key: 'archived', title: 'Архів', hint: 'закриті власником' },
]

export default function CallsJournalPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [events, setEvents] = useState<CallEvent[]>([])
  const [results, setResults] = useState<CallResult[]>([])
  const [tasks, setTasks] = useState<BotTask[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<0 | 1 | 2>(0) // 0 = мій канбан, 1 = дошка оператора, 2 = журнал
  const [q, setQ] = useState('')
  const [employeeFilter, setEmployeeFilter] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [e, r, t] = await Promise.all([callsService.listEvents(), callsService.listResults(), callsService.listTasks()])
    setEvents(e); setResults(r); setTasks(t)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { setShown(PAGE) }, [q, employeeFilter, view])

  const rows = useMemo<Row[]>(() => {
    // call.incoming і call.completed одного дзвінка приходять з РІЗНИМИ callId (бот генерує
    // uuid на кожну подію) — приклеюємо «завершено» до найближчого вхідного за телефоном (≤6 год).
    const primaries: CallEvent[] = []
    const completions: CallEvent[] = []
    for (const e of events) (e.lastType === 'call.completed' ? completions : primaries).push({ ...e })
    const leftovers: CallEvent[] = []
    for (const c of completions) {
      const cand = primaries
        .filter((p) => p.phone === c.phone && !p.completedAt && p.at <= c.at
          && Date.parse(c.at) - Date.parse(p.at) < 6 * 3600 * 1000)
        .sort((a, b) => b.at.localeCompare(a.at))[0]
      if (cand) cand.completedAt = c.completedAt || c.at
      else leftovers.push(c)
    }
    const evList = [...primaries, ...leftovers]

    const byCall = new Map<string, CallResult[]>()
    const orphan: CallResult[] = []
    for (const r of results) {
      if (r.callId) {
        const arr = byCall.get(r.callId) || []
        arr.push(r); byCall.set(r.callId, arr)
      } else orphan.push(r)
    }
    const matched = new Set<string>()
    const out: Row[] = evList.map((e) => {
      const rs = (byCall.get(e.callId) || []).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      rs.forEach((r) => matched.add(r.id))
      return {
        key: `e-${e.callId}`, kind: 'event' as const, docId: e.callId,
        event: e, results: rs, at: e.at || '', phone: e.phone, clientName: e.clientName || '',
        status: e.workflowStatus || (rs.length ? 'processed' : 'new'),
        notes: e.notes || [],
      }
    })
    for (const r of [...orphan, ...results.filter((r) => r.callId && !matched.has(r.id))]) {
      out.push({
        key: `r-${r.id}`, kind: 'result' as const, docId: r.id,
        event: null, results: [r], at: r.createdAt || '', phone: r.phone, clientName: r.clientName || '',
        status: r.workflowStatus || 'processed',
        notes: r.notes || [],
      })
    }
    return out.sort((a, b) => (b.at || '').localeCompare(a.at || '')) // нові зверху
  }, [events, results])

  const employees = useMemo(() => {
    const set = new Map<string, string>()
    for (const e of events) {
      const label = e.employee || e.employeeId
      if (label) set.set(String(e.employeeId || e.employee), String(label))
    }
    return [...set.entries()]
  }, [events])

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    const qDigits = query.replace(/\D/g, '')
    return rows
      .filter((r) => !employeeFilter || String(r.event?.employeeId || r.event?.employee || '') === employeeFilter)
      .filter((r) => {
        if (!query) return true
        const inPhone = qDigits.length >= 3 && r.phone.replace(/\D/g, '').includes(qDigits)
        return inPhone
          || r.clientName.toLowerCase().includes(query)
          || r.results.some((x) => x.resultText.toLowerCase().includes(query) || (x.operatorName || '').toLowerCase().includes(query))
          || r.notes.some((n) => n.text.toLowerCase().includes(query))
          || (r.event?.line || '').toLowerCase().includes(query)
      })
  }, [rows, q, employeeFilter])

  // ---- Задачі бота (окремі колонки канбану) ----
  const taskKey = (t: BotTask) => `t-${t.id}`
  const filteredTasks = useMemo(() => {
    const query = q.trim().toLowerCase()
    const qDigits = query.replace(/\D/g, '')
    return tasks.filter((t) => !query
      || t.title.toLowerCase().includes(query)
      || (t.assigneeName || '').toLowerCase().includes(query)
      || (t.clientName || '').toLowerCase().includes(query)
      || (qDigits.length >= 3 && (t.phone || '').replace(/\D/g, '').includes(qDigits))
      || (t.result || '').toLowerCase().includes(query)
      || (t.notes || []).some((n) => n.text.toLowerCase().includes(query)))
  }, [tasks, q])

  const saveTaskWorkflow = async (t: BotTask, patch: Parameters<typeof callsService.updateTask>[1]) => {
    setBusyKey(taskKey(t))
    const ok = await callsService.updateTask(t.id, patch)
    if (ok) setTasks((list) => list.map((x) => (x.id === t.id ? { ...x, ...patch } : x)))
    setBusyKey('')
  }
  const taskMove = async (t: BotTask, status: CallWorkflowStatus) => {
    const draft = (noteDraft[taskKey(t)] || '').trim()
    const notes = draft ? [...(t.notes || []), { text: draft, at: new Date().toISOString(), by: 'власник' }] : t.notes || []
    await saveTaskWorkflow(t, { workflowStatus: status, ...(draft ? { notes } : {}) })
    if (draft) setNoteDraft((d) => ({ ...d, [taskKey(t)]: '' }))
  }
  const taskAddNote = async (t: BotTask) => {
    const draft = (noteDraft[taskKey(t)] || '').trim()
    if (!draft) return
    await saveTaskWorkflow(t, { notes: [...(t.notes || []), { text: draft, at: new Date().toISOString(), by: 'власник' }] })
    setNoteDraft((d) => ({ ...d, [taskKey(t)]: '' }))
  }

  // Створення задачі власником прямо на дошці: сама по собі («+» у колонці) або
  // НА ОСНОВІ ДЗВІНКА (кнопка на картці — клієнт підвʼязується, на дзвінок пишеться дія).
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskDue, setNewTaskDue] = useState('')
  const [newTaskCtx, setNewTaskCtx] = useState<{ phone?: string; clientName?: string; callId?: string; row?: Row } | null>(null)
  const openTaskDialog = (ctx: { phone?: string; clientName?: string; callId?: string; row?: Row } | null) => {
    setNewTaskCtx(ctx); setNewTaskOpen(true)
  }
  const createTask = async () => {
    if (!newTaskTitle.trim()) return
    const t = await callsService.createTask({
      title: newTaskTitle.trim(),
      dueAt: newTaskDue ? new Date(newTaskDue).toISOString() : null,
      phone: newTaskCtx?.phone || null,
      clientName: newTaskCtx?.clientName || null,
      callId: newTaskCtx?.callId || null,
    })
    if (t) {
      setTasks((list) => [t, ...list])
      // На дзвінку лишаємо слід: дія «створено задачу» (видно історію обробки).
      if (newTaskCtx?.row) {
        const row = newTaskCtx.row
        await saveWorkflow(row, { notes: [...row.notes, { text: `📝 Створено задачу: ${t.title}`, at: new Date().toISOString(), by: 'власник' }] })
      }
      setNewTaskOpen(false); setNewTaskTitle(''); setNewTaskDue(''); setNewTaskCtx(null)
    }
  }
  // «Виконано» — только для задач, созданных на портале (portal-*): задачи из бота
  // выполняются в Telegram, иначе статусы разъедутся.
  const taskMarkDone = async (t: BotTask) => {
    const draft = (noteDraft[taskKey(t)] || '').trim()
    await saveTaskWorkflow(t, {
      status: 'done', result: draft || 'виконано',
      doneAt: new Date().toISOString(), doneByName: 'Власник',
    })
    if (draft) setNoteDraft((d) => ({ ...d, [taskKey(t)]: '' }))
  }

  // Локально применить патч воркфлоу к источнику строки (без перезагрузки).
  const applyLocal = (row: Row, patch: { workflowStatus?: CallWorkflowStatus; notes?: CallNote[] }) => {
    if (row.kind === 'event') setEvents((list) => list.map((e) => (e.callId === row.docId ? { ...e, ...patch } : e)))
    else setResults((list) => list.map((r) => (r.id === row.docId ? { ...r, ...patch } : r)))
  }

  const saveWorkflow = async (row: Row, patch: { workflowStatus?: CallWorkflowStatus; notes?: CallNote[] }) => {
    setBusyKey(row.key)
    const ok = row.kind === 'event'
      ? await callsService.updateEvent(row.docId, patch)
      : await callsService.updateResult(row.docId, patch)
    if (ok) applyLocal(row, patch)
    setBusyKey('')
  }

  // Коментар до дзвінка йде через backend: зберігається в журналі І автоматично
  // відправляється в 1С як результат розмови (рішення власника — КОЖЕН коментар).
  const postCallNote = async (row: Row, text: string): Promise<boolean> => {
    setBusyKey(row.key)
    const r = await callsAdminApi.addNote({ kind: row.kind, docId: row.docId, text })
    if (r.ok && r.note) applyLocal(row, { notes: [...row.notes, r.note] })
    setBusyKey('')
    return r.ok
  }

  // Перемещение: если в поле набрана дія — она сохраняется (и уходит в 1С) тем же действием.
  const moveTo = async (row: Row, status: CallWorkflowStatus) => {
    const draft = (noteDraft[row.key] || '').trim()
    if (draft) {
      const ok = await postCallNote(row, draft)
      if (ok) setNoteDraft((d) => ({ ...d, [row.key]: '' }))
    }
    await saveWorkflow(row, { workflowStatus: status })
  }
  const addNote = async (row: Row) => {
    const draft = (noteDraft[row.key] || '').trim()
    if (!draft) return
    const ok = await postCallNote(row, draft)
    if (ok) setNoteDraft((d) => ({ ...d, [row.key]: '' }))
  }

  // Історія обращений клієнта з 1С (дзвінки/консультації) — за телефоном.
  const [histOpen, setHistOpen] = useState(false)
  const [histLoading, setHistLoading] = useState(false)
  const [histPhone, setHistPhone] = useState('')
  const [histItems, setHistItems] = useState<{ Desc: string; Date: string }[]>([])
  const openHistory = async (phone: string) => {
    setHistPhone(phone); setHistItems([]); setHistOpen(true); setHistLoading(true)
    const r = await serviceApi.getRepairHistory(phone)
    setHistItems(r.success && r.data ? r.data : [])
    setHistLoading(false)
  }

  // Лід на купівлю кораблика прямо зі дзвінка: створюємо замовлення в статусі «Лід»
  // з клієнтом із картки, відкриваємо картку замовлення в новій вкладці (дошка лишається).
  const createBoatLead = async (row: Row) => {
    setBusyKey(row.key)
    const now = new Date().toISOString()
    const res = await boatOrderService.save({
      clientName: row.clientName || '',
      clientPhone: row.phone || '',
      lines: [], total: 0,
      status: 'lead',
      statusHistory: [{ status: 'lead', at: now }],
      note: `Лід зі дзвінка ${fmtDT(row.at)}`,
    })
    if (res) {
      await saveWorkflow(row, { notes: [...row.notes, { text: '⛵ Створено лід на купівлю кораблика', at: now, by: 'власник' }] })
      window.open(`/boat-orders/${res.id}`, '_blank')
    }
    setBusyKey('')
  }

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для адміністратора.</Alert>
      </Container>
    )
  }

  // operatorMode — спрощена дошка оператора: лише коментар і «Обробити», без архіву/задач.
  const renderCard = (r: Row, inKanban: boolean, operatorMode = false) => (
    <Paper key={r.key} sx={{ p: 1.5, opacity: busyKey === r.key ? 0.6 : 1 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="caption" color="text.secondary">{fmtDT(r.at)}</Typography>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {r.clientName || '—'} · {r.phone || '—'}
        </Typography>
        {r.event?.direction === 'outgoing' && <Chip size="small" variant="outlined" color="info" label="вихідний" />}
        {r.event?.employee && <Chip size="small" variant="outlined" label={r.event.employee} />}
        {!r.event?.employee && r.event?.employeeId && <Chip size="small" variant="outlined" label={`вн. ${r.event.employeeId}`} />}
        {r.event?.line && <Chip size="small" variant="outlined" label={`лінія ${r.event.line}`} />}
        {r.event?.source === 'kyivstar' && r.event?.completedAt && !r.event?.answeredAt && (
          <Chip size="small" color="error" variant="outlined" label="без відповіді" />
        )}
        {!inKanban && r.status === 'archived' && <Chip size="small" variant="outlined" icon={<ArchiveIcon />} label="архів" />}
      </Stack>

      {/* Резюме операторів (з бота) */}
      {r.results.map((x) => (
        <Box key={x.id} sx={{ mt: 1, pl: 1.5, borderLeft: 2, borderColor: x.reviewedAt ? 'success.main' : 'warning.main' }}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{x.resultText}</Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.25 }} flexWrap="wrap" useFlexGap>
            <Typography variant="caption" color="text.secondary">
              {x.operatorName || 'оператор'} · {fmtDT(x.createdAt)}
            </Typography>
            {x.reviewedAt
              ? <Chip size="small" color="success" variant="outlined" icon={<ReviewedIcon />} label={`Прийнято${x.reviewedByName ? ` · ${x.reviewedByName}` : ''}`} />
              : <Chip size="small" color="warning" variant="outlined" label="очікує перегляду" />}
            {x.sentTo1C === false && <Chip size="small" color="error" variant="outlined" label="не пішло в 1С" />}
          </Stack>
        </Box>
      ))}

      {/* Дії/коментарі власника (кожен коментар автоматично йде в 1С) */}
      {r.notes.map((n, i) => (
        <Box key={i} sx={{ mt: 1, pl: 1.5, borderLeft: 2, borderColor: 'info.main' }}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{n.text}</Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" color="text.secondary">{n.by || 'власник'} · {fmtDT(n.at)}</Typography>
            {n.sentTo1C === true && <Chip size="small" variant="outlined" color="success" label="→ 1С" sx={{ height: 18 }} />}
            {n.sentTo1C === false && <Chip size="small" variant="outlined" color="error" label="не пішло в 1С" sx={{ height: 18 }} />}
          </Stack>
        </Box>
      ))}

      {/* Дія + перемещения */}
      {inKanban && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="center">
          <TextField size="small" fullWidth placeholder="Додати дію / коментар…"
            value={noteDraft[r.key] || ''}
            onChange={(e) => setNoteDraft((d) => ({ ...d, [r.key]: e.target.value }))} />
          <Tooltip title="Зберегти коментар">
            <span><IconButton size="small" color="info" disabled={!(noteDraft[r.key] || '').trim() || busyKey === r.key} onClick={() => addNote(r)}><NoteIcon fontSize="small" /></IconButton></span>
          </Tooltip>
          {r.phone && (
            <Tooltip title="Історія обращень з 1С">
              <span><IconButton size="small" disabled={busyKey === r.key} onClick={() => openHistory(r.phone)}><HistoryIcon fontSize="small" /></IconButton></span>
            </Tooltip>
          )}
          {!operatorMode && (
            <Tooltip title="Лід на купівлю кораблика">
              <span><IconButton size="small" color="primary" disabled={busyKey === r.key} onClick={() => createBoatLead(r)}>
                <BoatIcon fontSize="small" /></IconButton></span>
            </Tooltip>
          )}
          {!operatorMode && (
            <Tooltip title="Створити задачу з дзвінка">
              <span><IconButton size="small" color="primary" disabled={busyKey === r.key}
                onClick={() => openTaskDialog({ phone: r.phone, clientName: r.clientName, callId: r.event?.callId, row: r })}>
                <TaskIcon fontSize="small" /></IconButton></span>
            </Tooltip>
          )}
          {r.status === 'new' && (
            <Tooltip title={operatorMode ? 'Обробити (коментар збережеться)' : 'В «Оброблені»'}>
              <span><IconButton size="small" color={operatorMode ? 'success' : 'default'} disabled={busyKey === r.key} onClick={() => moveTo(r, 'processed')}><FwdIcon fontSize="small" /></IconButton></span>
            </Tooltip>
          )}
          {!operatorMode && (r.status !== 'archived' ? (
            <Tooltip title="В архів (з коментарем, якщо набрано)">
              <span><IconButton size="small" color="success" disabled={busyKey === r.key} onClick={() => moveTo(r, 'archived')}><ArchiveIcon fontSize="small" /></IconButton></span>
            </Tooltip>
          ) : (
            <Tooltip title="Повернути в «Оброблені»">
              <span><IconButton size="small" disabled={busyKey === r.key} onClick={() => moveTo(r, 'processed')}><UnarchiveIcon fontSize="small" /></IconButton></span>
            </Tooltip>
          ))}
        </Stack>
      )}
    </Paper>
  )

  // Картка задачі бота (завдання/нагадування): виконавець, строк, результат, дії власника.
  const renderTaskCard = (t: BotTask) => (
    <Paper key={t.id} sx={{ p: 1.5, opacity: busyKey === taskKey(t) ? 0.6 : 1 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {t.status === 'done' ? <TaskDoneIcon fontSize="small" color="success" /> : <TaskIcon fontSize="small" color="action" />}
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>{t.title}</Typography>
        <Chip size="small" variant="outlined" label={t.kind === 'reminder' ? 'нагадування' : 'завдання'} />
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }} alignItems="center" flexWrap="wrap" useFlexGap>
        {(t.clientName || t.phone) && (
          <Chip size="small" variant="outlined" color="info" icon={<CallIcon />}
            label={`${t.clientName ? `${t.clientName} · ` : ''}${t.phone || ''}`} />
        )}
        {t.assigneeName && <Chip size="small" label={t.assigneeName} />}
        <Typography variant="caption" color="text.secondary">
          {t.creatorName ? `від: ${t.creatorName} · ` : ''}{fmtDT(t.createdAt)}
        </Typography>
        {t.dueAt && (
          <Chip size="small" variant="outlined"
            color={t.status === 'open' && t.dueAt < new Date().toISOString() ? 'error' : 'default'}
            label={`строк: ${fmtDT(t.dueAt)}`} />
        )}
      </Stack>
      {t.status === 'done' && (
        <Box sx={{ mt: 1, pl: 1.5, borderLeft: 2, borderColor: 'success.main' }}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{t.result || 'виконано'}</Typography>
          <Typography variant="caption" color="text.secondary">{t.doneByName || 'виконавець'} · {fmtDT(t.doneAt)}</Typography>
        </Box>
      )}
      {(t.notes || []).map((n, i) => (
        <Box key={i} sx={{ mt: 1, pl: 1.5, borderLeft: 2, borderColor: 'info.main' }}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{n.text}</Typography>
          <Typography variant="caption" color="text.secondary">{n.by || 'власник'} · {fmtDT(n.at)}</Typography>
        </Box>
      ))}
      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="center">
        <TextField size="small" fullWidth placeholder="Додати дію / коментар…"
          value={noteDraft[taskKey(t)] || ''}
          onChange={(e) => setNoteDraft((d) => ({ ...d, [taskKey(t)]: e.target.value }))} />
        <Tooltip title="Зберегти коментар">
          <span><IconButton size="small" color="info" disabled={!(noteDraft[taskKey(t)] || '').trim() || busyKey === taskKey(t)} onClick={() => taskAddNote(t)}><NoteIcon fontSize="small" /></IconButton></span>
        </Tooltip>
        {t.status === 'open' && t.id.startsWith('portal-') && (
          <Tooltip title="Виконано (текст у полі стане результатом)">
            <span><IconButton size="small" color="success" disabled={busyKey === taskKey(t)} onClick={() => taskMarkDone(t)}><DoneIcon fontSize="small" /></IconButton></span>
          </Tooltip>
        )}
        {t.workflowStatus !== 'archived' ? (
          <Tooltip title="В архів (з коментарем, якщо набрано)">
            <span><IconButton size="small" color="success" disabled={busyKey === taskKey(t)} onClick={() => taskMove(t, 'archived')}><ArchiveIcon fontSize="small" /></IconButton></span>
          </Tooltip>
        ) : (
          <Tooltip title="Повернути">
            <span><IconButton size="small" disabled={busyKey === taskKey(t)} onClick={() => taskMove(t, 'processed')}><UnarchiveIcon fontSize="small" /></IconButton></span>
          </Tooltip>
        )}
      </Stack>
    </Paper>
  )

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <CallIcon color="primary" />
        <Typography variant="h5" sx={{ flexGrow: 1 }}>Дзвінки</Typography>
        <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>Оновити</Button>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Головна</Button>
      </Stack>

      <Paper sx={{ mb: 2 }}>
        <Tabs value={view} onChange={(_, v) => setView(v)} variant="fullWidth">
          <Tab label={`Мій канбан (${rows.filter((r) => r.status !== 'archived').length + tasks.filter((t) => t.workflowStatus !== 'archived').length})`} />
          <Tab label={`Дошка оператора (${rows.filter((r) => r.status === 'new').length})`} />
          <Tab label={`Журнал (${rows.length})`} />
        </Tabs>
      </Paper>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap alignItems="center">
        {employees.length > 0 && (
          <TextField select label="Співробітник" value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)} size="small" sx={{ minWidth: 160 }}>
            <MenuItem value="">Усі</MenuItem>
            {employees.map(([id, label]) => <MenuItem key={id} value={id}>{label}</MenuItem>)}
          </TextField>
        )}
        <TextField size="small" placeholder="Пошук: телефон / імʼя / текст / оператор" value={q}
          onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 260, flexGrow: 1 }} />
      </Stack>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : rows.length === 0 ? (
        <Alert severity="info">Журнал порожній — дзвінки зʼявляться автоматично (1С/бот та Kyivstar).</Alert>
      ) : view === 0 ? (
        /* ---- КАНБАН ---- */
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="stretch">
          {COLUMNS.map((col) => {
            const items = filtered.filter((r) => r.status === col.key)
            return (
              <Box key={col.key} sx={{ flex: 1, minWidth: 0 }}>
                <Paper sx={{ p: 1.5, bgcolor: 'action.hover', mb: 1 }}>
                  <Typography variant="subtitle2">{col.title} ({items.length})</Typography>
                  <Typography variant="caption" color="text.secondary">{col.hint}</Typography>
                </Paper>
                <Stack spacing={1} sx={{ maxHeight: '70vh', overflowY: 'auto', pr: 0.5 }}>
                  {items.length === 0
                    ? <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>порожньо</Typography>
                    : items.slice(0, col.key === 'archived' ? 30 : 200).map((r) => renderCard(r, true))}
                  {col.key === 'archived' && items.length > 30 && (
                    <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
                      …ще {items.length - 30} в архіві (повний список — у «Журналі»)
                    </Typography>
                  )}
                </Stack>
              </Box>
            )
          })}

          {/* ---- Колонки задач (зеркало задач/нагадувань операторського бота) ---- */}
          {(() => {
            const open = filteredTasks.filter((t) => t.status === 'open' && t.workflowStatus !== 'archived')
            const done = filteredTasks.filter((t) => t.status === 'done' && t.workflowStatus !== 'archived')
            const archivedCount = filteredTasks.filter((t) => t.workflowStatus === 'archived').length
            return (
              <>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Paper sx={{ p: 1.5, bgcolor: 'action.hover', mb: 1 }}>
                    <Stack direction="row" alignItems="center">
                      <Box sx={{ flexGrow: 1 }}>
                        <Typography variant="subtitle2">Задачі в роботі ({open.length})</Typography>
                        <Typography variant="caption" color="text.secondary">з бота та створені тут</Typography>
                      </Box>
                      <Tooltip title="Нова задача (собі)">
                        <IconButton size="small" color="primary" onClick={() => setNewTaskOpen(true)}><AddIcon /></IconButton>
                      </Tooltip>
                    </Stack>
                  </Paper>
                  <Stack spacing={1} sx={{ maxHeight: '70vh', overflowY: 'auto', pr: 0.5 }}>
                    {open.length === 0
                      ? <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>порожньо</Typography>
                      : open.map(renderTaskCard)}
                  </Stack>
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Paper sx={{ p: 1.5, bgcolor: 'action.hover', mb: 1 }}>
                    <Typography variant="subtitle2">Задачі виконані ({done.length})</Typography>
                    <Typography variant="caption" color="text.secondary">перегляньте результат і в архів</Typography>
                  </Paper>
                  <Stack spacing={1} sx={{ maxHeight: '70vh', overflowY: 'auto', pr: 0.5 }}>
                    {done.length === 0
                      ? <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>порожньо</Typography>
                      : done.map(renderTaskCard)}
                    {archivedCount > 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>
                        в архіві задач: {archivedCount}
                      </Typography>
                    )}
                  </Stack>
                </Box>
              </>
            )
          })()}
        </Stack>
      ) : view === 1 ? (
        /* ---- ДОШКА ОПЕРАТОРА: лише необроблені/оброблені, без архіву і задач ---- */
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="stretch">
          {([
            { key: 'new' as const, title: 'Необроблені', hint: 'зафіксуйте результат розмови і обробіть' },
            { key: 'processed' as const, title: 'Оброблені', hint: 'з коментарем — далі їх переглядає власник' },
          ]).map((col) => {
            const items = filtered.filter((r) => r.status === col.key)
            return (
              <Box key={col.key} sx={{ flex: 1, minWidth: 0 }}>
                <Paper sx={{ p: 1.5, bgcolor: 'action.hover', mb: 1 }}>
                  <Typography variant="subtitle2">{col.title} ({items.length})</Typography>
                  <Typography variant="caption" color="text.secondary">{col.hint}</Typography>
                </Paper>
                <Stack spacing={1} sx={{ maxHeight: '70vh', overflowY: 'auto', pr: 0.5 }}>
                  {items.length === 0
                    ? <Typography variant="caption" color="text.secondary" sx={{ px: 1 }}>порожньо</Typography>
                    : items.slice(0, 200).map((r) => renderCard(r, true, true))}
                </Stack>
              </Box>
            )
          })}
        </Stack>
      ) : (
        /* ---- ЖУРНАЛ ---- */
        <>
          <Stack spacing={1}>
            {filtered.slice(0, shown).map((r) => renderCard(r, false))}
          </Stack>
          {filtered.length > shown && (
            <Box sx={{ textAlign: 'center', mt: 2 }}>
              <Button onClick={() => setShown((n) => n + PAGE)}>Показати ще ({filtered.length - shown})</Button>
            </Box>
          )}
        </>
      )}

      {/* Діалог «Нова задача» (створюється власником на дошці; в Telegram не доставляється) */}
      <Dialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{newTaskCtx?.phone || newTaskCtx?.clientName ? 'Задача з дзвінка' : 'Нова задача'}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {(newTaskCtx?.phone || newTaskCtx?.clientName) && (
              <Chip icon={<CallIcon />} color="info" variant="outlined"
                label={`Клієнт: ${newTaskCtx?.clientName ? `${newTaskCtx.clientName} · ` : ''}${newTaskCtx?.phone || ''}`} />
            )}
            <TextField label="Що зробити" value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)}
              size="small" fullWidth autoFocus multiline
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); createTask() } }} />
            <TextField label="Строк (необовʼязково)" type="datetime-local" value={newTaskDue}
              onChange={(e) => setNewTaskDue(e.target.value)} size="small" fullWidth InputLabelProps={{ shrink: true }} />
            <Typography variant="caption" color="text.secondary">
              Задача зʼявиться в колонці «Задачі в роботі»; закриєте її кнопкою «Виконано» на картці.
              Задачі для операторів із доставкою в Telegram — створюйте поки що з карток дзвінків у боті.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewTaskOpen(false)}>Скасувати</Button>
          <Button variant="contained" onClick={createTask} disabled={!newTaskTitle.trim()}>Створити</Button>
        </DialogActions>
      </Dialog>

      {/* Історія обращень клієнта з 1С (дзвінки, консультації тощо) — за телефоном */}
      <Dialog open={histOpen} onClose={() => setHistOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Історія з 1С · {histPhone}</DialogTitle>
        <DialogContent dividers>
          {histLoading ? (
            <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress size={28} /></Box>
          ) : histItems.length === 0 ? (
            <Alert severity="info">Історії по цьому номеру в 1С немає (або 1С недоступна).</Alert>
          ) : (
            <Stack spacing={1.5}>
              {histItems.map((h, i) => (
                <Box key={i} sx={{ pl: 1.5, borderLeft: 2, borderColor: 'divider' }}>
                  <Typography variant="caption" color="text.secondary">{fmtDT(h.Date) || h.Date}</Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{h.Desc}</Typography>
                </Box>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistOpen(false)}>Закрити</Button>
        </DialogActions>
      </Dialog>
    </Container>
  )
}
