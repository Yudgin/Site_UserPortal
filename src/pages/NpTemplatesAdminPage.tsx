// Шаблоны посылок Новой Почты (владелец). Пресеты параметров для будущего создания ТТН:
// размер (великий/малий), вес/габариты, плательщик, наложенный платёж (COD), сценарий, привязка
// к сервисному центру и ФОП-отправителю. Само создание ТТН — следующая фаза.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Chip, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Switch, FormControlLabel,
  IconButton, Snackbar,
} from '@mui/material'
import {
  Home as HomeIcon, Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, LocalShipping as ShipIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { npTemplateService } from '@/api/npTemplateService'
import { serviceCenterService } from '@/api/serviceCenterService'
import { fopsAdminApi, type FopAdmin } from '@/api/endpoints/fopsAdmin'
import {
  SIZE_LABELS, SCENARIO_LABELS, PAYER_LABELS, SERVICE_TYPE_LABELS,
  type NpTemplate, type ParcelSize, type ShipScenario, type PayerType,
  type NpServiceType, type NpPartyTarget, type NpRecipientTarget, type NpAddress,
} from '@/types/npTemplate'
import type { ServiceCenter } from '@/types/access'
import NpAddressPicker from '@/components/NpAddressPicker'

const blank = (): Partial<NpTemplate> => ({
  name: '', serviceCenterId: '', fopId: '', size: 'big', scenario: 'incoming',
  serviceType: 'WarehouseWarehouse', senderTarget: 'service', sender: {}, recipientTarget: 'client', recipient: {},
  recipientName: '', recipientPhone: '',
  weight: 29, seatsAmount: 1, cargoType: 'Parcel', description: '', payerType: 'recipient', cod: false, active: true,
})

export default function NpTemplatesAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [templates, setTemplates] = useState<NpTemplate[]>([])
  const [centers, setCenters] = useState<ServiceCenter[]>([])
  const [fops, setFops] = useState<FopAdmin[]>([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState<Partial<NpTemplate> | null>(null)
  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' = 'success') => setSnack({ open: true, msg, sev })

  const load = useCallback(async () => {
    setLoading(true)
    const [t, c, f] = await Promise.all([npTemplateService.list(), serviceCenterService.list(), fopsAdminApi.list()])
    setTemplates(t); setCenters(c); setFops(f)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const centerName = (id: string) => centers.find((c) => c.id === id)?.name || id || '— без центру —'
  const grouped = useMemo(() => {
    const map: Record<string, NpTemplate[]> = {}
    for (const t of templates) { const k = t.serviceCenterId || ''; (map[k] ||= []).push(t) }
    return map
  }, [templates])

  const save = async () => {
    if (!edit) return
    if (!edit.name?.trim()) { notify('Вкажіть назву шаблону', 'error'); return }
    if (!edit.serviceCenterId) { notify('Оберіть сервісний центр', 'error'); return }
    setSaving(true)
    const ok = await npTemplateService.save({
      ...edit,
      name: edit.name.trim(),
      weight: Number(edit.weight) || 0,
      seatsAmount: Number(edit.seatsAmount) || 1,
      volumeGeneral: edit.volumeGeneral ? Number(edit.volumeGeneral) : undefined,
      length: edit.length ? Number(edit.length) : undefined,
      width: edit.width ? Number(edit.width) : undefined,
      height: edit.height ? Number(edit.height) : undefined,
    })
    setSaving(false)
    if (ok) { notify('Шаблон збережено'); setEdit(null); load() } else notify('Не вдалося зберегти', 'error')
  }

  const remove = async (t: NpTemplate) => {
    if (!window.confirm(`Видалити шаблон «${t.name}»?`)) return
    if (await npTemplateService.remove(t.id)) { notify('Видалено'); load() } else notify('Не вдалося', 'error')
  }

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для власника.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }

  const set = (patch: Partial<NpTemplate>) => setEdit((e) => ({ ...e, ...patch }))

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Шаблони посилок (Нова Пошта)</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEdit(blank())}>Додати шаблон</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Пресети параметрів посилки для створення ТТН: розмір, вага/габарити, платник, накладений
        платіж, сценарій. Прив’язуються до сервісного центру та ФОП-відправника. Створення ТТН — наступний крок.
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
      ) : centers.length === 0 ? (
        <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => navigate('/access')}>До центрів</Button>}>
          Спершу створіть сервісні центри (сторінка «Доступ та центри»).
        </Alert>
      ) : templates.length === 0 ? (
        <Alert severity="info">Шаблонів ще немає. Натисніть «Додати шаблон».</Alert>
      ) : (
        <Stack spacing={3}>
          {Object.entries(grouped).map(([centerId, list]) => (
            <Box key={centerId || 'none'}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>🏢 {centerName(centerId)}</Typography>
              <Stack spacing={1}>
                {list.map((t) => (
                  <Paper key={t.id} sx={{ p: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                        <ShipIcon color="primary" fontSize="small" />
                        <Typography variant="subtitle1">{t.name}</Typography>
                        <Chip size="small" label={SIZE_LABELS[t.size]} />
                        <Chip size="small" variant="outlined" label={SCENARIO_LABELS[t.scenario]} />
                        {t.cod && <Chip size="small" color="warning" label="накладений платіж" />}
                        {!t.active && <Chip size="small" label="вимкнено" />}
                      </Stack>
                      <Stack direction="row" spacing={0.5}>
                        <IconButton size="small" onClick={() => setEdit(t)}><EditIcon fontSize="small" /></IconButton>
                        <IconButton size="small" color="error" onClick={() => remove(t)}><DeleteIcon fontSize="small" /></IconButton>
                      </Stack>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {t.weight} кг · {t.seatsAmount} місць · платник: {PAYER_LABELS[t.payerType]}
                      {t.fopId ? ` · ФОП: ${fops.find((f) => f.id === t.fopId)?.name || t.fopId}` : ''}
                    </Typography>
                  </Paper>
                ))}
              </Stack>
            </Box>
          ))}
        </Stack>
      )}

      {/* Диалог создания/редактирования */}
      <Dialog open={!!edit} onClose={() => setEdit(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{edit?.id ? 'Редагувати шаблон' : 'Новий шаблон'}</DialogTitle>
        <DialogContent dividers>
          {edit && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField label="Назва шаблону" value={edit.name || ''} onChange={(e) => set({ name: e.target.value })} size="small" fullWidth />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField select label="Сервісний центр" value={edit.serviceCenterId || ''} onChange={(e) => set({ serviceCenterId: e.target.value })} size="small" fullWidth>
                  {centers.map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
                </TextField>
                <TextField select label="ФОП-відправник" value={edit.fopId || ''} onChange={(e) => set({ fopId: e.target.value })} size="small" fullWidth
                  helperText={fops.length === 0 ? 'Додайте ФОП на сторінці «ФОПи та ключі»' : undefined}>
                  <MenuItem value="">— не вказано —</MenuItem>
                  {fops.map((f) => <MenuItem key={f.id} value={f.id}>{f.name}</MenuItem>)}
                </TextField>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField select label="Розмір" value={edit.size || 'big'} onChange={(e) => set({ size: e.target.value as ParcelSize })} size="small" fullWidth>
                  {(Object.keys(SIZE_LABELS) as ParcelSize[]).map((s) => <MenuItem key={s} value={s}>{SIZE_LABELS[s]}</MenuItem>)}
                </TextField>
                <TextField select label="Сценарій" value={edit.scenario || 'incoming'} onChange={(e) => set({ scenario: e.target.value as ShipScenario })} size="small" fullWidth>
                  {(Object.keys(SCENARIO_LABELS) as ShipScenario[]).map((s) => <MenuItem key={s} value={s}>{SCENARIO_LABELS[s]}</MenuItem>)}
                </TextField>
              </Stack>

              <Divider textAlign="left"><Typography variant="caption">Маршрут доставки</Typography></Divider>
              <TextField select label="Тип доставки" value={edit.serviceType || 'WarehouseWarehouse'} onChange={(e) => set({ serviceType: e.target.value as NpServiceType })} size="small" fullWidth>
                {(Object.keys(SERVICE_TYPE_LABELS) as NpServiceType[]).map((s) => <MenuItem key={s} value={s}>{SERVICE_TYPE_LABELS[s]}</MenuItem>)}
              </TextField>

              <TextField select label="Відправник" value={edit.senderTarget || 'service'} onChange={(e) => set({ senderTarget: e.target.value as NpPartyTarget })} size="small" fullWidth
                helperText="«Сервіс» — фіксована адреса нижче; «Клієнт заявки» — адреса підставляється при створенні ТТН (приймання)">
                <MenuItem value="service">Сервіс (фіксована адреса)</MenuItem>
                <MenuItem value="client">Клієнт заявки</MenuItem>
              </TextField>
              {edit.senderTarget !== 'client' && (
                <NpAddressPicker value={(edit.sender || {}) as NpAddress} onChange={(v) => set({ sender: v })} label="Місто відправника" warehouseLabel="Відділення відправника" />
              )}

              <TextField select label="Отримувач" value={edit.recipientTarget || 'client'} onChange={(e) => set({ recipientTarget: e.target.value as NpRecipientTarget })} size="small" fullWidth>
                <MenuItem value="client">Клієнт заявки</MenuItem>
                <MenuItem value="service">Сервіс (фіксована адреса)</MenuItem>
                <MenuItem value="fixed">Інша фіксована особа</MenuItem>
              </TextField>
              {edit.recipientTarget === 'fixed' && (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField label="ФІО отримувача" value={edit.recipientName || ''} onChange={(e) => set({ recipientName: e.target.value })} size="small" fullWidth />
                  <TextField label="Телефон отримувача" value={edit.recipientPhone || ''} onChange={(e) => set({ recipientPhone: e.target.value })} size="small" fullWidth />
                </Stack>
              )}
              {edit.recipientTarget !== 'client' && (
                <NpAddressPicker value={(edit.recipient || {}) as NpAddress} onChange={(v) => set({ recipient: v })} label="Місто отримувача" warehouseLabel="Відділення отримувача" />
              )}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Вага, кг" type="number" value={edit.weight ?? ''} onChange={(e) => set({ weight: Number(e.target.value) })} size="small" fullWidth />
                <TextField label="Місць" type="number" value={edit.seatsAmount ?? 1} onChange={(e) => set({ seatsAmount: Number(e.target.value) })} size="small" fullWidth />
                <TextField label="Об'єм, м³" type="number" value={edit.volumeGeneral ?? ''} onChange={(e) => set({ volumeGeneral: e.target.value ? Number(e.target.value) : undefined })} size="small" fullWidth />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField label="Довжина, см" type="number" value={edit.length ?? ''} onChange={(e) => set({ length: e.target.value ? Number(e.target.value) : undefined })} size="small" fullWidth />
                <TextField label="Ширина, см" type="number" value={edit.width ?? ''} onChange={(e) => set({ width: e.target.value ? Number(e.target.value) : undefined })} size="small" fullWidth />
                <TextField label="Висота, см" type="number" value={edit.height ?? ''} onChange={(e) => set({ height: e.target.value ? Number(e.target.value) : undefined })} size="small" fullWidth />
              </Stack>
              <TextField label="Тип вантажу" value={edit.cargoType || ''} onChange={(e) => set({ cargoType: e.target.value })} size="small" fullWidth placeholder="Parcel / Cargo" />
              <TextField label="Опис (шаблон)" value={edit.description || ''} onChange={(e) => set({ description: e.target.value })} size="small" fullWidth multiline minRows={2}
                helperText="№ ремонту підставиться при створенні ТТН" />
              <Divider textAlign="left"><Typography variant="caption">Оплата доставки</Typography></Divider>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                <TextField select label="Платник доставки" value={edit.payerType || 'recipient'} onChange={(e) => set({ payerType: e.target.value as PayerType })} size="small" fullWidth>
                  {(Object.keys(PAYER_LABELS) as PayerType[]).map((p) => <MenuItem key={p} value={p}>{PAYER_LABELS[p]}</MenuItem>)}
                </TextField>
                <FormControlLabel control={<Switch checked={!!edit.cod} onChange={(e) => set({ cod: e.target.checked })} />} label="Накладений платіж" />
              </Stack>
              <FormControlLabel control={<Switch checked={edit.active !== false} onChange={(e) => set({ active: e.target.checked })} />} label="Активний" />
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
