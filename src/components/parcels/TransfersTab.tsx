// Реєстр передач водієві (§36): коробки з накладними НП (або без) віддаються водієві, він називає одну суму
// за всі — сума ділиться порівну між посилками передачі й показується в журналі як «вартість передачі».
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box, Paper, Stack, Typography, Button, Chip, Alert, CircularProgress, IconButton, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, MenuItem, Autocomplete, FormControlLabel, Switch,
} from '@mui/material'
import { Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, DirectionsBus as BusIcon } from '@mui/icons-material'
import { parcelsApi, type Parcel, type ParcelTransfer, type Currency, type PaidMethod } from '@/api/endpoints/parcels'
import { CURRENCIES, METHOD_LABELS, PAID_METHODS, PAID_METHOD_LABELS, fmtDate, fmtMoney, counterpartyLabel, statusLabel, todayIso } from './parcelUi'

type Edit = {
  id: string | null; date: string; driver: string; driverPhone: string; route: string; cost: string; currency: Currency; parcelIds: string[]; note: string; done: boolean
  paid: boolean; paidAt: string; paidMethod: PaidMethod
}
const blank = (): Edit => ({ id: null, date: todayIso(), driver: '', driverPhone: '', route: '', cost: '', currency: 'EUR', parcelIds: [], note: '', done: false, paid: false, paidAt: todayIso(), paidMethod: 'cash' })
const toEdit = (t: ParcelTransfer, markPaid = false): Edit => ({
  id: t.id, date: t.date, driver: t.driver, driverPhone: t.driverPhone || '', route: t.route || '', cost: String(t.cost), currency: t.currency, parcelIds: t.parcelIds, note: t.note || '', done: t.done,
  paid: markPaid || t.paid === true, paidAt: t.paidAt || todayIso(), paidMethod: t.paidMethod || 'cash',
})

const parcelLabel = (p: Parcel) => `${p.number || METHOD_LABELS[p.method]} · ${counterpartyLabel(p)} · ${statusLabel(p)}`

export default function TransfersTab({ parcels, onChanged }: { parcels: Parcel[]; onChanged: () => void }) {
  const [items, setItems] = useState<ParcelTransfer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<Edit | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await parcelsApi.transfers()
    setLoading(false)
    if (r.ok) { setItems(r.data); setError('') } else setError(r.error)
  }, [])
  useEffect(() => { load() }, [load])

  const byId = useMemo(() => new Map(parcels.map((p) => [p.id, p])), [parcels])
  // У передачу можна додати незавершену посилку, яка ще не в іншій передачі (або вже в цій).
  const candidates = useMemo(
    () => parcels.filter((p) => (!p.final && (!p.transfer || p.transfer.id === edit?.id)) || !!edit?.parcelIds.includes(p.id)),
    [parcels, edit?.id, edit?.parcelIds],
  )
  // Скільки ще винні водіям: суми неоплачених передач за валютами.
  const unpaid = useMemo(() => {
    const byCur = new Map<Currency, number>()
    let n = 0
    for (const t of items) if (!t.paid && t.cost > 0) { byCur.set(t.currency, (byCur.get(t.currency) || 0) + t.cost); n++ }
    return { n, text: [...byCur.entries()].map(([c, v]) => fmtMoney(Math.round(v * 100) / 100, c)).join(' + ') }
  }, [items])
  const share = edit && edit.parcelIds.length ? (Number(edit.cost.replace(',', '.')) || 0) / edit.parcelIds.length : 0

  const save = async () => {
    if (!edit) return
    setBusy(true); setDialogError('')
    const r = await parcelsApi.saveTransfer(edit.id, {
      date: edit.date, driver: edit.driver, driverPhone: edit.driverPhone, route: edit.route,
      cost: Number(edit.cost.replace(',', '.')) || 0, currency: edit.currency, parcelIds: edit.parcelIds, note: edit.note, done: edit.done,
      paid: edit.paid, paidAt: edit.paid ? edit.paidAt : null, paidMethod: edit.paid ? edit.paidMethod : null,
    })
    setBusy(false)
    if (r.ok) { setEdit(null); load(); onChanged() } else setDialogError(r.error)
  }
  const remove = async (t: ParcelTransfer) => {
    if (!window.confirm(`Видалити передачу ${fmtDate(t.date)} (${t.driver})? Посилки залишаться в журналі.`)) return
    const r = await parcelsApi.removeTransfer(t.id)
    if (r.ok) { load(); onChanged() } else setError(r.error)
  }

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
          Передача — це коробки, які ви віддали водієві одним разом. Вкажіть загальну суму, яку назвав водій:
          вона поділиться порівну між посилками.
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setEdit(blank()); setDialogError('') }}>Нова передача</Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {!loading && unpaid.n > 0 && <Alert severity="warning" sx={{ mb: 2 }}>Не оплачено водіям: {unpaid.text} ({unpaid.n} {unpaid.n === 1 ? 'передача' : 'передач'}).</Alert>}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      ) : items.length === 0 ? (
        <Alert severity="info">Передач ще немає.</Alert>
      ) : (
        <Stack spacing={1.5}>
          {items.map((t) => (
            <Paper key={t.id} sx={{ p: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ gap: 1 }}>
                <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <BusIcon color="primary" fontSize="small" />
                    <Typography variant="subtitle1">{fmtDate(t.date)} · {t.driver}</Typography>
                    <Chip size="small" color={t.done ? 'success' : 'info'} label={t.done ? 'виконано' : 'у водія'} />
                    <Chip size="small" variant="outlined" label={`${fmtMoney(t.cost, t.currency)} за ${t.parcelIds.length}`} />
                    {t.paid
                      ? <Chip size="small" color="success" variant="outlined" label={`оплачено ${fmtDate(t.paidAt)}${t.paidMethod ? ` · ${PAID_METHOD_LABELS[t.paidMethod]}` : ''}`} />
                      : <Chip size="small" color="warning" label="не оплачено" />}
                  </Stack>
                  {(t.route || t.driverPhone) && <Typography variant="body2" color="text.secondary">{[t.route, t.driverPhone].filter(Boolean).join(' · ')}</Typography>}
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {t.parcelIds.map((id) => {
                      const p = byId.get(id)
                      return <Chip key={id} size="small" label={`${p ? p.number || METHOD_LABELS[p.method] : id} · ${fmtMoney(t.shares?.[id], t.currency)}`} />
                    })}
                  </Stack>
                  {t.note && <Typography variant="body2">{t.note}</Typography>}
                </Stack>
                <Stack direction="row" alignItems="center">
                  {!t.paid && <Button size="small" onClick={() => { setDialogError(''); setEdit(toEdit(t, true)) }}>Оплачено</Button>}
                  <IconButton size="small" aria-label="Редагувати" onClick={() => { setDialogError(''); setEdit(toEdit(t)) }}><EditIcon fontSize="small" /></IconButton>
                  <IconButton size="small" aria-label="Видалити" onClick={() => remove(t)}><DeleteIcon fontSize="small" /></IconButton>
                </Stack>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      <Dialog open={!!edit} onClose={() => setEdit(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{edit?.id ? 'Передача водієві' : 'Нова передача водієві'}</DialogTitle>
        {edit && (
          <DialogContent dividers>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField label="Дата" type="date" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} size="small" fullWidth InputLabelProps={{ shrink: true }} />
                <TextField label="Водій або перевізник" value={edit.driver} onChange={(e) => setEdit({ ...edit, driver: e.target.value })} size="small" fullWidth />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField label="Телефон водія" value={edit.driverPhone} onChange={(e) => setEdit({ ...edit, driverPhone: e.target.value })} size="small" fullWidth />
                <TextField label="Маршрут" value={edit.route} onChange={(e) => setEdit({ ...edit, route: e.target.value })} size="small" fullWidth placeholder="Берлін → Київ" />
              </Stack>
              <Autocomplete
                multiple disableCloseOnSelect size="small" options={candidates} value={edit.parcelIds.map((id) => byId.get(id)).filter((p): p is Parcel => !!p)}
                getOptionLabel={parcelLabel} isOptionEqualToValue={(a, b) => a.id === b.id}
                onChange={(_e, v) => setEdit({ ...edit, parcelIds: v.map((p) => p.id) })}
                renderInput={(params) => <TextField {...params} label="Посилки в передачі" placeholder="номер або імʼя" />}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField label="Загальна сума" value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} size="small" fullWidth inputMode="decimal"
                  helperText={edit.parcelIds.length ? `≈ ${fmtMoney(Math.round(share * 100) / 100, edit.currency)} на посилку` : 'додайте посилки'} />
                <TextField select label="Валюта" value={edit.currency} onChange={(e) => setEdit({ ...edit, currency: e.target.value as Currency })} size="small" sx={{ minWidth: 110 }}>
                  {CURRENCIES.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                </TextField>
              </Stack>
              <TextField label="Нотатка" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} size="small" fullWidth multiline minRows={1} />
              <FormControlLabel control={<Switch checked={edit.done} onChange={(e) => setEdit({ ...edit, done: e.target.checked })} />} label="Водій усе відправив або передав" />
              <FormControlLabel control={<Switch checked={edit.paid} onChange={(e) => setEdit({ ...edit, paid: e.target.checked })} />} label="Водієві оплачено" />
              {edit.paid && (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField label="Дата оплати" type="date" value={edit.paidAt} onChange={(e) => setEdit({ ...edit, paidAt: e.target.value })} size="small" fullWidth InputLabelProps={{ shrink: true }} />
                  <TextField select label="Як заплатили" value={edit.paidMethod} onChange={(e) => setEdit({ ...edit, paidMethod: e.target.value as PaidMethod })} size="small" fullWidth>
                    {PAID_METHODS.map((m) => <MenuItem key={m} value={m}>{PAID_METHOD_LABELS[m]}</MenuItem>)}
                  </TextField>
                </Stack>
              )}
              {dialogError && <Alert severity="error">{dialogError}</Alert>}
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setEdit(null)}>Скасувати</Button>
          <Button variant="contained" disabled={busy} onClick={save}>Зберегти</Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
