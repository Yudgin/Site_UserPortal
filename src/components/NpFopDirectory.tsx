// Справочник Новой Почты для конкретного ФОП (в диалоге настроек ФОП). Позволяет:
//  • синхронизировать отправителей (контрагентов) кабинета НП по ключу этого ФОП и выбрать из списка;
//  • подтянуть контакты выбранного отправителя и выбрать (заполняет телефон);
//  • добавить нового отправителя (контрагента) или контакт прямо здесь;
//  • выбрать город+отделение отправителя пикером (без ручного ввода Ref).
// Ключ НП по умолчанию берётся сохранённый; если владелец ввёл новый и ещё не сохранил — передаём его.
import { useState } from 'react'
import {
  Stack, TextField, MenuItem, Button, CircularProgress, Typography, Alert, Box, IconButton,
  Dialog, DialogTitle, DialogContent, DialogActions, ToggleButtonGroup, ToggleButton,
} from '@mui/material'
import { Sync as SyncIcon, PersonAdd as PersonAddIcon } from '@mui/icons-material'
import NpAddressPicker from '@/components/NpAddressPicker'
import { npAccountApi, type NpSender, type NpContact } from '@/api/endpoints/npAccount'
import type { FopNovaPoshtaRefs } from '@/api/endpoints/fopsAdmin'
import type { NpAddress } from '@/types/npTemplate'

type AddState =
  | { kind: 'sender'; type: 'org' | 'person'; edrpou: string; firstName: string; lastName: string; middleName: string; phone: string }
  | { kind: 'contact'; firstName: string; lastName: string; middleName: string; phone: string }

export default function NpFopDirectory({ fopId, np, onChange, apiKeySet, typedApiKey }: {
  fopId: string
  np: FopNovaPoshtaRefs
  onChange: (patch: Partial<FopNovaPoshtaRefs>) => void
  apiKeySet: boolean
  typedApiKey?: string
}) {
  const [senders, setSenders] = useState<NpSender[]>([])
  const [contacts, setContacts] = useState<NpContact[]>([])
  const [busy, setBusy] = useState<'' | 'senders' | 'contacts' | 'add'>('')
  const [err, setErr] = useState('')
  const [add, setAdd] = useState<AddState | null>(null)

  const key = (typedApiKey || '').trim() || undefined
  const canSync = !!fopId.trim() && (apiKeySet || !!key)
  const senderLabel = (s: NpSender) => s.Description || `${s.LastName || ''} ${s.FirstName || ''}`.trim() || s.Ref

  const fail = (r: { error?: string; npErrors?: string[] }) => setErr([r.error, ...(r.npErrors || [])].filter(Boolean).join(' · '))

  const syncSenders = async () => {
    setErr(''); setBusy('senders')
    const r = await npAccountApi.senders(fopId, key)
    setBusy('')
    if (r.ok && r.data) setSenders(r.data); else fail(r)
  }

  const syncContacts = async (ref: string) => {
    if (!ref) return
    setErr(''); setBusy('contacts')
    const r = await npAccountApi.contacts(fopId, ref, key)
    setBusy('')
    if (r.ok && r.data) setContacts(r.data); else fail(r)
  }

  const selectSender = (ref: string) => {
    const s = senders.find((x) => x.Ref === ref)
    onChange({ senderRef: ref, senderName: s ? senderLabel(s) : np.senderName, contactRef: '', contactName: '' })
    setContacts([])
    syncContacts(ref)
  }

  const selectContact = (ref: string) => {
    const c = contacts.find((x) => x.Ref === ref)
    onChange({ contactRef: ref, contactName: c?.Description || np.contactName, senderPhone: c?.Phones || np.senderPhone })
  }

  const addr: NpAddress = {
    cityRef: np.cityRef, cityName: np.cityName, settlementRef: np.settlementRef,
    warehouseRef: np.warehouseRef, warehouseName: np.warehouseName,
  }
  const onAddr = (a: NpAddress) => onChange({
    cityRef: a.cityRef, cityName: a.cityName, settlementRef: a.settlementRef,
    warehouseRef: a.warehouseRef, warehouseName: a.warehouseName,
  })

  const submitAdd = async () => {
    if (!add) return
    setErr(''); setBusy('add')
    if (add.kind === 'sender') {
      const r = await npAccountApi.addSender(fopId, {
        type: add.type,
        edrpou: add.type === 'org' ? add.edrpou : undefined,
        firstName: add.type === 'person' ? add.firstName : undefined,
        lastName: add.type === 'person' ? add.lastName : undefined,
        middleName: add.type === 'person' ? add.middleName : undefined,
        phone: add.type === 'person' ? add.phone : undefined,
        cityRef: np.cityRef,
      }, key)
      setBusy('')
      if (r.ok && r.data && r.data[0]) {
        const s = r.data[0]
        onChange({ senderRef: s.Ref, senderName: senderLabel(s), contactRef: '', contactName: '' })
        setAdd(null); syncSenders(); syncContacts(s.Ref)
      } else fail(r)
    } else {
      if (!np.senderRef) { setBusy(''); setErr('Спочатку оберіть відправника'); return }
      const r = await npAccountApi.addContact(fopId, {
        ref: np.senderRef, firstName: add.firstName, lastName: add.lastName, middleName: add.middleName, phone: add.phone,
      }, key)
      setBusy('')
      if (r.ok && r.data && r.data[0]) {
        const c = r.data[0]
        onChange({ contactRef: c.Ref, contactName: c.Description, senderPhone: c.Phones || add.phone || np.senderPhone })
        setAdd(null); syncContacts(np.senderRef)
      } else fail(r)
    }
  }

  return (
    <Stack spacing={1.5}>
      {!canSync && (
        <Alert severity="info" sx={{ py: 0 }}>Введіть ключ НП вище — тоді можна синхронізувати відправників і вибирати зі списку.</Alert>
      )}

      {/* Отправитель (контрагент) */}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField select size="small" fullWidth label="Відправник (контрагент)"
          value={np.senderRef || ''} onChange={(e) => selectSender(e.target.value)}
          disabled={!np.senderRef && senders.length === 0}
          helperText={senders.length ? `Синхронізовано: ${senders.length}` : 'Натисніть «Синхр.», щоб підтягнути зі списку'}>
          {np.senderRef && !senders.some((s) => s.Ref === np.senderRef) && (
            <MenuItem value={np.senderRef}>{np.senderName || np.senderRef}</MenuItem>
          )}
          {senders.map((s) => <MenuItem key={s.Ref} value={s.Ref}>{senderLabel(s)}{s.EDRPOU ? ` · ${s.EDRPOU}` : ''}</MenuItem>)}
        </TextField>
        <Button variant="outlined" size="small" onClick={syncSenders} disabled={!canSync || busy === 'senders'}
          startIcon={busy === 'senders' ? <CircularProgress size={14} /> : <SyncIcon fontSize="small" />} sx={{ whiteSpace: 'nowrap', mt: 0.25 }}>Синхр.</Button>
        <IconButton size="small" color="primary" onClick={() => setAdd({ kind: 'sender', type: 'org', edrpou: '', firstName: '', lastName: '', middleName: '', phone: '' })}
          disabled={!canSync} title="Додати відправника" sx={{ mt: 0.25 }}><PersonAddIcon fontSize="small" /></IconButton>
      </Stack>

      {/* Контакт отправителя */}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField select size="small" fullWidth label="Контакт відправника"
          value={np.contactRef || ''} onChange={(e) => selectContact(e.target.value)}
          disabled={!np.senderRef && !np.contactRef}
          helperText={np.senderRef ? (contacts.length ? `Контактів: ${contacts.length}` : 'Натисніть «Синхр.» контактів') : 'Спершу оберіть відправника'}>
          {np.contactRef && !contacts.some((c) => c.Ref === np.contactRef) && (
            <MenuItem value={np.contactRef}>{np.contactName || np.contactRef}</MenuItem>
          )}
          {contacts.map((c) => <MenuItem key={c.Ref} value={c.Ref}>{c.Description || `${c.LastName || ''} ${c.FirstName || ''}`.trim()}{c.Phones ? ` · ${c.Phones}` : ''}</MenuItem>)}
        </TextField>
        <Button variant="outlined" size="small" onClick={() => syncContacts(np.senderRef || '')} disabled={!np.senderRef || busy === 'contacts'}
          startIcon={busy === 'contacts' ? <CircularProgress size={14} /> : <SyncIcon fontSize="small" />} sx={{ whiteSpace: 'nowrap', mt: 0.25 }}>Синхр.</Button>
        <IconButton size="small" color="primary" onClick={() => setAdd({ kind: 'contact', firstName: '', lastName: '', middleName: '', phone: '' })}
          disabled={!np.senderRef} title="Додати контакт" sx={{ mt: 0.25 }}><PersonAddIcon fontSize="small" /></IconButton>
      </Stack>

      <TextField label="Телефон відправника" value={np.senderPhone || ''} onChange={(e) => onChange({ senderPhone: e.target.value })}
        size="small" fullWidth helperText="Підставляється з контакту; можна змінити" />

      {/* Город + отделение отправителя */}
      <Typography variant="caption" color="text.secondary">Місто та відділення відправника</Typography>
      <NpAddressPicker value={addr} onChange={onAddr} delivery="warehouse" label="Місто відправника" warehouseLabel="Відділення відправника" />

      {err && <Alert severity="error" onClose={() => setErr('')}><Box sx={{ whiteSpace: 'pre-wrap' }}>{err}</Box></Alert>}

      {/* Диалог добавления отправителя/контакта */}
      <Dialog open={!!add} onClose={() => setAdd(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{add?.kind === 'sender' ? 'Новий відправник (НП)' : 'Новий контакт відправника'}</DialogTitle>
        <DialogContent dividers>
          {add?.kind === 'sender' ? (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <ToggleButtonGroup exclusive size="small" value={add.type} onChange={(_, v) => v && setAdd({ ...add, type: v })}>
                <ToggleButton value="org">Організація (ЄДРПОУ)</ToggleButton>
                <ToggleButton value="person">Фізособа</ToggleButton>
              </ToggleButtonGroup>
              {add.type === 'org' ? (
                <TextField label="ЄДРПОУ" value={add.edrpou} onChange={(e) => setAdd({ ...add, edrpou: e.target.value })} size="small" fullWidth />
              ) : (
                <>
                  <Stack direction="row" spacing={1}>
                    <TextField label="Прізвище" value={add.lastName} onChange={(e) => setAdd({ ...add, lastName: e.target.value })} size="small" fullWidth />
                    <TextField label="Імʼя" value={add.firstName} onChange={(e) => setAdd({ ...add, firstName: e.target.value })} size="small" fullWidth />
                  </Stack>
                  <TextField label="По батькові" value={add.middleName} onChange={(e) => setAdd({ ...add, middleName: e.target.value })} size="small" fullWidth />
                  <TextField label="Телефон (380…)" value={add.phone} onChange={(e) => setAdd({ ...add, phone: e.target.value })} size="small" fullWidth />
                </>
              )}
              <Typography variant="caption" color="text.secondary">
                Місто відправника береться з вибраного нижче (City Ref). Якщо НП поверне помилку — спочатку оберіть місто.
              </Typography>
            </Stack>
          ) : add ? (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Stack direction="row" spacing={1}>
                <TextField label="Прізвище" value={add.lastName} onChange={(e) => setAdd({ ...add, lastName: e.target.value })} size="small" fullWidth />
                <TextField label="Імʼя" value={add.firstName} onChange={(e) => setAdd({ ...add, firstName: e.target.value })} size="small" fullWidth />
              </Stack>
              <TextField label="По батькові" value={add.middleName} onChange={(e) => setAdd({ ...add, middleName: e.target.value })} size="small" fullWidth />
              <TextField label="Телефон (380…)" value={add.phone} onChange={(e) => setAdd({ ...add, phone: e.target.value })} size="small" fullWidth />
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdd(null)}>Скасувати</Button>
          <Button variant="contained" onClick={submitAdd} disabled={busy === 'add'}
            startIcon={busy === 'add' ? <CircularProgress size={16} /> : undefined}>Створити</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
