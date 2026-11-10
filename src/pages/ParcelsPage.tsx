// «Посилки» (§36): журнал відправлень — Нова Пошта по всіх ФОП і особистих акаунтах, самовивіз, автобус, інше;
// реєстр передач водієві; акаунти НП. Власник бачить і змінює все; директор бачить лише ділові посилки, привʼязані
// до заявок його центрів (тільки журнал). Дані — через сервер (server/parcels.js).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Chip, Tabs, Tab, TextField, MenuItem,
  ToggleButton, ToggleButtonGroup, Table, TableHead, TableBody, TableRow, TableCell, TableContainer, FormControlLabel,
  Checkbox, Snackbar, Tooltip,
} from '@mui/material'
import { Home as HomeIcon, Add as AddIcon, Sync as SyncIcon, LocalShipping as ShipIcon } from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { useAccess } from '@/store/accessStore'
import { isAdminEmail } from '@/config/access'
import { parcelsApi, type Parcel, type ParcelsList, type ParcelGroup, type ParcelMethod, type ParcelAttention } from '@/api/endpoints/parcels'
import {
  GROUP_LABELS, GROUP_COLOR, METHOD_LABELS, ATTENTION_LABELS, fmtDateTime, fmtDate, fmtMoney, statusLabel, counterpartyLabel, placeLabel, extraCostLabel,
} from '@/components/parcels/parcelUi'
import { ParcelDetailDialog, ManualParcelDialog } from '@/components/parcels/ParcelDialogs'
import TransfersTab from '@/components/parcels/TransfersTab'
import NpAccountsTab from '@/components/parcels/NpAccountsTab'

type Dir = 'all' | 'in' | 'out'
const GROUP_FILTER: ParcelGroup[] = ['draft', 'transit', 'arrived', 'received', 'problem', 'deleted']
const METHOD_FILTER: ParcelMethod[] = ['np', 'pickup', 'bus', 'other']
const PERIODS = [7, 30, 90, 365]

export default function ParcelsPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const access = useAccess()
  const isOwner = !!user && isAdminEmail(user.email)
  const allowed = isOwner || access.role === 'director'

  const [tab, setTab] = useState(0)
  const [list, setList] = useState<ParcelsList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [days, setDays] = useState(30)
  const [syncing, setSyncing] = useState(false)
  const [snack, setSnack] = useState<{ msg: string; sev: 'success' | 'error' } | null>(null)

  const [dir, setDir] = useState<Dir>('all')
  const [account, setAccount] = useState('')
  const [group, setGroup] = useState<ParcelGroup | ''>('')
  const [method, setMethod] = useState<ParcelMethod | ''>('')
  const [codOnly, setCodOnly] = useState(false)
  const [unlinked, setUnlinked] = useState(false)
  const [attention, setAttention] = useState<ParcelAttention | ''>('')
  const [q, setQ] = useState('')

  const [selected, setSelected] = useState<Parcel | null>(null)
  const [manual, setManual] = useState<{ open: boolean; parcel: Parcel | null }>({ open: false, parcel: null })

  const load = useCallback(async (d: number) => {
    setLoading(true)
    const r = await parcelsApi.list(d)
    setLoading(false)
    if (r.ok) { setList(r.data); setError('') } else setError(r.error)
  }, [])
  useEffect(() => { if (allowed) load(days) }, [allowed, days, load])

  const items = useMemo(() => list?.items ?? [], [list])
  const accounts = useMemo(() => list?.accounts ?? [], [list])
  const accName = useCallback((id: string) => accounts.find((a) => a.id === id)?.name || id, [accounts])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const digits = needle.replace(/\D/g, '')
    return items.filter((p) => {
      if (dir !== 'all' && !p.directions.includes(dir)) return false
      if (account && !p.accountIds.includes(account)) return false
      if (group && p.group !== group) return false
      if (method && p.method !== method) return false
      if (codOnly && !p.cod) return false
      if (unlinked && p.link) return false
      if (attention && !p.attention.includes(attention)) return false
      if (needle) {
        const hay = [p.number, p.description, p.note, p.sender?.name, p.sender?.company, p.recipient?.name, p.recipient?.company, p.sender?.city, p.recipient?.city, p.link?.title, p.transfer?.driver]
          .filter(Boolean).join(' ').toLowerCase()
        const phones = `${p.sender?.phone || ''} ${p.recipient?.phone || ''}`.replace(/\D/g, '')
        if (!hay.includes(needle) && !(digits.length >= 4 && (phones.includes(digits) || p.number.includes(digits)))) return false
      }
      return true
    })
  }, [items, dir, account, group, method, codOnly, unlinked, attention, q])

  const attentionCounts = useMemo(() => {
    const m = new Map<ParcelAttention, number>()
    for (const p of items) for (const a of p.attention) m.set(a, (m.get(a) || 0) + 1)
    return [...m.entries()]
  }, [items])

  const sync = async () => {
    setSyncing(true)
    const r = await parcelsApi.sync()
    setSyncing(false)
    if (!r.ok) { setSnack({ msg: r.error, sev: 'error' }); return }
    const bad = r.data.accounts.filter((a) => !a.ok)
    const created = r.data.accounts.reduce((n, a) => n + a.created, 0)
    setSnack(bad.length
      ? { msg: `Оновлено з помилками: ${bad.map((a) => `${a.accounts.map(accName).join(', ')} — ${a.error}`).join('; ')}`, sev: 'error' }
      : { msg: r.data.accounts.length ? `Оновлено. Нових посилок: ${created}` : 'Немає жодного акаунта з ключем Нової Пошти', sev: 'success' })
    load(days)
  }

  const replace = (p: Parcel) => setList((l) => (l ? { ...l, items: l.items.some((x) => x.id === p.id) ? l.items.map((x) => (x.id === p.id ? p : x)) : [p, ...l.items] } : l))
  const openRequest = (p: Parcel) => {
    if (p.link?.boatOrderId) navigate(`/boat-orders/${p.link.boatOrderId}`)
    else if (p.link?.serviceRequestId) navigate(`/service-request/${p.link.serviceRequestId}`)
  }

  if (!user || (!allowed && access.loaded)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Немає доступу до журналу посилок.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, gap: 2, flexWrap: 'wrap' }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <ShipIcon color="primary" />
          <Typography variant="h4">Посилки</Typography>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {isOwner && <Button variant="outlined" startIcon={syncing ? <CircularProgress size={16} /> : <SyncIcon />} disabled={syncing} onClick={sync}>Оновити з НП</Button>}
          {isOwner && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setManual({ open: true, parcel: null })}>Додати вручну</Button>}
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>

      {isOwner && (
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="Журнал" />
          <Tab label="Передачі водієві" />
          <Tab label="Акаунти НП" />
        </Tabs>
      )}

      {tab === 0 && (
        <>
          {attentionCounts.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }} icon={false}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>Потребує уваги:</Typography>
                {attentionCounts.map(([a, n]) => (
                  <Chip key={a} size="small" color={attention === a ? 'warning' : 'default'} variant={attention === a ? 'filled' : 'outlined'}
                    label={`${ATTENTION_LABELS[a]} · ${n}`} onClick={() => setAttention(attention === a ? '' : a)} />
                ))}
              </Stack>
            </Alert>
          )}

          <Paper sx={{ p: 1.5, mb: 2 }}>
            <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
              <ToggleButtonGroup size="small" exclusive value={dir} onChange={(_e, v) => v && setDir(v)}>
                <ToggleButton value="all">Усі</ToggleButton>
                <ToggleButton value="in">Вхідні</ToggleButton>
                <ToggleButton value="out">Вихідні</ToggleButton>
              </ToggleButtonGroup>
              <TextField select size="small" label="Акаунт" value={account} onChange={(e) => setAccount(e.target.value)} sx={{ minWidth: 170 }}>
                <MenuItem value="">Усі акаунти</MenuItem>
                {accounts.map((a) => <MenuItem key={a.id} value={a.id}>{a.name}{a.kind === 'personal' ? ' (особистий)' : ''}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="Стан" value={group} onChange={(e) => setGroup(e.target.value as ParcelGroup | '')} sx={{ minWidth: 150 }}>
                <MenuItem value="">Будь-який</MenuItem>
                {GROUP_FILTER.map((g) => <MenuItem key={g} value={g}>{GROUP_LABELS[g]}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="Спосіб" value={method} onChange={(e) => setMethod(e.target.value as ParcelMethod | '')} sx={{ minWidth: 150 }}>
                <MenuItem value="">Будь-який</MenuItem>
                {METHOD_FILTER.map((m) => <MenuItem key={m} value={m}>{METHOD_LABELS[m]}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="Період" value={days} onChange={(e) => setDays(Number(e.target.value))} sx={{ minWidth: 130 }}>
                {PERIODS.map((d) => <MenuItem key={d} value={d}>{d === 365 ? 'рік' : `${d} днів`}</MenuItem>)}
              </TextField>
              <TextField size="small" label="Пошук: номер, телефон, імʼя" value={q} onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 220, flex: 1 }} />
              <FormControlLabel control={<Checkbox size="small" checked={codOnly} onChange={(e) => setCodOnly(e.target.checked)} />} label="З накладеним платежем" />
              <FormControlLabel control={<Checkbox size="small" checked={unlinked} onChange={(e) => setUnlinked(e.target.checked)} />} label="Без заявки" />
            </Stack>
          </Paper>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {loading && !list ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
          ) : filtered.length === 0 ? (
            <Alert severity="info">
              {items.length === 0
                ? (isOwner ? 'Журнал порожній. Натисніть «Оновити з НП», щоб завантажити посилки, або додайте запис вручну.' : 'Посилок за заявками вашого центру поки немає.')
                : 'За цими фільтрами нічого немає.'}
            </Alert>
          ) : (
            <TableContainer component={Paper}>
              <Table size="small" sx={{ minWidth: 980 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Дата</TableCell>
                    <TableCell>Номер</TableCell>
                    <TableCell>Стан</TableCell>
                    <TableCell>Кому / від кого</TableCell>
                    <TableCell>Місто, відділення</TableCell>
                    <TableCell>Опис</TableCell>
                    <TableCell align="right">Наложка</TableCell>
                    <TableCell align="right">Доставка</TableCell>
                    <TableCell>Акаунт</TableCell>
                    <TableCell>Заявка</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((p) => (
                    <TableRow key={p.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelected(p)}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{p.manual ? fmtDate(p.createdAt) : fmtDateTime(p.createdAt)}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Tooltip title={p.directions.length > 1 ? 'Внутрішня' : p.directions[0] === 'in' ? 'Вхідна' : 'Вихідна'}>
                            <Typography component="span" variant="body2" color={p.directions[0] === 'in' && p.directions.length === 1 ? 'success.main' : 'text.secondary'}>
                              {p.directions.length > 1 ? '⇄' : p.directions[0] === 'in' ? '↓' : '↑'}
                            </Typography>
                          </Tooltip>
                          <span>{p.number || '—'}</span>
                          {p.method !== 'np' && <Chip size="small" variant="outlined" label={METHOD_LABELS[p.method]} />}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Chip size="small" color={GROUP_COLOR[p.group]} label={statusLabel(p)} sx={{ maxWidth: 220 }} />
                          {p.attention.length > 0 && <Tooltip title={p.attention.map((a) => ATTENTION_LABELS[a]).join(' · ')}><Chip size="small" color="warning" label="!" /></Tooltip>}
                        </Stack>
                      </TableCell>
                      <TableCell>{counterpartyLabel(p)}</TableCell>
                      <TableCell sx={{ maxWidth: 240 }}>{placeLabel(p)}</TableCell>
                      <TableCell sx={{ maxWidth: 200 }}>{p.description || '—'}</TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{p.cod ? fmtMoney(p.cod) : ''}</TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        {[p.deliveryCost ? fmtMoney(p.deliveryCost) : '', extraCostLabel(p)].filter(Boolean).join(' + ')}
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {p.accountIds.length ? p.accountIds.map(accName).join(', ') : '—'}
                        {p.private && <Chip size="small" variant="outlined" label="особиста" sx={{ ml: 0.5 }} />}
                      </TableCell>
                      <TableCell>
                        {p.link ? (
                          <Chip size="small" clickable color="primary" variant="outlined" label={p.link.title || (p.link.boatOrderId ? 'замовлення' : 'заявка')}
                            onClick={(e) => { e.stopPropagation(); openRequest(p) }} />
                        ) : ''}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {list && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Показано {filtered.length} з {items.length}: за {list.days} днів і все незавершене.</Typography>}
        </>
      )}

      {isOwner && tab === 1 && <TransfersTab parcels={items} onChanged={() => load(days)} />}
      {isOwner && tab === 2 && <NpAccountsTab onSynced={() => load(days)} />}

      <ParcelDetailDialog
        parcel={selected} accounts={accounts} owner={isOwner} onClose={() => setSelected(null)}
        onChanged={(p) => { replace(p); setSelected(null); setSnack({ msg: 'Збережено', sev: 'success' }) }}
        onEdit={(p) => { setSelected(null); setManual({ open: true, parcel: p }) }}
        onOpenRequest={openRequest}
      />
      <ManualParcelDialog
        open={manual.open} parcel={manual.parcel} onClose={() => setManual({ open: false, parcel: null })}
        onSaved={(p) => { replace(p); setManual({ open: false, parcel: null }); setSnack({ msg: 'Запис збережено', sev: 'success' }) }}
        onDeleted={() => { setManual({ open: false, parcel: null }); setSnack({ msg: 'Запис видалено', sev: 'success' }); load(days) }}
      />
      <Snackbar open={!!snack} autoHideDuration={6000} onClose={() => setSnack(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {snack ? <Alert severity={snack.sev} onClose={() => setSnack(null)}>{snack.msg}</Alert> : undefined}
      </Snackbar>
    </Container>
  )
}
