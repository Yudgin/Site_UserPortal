// Каталог продажів корабликів (власник): моделі → модельні ряди (роки, базова ціна) → кольори;
// опції комплектації (сумки/ехолоти/глибиноміри/аксесуари) з ознакою сумісності по МОДЕЛІ;
// довідник дропшиперів. Замовлення (картотека) — окрема сторінка (фаза 2).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Chip, Divider,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Switch, FormControlLabel,
  IconButton, Snackbar, Tabs, Tab, Autocomplete,
} from '@mui/material'
import {
  Home as HomeIcon, Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon,
  Sailing as BoatIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { boatModelService, boatOptionService, dropshipperService } from '@/api/boatCatalogService'
import {
  BOAT_OPTION_KINDS, BOAT_OPTION_KIND_LABELS,
  type BoatModel, type BoatModelRow, type BoatOption, type BoatOptionKind, type Dropshipper,
} from '@/types/boats'
import { secureId } from '@/utils/id'

const fmtUah = (n: number) => `${(n || 0).toLocaleString('uk-UA')} грн`

export default function BoatCatalogPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [tab, setTab] = useState(0)
  const [models, setModels] = useState<BoatModel[]>([])
  const [options, setOptions] = useState<BoatOption[]>([])
  const [droppers, setDroppers] = useState<Dropshipper[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' = 'success') => setSnack({ open: true, msg, sev })

  // Редакторы (диалоги) трёх сущностей
  const [editModel, setEditModel] = useState<Partial<BoatModel> | null>(null)
  const [editOption, setEditOption] = useState<Partial<BoatOption> | null>(null)
  const [editDropper, setEditDropper] = useState<Partial<Dropshipper> | null>(null)
  const [kindFilter, setKindFilter] = useState<BoatOptionKind | 'all'>('all')

  const load = useCallback(async () => {
    setLoading(true)
    const [m, o, d] = await Promise.all([boatModelService.list(), boatOptionService.list(), dropshipperService.list()])
    setModels(m); setOptions(o); setDroppers(d)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const modelName = (id: string) => models.find((m) => m.id === id)?.name || id
  const filteredOptions = useMemo(
    () => (kindFilter === 'all' ? options : options.filter((o) => o.kind === kindFilter)),
    [options, kindFilter]
  )

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ заборонено.</Alert>
      </Container>
    )
  }

  const saveModel = async () => {
    if (!editModel?.name?.trim()) return
    setSaving(true)
    const rows = (editModel.rows || []).filter((r) => r.name.trim())
    const res = await boatModelService.save({ active: true, ...editModel, name: editModel.name.trim(), rows })
    setSaving(false)
    if (res) { setEditModel(null); notify('Модель збережено'); load() } else notify('Не вдалося зберегти', 'error')
  }

  const saveOption = async () => {
    if (!editOption?.name?.trim()) return
    setSaving(true)
    const res = await boatOptionService.save({
      kind: 'accessory', price: 0, active: true, ...editOption, name: editOption.name.trim(),
      compatibleModelIds: editOption.compatibleModelIds?.length ? editOption.compatibleModelIds : [],
    })
    setSaving(false)
    if (res) { setEditOption(null); notify('Опцію збережено'); load() } else notify('Не вдалося зберегти', 'error')
  }

  const saveDropper = async () => {
    if (!editDropper?.name?.trim()) return
    setSaving(true)
    const res = await dropshipperService.save({ active: true, ...editDropper, name: editDropper.name.trim() })
    setSaving(false)
    if (res) { setEditDropper(null); notify('Дропшипера збережено'); load() } else notify('Не вдалося зберегти', 'error')
  }

  const removeEntity = async (svc: { remove: (id: string) => Promise<boolean> }, id: string, what: string) => {
    if (!window.confirm(`Видалити ${what}? Дію не можна скасувати.`)) return
    if (await svc.remove(id)) { notify('Видалено'); load() } else notify('Не вдалося видалити', 'error')
  }

  // --- Редактор рядів усередині діалогу моделі ---
  const patchRow = (idx: number, patch: Partial<BoatModelRow>) =>
    setEditModel((m) => m ? { ...m, rows: (m.rows || []).map((r, i) => (i === idx ? { ...r, ...patch } : r)) } : m)
  const addRow = () =>
    setEditModel((m) => m ? { ...m, rows: [...(m.rows || []), { id: secureId(8), name: '', basePrice: 0 }] } : m)
  const dropRow = (idx: number) =>
    setEditModel((m) => m ? { ...m, rows: (m.rows || []).filter((_, i) => i !== idx) } : m)

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <BoatIcon color="primary" />
        <Typography variant="h5" sx={{ flexGrow: 1 }}>Каталог корабликів</Typography>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Головна</Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Моделі з модельними рядами (роки випуску, базова ціна) та кольорами; опції комплектації
        з сумісністю по моделі; довідник дропшиперів. Замовлення — окрема картотека.
      </Typography>

      <Paper sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="fullWidth">
          <Tab label={`Моделі (${models.length})`} />
          <Tab label={`Опції (${options.length})`} />
          <Tab label={`Дропшипери (${droppers.length})`} />
        </Tabs>
      </Paper>

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
      ) : tab === 0 ? (
        <Stack spacing={1.5}>
          <Box>
            <Button variant="contained" startIcon={<AddIcon />}
              onClick={() => setEditModel({ name: '', colors: [], rows: [{ id: secureId(8), name: '', basePrice: 0 }], active: true })}>
              Додати модель
            </Button>
          </Box>
          {models.length === 0 && <Alert severity="info">Моделей поки немає — додайте першу.</Alert>}
          {models.map((m) => (
            <Paper key={m.id} sx={{ p: 2, opacity: m.active ? 1 : 0.55 }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
                  {m.name}{!m.active && ' (неактивна)'}
                </Typography>
                <IconButton size="small" onClick={() => setEditModel({ ...m, rows: [...(m.rows || [])], colors: [...(m.colors || [])] })}><EditIcon fontSize="small" /></IconButton>
                <IconButton size="small" color="error" onClick={() => removeEntity(boatModelService, m.id, `модель «${m.name}»`)}><DeleteIcon fontSize="small" /></IconButton>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                {(m.rows || []).map((r) => <Chip key={r.id} size="small" label={`${r.name} · ${fmtUah(r.basePrice)}`} />)}
              </Stack>
              {(m.colors || []).length > 0 && (
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                  {m.colors.map((c) => <Chip key={c} size="small" variant="outlined" label={c} />)}
                </Stack>
              )}
            </Paper>
          ))}
        </Stack>
      ) : tab === 1 ? (
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button variant="contained" startIcon={<AddIcon />}
              onClick={() => setEditOption({ kind: kindFilter === 'all' ? 'accessory' : kindFilter, name: '', price: 0, compatibleModelIds: [], active: true })}>
              Додати опцію
            </Button>
            <Divider orientation="vertical" flexItem />
            <Chip label="Усі" size="small" color={kindFilter === 'all' ? 'primary' : 'default'} onClick={() => setKindFilter('all')} />
            {BOAT_OPTION_KINDS.map((k) => (
              <Chip key={k} label={BOAT_OPTION_KIND_LABELS[k]} size="small" color={kindFilter === k ? 'primary' : 'default'} onClick={() => setKindFilter(k)} />
            ))}
          </Stack>
          {filteredOptions.length === 0 && <Alert severity="info">Опцій поки немає.</Alert>}
          {filteredOptions.map((o) => (
            <Paper key={o.id} sx={{ p: 2, opacity: o.active ? 1 : 0.55 }}>
              <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip size="small" label={BOAT_OPTION_KIND_LABELS[o.kind]} />
                <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>{o.name}{!o.active && ' (неактивна)'}</Typography>
                <Typography variant="subtitle2">{fmtUah(o.price)}</Typography>
                <IconButton size="small" onClick={() => setEditOption({ ...o, compatibleModelIds: [...(o.compatibleModelIds || [])] })}><EditIcon fontSize="small" /></IconButton>
                <IconButton size="small" color="error" onClick={() => removeEntity(boatOptionService, o.id, `опцію «${o.name}»`)}><DeleteIcon fontSize="small" /></IconButton>
              </Stack>
              <Box sx={{ mt: 0.5 }}>
                {!o.compatibleModelIds?.length ? (
                  <Chip size="small" variant="outlined" color="success" label="Сумісна з усіма моделями" />
                ) : (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {o.compatibleModelIds.map((id) => <Chip key={id} size="small" variant="outlined" label={modelName(id)} />)}
                  </Stack>
                )}
              </Box>
            </Paper>
          ))}
        </Stack>
      ) : (
        <Stack spacing={1.5}>
          <Box>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditDropper({ name: '', phone: '', note: '', active: true })}>
              Додати дропшипера
            </Button>
          </Box>
          {droppers.length === 0 && <Alert severity="info">Дропшиперів поки немає.</Alert>}
          {droppers.map((d) => (
            <Paper key={d.id} sx={{ p: 2, opacity: d.active ? 1 : 0.55 }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>{d.name}{!d.active && ' (неактивний)'}</Typography>
                {d.phone && <Typography variant="body2" color="text.secondary">{d.phone}</Typography>}
                <IconButton size="small" onClick={() => setEditDropper({ ...d })}><EditIcon fontSize="small" /></IconButton>
                <IconButton size="small" color="error" onClick={() => removeEntity(dropshipperService, d.id, `дропшипера «${d.name}»`)}><DeleteIcon fontSize="small" /></IconButton>
              </Stack>
              {d.note && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{d.note}</Typography>}
            </Paper>
          ))}
        </Stack>
      )}

      {/* ---- Діалог моделі ---- */}
      <Dialog open={!!editModel} onClose={() => setEditModel(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{editModel?.id ? 'Модель кораблика' : 'Нова модель'}</DialogTitle>
        <DialogContent dividers>
          {editModel && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField label="Назва моделі" value={editModel.name || ''} onChange={(e) => setEditModel({ ...editModel, name: e.target.value })} size="small" fullWidth autoFocus />
              <Autocomplete
                multiple freeSolo options={[]} value={editModel.colors || []}
                onChange={(_, v) => setEditModel({ ...editModel, colors: v as string[] })}
                renderInput={(p) => <TextField {...p} label="Кольори (введіть і натисніть Enter)" size="small" />}
              />
              <Divider>Модельні ряди (роки випуску)</Divider>
              {(editModel.rows || []).map((r, idx) => (
                <Stack key={r.id} direction="row" spacing={1} alignItems="center">
                  <TextField label="Рік / назва ряду" value={r.name} onChange={(e) => patchRow(idx, { name: e.target.value })} size="small" sx={{ flex: 1 }} />
                  <TextField label="Базова ціна, грн" type="number" value={r.basePrice || ''} onChange={(e) => patchRow(idx, { basePrice: Number(e.target.value) || 0 })} size="small" sx={{ width: 160 }} />
                  <IconButton size="small" color="error" onClick={() => dropRow(idx)}><DeleteIcon fontSize="small" /></IconButton>
                </Stack>
              ))}
              <Box><Button size="small" startIcon={<AddIcon />} onClick={addRow}>Додати ряд</Button></Box>
              <FormControlLabel control={<Switch checked={editModel.active !== false} onChange={(e) => setEditModel({ ...editModel, active: e.target.checked })} />} label="Активна" />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditModel(null)}>Скасувати</Button>
          <Button variant="contained" onClick={saveModel} disabled={saving || !editModel?.name?.trim()}>Зберегти</Button>
        </DialogActions>
      </Dialog>

      {/* ---- Діалог опції ---- */}
      <Dialog open={!!editOption} onClose={() => setEditOption(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{editOption?.id ? 'Опція комплектації' : 'Нова опція'}</DialogTitle>
        <DialogContent dividers>
          {editOption && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField select label="Тип" value={editOption.kind || 'accessory'} onChange={(e) => setEditOption({ ...editOption, kind: e.target.value as BoatOptionKind })} size="small" fullWidth>
                {BOAT_OPTION_KINDS.map((k) => <MenuItem key={k} value={k}>{BOAT_OPTION_KIND_LABELS[k]}</MenuItem>)}
              </TextField>
              <TextField label="Назва" value={editOption.name || ''} onChange={(e) => setEditOption({ ...editOption, name: e.target.value })} size="small" fullWidth autoFocus />
              <TextField label="Ціна, грн" type="number" value={editOption.price || ''} onChange={(e) => setEditOption({ ...editOption, price: Number(e.target.value) || 0 })} size="small" fullWidth />
              <FormControlLabel
                control={<Switch checked={!editOption.compatibleModelIds?.length} onChange={(e) => setEditOption({ ...editOption, compatibleModelIds: e.target.checked ? [] : models.map((m) => m.id).slice(0, 1) })} />}
                label="Сумісна з усіма моделями"
              />
              {(editOption.compatibleModelIds?.length ?? 0) > 0 && (
                <Autocomplete
                  multiple options={models.map((m) => m.id)} getOptionLabel={modelName}
                  value={editOption.compatibleModelIds || []}
                  onChange={(_, v) => setEditOption({ ...editOption, compatibleModelIds: v })}
                  renderInput={(p) => <TextField {...p} label="Сумісні моделі" size="small" helperText="Опція буде доступна лише для цих моделей" />}
                />
              )}
              <FormControlLabel control={<Switch checked={editOption.active !== false} onChange={(e) => setEditOption({ ...editOption, active: e.target.checked })} />} label="Активна" />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOption(null)}>Скасувати</Button>
          <Button variant="contained" onClick={saveOption} disabled={saving || !editOption?.name?.trim()}>Зберегти</Button>
        </DialogActions>
      </Dialog>

      {/* ---- Діалог дропшипера ---- */}
      <Dialog open={!!editDropper} onClose={() => setEditDropper(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{editDropper?.id ? 'Дропшипер' : 'Новий дропшипер'}</DialogTitle>
        <DialogContent dividers>
          {editDropper && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField label="Назва / імʼя" value={editDropper.name || ''} onChange={(e) => setEditDropper({ ...editDropper, name: e.target.value })} size="small" fullWidth autoFocus />
              <TextField label="Телефон" value={editDropper.phone || ''} onChange={(e) => setEditDropper({ ...editDropper, phone: e.target.value })} size="small" fullWidth />
              <TextField label="Нотатка" value={editDropper.note || ''} onChange={(e) => setEditDropper({ ...editDropper, note: e.target.value })} size="small" fullWidth multiline minRows={2} />
              <FormControlLabel control={<Switch checked={editDropper.active !== false} onChange={(e) => setEditDropper({ ...editDropper, active: e.target.checked })} />} label="Активний" />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDropper(null)}>Скасувати</Button>
          <Button variant="contained" onClick={saveDropper} disabled={saving || !editDropper?.name?.trim()}>Зберегти</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={3000} onClose={() => setSnack((s) => ({ ...s, open: false }))}>
        <Alert severity={snack.sev} onClose={() => setSnack((s) => ({ ...s, open: false }))}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
