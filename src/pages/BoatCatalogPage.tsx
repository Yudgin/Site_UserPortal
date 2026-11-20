// Каталог продажів корабликів (власник): моделі → модельні ряди (роки, базова ціна) → кольори;
// опції комплектації (сумки/ехолоти/глибиноміри/аксесуари) з ознакою сумісності по МОДЕЛІ;
// довідник магазинів-партнерів (дропшиперів) з умовами: комісія по видах позицій, строк оплати,
// хто створює накладну, платники (§26.1). Замовлення (картотека) — окрема сторінка.
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
  BOAT_OPTION_KINDS, BOAT_OPTION_KIND_LABELS, discountPct,
  SHOP_LINE_KINDS, SHOP_LINE_KIND_LABELS, SHOP_PAY_TERM_DAYS,
  type BoatModel, type BoatModelRow, type BoatOption, type BoatOptionKind, type Dropshipper,
  type ShopLineKind, type ShopPayer, type ShopTerms,
} from '@/types/boats'
import { secureId } from '@/utils/id'

const fmtUah = (n: number) => `${(n || 0).toLocaleString('uk-UA')} грн`

// Умови магазину перед збереженням: відсотки 0..100 по кожному виду (порожньо = 0), строк оплати, типові вибори.
const cleanTerms = (t?: ShopTerms): ShopTerms => {
  const commissionByKind: Partial<Record<ShopLineKind, number>> = {}
  for (const k of SHOP_LINE_KINDS) {
    const v = Number(t?.commissionByKind?.[k])
    commissionByKind[k] = Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 0
  }
  const days = Number(t?.payTermDays)
  return {
    commissionByKind,
    payTermDays: Number.isFinite(days) && days > 0 ? Math.round(days) : SHOP_PAY_TERM_DAYS,
    ttnBy: t?.ttnBy === 'shop' ? 'shop' : 'us',
    collectBy: t?.collectBy === 'us' ? 'us' : 'shop',
  }
}
const cleanPayers = (p?: ShopPayer[]): ShopPayer[] =>
  (p || [])
    .map((x) => ({ name: (x.name || '').trim(), taxId: (x.taxId || '').trim(), iban: (x.iban || '').replace(/\s+/g, '').toUpperCase() }))
    .filter((x) => x.name || x.taxId || x.iban)

// Короткий опис умов для списку магазинів.
const termsSummary = (d: Dropshipper): string[] => {
  const t = d.terms
  if (!t) return ['умови не задано']
  const out: string[] = []
  for (const k of SHOP_LINE_KINDS) {
    const v = Number(t.commissionByKind?.[k]) || 0
    if (v > 0) out.push(`${SHOP_LINE_KIND_LABELS[k].toLowerCase()} ${v}%`)
  }
  if (!out.length) out.push('без комісії')
  out.push(`оплата ${t.payTermDays || SHOP_PAY_TERM_DAYS} дн.`)
  out.push(t.ttnBy === 'shop' ? 'ТТН магазину' : 'ТТН наша')
  return out
}

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
    const res = await dropshipperService.save({
      active: true, ...editDropper, name: editDropper.name.trim(),
      legalName: (editDropper.legalName || '').trim(), taxId: (editDropper.taxId || '').trim(),
      terms: cleanTerms(editDropper.terms), payers: cleanPayers(editDropper.payers),
    })
    setSaving(false)
    if (res) { setEditDropper(null); notify('Магазин збережено'); load() } else notify('Не вдалося зберегти', 'error')
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
        з сумісністю по моделі; довідник магазинів-партнерів з умовами. Замовлення — окрема картотека.
      </Typography>

      <Paper sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="fullWidth">
          <Tab label={`Моделі (${models.length})`} />
          <Tab label={`Опції (${options.length})`} />
          <Tab label={`Магазини (${droppers.length})`} />
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
                {(m.rows || []).map((r) => (
                  <Chip key={r.id} size="small" label={
                    <span>
                      {r.name} ·{' '}
                      {discountPct(r.basePrice, r.oldPrice) != null && (
                        <s style={{ opacity: 0.6, marginRight: 4 }}>{fmtUah(r.oldPrice || 0)}</s>
                      )}
                      {fmtUah(r.basePrice)}
                      {discountPct(r.basePrice, r.oldPrice) != null && ` (-${discountPct(r.basePrice, r.oldPrice)}%)`}
                    </span>
                  } />
                ))}
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
                {discountPct(o.price, o.oldPrice) != null && (
                  <>
                    <Typography variant="body2" color="text.secondary" sx={{ textDecoration: 'line-through' }}>{fmtUah(o.oldPrice || 0)}</Typography>
                    <Chip size="small" color="error" label={`-${discountPct(o.price, o.oldPrice)}%`} />
                  </>
                )}
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
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditDropper({ name: '', phone: '', note: '', active: true, terms: cleanTerms() })}>
              Додати магазин
            </Button>
          </Box>
          {droppers.length === 0 && <Alert severity="info">Магазинів-партнерів поки немає.</Alert>}
          {droppers.map((d) => (
            <Paper key={d.id} sx={{ p: 2, opacity: d.active ? 1 : 0.55 }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>{d.name}{!d.active && ' (неактивний)'}</Typography>
                {d.phone && <Typography variant="body2" color="text.secondary">{d.phone}</Typography>}
                <IconButton size="small" onClick={() => setEditDropper({ ...d })}><EditIcon fontSize="small" /></IconButton>
                <IconButton size="small" color="error" onClick={() => removeEntity(dropshipperService, d.id, `магазин «${d.name}»`)}><DeleteIcon fontSize="small" /></IconButton>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {termsSummary(d).map((t) => <Chip key={t} size="small" variant="outlined" color={d.terms ? 'default' : 'warning'} label={t} />)}
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
                  <TextField label="Ціна (зі знижкою)" type="number" value={r.basePrice || ''} onChange={(e) => patchRow(idx, { basePrice: Number(e.target.value) || 0 })} size="small" sx={{ width: 140 }} />
                  <TextField label="Без знижки" type="number" value={r.oldPrice || ''} onChange={(e) => patchRow(idx, { oldPrice: Number(e.target.value) || null })} size="small" sx={{ width: 130 }}
                    helperText={discountPct(r.basePrice, r.oldPrice) ? `-${discountPct(r.basePrice, r.oldPrice)}%` : ' '} />
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
              <Stack direction="row" spacing={1}>
                <TextField label="Ціна (зі знижкою), грн" type="number" value={editOption.price || ''} onChange={(e) => setEditOption({ ...editOption, price: Number(e.target.value) || 0 })} size="small" fullWidth />
                <TextField label="Без знижки, грн" type="number" value={editOption.oldPrice || ''} onChange={(e) => setEditOption({ ...editOption, oldPrice: Number(e.target.value) || null })} size="small" fullWidth
                  helperText={discountPct(editOption.price || 0, editOption.oldPrice) ? `знижка -${discountPct(editOption.price || 0, editOption.oldPrice)}%` : 'порожньо = без знижки'} />
              </Stack>
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

      {/* ---- Діалог магазину-партнера: контакти, умови, платники ---- */}
      <Dialog open={!!editDropper} onClose={() => setEditDropper(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{editDropper?.id ? 'Магазин-партнер' : 'Новий магазин-партнер'}</DialogTitle>
        <DialogContent dividers>
          {editDropper && (() => {
            const terms = editDropper.terms || {}
            const setTerms = (p: Partial<ShopTerms>) => setEditDropper({ ...editDropper, terms: { ...terms, ...p } })
            const payers = editDropper.payers || []
            const setPayer = (idx: number, p: Partial<ShopPayer>) =>
              setEditDropper({ ...editDropper, payers: payers.map((x, i) => (i === idx ? { ...x, ...p } : x)) })
            return (
              <Stack spacing={2} sx={{ pt: 1 }}>
                <TextField label="Назва / імʼя" value={editDropper.name || ''} onChange={(e) => setEditDropper({ ...editDropper, name: e.target.value })} size="small" fullWidth autoFocus />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField label="Телефон" value={editDropper.phone || ''} onChange={(e) => setEditDropper({ ...editDropper, phone: e.target.value })} size="small" fullWidth />
                  <TextField label="Юридична назва" value={editDropper.legalName || ''} onChange={(e) => setEditDropper({ ...editDropper, legalName: e.target.value })} size="small" fullWidth />
                  <TextField label="ЄДРПОУ / РНОКПП" value={editDropper.taxId || ''} onChange={(e) => setEditDropper({ ...editDropper, taxId: e.target.value })} size="small" fullWidth />
                </Stack>

                <Divider>Комісія магазину, % від роздрібної ціни</Divider>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {SHOP_LINE_KINDS.map((k) => (
                    <TextField key={k} label={SHOP_LINE_KIND_LABELS[k]} type="number" size="small" sx={{ width: 118 }}
                      value={terms.commissionByKind?.[k] || ''} placeholder="0"
                      inputProps={{ min: 0, max: 100, step: 0.5 }}
                      onChange={(e) => setTerms({ commissionByKind: { ...(terms.commissionByKind || {}), [k]: Number(e.target.value) || 0 } })} />
                  ))}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Задається на кожен вид позиції окремо; порожньо — без комісії. У замовленні відсоток підставляється в рядок, його можна поправити.
                </Typography>

                <Divider>Умови</Divider>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField label="Строк оплати, днів" type="number" size="small" sx={{ minWidth: 150 }}
                    value={terms.payTermDays || ''} placeholder={String(SHOP_PAY_TERM_DAYS)} inputProps={{ min: 1, max: 365 }}
                    onChange={(e) => setTerms({ payTermDays: Number(e.target.value) || undefined })}
                    helperText="після отримання посилки" />
                  <TextField select label="Накладну зазвичай створює" size="small" fullWidth
                    value={terms.ttnBy === 'shop' ? 'shop' : 'us'} onChange={(e) => setTerms({ ttnBy: e.target.value as 'us' | 'shop' })}>
                    <MenuItem value="us">Ми (наша ТТН)</MenuItem>
                    <MenuItem value="shop">Магазин (дає свій номер ТТН)</MenuItem>
                  </TextField>
                  <TextField select label="Гроші клієнта зазвичай отримує" size="small" fullWidth
                    value={terms.collectBy === 'us' ? 'us' : 'shop'} onChange={(e) => setTerms({ collectBy: e.target.value as 'us' | 'shop' })}>
                    <MenuItem value="shop">Магазин</MenuItem>
                    <MenuItem value="us">Ми (наложка в нашій ТТН)</MenuItem>
                  </TextField>
                </Stack>

                <Divider>Платники</Divider>
                <Typography variant="caption" color="text.secondary">
                  З яких рахунків і від чийого імені магазин платить нам — за цим його платіж упізнається у виписці. Можна кілька.
                </Typography>
                {payers.map((x, idx) => (
                  <Stack key={idx} direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                    <TextField label="Назва платника" value={x.name || ''} onChange={(e) => setPayer(idx, { name: e.target.value })} size="small" sx={{ flex: 1 }} />
                    <TextField label="ЄДРПОУ / РНОКПП" value={x.taxId || ''} onChange={(e) => setPayer(idx, { taxId: e.target.value })} size="small" sx={{ width: { sm: 150 } }} />
                    <TextField label="IBAN" value={x.iban || ''} onChange={(e) => setPayer(idx, { iban: e.target.value })} size="small" sx={{ flex: 1.3 }} placeholder="UA…" />
                    <IconButton size="small" color="error" onClick={() => setEditDropper({ ...editDropper, payers: payers.filter((_, i) => i !== idx) })}><DeleteIcon fontSize="small" /></IconButton>
                  </Stack>
                ))}
                <Box>
                  <Button size="small" startIcon={<AddIcon />} onClick={() => setEditDropper({ ...editDropper, payers: [...payers, { name: '', taxId: '', iban: '' }] })}>
                    Додати платника
                  </Button>
                </Box>

                <TextField label="Нотатка" value={editDropper.note || ''} onChange={(e) => setEditDropper({ ...editDropper, note: e.target.value })} size="small" fullWidth multiline minRows={2} />
                <FormControlLabel control={<Switch checked={editDropper.active !== false} onChange={(e) => setEditDropper({ ...editDropper, active: e.target.checked })} />} label="Активний" />
              </Stack>
            )
          })()}
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
