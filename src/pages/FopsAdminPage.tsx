// Управление ФОПами (владелец): название, включённые методы оплаты, реквизиты отправителя
// Новой Почты, и СЕКРЕТНЫЕ ключи (LiqPay, monobank Частини/эквайринг, ПриватБанк Частини,
// Checkbox, ключ НП). Секреты write-only: показываем «задано/не задано», значения не отдаются;
// пустые поля при сохранении не перезаписывают существующие.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Divider, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Switch, FormControlLabel,
  FormGroup, Checkbox, IconButton, Snackbar,
} from '@mui/material'
import {
  Home as HomeIcon, Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, Payments as FopIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { fopsAdminApi, type FopAdmin, type FopSavePayload, type FopSecretsPayload, type FopNovaPoshtaRefs } from '@/api/endpoints/fopsAdmin'
import NpFopDirectory from '@/components/NpFopDirectory'

const emptyEdit = () => ({
  id: '', name: '', active: true, isNew: true,
  methods: { liqpayCard: false, liqpayPaypart: false, monoChast: false, monoAcquire: false, privatPaypart: false, cod: false },
  np: { senderRef: '', senderName: '', contactRef: '', contactName: '', senderPhone: '', cityRef: '', cityName: '', settlementRef: '', warehouseRef: '', warehouseName: '' } as FopNovaPoshtaRefs,
  secretsSet: { liqpay: false, monoChast: false, monoAcquire: false, privatPaypart: false, checkbox: false, novaPoshtaApiKey: false },
  // секретные поля (write-only, пустые = не менять)
  s: {
    liqpayPublic: '', liqpayPrivate: '', monoStoreId: '', monoStoreSecret: '', monoAcquireToken: '',
    privatStoreId: '', privatPassword: '', cbLicense: '', cbPin: '', cbCashier: '', npApiKey: '',
  },
})
type EditState = ReturnType<typeof emptyEdit>

export default function FopsAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [fops, setFops] = useState<FopAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' = 'success') => setSnack({ open: true, msg, sev })

  const load = useCallback(async () => { setLoading(true); setFops(await fopsAdminApi.list()); setLoading(false) }, [])
  useEffect(() => { load() }, [load])

  const openNew = () => setEdit(emptyEdit())
  const openEdit = (f: FopAdmin) => setEdit({
    id: f.id, name: f.name, active: f.active, isNew: false,
    methods: { ...emptyEdit().methods, ...f.methods },
    np: { ...emptyEdit().np, ...f.novaPoshta },
    secretsSet: f.secretsSet,
    s: emptyEdit().s,
  })

  const save = async () => {
    if (!edit) return
    const id = edit.id.trim()
    if (!id) { notify('Вкажіть id ФОП (латиниця/цифри)', 'error'); return }
    if (!edit.name.trim()) { notify('Вкажіть назву ФОП', 'error'); return }
    setSaving(true)
    // Собираем секреты — только непустые (write-only)
    const secrets: FopSecretsPayload = {}
    const s = edit.s
    if (s.liqpayPublic || s.liqpayPrivate) secrets.liqpay = { publicKey: s.liqpayPublic || undefined, privateKey: s.liqpayPrivate || undefined }
    if (s.monoStoreId || s.monoStoreSecret) secrets.monoChast = { storeId: s.monoStoreId || undefined, storeSecret: s.monoStoreSecret || undefined }
    if (s.monoAcquireToken) secrets.monoAcquire = { token: s.monoAcquireToken }
    if (s.privatStoreId || s.privatPassword) secrets.privatPaypart = { storeId: s.privatStoreId || undefined, password: s.privatPassword || undefined }
    if (s.cbLicense || s.cbPin || s.cbCashier) secrets.checkbox = { licenseKey: s.cbLicense || undefined, pinCode: s.cbPin || undefined, cashierName: s.cbCashier || undefined }
    if (s.npApiKey) secrets.novaPoshta = { apiKey: s.npApiKey }

    const payload: FopSavePayload = {
      name: edit.name.trim(), active: edit.active, methods: edit.methods, novaPoshta: edit.np,
      ...(Object.keys(secrets).length ? { secrets } : {}),
    }
    const ok = await fopsAdminApi.save(id, payload)
    setSaving(false)
    if (ok) { notify('ФОП збережено'); setEdit(null); load() } else notify('Не вдалося зберегти', 'error')
  }

  const remove = async (f: FopAdmin) => {
    if (!window.confirm(`Видалити ФОП «${f.name}»? Ключі теж будуть видалені.`)) return
    const ok = await fopsAdminApi.remove(f.id)
    if (ok) { notify('ФОП видалено'); load() } else notify('Не вдалося', 'error')
  }

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для власника.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }

  const secretField = (label: string, value: string, onChange: (v: string) => void, isSet: boolean) => (
    <TextField label={label} type="password" value={value} onChange={(e) => onChange(e.target.value)} size="small" fullWidth
      autoComplete="new-password"
      placeholder={isSet ? '•••• задано (залиште порожнім)' : 'не задано'}
      helperText={isSet ? 'Задано. Введіть нове значення, щоб змінити.' : undefined} />
  )

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">ФОПи та ключі</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openNew}>Додати ФОП</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Секретні ключі зберігаються лише на сервері (у браузер не потрапляють). Показуємо «задано / не
        задано»; щоб змінити ключ — введіть нове значення, порожнє поле не перезаписує наявне.
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
      ) : fops.length === 0 ? (
        <Alert severity="info">ФОПів ще немає. Натисніть «Додати ФОП».</Alert>
      ) : (
        <Stack spacing={2}>
          {fops.map((f) => (
            <Paper key={f.id} sx={{ p: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1, flexWrap: 'wrap', gap: 1 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <FopIcon color="primary" />
                  <Typography variant="subtitle1">{f.name}</Typography>
                  <Chip size="small" label={f.id} variant="outlined" />
                  {!f.active && <Chip size="small" color="default" label="вимкнено" />}
                </Stack>
                <Stack direction="row" spacing={0.5}>
                  <IconButton size="small" onClick={() => openEdit(f)}><EditIcon fontSize="small" /></IconButton>
                  <IconButton size="small" color="error" onClick={() => remove(f)}><DeleteIcon fontSize="small" /></IconButton>
                </Stack>
              </Stack>
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                {f.secretsSet.liqpay && <Chip size="small" color="success" label="LiqPay" />}
                {f.secretsSet.monoChast && <Chip size="small" color="success" label="mono Частини" />}
                {f.secretsSet.monoAcquire && <Chip size="small" color="success" label="mono еквайринг" />}
                {f.secretsSet.privatPaypart && <Chip size="small" color="success" label="ПриватБанк Частини" />}
                {f.secretsSet.checkbox && <Chip size="small" color="info" label="Checkbox (чеки)" />}
                {f.secretsSet.novaPoshtaApiKey && <Chip size="small" color="warning" label="Нова Пошта" />}
                {!f.secretsSet.liqpay && !f.secretsSet.monoChast && !f.secretsSet.monoAcquire && !f.secretsSet.privatPaypart && !f.secretsSet.checkbox && !f.secretsSet.novaPoshtaApiKey && (
                  <Typography variant="caption" color="text.secondary">ключі не задані</Typography>
                )}
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      {/* Диалог создания/редактирования */}
      <Dialog open={!!edit} onClose={() => setEdit(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{edit?.isNew ? 'Новий ФОП' : `ФОП: ${edit?.name}`}</DialogTitle>
        <DialogContent dividers>
          {edit && (
            <Stack spacing={2.5} sx={{ pt: 1 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="id (латиниця/цифри)" value={edit.id} disabled={!edit.isNew}
                  onChange={(e) => setEdit({ ...edit, id: e.target.value.replace(/[^\w-]/g, '') })} size="small" sx={{ minWidth: 160 }} />
                <TextField label="Назва ФОП" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} size="small" fullWidth />
              </Stack>
              <FormControlLabel control={<Switch checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />} label="Активний (доступний для оплат)" />

              <Divider textAlign="left"><Typography variant="caption">Методи оплати (увімкнені)</Typography></Divider>
              <FormGroup>
                {([
                  ['liqpayCard', 'LiqPay — картою'],
                  ['liqpayPaypart', 'LiqPay — частинами'],
                  ['monoChast', 'monobank — Частинами'],
                  ['monoAcquire', 'monobank — еквайринг'],
                  ['privatPaypart', 'ПриватБанк — Оплата частинами'],
                  ['cod', 'Накладений платіж (Нова Пошта)'],
                ] as const).map(([k, label]) => (
                  <FormControlLabel key={k}
                    control={<Checkbox checked={!!edit.methods[k]} onChange={(e) => setEdit({ ...edit, methods: { ...edit.methods, [k]: e.target.checked } })} />}
                    label={label} />
                ))}
              </FormGroup>
              <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
                Накладений платіж — оплата клієнтом при отриманні через Нову Пошту (не онлайн). Працює лише
                за наявності ключа НП у цього ФОП; при створенні ТТН сума береться з фактичного розрахунку.
              </Typography>

              <Divider textAlign="left"><Typography variant="caption">Секретні ключі (write-only)</Typography></Divider>
              <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>LiqPay</Typography>
              {secretField('LiqPay public key', edit.s.liqpayPublic, (v) => setEdit({ ...edit, s: { ...edit.s, liqpayPublic: v } }), edit.secretsSet.liqpay)}
              {secretField('LiqPay private key', edit.s.liqpayPrivate, (v) => setEdit({ ...edit, s: { ...edit.s, liqpayPrivate: v } }), edit.secretsSet.liqpay)}

              <Typography variant="caption" color="text.secondary">monobank Частини</Typography>
              {secretField('mono store id', edit.s.monoStoreId, (v) => setEdit({ ...edit, s: { ...edit.s, monoStoreId: v } }), edit.secretsSet.monoChast)}
              {secretField('mono store secret', edit.s.monoStoreSecret, (v) => setEdit({ ...edit, s: { ...edit.s, monoStoreSecret: v } }), edit.secretsSet.monoChast)}

              <Typography variant="caption" color="text.secondary">monobank еквайринг</Typography>
              {secretField('mono acquire token', edit.s.monoAcquireToken, (v) => setEdit({ ...edit, s: { ...edit.s, monoAcquireToken: v } }), edit.secretsSet.monoAcquire)}

              <Typography variant="caption" color="text.secondary">ПриватБанк Частини</Typography>
              {secretField('Privat store id', edit.s.privatStoreId, (v) => setEdit({ ...edit, s: { ...edit.s, privatStoreId: v } }), edit.secretsSet.privatPaypart)}
              {secretField('Privat password', edit.s.privatPassword, (v) => setEdit({ ...edit, s: { ...edit.s, privatPassword: v } }), edit.secretsSet.privatPaypart)}

              <Typography variant="caption" color="text.secondary">Checkbox (фіскальні чеки)</Typography>
              {secretField('Checkbox license key', edit.s.cbLicense, (v) => setEdit({ ...edit, s: { ...edit.s, cbLicense: v } }), edit.secretsSet.checkbox)}
              {secretField('Checkbox PIN касира', edit.s.cbPin, (v) => setEdit({ ...edit, s: { ...edit.s, cbPin: v } }), edit.secretsSet.checkbox)}
              <TextField label="Назва касира (для чека)" value={edit.s.cbCashier} onChange={(e) => setEdit({ ...edit, s: { ...edit.s, cbCashier: e.target.value } })} size="small" fullWidth
                placeholder={edit.secretsSet.checkbox ? 'задано (залиште порожнім)' : ''} />

              <Divider textAlign="left"><Typography variant="caption">Нова Пошта (відправник для ТТН)</Typography></Divider>
              {secretField('API-ключ Нової Пошти', edit.s.npApiKey, (v) => setEdit({ ...edit, s: { ...edit.s, npApiKey: v } }), edit.secretsSet.novaPoshtaApiKey)}
              <NpFopDirectory fopId={edit.id} np={edit.np}
                onChange={(patch) => setEdit({ ...edit, np: { ...edit.np, ...patch } })}
                apiKeySet={edit.secretsSet.novaPoshtaApiKey} typedApiKey={edit.s.npApiKey} />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEdit(null)}>Скасувати</Button>
          <Button variant="contained" onClick={save} disabled={saving}>Зберегти</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
