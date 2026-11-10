// Вікна журналу «Посилки»: картка посилки (усі дані, історія, нотатка, привʼязка до заявки) і ручний запис
// (самовивіз, автобус, інше).
import { useEffect, useState } from 'react'
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, Typography, Chip, Divider, TextField, MenuItem,
  Box, Alert, FormControlLabel, Checkbox, Link,
} from '@mui/material'
import { parcelsApi, type Parcel, type ManualParcelPayload, type Currency, type ParcelAccountBrief } from '@/api/endpoints/parcels'
import {
  GROUP_COLOR, METHOD_LABELS, ATTENTION_LABELS, CURRENCIES, fmtDateTime, fmtDate, fmtMoney, statusLabel, directionLabel, todayIso,
} from './parcelUi'

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Box sx={{ display: 'flex', gap: 1, py: 0.25 }}>
    <Typography variant="body2" color="text.secondary" sx={{ minWidth: 150, flexShrink: 0 }}>{label}</Typography>
    <Typography variant="body2" component="div" sx={{ wordBreak: 'break-word' }}>{children}</Typography>
  </Box>
)
const party = (x?: { name?: string; company?: string; phone?: string; city?: string; address?: string }) =>
  [x?.name, x?.company && x.company !== x.name ? x.company : '', x?.phone, x?.city, x?.address].filter(Boolean).join(' · ') || '—'

const CAN_LABELS: Record<string, string> = {
  redirect: 'переадресація', changeEW: 'зміна даних', return: 'повернення', extend: 'продовження зберігання', refuse: 'відмова', trustee: 'інший отримувач',
}

export function ParcelDetailDialog({ parcel, accounts, owner, onClose, onChanged, onEdit, onOpenRequest }: {
  parcel: Parcel | null
  accounts: ParcelAccountBrief[]
  owner: boolean
  onClose: () => void
  onChanged: (p: Parcel) => void
  onEdit: (p: Parcel) => void
  onOpenRequest: (p: Parcel) => void
}) {
  const [note, setNote] = useState('')
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setNote(parcel?.note || ''); setRequestId(parcel?.link?.serviceRequestId || ''); setError('') }, [parcel])
  if (!parcel) return null
  const p = parcel
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name || id
  const can = Object.entries(p.can || {}).filter(([, v]) => v).map(([k]) => CAN_LABELS[k] || k)

  const saveMeta = async () => {
    setBusy(true); setError('')
    const r = await parcelsApi.setMeta(p.id, { note, serviceRequestId: requestId.trim() })
    setBusy(false)
    if (r.ok) onChanged(r.data); else setError(r.error)
  }

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <span>{p.number || METHOD_LABELS[p.method]}</span>
          <Chip size="small" color={GROUP_COLOR[p.group]} label={statusLabel(p)} />
          {p.private && <Chip size="small" variant="outlined" label="особиста" />}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {p.attention.length > 0 && <Alert severity="warning" sx={{ mb: 1.5 }}>{p.attention.map((a) => ATTENTION_LABELS[a]).join(' · ')}</Alert>}
        <Row label="Спосіб">{METHOD_LABELS[p.method]} · {directionLabel(p)}</Row>
        {p.accountIds.length > 0 && <Row label="Акаунт">{p.accountIds.map(accName).join(', ')}</Row>}
        <Row label="Відправник">{party(p.sender)}</Row>
        <Row label="Одержувач">{party(p.recipient)}</Row>
        <Row label="Опис">{p.description || '—'}</Row>
        <Divider sx={{ my: 1 }} />
        <Row label="Створена">{p.manual ? fmtDate(p.createdAt) : fmtDateTime(p.createdAt)}</Row>
        {p.scheduledAt && <Row label="Планова доставка">{fmtDateTime(p.scheduledAt)}</Row>}
        {p.arrivedAt && <Row label="Прибула">{fmtDateTime(p.arrivedAt)}</Row>}
        {p.receivedAt && <Row label="Отримана">{fmtDateTime(p.receivedAt)}</Row>}
        {p.storageFrom && <Row label="Платне зберігання з">{fmtDate(p.storageFrom)}</Row>}
        {p.autoReturnAt && <Row label="Автоповернення">{fmtDateTime(p.autoReturnAt)}</Row>}
        <Divider sx={{ my: 1 }} />
        <Row label="Оголошена вартість">{fmtMoney(p.declaredCost)}</Row>
        <Row label="Накладений платіж">{fmtMoney(p.cod)}</Row>
        {p.method === 'np' && <Row label="Доставка НП">{fmtMoney(p.deliveryCost)}{p.payer ? ` · платить ${p.payer === 'Sender' ? 'відправник' : p.payer === 'Recipient' ? 'одержувач' : 'третя особа'}` : ''}{p.payStatus === 'NeedPayment' ? ' · не оплачено' : ''}</Row>}
        {p.transfer && <Row label="Передача водієві">{fmtDate(p.transfer.date)} · {p.transfer.driver} · частка {fmtMoney(p.transfer.share, p.transfer.currency)}</Row>}
        {p.extraCost && <Row label="Вартість передачі">{fmtMoney(p.extraCost.amount, p.extraCost.currency)}</Row>}
        {(p.weight || p.seats) ? <Row label="Вага / місць">{p.weight ? `${p.weight} кг` : '—'} / {p.seats || '—'}</Row> : null}
        {can.length > 0 && <Row label="НП дозволяє">{can.join(', ')}</Row>}
        {p.link && (
          <Row label="Привʼязка">
            <Link component="button" onClick={() => onOpenRequest(p)}>
              {p.link.boatOrderId ? 'Замовлення кораблика' : 'Заявка'}{p.link.title ? ` · ${p.link.title}` : ''}
            </Link>
          </Row>
        )}
        {(p.history?.length || 0) > 1 && (
          <>
            <Divider sx={{ my: 1 }} />
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Історія статусів</Typography>
            {p.history!.map((h, i) => <Row key={i} label={fmtDateTime(h.at)}>{h.name || h.code}</Row>)}
          </>
        )}
        {owner && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Stack spacing={1.5}>
              <TextField label="Нотатка" value={note} onChange={(e) => setNote(e.target.value)} size="small" fullWidth multiline minRows={1} />
              <TextField label="Заявка (id), порожньо — зняти привʼязку" value={requestId} onChange={(e) => setRequestId(e.target.value)} size="small" fullWidth />
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </>
        )}
        {!owner && p.note && <Row label="Нотатка">{p.note}</Row>}
      </DialogContent>
      <DialogActions>
        {owner && p.manual && <Button onClick={() => onEdit(p)}>Редагувати запис</Button>}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Закрити</Button>
        {owner && <Button variant="contained" disabled={busy} onClick={saveMeta}>Зберегти</Button>}
      </DialogActions>
    </Dialog>
  )
}

type ManualState = {
  method: 'pickup' | 'bus' | 'other'; direction: 'in' | 'out'; date: string; group: 'draft' | 'transit' | 'received' | 'problem'
  number: string; description: string; name: string; phone: string; city: string; address: string
  declaredCost: string; cod: string; amount: string; currency: Currency; serviceRequestId: string; note: string; private: boolean
}
const blankManual = (): ManualState => ({
  method: 'bus', direction: 'out', date: todayIso(), group: 'transit', number: '', description: '', name: '', phone: '', city: '', address: '',
  declaredCost: '', cod: '', amount: '', currency: 'UAH', serviceRequestId: '', note: '', private: false,
})
const fromParcel = (p: Parcel): ManualState => {
  const cp = p.directions[0] === 'in' ? p.sender : p.recipient
  return {
    method: p.method === 'np' ? 'other' : p.method, direction: p.directions[0] || 'out', date: (p.createdAt || '').slice(0, 10) || todayIso(),
    group: p.group === 'draft' || p.group === 'received' || p.group === 'problem' ? p.group : 'transit',
    number: p.number || '', description: p.description || '', name: cp?.name || '', phone: cp?.phone || '', city: cp?.city || '', address: cp?.address || '',
    declaredCost: p.declaredCost ? String(p.declaredCost) : '', cod: p.cod ? String(p.cod) : '',
    amount: p.extraCost ? String(p.extraCost.amount) : '', currency: p.extraCost?.currency || 'UAH',
    serviceRequestId: p.link?.serviceRequestId || '', note: p.note || '', private: p.private,
  }
}

// Ручний запис: parcel = null → новий; parcel → правка.
export function ManualParcelDialog({ open, parcel, onClose, onSaved, onDeleted }: {
  open: boolean
  parcel: Parcel | null
  onClose: () => void
  onSaved: (p: Parcel) => void
  onDeleted: (id: string) => void
}) {
  const [s, setS] = useState<ManualState>(blankManual())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (open) { setS(parcel ? fromParcel(parcel) : blankManual()); setError('') } }, [open, parcel])
  const set = <K extends keyof ManualState>(k: K, v: ManualState[K]) => setS((x) => ({ ...x, [k]: v }))

  const save = async () => {
    setBusy(true); setError('')
    const payload: ManualParcelPayload = {
      method: s.method, direction: s.direction, date: s.date, group: s.group, number: s.number, description: s.description,
      counterparty: { name: s.name, phone: s.phone, city: s.city, address: s.address },
      declaredCost: s.declaredCost, cod: s.cod, cost: { amount: s.amount, currency: s.currency },
      serviceRequestId: s.serviceRequestId.trim(), note: s.note, private: s.private,
    }
    const r = parcel ? await parcelsApi.updateManual(parcel.id, payload) : await parcelsApi.createManual(payload)
    setBusy(false)
    if (r.ok) onSaved(r.data); else setError(r.error)
  }
  const remove = async () => {
    if (!parcel || !window.confirm('Видалити цей запис із журналу?')) return
    setBusy(true)
    const r = await parcelsApi.removeManual(parcel.id)
    setBusy(false)
    if (r.ok) onDeleted(parcel.id); else setError(r.error)
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{parcel ? 'Ручний запис' : 'Додати вручну'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField select label="Спосіб" value={s.method} onChange={(e) => set('method', e.target.value as ManualState['method'])} size="small" fullWidth>
              <MenuItem value="pickup">Самовивіз</MenuItem>
              <MenuItem value="bus">Автобус</MenuItem>
              <MenuItem value="other">Інше</MenuItem>
            </TextField>
            <TextField select label="Напрям" value={s.direction} onChange={(e) => set('direction', e.target.value as 'in' | 'out')} size="small" fullWidth>
              <MenuItem value="out">Вихідна (від нас)</MenuItem>
              <MenuItem value="in">Вхідна (до нас)</MenuItem>
            </TextField>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField label="Дата" type="date" value={s.date} onChange={(e) => set('date', e.target.value)} size="small" fullWidth InputLabelProps={{ shrink: true }} />
            <TextField select label="Стан" value={s.group} onChange={(e) => set('group', e.target.value as ManualState['group'])} size="small" fullWidth>
              <MenuItem value="draft">Підготовлено</MenuItem>
              <MenuItem value="transit">Передано</MenuItem>
              <MenuItem value="received">Отримано</MenuItem>
              <MenuItem value="problem">Проблема</MenuItem>
            </TextField>
          </Stack>
          <TextField label={s.direction === 'out' ? 'Кому (імʼя)' : 'Від кого (імʼя)'} value={s.name} onChange={(e) => set('name', e.target.value)} size="small" fullWidth />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField label="Телефон" value={s.phone} onChange={(e) => set('phone', e.target.value)} size="small" fullWidth />
            <TextField label="Місто" value={s.city} onChange={(e) => set('city', e.target.value)} size="small" fullWidth />
          </Stack>
          <TextField label="Адреса або місце передачі" value={s.address} onChange={(e) => set('address', e.target.value)} size="small" fullWidth />
          <TextField label="Що передаємо" value={s.description} onChange={(e) => set('description', e.target.value)} size="small" fullWidth />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField label="Номер або рейс" value={s.number} onChange={(e) => set('number', e.target.value)} size="small" fullWidth />
            <TextField label="Заявка (id)" value={s.serviceRequestId} onChange={(e) => set('serviceRequestId', e.target.value)} size="small" fullWidth />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField label="Вартість передачі" value={s.amount} onChange={(e) => set('amount', e.target.value)} size="small" fullWidth inputMode="decimal" />
            <TextField select label="Валюта" value={s.currency} onChange={(e) => set('currency', e.target.value as Currency)} size="small" sx={{ minWidth: 110 }}>
              {CURRENCIES.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
            </TextField>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField label="Оголошена вартість, грн" value={s.declaredCost} onChange={(e) => set('declaredCost', e.target.value)} size="small" fullWidth inputMode="decimal" />
            <TextField label="Отримати з клієнта, грн" value={s.cod} onChange={(e) => set('cod', e.target.value)} size="small" fullWidth inputMode="decimal" />
          </Stack>
          <TextField label="Нотатка" value={s.note} onChange={(e) => set('note', e.target.value)} size="small" fullWidth multiline minRows={1} />
          <FormControlLabel control={<Checkbox checked={s.private} onChange={(e) => set('private', e.target.checked)} />} label="Особиста (бачить лише власник)" />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {parcel && <Button color="error" disabled={busy} onClick={remove}>Видалити</Button>}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Скасувати</Button>
        <Button variant="contained" disabled={busy} onClick={save}>Зберегти</Button>
      </DialogActions>
    </Dialog>
  )
}
