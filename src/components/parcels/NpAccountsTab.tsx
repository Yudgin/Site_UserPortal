// Акаунти Нової Пошти для журналу «Посилки» (§36): ФОП з ключем (ключ змінюється на «ФОПи та ключі») і особисті
// акаунти з власним ключем. Ключ write-only. «Перевірити ключ» — три запити лише на читання: що НП віддає цьому ключу.
import { useCallback, useEffect, useState } from 'react'
import {
  Box, Paper, Stack, Typography, Button, Chip, Alert, CircularProgress, IconButton, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, FormControlLabel, Switch,
} from '@mui/material'
import { Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, VpnKey as KeyIcon, Person as PersonIcon, Payments as FopIcon, Sync as SyncIcon } from '@mui/icons-material'
import { parcelsApi, type NpAccount, type NpKeyCheck, type NpProbe } from '@/api/endpoints/parcels'
import { fmtDateTime } from './parcelUi'

type Edit = { id: string; isNew: boolean; name: string; active: boolean; private: boolean; apiKey: string; keySet: boolean }

const probeLine = (label: string, p: NpProbe) => (
  <Alert severity={p.ok ? 'success' : 'error'} sx={{ py: 0 }}>
    {label}: {p.ok ? `працює, записів за 2 тижні: ${p.count}` : `не працює — ${p.error || 'помилка'}`}
  </Alert>
)

export default function NpAccountsTab({ onSynced }: { onSynced: () => void }) {
  const [items, setItems] = useState<NpAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<Edit | null>(null)
  const [busy, setBusy] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [check, setCheck] = useState<{ name: string; data?: NpKeyCheck; error?: string } | null>(null)
  const [ownPhones, setOwnPhones] = useState('')
  const [tplPhones, setTplPhones] = useState<string[]>([])
  const [phonesMsg, setPhonesMsg] = useState<{ text: string; sev: 'success' | 'error' } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await parcelsApi.accounts()
    setLoading(false)
    if (r.ok) { setItems(r.data); setError('') } else setError(r.error)
    const st = await parcelsApi.settings()
    if (st.ok) { setOwnPhones(st.data.ownPhones.join(', ')); setTplPhones(st.data.fromTemplates) }
  }, [])
  useEffect(() => { load() }, [load])

  const savePhones = async () => {
    setBusy('phones'); setPhonesMsg(null)
    const r = await parcelsApi.saveSettings(ownPhones.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))
    setBusy('')
    if (!r.ok) { setPhonesMsg({ text: r.error, sev: 'error' }); return }
    setOwnPhones(r.data.ownPhones.join(', '))
    setPhonesMsg({ text: `Збережено. Напрям змінено у ${r.data.recalculated.changed} посилок.`, sev: 'success' })
    onSynced()
  }

  const save = async () => {
    if (!edit) return
    const id = edit.isNew ? edit.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') : edit.id
    if (!id) { setDialogError('Вкажіть короткий код латиницею, наприклад personal'); return }
    if (edit.isNew && !edit.apiKey.trim()) { setDialogError('Вставте ключ API з особистого кабінету Нової Пошти'); return }
    setBusy('save'); setDialogError('')
    const r = await parcelsApi.saveAccount(id, { name: edit.name.trim() || id, active: edit.active, private: edit.private, apiKey: edit.apiKey.trim() || undefined })
    setBusy('')
    if (r.ok) { setEdit(null); load() } else setDialogError(r.error)
  }
  const runCheck = async (a: { id: string; name: string }, apiKey?: string) => {
    setBusy(`check:${a.id}`)
    const r = await parcelsApi.checkAccount(a.id, apiKey)
    setBusy('')
    setCheck(r.ok ? { name: a.name, data: r.data } : { name: a.name, error: r.error })
  }
  const sync = async (a: NpAccount) => {
    setBusy(`sync:${a.id}`)
    const r = await parcelsApi.sync(a.id)
    setBusy('')
    if (!r.ok) setError(r.error); else { setError(''); onSynced() }
    load()
  }
  const remove = async (a: NpAccount) => {
    if (!window.confirm(`Видалити акаунт «${a.name}» і його ключ? Уже завантажені посилки залишаться в журналі.`)) return
    const r = await parcelsApi.removeAccount(a.id)
    if (r.ok) load(); else setError(r.error)
  }

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
          Журнал збирає посилки по кожному ключу Нової Пошти. Ключі ФОП беруться зі сторінки «ФОПи та ключі».
          Особистий акаунт: увійдіть на new.novaposhta.ua своїм телефоном → «Налаштування» → «Безпека» → «Створити ключ» і вставте ключ сюди.
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setDialogError(''); setEdit({ id: 'personal', isNew: true, name: 'Особистий', active: true, private: true, apiKey: '', keySet: false }) }}>
          Особистий акаунт
        </Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      ) : items.length === 0 ? (
        <Alert severity="info">Жоден ФОП ще не має ключа Нової Пошти, особистих акаунтів теж немає.</Alert>
      ) : (
        <Stack spacing={1.5}>
          {items.map((a) => (
            <Paper key={a.id} sx={{ p: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ gap: 1 }}>
                <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    {a.kind === 'fop' ? <FopIcon color="primary" fontSize="small" /> : <PersonIcon color="primary" fontSize="small" />}
                    <Typography variant="subtitle1">{a.name}</Typography>
                    <Chip size="small" variant="outlined" label={a.kind === 'fop' ? 'ФОП' : 'особистий'} />
                    {a.private && <Chip size="small" variant="outlined" label="бачить лише власник" />}
                    {!a.active && <Chip size="small" label="вимкнено" />}
                    {!a.keySet && <Chip size="small" color="warning" label="немає ключа" />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {a.lastSyncAt ? `Останнє оновлення: ${fmtDateTime(a.lastSyncAt)}` : 'Ще не синхронізувався'}
                    {a.phones.length ? ` · телефон ${a.phones.join(', ')}` : ''}
                    {a.counts ? ` · у кабінеті ${a.counts.listed}, вихідних за телефоном ${a.counts.out}, вхідних ${a.counts.inc}` : ''}
                  </Typography>
                  {a.lastError && <Alert severity="error" sx={{ py: 0 }}>{a.lastError}</Alert>}
                </Stack>
                <Stack direction="row" alignItems="center">
                  <Button size="small" startIcon={<KeyIcon />} disabled={!a.keySet || busy === `check:${a.id}`} onClick={() => runCheck(a)}>Перевірити</Button>
                  <IconButton size="small" aria-label="Оновити з НП" disabled={!a.keySet || !a.active || busy === `sync:${a.id}`} onClick={() => sync(a)}>
                    {busy === `sync:${a.id}` ? <CircularProgress size={18} /> : <SyncIcon fontSize="small" />}
                  </IconButton>
                  {a.kind === 'personal' && (
                    <>
                      <IconButton size="small" aria-label="Редагувати" onClick={() => { setDialogError(''); setEdit({ id: a.id, isNew: false, name: a.name, active: a.active, private: a.private, apiKey: '', keySet: a.keySet }) }}><EditIcon fontSize="small" /></IconButton>
                      <IconButton size="small" aria-label="Видалити" onClick={() => remove(a)}><DeleteIcon fontSize="small" /></IconButton>
                    </>
                  )}
                </Stack>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      <Paper sx={{ p: 2, mt: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 0.5 }}>Наші телефони</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Посилка на такий номер вважається вхідною (наприклад, клієнт шле кораблик на офіс). Номер ФОП і номери,
          які Нова Пошта сама повʼязує з ключем, додавати не треба.
          {tplPhones.length > 0 && ` Із шаблонів «до нас» уже враховано: ${tplPhones.join(', ')}.`}
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
          <TextField label="Номери через кому" value={ownPhones} onChange={(e) => setOwnPhones(e.target.value)} size="small" fullWidth placeholder="+380631234567, 0671234567" />
          <Button variant="outlined" disabled={busy === 'phones'} onClick={savePhones}>Зберегти</Button>
        </Stack>
        {phonesMsg && <Alert severity={phonesMsg.sev} sx={{ mt: 1.5, py: 0 }}>{phonesMsg.text}</Alert>}
      </Paper>

      <Dialog open={!!edit} onClose={() => setEdit(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{edit?.isNew ? 'Новий особистий акаунт' : 'Особистий акаунт'}</DialogTitle>
        {edit && (
          <DialogContent dividers>
            <Stack spacing={1.5} sx={{ pt: 0.5 }}>
              {edit.isNew && <TextField label="Код (латиницею)" value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} size="small" fullWidth />}
              <TextField label="Назва" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} size="small" fullWidth />
              <TextField label="Ключ API Нової Пошти" type="password" autoComplete="new-password" value={edit.apiKey} onChange={(e) => setEdit({ ...edit, apiKey: e.target.value })} size="small" fullWidth
                placeholder={edit.keySet ? '•••• задано (залиште порожнім)' : 'не задано'} helperText={edit.keySet ? 'Задано. Введіть новий, щоб змінити.' : undefined} />
              <Button size="small" startIcon={<KeyIcon />} disabled={!edit.apiKey.trim() || busy.startsWith('check:')} onClick={() => runCheck({ id: edit.isNew ? 'acc:new' : edit.id, name: edit.name }, edit.apiKey.trim())}>
                Перевірити введений ключ
              </Button>
              <FormControlLabel control={<Switch checked={edit.private} onChange={(e) => setEdit({ ...edit, private: e.target.checked })} />} label="Посилки бачить лише власник" />
              <FormControlLabel control={<Switch checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />} label="Синхронізувати" />
              {dialogError && <Alert severity="error">{dialogError}</Alert>}
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setEdit(null)}>Скасувати</Button>
          <Button variant="contained" disabled={busy === 'save'} onClick={save}>Зберегти</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!check} onClose={() => setCheck(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Перевірка ключа · {check?.name}</DialogTitle>
        <DialogContent dividers>
          {check?.error && <Alert severity="error">{check.error}</Alert>}
          {check?.data && (
            <Stack spacing={1}>
              {probeLine('Накладні кабінету', check.data.list)}
              {probeLine('Вихідні за телефоном', check.data.outgoing)}
              {probeLine('Вхідні за телефоном', check.data.incoming)}
              <Typography variant="body2" color="text.secondary">
                {check.data.phone ? `Телефон акаунта: ${check.data.phone}.` : 'Телефон акаунта не визначено: за останні два тижні посилок за телефоном немає.'}
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions><Button onClick={() => setCheck(null)}>Закрити</Button></DialogActions>
      </Dialog>
    </Box>
  )
}
