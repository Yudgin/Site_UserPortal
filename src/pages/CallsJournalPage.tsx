// Журнал дзвінків (власник): події дзвінків від 1С/Binotel + результати розмов операторів
// (зеркало операторского Telegram-бота — етап 1 поглощения; після Б4 події підуть до нас
// напряму, тут же зʼявляться НАШІ правила маршрутизації за категоріями клієнтів).
// Сортування — нові зверху. Фільтри: пошук, «з результатом / без», «непереглянуті», співробітник.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip, Stack, TextField, MenuItem,
} from '@mui/material'
import {
  Home as HomeIcon, Refresh as RefreshIcon, Call as CallIcon, CheckCircle as ReviewedIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { callsService, type CallEvent, type CallResult } from '@/api/callsService'

const PAGE = 50

const fmtDT = (s?: string | null) => {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d.getTime()) ? '' : d.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
}

type Row = { event: CallEvent | null; results: CallResult[]; at: string; phone: string; clientName: string }

export default function CallsJournalPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [events, setEvents] = useState<CallEvent[]>([])
  const [results, setResults] = useState<CallResult[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<'all' | 'withResult' | 'noResult' | 'unreviewed'>('all')
  const [employeeFilter, setEmployeeFilter] = useState('')
  const [shown, setShown] = useState(PAGE)

  const load = useCallback(async () => {
    setLoading(true)
    const [e, r] = await Promise.all([callsService.listEvents(), callsService.listResults()])
    setEvents(e); setResults(r)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { setShown(PAGE) }, [q, mode, employeeFilter])

  // Склейка: рядок = дзвінок (подія) з його результатами; результати без події — окремими рядками.
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
      return { event: e, results: rs, at: e.at || '', phone: e.phone, clientName: e.clientName || '' }
    })
    for (const r of [...orphan, ...results.filter((r) => r.callId && !matched.has(r.id))]) {
      out.push({ event: null, results: [r], at: r.createdAt || '', phone: r.phone, clientName: r.clientName || '' })
    }
    return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''))
  }, [events, results])

  const employees = useMemo(() => {
    const set = new Map<string, string>() // employeeId/employee → label
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
      .filter((r) => {
        if (mode === 'withResult') return r.results.length > 0
        if (mode === 'noResult') return r.results.length === 0
        if (mode === 'unreviewed') return r.results.some((x) => !x.reviewedAt)
        return true
      })
      .filter((r) => !employeeFilter || String(r.event?.employeeId || r.event?.employee || '') === employeeFilter)
      .filter((r) => {
        if (!query) return true
        const inPhone = qDigits.length >= 3 && r.phone.replace(/\D/g, '').includes(qDigits)
        return inPhone
          || r.clientName.toLowerCase().includes(query)
          || r.results.some((x) => x.resultText.toLowerCase().includes(query) || (x.operatorName || '').toLowerCase().includes(query))
          || (r.event?.line || '').toLowerCase().includes(query)
      })
  }, [rows, q, mode, employeeFilter])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для адміністратора.</Alert>
      </Container>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <CallIcon color="primary" />
        <Typography variant="h5" sx={{ flexGrow: 1 }}>Дзвінки</Typography>
        <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>Оновити</Button>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Головна</Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Дзвінки з 1С/Binotel і результати розмов операторів (фіксуються в Telegram-боті).
        Маршрутизацію поки що робить 1С; правила за категоріями клієнтів — наступний етап.
      </Typography>

      <Stack direction="row" spacing={0.5} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap alignItems="center">
        {([['all', `Усі (${rows.length})`],
          ['withResult', `З результатом (${rows.filter((r) => r.results.length).length})`],
          ['noResult', `Без результату (${rows.filter((r) => !r.results.length).length})`],
          ['unreviewed', `Непереглянуті (${rows.filter((r) => r.results.some((x) => !x.reviewedAt)).length})`],
        ] as const).map(([m, label]) => (
          <Chip key={m} label={label} size="small" color={mode === m ? 'primary' : 'default'} onClick={() => setMode(m)} />
        ))}
        <Box sx={{ flexGrow: 1 }} />
        {employees.length > 0 && (
          <TextField select label="Співробітник" value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)} size="small" sx={{ minWidth: 160 }}>
            <MenuItem value="">Усі</MenuItem>
            {employees.map(([id, label]) => <MenuItem key={id} value={id}>{label}</MenuItem>)}
          </TextField>
        )}
        <TextField size="small" placeholder="Пошук: телефон / імʼя / текст / оператор" value={q}
          onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 260 }} />
      </Stack>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : filtered.length === 0 ? (
        <Alert severity="info">
          {rows.length === 0
            ? 'Журнал порожній. Дані зʼявляться, щойно операторський бот почне дублювати події до порталу (потрібен його редеплой з новими env).'
            : 'Нічого не знайдено за фільтром.'}
        </Alert>
      ) : (
        <>
          <Stack spacing={1}>
            {filtered.slice(0, shown).map((r, i) => (
              <Paper key={r.event?.callId || r.results[0]?.id || i} sx={{ p: 1.5 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 105 }}>{fmtDT(r.at)}</Typography>
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
                  {r.results.length === 0 && <Chip size="small" color="warning" variant="outlined" label="без результату" />}
                </Stack>
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
              </Paper>
            ))}
          </Stack>
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
