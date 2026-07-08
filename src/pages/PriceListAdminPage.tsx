import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Tabs, Tab, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, IconButton, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, MenuItem, Switch, FormControlLabel, Collapse, Chip, Alert,
  Snackbar, CircularProgress, Divider, Tooltip,
} from '@mui/material'
import {
  Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, Save as SaveIcon,
  Home as HomeIcon, Calculate as CalcIcon, AutoAwesome as AiIcon, History as HistoryIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { usePricingStore } from '@/store/pricingStore'
import { isAdminEmail } from '@/config/access'
import { pricingService, PriceListDoc, type PriceArchiveEntry } from '@/api/pricingService'
import { aiApi, BuildPricingResult } from '@/api/endpoints/ai'
import type { Lang, LocalizedText, Work, Kit, Material, Addon, WorkCategory, SeasonRule, RateComponent, ServiceKind, KitSeasonMode } from '@/types/pricing'
import { KIT_SEASON_LABELS } from '@/types/pricing'
import { tName, formatMoney, buildCatalog, workTurnkeyPrice, computeLaborRate, resolveLaborRate } from '@/utils/pricing'

const LANGS: { code: Lang; label: string }[] = [
  { code: 'uk', label: 'UA' }, { code: 'ru', label: 'RU' }, { code: 'en', label: 'EN' },
  { code: 'de', label: 'DE' }, { code: 'pl', label: 'PL' }, { code: 'ro', label: 'RO' },
]

// Короткий id для новых элементов каталога
const genId = (prefix: string): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
  return `${prefix}-${s}`
}

const emptyLocalized = (): LocalizedText => ({ uk: '' })

// Поле локализованного текста: основной украинский + сворачиваемые остальные языки
function LocalizedField({ label, value, onChange, required }: {
  label: string; value: LocalizedText; onChange: (v: LocalizedText) => void; required?: boolean
}) {
  const [open, setOpen] = useState(false)
  const set = (lang: Lang, v: string) => onChange({ ...value, [lang]: v })
  return (
    <Box>
      <TextField
        label={`${label} (UA)`} value={value.uk || ''} required={required} size="small" fullWidth
        onChange={(e) => set('uk', e.target.value)}
      />
      <Button size="small" onClick={() => setOpen(!open)} sx={{ mt: 0.5 }}>
        {open ? 'Скрыть переводы' : 'Другие языки'}
      </Button>
      <Collapse in={open}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1, mt: 1 }}>
          {LANGS.filter((l) => l.code !== 'uk').map((l) => (
            <TextField
              key={l.code} label={l.label} value={(value as Record<string, string>)[l.code] || ''} size="small"
              onChange={(e) => set(l.code, e.target.value)}
            />
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}

export default function PriceListAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const { catalog, loadFromServer, savePriceList, persisted, isLoading } = usePricingStore()

  const [draft, setDraft] = useState<PriceListDoc | null>(null)
  const [tab, setTab] = useState(0)
  const [saving, setSaving] = useState(false)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false, message: '', severity: 'success',
  })

  // Диалоги редактирования
  const [editWork, setEditWork] = useState<Work | null>(null)
  const [editKit, setEditKit] = useState<Kit | null>(null)
  const [editMaterial, setEditMaterial] = useState<Material | null>(null)
  const [editAddon, setEditAddon] = useState<Addon | null>(null)
  const [editCategory, setEditCategory] = useState<WorkCategory | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)

  useEffect(() => { loadFromServer() }, [loadFromServer])
  useEffect(() => { setDraft(structuredClone(catalog)) }, [catalog])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ только для администратора прайс-листа.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На главную</Button>
      </Container>
    )
  }

  if (isLoading || !draft) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
  }

  const notify = (message: string, severity: 'success' | 'error' = 'success') =>
    setSnackbar({ open: true, message, severity })

  const indexed = buildCatalog(draft)
  const categoryName = (id: string) => tName(draft.categories.find((c) => c.id === id)?.name, 'uk') || '—'

  const handleSave = async () => {
    setSaving(true)
    const ok = await savePriceList({
      categories: draft.categories, works: draft.works, kits: draft.kits,
      materials: draft.materials, addons: draft.addons, settings: draft.settings,
    })
    setSaving(false)
    notify(ok ? 'Прайс-лист сохранён' : 'Не удалось сохранить (нужны права администратора)', ok ? 'success' : 'error')
  }

  // Универсальные upsert/remove по массиву каталога
  const upsert = <T extends { id: string }>(key: keyof PriceListDoc, item: T) => {
    setDraft((d) => {
      if (!d) return d
      const arr = d[key] as unknown as T[]
      const exists = arr.some((x) => x.id === item.id)
      const next = exists ? arr.map((x) => (x.id === item.id ? item : x)) : [...arr, item]
      return { ...d, [key]: next }
    })
  }
  const remove = (key: keyof PriceListDoc, id: string) => {
    setDraft((d) => (d ? { ...d, [key]: (d[key] as unknown as { id: string }[]).filter((x) => x.id !== id) } : d))
  }

  // Ставка нормо-часа для передачи ИИ (из расшифровки или из простого поля)
  const laborRate = draft.settings.rateBreakdown
    ? computeLaborRate(draft.settings.rateBreakdown).rate
    : draft.settings.laborRatePerHour

  // Компактный каталог для контекста ИИ — чтобы переиспользовал существующие коды и категории
  const catalogContext = [
    'КАТЕГОРІЇ (id — назва):',
    ...draft.categories.map((c) => `${c.id} — ${tName(c.name, 'uk')}`),
    '',
    'ІСНУЮЧІ РОБОТИ (code — назва — н/г):',
    ...draft.works.map((w) => `${w.code} — ${tName(w.name, 'uk')} — ${w.laborHours}`),
    '',
    'ІСНУЮЧІ МАТЕРІАЛИ (code — назва — ціна):',
    ...draft.materials.map((m) => `${m.code} — ${tName(m.name, 'uk')} — ${m.price}`),
  ].join('\n')

  // Слить результат AI-конструктора в черновик: новые материалы/работы/набор.
  // reused-работы не создаём заново (связываем по существующему коду).
  const applyAiBuild = (res: BuildPricingResult) => {
    setDraft((d) => {
      if (!d) return d
      const matCodeToId = new Map<string, string>()
      d.materials.forEach((m) => matCodeToId.set(m.code, m.id))
      const newMaterials: Material[] = []
      res.materials.forEach((m) => {
        if (matCodeToId.has(m.code)) return
        const id = genId('mat')
        matCodeToId.set(m.code, id)
        newMaterials.push({ id, code: m.code, name: { uk: m.name }, unit: { uk: m.unit || 'шт' }, price: m.price, active: true })
      })

      const workCodeToId = new Map<string, string>()
      d.works.forEach((w) => workCodeToId.set(w.code, w.id))
      const newWorks: Work[] = []
      res.works.forEach((wk) => {
        if (wk.reused || workCodeToId.has(wk.code)) return // существующая работа — не дублируем
        const id = genId('w')
        workCodeToId.set(wk.code, id)
        const categoryId = d.categories.some((c) => c.id === wk.categoryId) ? wk.categoryId : (d.categories[0]?.id || '')
        newWorks.push({
          id, code: wk.code, name: { uk: wk.name }, categoryId,
          laborHours: wk.laborHours, dedupe: wk.dedupe,
          materials: wk.materials
            .map((mr) => ({ materialId: matCodeToId.get(mr.materialCode) || '', qty: mr.qty }))
            .filter((mr) => mr.materialId),
          addons: [], publicVisible: true, active: true,
        })
      })

      const kitItems = res.kit.items
        .map((it) => ({ workId: workCodeToId.get(it.workCode) || '', qty: it.qty }))
        .filter((it) => it.workId)
      const newKit: Kit = {
        id: genId('kit'), code: res.kit.code, name: { uk: res.kit.name },
        categoryId: newWorks[0]?.categoryId || d.categories[0]?.id || '',
        serviceKind: res.kit.serviceKind, items: kitItems, active: true,
      }

      return {
        ...d,
        materials: [...d.materials, ...newMaterials],
        works: [...d.works, ...newWorks],
        kits: kitItems.length ? [...d.kits, newKit] : d.kits,
      }
    })
    notify('Позиции добавлены в черновик. Проверьте и нажмите «Сохранить».')
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CalcIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">Редактор прайс-листа</Typography>
          <Chip size="small" label={persisted ? 'сохранён в базе' : 'демо-каталог (ещё не в базе)'}
            color={persisted ? 'success' : 'warning'} variant="outlined" />
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
          <Button startIcon={<HistoryIcon />} onClick={() => setArchiveOpen(true)}>История цен</Button>
          <Button variant="outlined" color="secondary" startIcon={<AiIcon />} onClick={() => setAiOpen(true)}>
            AI-конструктор
          </Button>
          <Button variant="contained" startIcon={saving ? <CircularProgress size={18} /> : <SaveIcon />}
            onClick={handleSave} disabled={saving}>Сохранить</Button>
        </Box>
      </Box>

      <Container maxWidth="lg" sx={{ pb: 6 }}>
        <Paper sx={{ p: { xs: 1, sm: 2 } }}>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto">
            <Tab label={`Работы (${draft.works.length})`} />
            <Tab label={`Наборы (${draft.kits.length})`} />
            <Tab label={`Материалы (${draft.materials.length})`} />
            <Tab label={`Доп. услуги (${draft.addons.length})`} />
            <Tab label={`Категории (${draft.categories.length})`} />
            <Tab label="Настройки" />
          </Tabs>

          {/* ==== РАБОТЫ ==== */}
          {tab === 0 && (
            <Box sx={{ pt: 2 }}>
              <Button startIcon={<AddIcon />} variant="outlined" sx={{ mb: 2 }}
                onClick={() => setEditWork({ id: genId('w'), code: '', name: emptyLocalized(), categoryId: draft.categories[0]?.id || '', laborHours: 0.5, dedupe: 'perComplaint', materials: [], addons: [], publicVisible: true, active: true })}>
                Добавить работу
              </Button>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Код</TableCell><TableCell>Название</TableCell><TableCell>Категория</TableCell>
                      <TableCell align="right">Н/ч</TableCell><TableCell align="right">Цена «под ключ»</TableCell>
                      <TableCell>Мат./доп.</TableCell><TableCell align="right">Действия</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {draft.works.map((w) => (
                      <TableRow key={w.id} sx={{ opacity: w.active ? 1 : 0.5 }}>
                        <TableCell><code>{w.code}</code></TableCell>
                        <TableCell>{tName(w.name, 'uk')}{!w.publicVisible && <Chip size="small" label="скрыта" sx={{ ml: 1 }} />}</TableCell>
                        <TableCell>{categoryName(w.categoryId)}</TableCell>
                        <TableCell align="right">{w.laborHours}</TableCell>
                        <TableCell align="right">{formatMoney(workTurnkeyPrice(w, indexed, draft.settings))}</TableCell>
                        <TableCell>{w.materials.length}/{w.addons.length}</TableCell>
                        <TableCell align="right">
                          <IconButton size="small" onClick={() => setEditWork(structuredClone(w))}><EditIcon fontSize="small" /></IconButton>
                          <IconButton size="small" onClick={() => remove('works', w.id)}><DeleteIcon fontSize="small" /></IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {/* ==== НАБОРЫ ==== */}
          {tab === 1 && (
            <Box sx={{ pt: 2 }}>
              <Button startIcon={<AddIcon />} variant="outlined" sx={{ mb: 2 }}
                onClick={() => setEditKit({ id: genId('kit'), code: '', name: emptyLocalized(), categoryId: draft.categories[0]?.id || '', serviceKind: 'repair', items: [], active: true })}>
                Добавить набор
              </Button>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Код</TableCell><TableCell>Название</TableCell><TableCell align="right">Работ</TableCell>
                      <TableCell align="right">Итого «под ключ»</TableCell><TableCell align="right">Действия</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {draft.kits.map((k) => {
                      const total = k.items.reduce((acc, it) => {
                        const w = indexed.works[it.workId]
                        return acc + (w ? workTurnkeyPrice(w, indexed, draft.settings) * it.qty : 0)
                      }, 0)
                      return (
                        <TableRow key={k.id} sx={{ opacity: k.active ? 1 : 0.5 }}>
                          <TableCell><code>{k.code}</code></TableCell>
                          <TableCell>
                            {tName(k.name, 'uk')}
                            <Chip size="small" sx={{ ml: 1 }} label={k.serviceKind === 'upgrade' ? 'апгрейд' : 'ремонт'}
                              color={k.serviceKind === 'upgrade' ? 'info' : 'default'} variant="outlined" />
                          </TableCell>
                          <TableCell align="right">{k.items.length}</TableCell>
                          <TableCell align="right">{formatMoney(total)}</TableCell>
                          <TableCell align="right">
                            <IconButton size="small" onClick={() => setEditKit(structuredClone(k))}><EditIcon fontSize="small" /></IconButton>
                            <IconButton size="small" onClick={() => remove('kits', k.id)}><DeleteIcon fontSize="small" /></IconButton>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {/* ==== МАТЕРИАЛЫ ==== */}
          {tab === 2 && (
            <Box sx={{ pt: 2 }}>
              <Button startIcon={<AddIcon />} variant="outlined" sx={{ mb: 2 }}
                onClick={() => setEditMaterial({ id: genId('mat'), code: '', name: emptyLocalized(), unit: { uk: 'шт' }, price: 0, active: true })}>
                Добавить материал
              </Button>
              <TableContainer>
                <Table size="small">
                  <TableHead><TableRow>
                    <TableCell>Код</TableCell><TableCell>Название</TableCell><TableCell>Ед.</TableCell>
                    <TableCell align="right">Цена</TableCell><TableCell align="right">Действия</TableCell>
                  </TableRow></TableHead>
                  <TableBody>
                    {draft.materials.map((m) => (
                      <TableRow key={m.id} sx={{ opacity: m.active ? 1 : 0.5 }}>
                        <TableCell><code>{m.code}</code></TableCell>
                        <TableCell>{tName(m.name, 'uk')}</TableCell>
                        <TableCell>{tName(m.unit, 'uk')}</TableCell>
                        <TableCell align="right">{formatMoney(m.price)}</TableCell>
                        <TableCell align="right">
                          <IconButton size="small" onClick={() => setEditMaterial(structuredClone(m))}><EditIcon fontSize="small" /></IconButton>
                          <IconButton size="small" onClick={() => remove('materials', m.id)}><DeleteIcon fontSize="small" /></IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {/* ==== ДОП. УСЛУГИ ==== */}
          {tab === 3 && (
            <Box sx={{ pt: 2 }}>
              <Button startIcon={<AddIcon />} variant="outlined" sx={{ mb: 2 }}
                onClick={() => setEditAddon({ id: genId('add'), code: '', name: emptyLocalized(), kind: 'service', price: 0, active: true })}>
                Добавить доп. услугу/товар
              </Button>
              <TableContainer>
                <Table size="small">
                  <TableHead><TableRow>
                    <TableCell>Код</TableCell><TableCell>Название</TableCell><TableCell>Тип</TableCell>
                    <TableCell align="right">Цена</TableCell><TableCell align="right">Действия</TableCell>
                  </TableRow></TableHead>
                  <TableBody>
                    {draft.addons.map((a) => (
                      <TableRow key={a.id} sx={{ opacity: a.active ? 1 : 0.5 }}>
                        <TableCell><code>{a.code}</code></TableCell>
                        <TableCell>{tName(a.name, 'uk')}</TableCell>
                        <TableCell>{a.kind === 'service' ? 'услуга' : 'товар'}</TableCell>
                        <TableCell align="right">{formatMoney(a.price)}</TableCell>
                        <TableCell align="right">
                          <IconButton size="small" onClick={() => setEditAddon(structuredClone(a))}><EditIcon fontSize="small" /></IconButton>
                          <IconButton size="small" onClick={() => remove('addons', a.id)}><DeleteIcon fontSize="small" /></IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {/* ==== КАТЕГОРИИ ==== */}
          {tab === 4 && (
            <Box sx={{ pt: 2 }}>
              <Button startIcon={<AddIcon />} variant="outlined" sx={{ mb: 2 }}
                onClick={() => setEditCategory({ id: genId('cat'), name: emptyLocalized(), order: draft.categories.length + 1 })}>
                Добавить категорию
              </Button>
              <TableContainer>
                <Table size="small">
                  <TableHead><TableRow>
                    <TableCell align="right">Порядок</TableCell><TableCell>Название</TableCell><TableCell align="right">Действия</TableCell>
                  </TableRow></TableHead>
                  <TableBody>
                    {[...draft.categories].sort((a, b) => a.order - b.order).map((c) => (
                      <TableRow key={c.id}>
                        <TableCell align="right">{c.order}</TableCell>
                        <TableCell>{tName(c.name, 'uk')}</TableCell>
                        <TableCell align="right">
                          <IconButton size="small" onClick={() => setEditCategory(structuredClone(c))}><EditIcon fontSize="small" /></IconButton>
                          <IconButton size="small" onClick={() => remove('categories', c.id)}><DeleteIcon fontSize="small" /></IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {/* ==== НАСТРОЙКИ ==== */}
          {tab === 5 && (
            <Box sx={{ pt: 2, maxWidth: 640 }}>
              <Typography variant="subtitle1" gutterBottom>Ставка нормо-часа и её расшифровка</Typography>
              {draft.settings.rateBreakdown ? (
                <Box sx={{ mb: 3 }}>
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 2 }}>
                    <Typography variant="h4" color="primary">{formatMoney(computeLaborRate(draft.settings.rateBreakdown).rate)}</Typography>
                    <Typography color="text.secondary">/ нормо-час — вычислено из компонентов ниже</Typography>
                  </Box>
                  {draft.settings.rateBreakdown.components.map((c, idx) => (
                    <Box key={c.id} sx={{ display: 'flex', gap: 1, mb: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                      <TextField label="Компонент" size="small" value={c.name.uk || ''} sx={{ flex: 1, minWidth: 150 }}
                        onChange={(e) => updateRateComp(idx, { name: { ...c.name, uk: e.target.value } })} />
                      <TextField select size="small" label="Тип" sx={{ width: 110 }} value={c.kind}
                        onChange={(e) => updateRateComp(idx, { kind: e.target.value as RateComponent['kind'] })}>
                        <MenuItem value="amount">Сумма ₴</MenuItem>
                        <MenuItem value="percent">Процент %</MenuItem>
                      </TextField>
                      <TextField type="number" size="small" label={c.kind === 'amount' ? '₴' : '%'} sx={{ width: 80 }} value={c.value}
                        onChange={(e) => updateRateComp(idx, { value: Number(e.target.value) })} />
                      {c.kind === 'percent' && (
                        <TextField select size="small" label="От чего" sx={{ width: 160 }} value={c.base || 'cumulative'}
                          onChange={(e) => updateRateComp(idx, { base: e.target.value as RateComponent['base'] })}>
                          <MenuItem value="salary">от зарплаты</MenuItem>
                          <MenuItem value="cumulative">от накопленного</MenuItem>
                          <MenuItem value="revenue">от выручки (налог)</MenuItem>
                        </TextField>
                      )}
                      <IconButton size="small" onClick={() => removeRateComp(idx)}><DeleteIcon fontSize="small" /></IconButton>
                    </Box>
                  ))}
                  <Button size="small" startIcon={<AddIcon />} sx={{ mt: 1 }} onClick={addRateComp}>Добавить компонент</Button>
                </Box>
              ) : (
                <TextField label="Ставка нормо-часа, ₴" type="number" size="small" fullWidth sx={{ mb: 3 }}
                  value={draft.settings.laborRatePerHour}
                  onChange={(e) => setDraft((d) => d && ({ ...d, settings: { ...d.settings, laborRatePerHour: Number(e.target.value) } }))} />
              )}
              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle1" gutterBottom>Сезонные коэффициенты (применяются только к работам)</Typography>
              {draft.settings.seasons.map((s, idx) => (
                <Box key={s.id} sx={{ display: 'flex', gap: 1, mb: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                  <TextField label="Название" size="small" value={s.name.uk || ''} sx={{ flex: 1, minWidth: 140 }}
                    onChange={(e) => updateSeason(idx, { name: { ...s.name, uk: e.target.value } })} />
                  <TextField label="Коэф." type="number" size="small" sx={{ width: 90 }} value={s.coefficient}
                    onChange={(e) => updateSeason(idx, { coefficient: Number(e.target.value) })} />
                  <TextField label="Месяцы (через запятую)" size="small" sx={{ width: 180 }} value={s.months.join(',')}
                    onChange={(e) => updateSeason(idx, { months: e.target.value.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n >= 1 && n <= 12) })} />
                  <IconButton size="small" onClick={() => setDraft((d) => d && ({ ...d, settings: { ...d.settings, seasons: d.settings.seasons.filter((_, i) => i !== idx) } }))}><DeleteIcon fontSize="small" /></IconButton>
                </Box>
              ))}
              <Button size="small" startIcon={<AddIcon />} sx={{ mt: 1, mb: 3 }}
                onClick={() => setDraft((d) => d && ({ ...d, settings: { ...d.settings, seasons: [...d.settings.seasons, { id: genId('season'), name: { uk: 'Новый сезон' }, coefficient: 1, months: [] }] } }))}>
                Добавить сезон
              </Button>
              <TextField select label="Активный сезон" size="small" fullWidth
                value={draft.settings.activeSeasonOverride || 'auto'}
                onChange={(e) => setDraft((d) => d && ({ ...d, settings: { ...d.settings, activeSeasonOverride: e.target.value === 'auto' ? null : e.target.value } }))}
                helperText="«Авто» — сезон определяется по текущему месяцу">
                <MenuItem value="auto">Авто (по календарю)</MenuItem>
                {draft.settings.seasons.map((s) => <MenuItem key={s.id} value={s.id}>{tName(s.name, 'uk')} (×{s.coefficient})</MenuItem>)}
              </TextField>

              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle1" gutterBottom>Общие работы (сопутствуют любому ремонту)</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Приёмка, подготовка, тест, сушка, упаковка и т.п. Добавляются в каждую смету автоматически,
                если ещё не включены (в том числе через набор).
              </Typography>
              <TextField select fullWidth size="small" label="Общие работы"
                value={draft.settings.commonWorkCodes || []}
                SelectProps={{ multiple: true, renderValue: (sel) => (sel as string[]).join(', ') || '—' }}
                onChange={(e) => setDraft((d) => d && ({ ...d, settings: { ...d.settings, commonWorkCodes: typeof e.target.value === 'string' ? e.target.value.split(',') : (e.target.value as unknown as string[]) } }))}>
                {draft.works.filter((w) => w.active).map((w) => (
                  <MenuItem key={w.code} value={w.code}>{tName(w.name, 'uk')} [{w.code}]</MenuItem>
                ))}
              </TextField>
            </Box>
          )}
        </Paper>
      </Container>

      {/* ==== Диалоги ==== */}
      {editWork && (
        <WorkDialog work={editWork} categories={draft.categories} materials={draft.materials} addons={draft.addons}
          onClose={() => setEditWork(null)} onSave={(w) => { upsert('works', w); setEditWork(null) }} />
      )}
      {editKit && (
        <KitDialog kit={editKit} categories={draft.categories} works={draft.works}
          onClose={() => setEditKit(null)} onSave={(k) => { upsert('kits', k); setEditKit(null) }} />
      )}
      {editMaterial && (
        <MaterialDialog material={editMaterial} onClose={() => setEditMaterial(null)}
          onSave={(m) => { upsert('materials', m); setEditMaterial(null) }} />
      )}
      {editAddon && (
        <AddonDialog addon={editAddon} onClose={() => setEditAddon(null)}
          onSave={(a) => { upsert('addons', a); setEditAddon(null) }} />
      )}
      {editCategory && (
        <CategoryDialog category={editCategory} onClose={() => setEditCategory(null)}
          onSave={(c) => { upsert('categories', c); setEditCategory(null) }} />
      )}
      {aiOpen && (
        <AiConstructorDialog laborRate={laborRate} catalogContext={catalogContext}
          categoryName={categoryName}
          onClose={() => setAiOpen(false)}
          onApply={(res) => { applyAiBuild(res); setAiOpen(false) }} />
      )}

      {archiveOpen && <PriceArchiveDialog onClose={() => setArchiveOpen(false)} />}

      <Snackbar open={snackbar.open} autoHideDuration={3000} onClose={() => setSnackbar((s) => ({ ...s, open: false }))}>
        <Alert severity={snackbar.severity}>{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  )

  function updateSeason(idx: number, patch: Partial<SeasonRule>) {
    setDraft((d) => d && ({
      ...d,
      settings: { ...d.settings, seasons: d.settings.seasons.map((s, i) => (i === idx ? { ...s, ...patch } : s)) },
    }))
  }

  function updateRateComp(idx: number, patch: Partial<RateComponent>) {
    setDraft((d) => {
      if (!d?.settings.rateBreakdown) return d
      const components = d.settings.rateBreakdown.components.map((c, i) => (i === idx ? { ...c, ...patch } : c))
      return { ...d, settings: { ...d.settings, rateBreakdown: { components } } }
    })
  }
  function removeRateComp(idx: number) {
    setDraft((d) => {
      if (!d?.settings.rateBreakdown) return d
      const components = d.settings.rateBreakdown.components.filter((_, i) => i !== idx)
      return { ...d, settings: { ...d.settings, rateBreakdown: { components } } }
    })
  }
  function addRateComp() {
    setDraft((d) => {
      if (!d?.settings.rateBreakdown) return d
      const comp: RateComponent = { id: genId('rc'), name: { uk: 'Новый компонент' }, kind: 'percent', value: 10, base: 'cumulative' }
      return { ...d, settings: { ...d.settings, rateBreakdown: { components: [...d.settings.rateBreakdown.components, comp] } } }
    })
  }
}

// ==== Диалог работы ====
function WorkDialog({ work, categories, materials, addons, onClose, onSave }: {
  work: Work; categories: WorkCategory[]; materials: Material[]; addons: Addon[]
  onClose: () => void; onSave: (w: Work) => void
}) {
  const [w, setW] = useState<Work>(work)
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Работа</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField label="Код (артикул)" size="small" value={w.code} onChange={(e) => setW({ ...w, code: e.target.value })} />
          <LocalizedField label="Название" value={w.name} required onChange={(name) => setW({ ...w, name })} />
          <TextField select label="Категория" size="small" value={w.categoryId} onChange={(e) => setW({ ...w, categoryId: e.target.value })}>
            {categories.map((c) => <MenuItem key={c.id} value={c.id}>{tName(c.name, 'uk')}</MenuItem>)}
          </TextField>
          <TextField label="Нормо-часы" type="number" size="small" value={w.laborHours}
            onChange={(e) => setW({ ...w, laborHours: Number(e.target.value) })} inputProps={{ step: 0.1, min: 0 }} />
          <TextField select label="Поведение при нескольких жалобах" size="small" value={w.dedupe}
            onChange={(e) => setW({ ...w, dedupe: e.target.value as Work['dedupe'] })}
            helperText="«Один раз» — общая операция (приёмка, транспорт); «По каждой жалобе» — конкретный ремонт">
            <MenuItem value="once">Один раз на смету (объединяется)</MenuItem>
            <MenuItem value="perComplaint">По каждой жалобе (суммируется)</MenuItem>
          </TextField>
          <FormControlLabel control={<Switch checked={w.publicVisible} onChange={(e) => setW({ ...w, publicVisible: e.target.checked })} />} label="Показывать в публичном прайс-листе" />
          <FormControlLabel control={<Switch checked={!!w.waivesHighSeasonSurcharge} onChange={(e) => setW({ ...w, waivesHighSeasonSurcharge: e.target.checked })} />} label="Льготная: снимает наценку сезона со ВСЕЙ сметы" />
          <FormControlLabel control={<Switch checked={!!w.criticalNoSurcharge} onChange={(e) => setW({ ...w, criticalNoSurcharge: e.target.checked })} />} label="Критическая: без наценки сезона (только на эту работу)" />
          <FormControlLabel control={<Switch checked={w.active} onChange={(e) => setW({ ...w, active: e.target.checked })} />} label="Активна" />

          <Divider textAlign="left"><Typography variant="caption">Материалы</Typography></Divider>
          {w.materials.map((ref, i) => (
            <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField select size="small" label="Материал" sx={{ flex: 1 }} value={ref.materialId}
                onChange={(e) => setW({ ...w, materials: w.materials.map((r, idx) => idx === i ? { ...r, materialId: e.target.value } : r) })}>
                {materials.map((m) => <MenuItem key={m.id} value={m.id}>{tName(m.name, 'uk')}</MenuItem>)}
              </TextField>
              <TextField type="number" size="small" label="Кол-во" sx={{ width: 90 }} value={ref.qty}
                onChange={(e) => setW({ ...w, materials: w.materials.map((r, idx) => idx === i ? { ...r, qty: Number(e.target.value) } : r) })} />
              <IconButton size="small" onClick={() => setW({ ...w, materials: w.materials.filter((_, idx) => idx !== i) })}><DeleteIcon fontSize="small" /></IconButton>
            </Box>
          ))}
          <Button size="small" startIcon={<AddIcon />} onClick={() => setW({ ...w, materials: [...w.materials, { materialId: materials[0]?.id || '', qty: 1 }] })} disabled={!materials.length}>Добавить материал</Button>

          <Divider textAlign="left"><Typography variant="caption">Доп. услуги/товары</Typography></Divider>
          {w.addons.map((ref, i) => (
            <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField select size="small" label="Доп." sx={{ flex: 1 }} value={ref.addonId}
                onChange={(e) => setW({ ...w, addons: w.addons.map((r, idx) => idx === i ? { ...r, addonId: e.target.value } : r) })}>
                {addons.map((a) => <MenuItem key={a.id} value={a.id}>{tName(a.name, 'uk')}</MenuItem>)}
              </TextField>
              <Tooltip title="Включать по умолчанию">
                <FormControlLabel control={<Switch size="small" checked={ref.includedByDefault}
                  onChange={(e) => setW({ ...w, addons: w.addons.map((r, idx) => idx === i ? { ...r, includedByDefault: e.target.checked } : r) })} />} label="по умолч." />
              </Tooltip>
              <IconButton size="small" onClick={() => setW({ ...w, addons: w.addons.filter((_, idx) => idx !== i) })}><DeleteIcon fontSize="small" /></IconButton>
            </Box>
          ))}
          <Button size="small" startIcon={<AddIcon />} onClick={() => setW({ ...w, addons: [...w.addons, { addonId: addons[0]?.id || '', includedByDefault: false }] })} disabled={!addons.length}>Добавить доп.</Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" onClick={() => onSave(w)} disabled={!w.name.uk}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}

// ==== Диалог набора ====
function KitDialog({ kit, categories, works, onClose, onSave }: {
  kit: Kit; categories: WorkCategory[]; works: Work[]; onClose: () => void; onSave: (k: Kit) => void
}) {
  const [k, setK] = useState<Kit>(kit)
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Набор работ</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField label="Код" size="small" value={k.code} onChange={(e) => setK({ ...k, code: e.target.value })} />
          <LocalizedField label="Название" value={k.name} required onChange={(name) => setK({ ...k, name })} />
          <LocalizedField label="Описание" value={k.description || { uk: '' }} onChange={(description) => setK({ ...k, description })} />
          <TextField select label="Категория" size="small" value={k.categoryId} onChange={(e) => setK({ ...k, categoryId: e.target.value })}>
            {categories.map((c) => <MenuItem key={c.id} value={c.id}>{tName(c.name, 'uk')}</MenuItem>)}
          </TextField>
          <TextField select label="Тип обращения" size="small" value={k.serviceKind}
            onChange={(e) => setK({ ...k, serviceKind: e.target.value as ServiceKind })}
            helperText="«Апгрейд» — делается сразу, без сезонной наценки; «Поломку» можно отложить до дешёвого сезона">
            <MenuItem value="repair">Поломка (ремонт)</MenuItem>
            <MenuItem value="upgrade">Апгрейд / доп. оборудование</MenuItem>
          </TextField>
          <TextField select label="Сезонность набора" size="small" value={k.seasonMode || 'normal'}
            onChange={(e) => setK({ ...k, seasonMode: e.target.value as KitSeasonMode })}
            helperText="Обычная — сезон действует; критическая — без наценки высокого сезона; льготная — снимает наценку со всей сметы">
            {(Object.keys(KIT_SEASON_LABELS) as KitSeasonMode[]).map((m) => (
              <MenuItem key={m} value={m}>{KIT_SEASON_LABELS[m]}</MenuItem>
            ))}
          </TextField>
          <FormControlLabel control={<Switch checked={k.active} onChange={(e) => setK({ ...k, active: e.target.checked })} />} label="Активен" />
          <Divider textAlign="left"><Typography variant="caption">Работы в наборе</Typography></Divider>
          {k.items.map((it, i) => (
            <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField select size="small" label="Работа" sx={{ flex: 1 }} value={it.workId}
                onChange={(e) => setK({ ...k, items: k.items.map((r, idx) => idx === i ? { ...r, workId: e.target.value } : r) })}>
                {works.map((wk) => <MenuItem key={wk.id} value={wk.id}>{tName(wk.name, 'uk')} ({wk.laborHours} н/ч)</MenuItem>)}
              </TextField>
              <TextField type="number" size="small" label="Кол-во" sx={{ width: 90 }} value={it.qty}
                onChange={(e) => setK({ ...k, items: k.items.map((r, idx) => idx === i ? { ...r, qty: Number(e.target.value) } : r) })} />
              <IconButton size="small" onClick={() => setK({ ...k, items: k.items.filter((_, idx) => idx !== i) })}><DeleteIcon fontSize="small" /></IconButton>
            </Box>
          ))}
          <Button size="small" startIcon={<AddIcon />} onClick={() => setK({ ...k, items: [...k.items, { workId: works[0]?.id || '', qty: 1 }] })} disabled={!works.length}>Добавить работу</Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" onClick={() => onSave(k)} disabled={!k.name.uk}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}

// ==== Диалог материала ====
function MaterialDialog({ material, onClose, onSave }: { material: Material; onClose: () => void; onSave: (m: Material) => void }) {
  const [m, setM] = useState<Material>(material)
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Материал</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField label="Код" size="small" value={m.code} onChange={(e) => setM({ ...m, code: e.target.value })} />
          <LocalizedField label="Название" value={m.name} required onChange={(name) => setM({ ...m, name })} />
          <LocalizedField label="Единица" value={m.unit} required onChange={(unit) => setM({ ...m, unit })} />
          <TextField label="Цена за единицу, ₴" type="number" size="small" value={m.price} onChange={(e) => setM({ ...m, price: Number(e.target.value) })} />
          <FormControlLabel control={<Switch checked={!!m.waivesHighSeasonSurcharge} onChange={(e) => setM({ ...m, waivesHighSeasonSurcharge: e.target.checked })} />} label="Оборудование: снимает наценку высокого сезона" />
          <FormControlLabel control={<Switch checked={m.active} onChange={(e) => setM({ ...m, active: e.target.checked })} />} label="Активен" />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" onClick={() => onSave(m)} disabled={!m.name.uk}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}

// ==== Диалог доп. услуги/товара ====
function AddonDialog({ addon, onClose, onSave }: { addon: Addon; onClose: () => void; onSave: (a: Addon) => void }) {
  const [a, setA] = useState<Addon>(addon)
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Доп. услуга/товар</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField label="Код" size="small" value={a.code} onChange={(e) => setA({ ...a, code: e.target.value })} />
          <LocalizedField label="Название" value={a.name} required onChange={(name) => setA({ ...a, name })} />
          <TextField select label="Тип" size="small" value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as Addon['kind'] })}>
            <MenuItem value="service">Услуга</MenuItem>
            <MenuItem value="product">Товар</MenuItem>
          </TextField>
          <TextField label="Цена, ₴" type="number" size="small" value={a.price} onChange={(e) => setA({ ...a, price: Number(e.target.value) })} />
          <FormControlLabel control={<Switch checked={a.active} onChange={(e) => setA({ ...a, active: e.target.checked })} />} label="Активен" />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" onClick={() => onSave(a)} disabled={!a.name.uk}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}

// ==== AI-конструктор услуг ====
// Описание услуги словами → ИИ разбивает на подуслуги/материалы/набор.
// Пример: «установка эхолота TOSLON 520, деталь 17000, работа 4000».
function AiConstructorDialog({ laborRate, catalogContext, categoryName, onClose, onApply }: {
  laborRate: number
  catalogContext: string
  categoryName: (id: string) => string
  onClose: () => void
  onApply: (res: BuildPricingResult) => void
}) {
  const [instruction, setInstruction] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<BuildPricingResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (!instruction.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    const res = await aiApi.buildPricing({ instruction, catalogContext, laborRate })
    setLoading(false)
    if (res.success && res.data) setResult(res.data)
    else setError(res.error?.message || 'Не удалось сформировать услугу')
  }

  const newWorks = result?.works.filter((w) => !w.reused) || []
  const reusedWorks = result?.works.filter((w) => w.reused) || []

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AiIcon color="secondary" /> AI-конструктор услуг
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Опишите услугу простыми словами — ИИ аккуратно разобьёт её на подуслуги, материалы и соберёт набор,
          переиспользуя существующие позиции каталога. Ставка нормо-часа: <b>{formatMoney(laborRate)}</b>.
        </Typography>
        <TextField
          fullWidth multiline minRows={3} value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Напр.: Установка эхолота TOSLON 520 — стоимость детали 17000 ₴, работа 4000 ₴"
          disabled={loading}
        />
        <Box sx={{ mt: 1.5, display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button variant="contained" color="secondary" onClick={run} disabled={loading || !instruction.trim()}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <AiIcon />}>
            {loading ? 'ИИ разбивает…' : 'Сформировать'}
          </Button>
          {loading && <Typography variant="caption" color="text.secondary">Это может занять до минуты — ИИ работает точно, не спеша.</Typography>}
        </Box>

        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}

        {result && (
          <Box sx={{ mt: 3 }}>
            <Alert severity="info" sx={{ mb: 2 }}>{result.summary}</Alert>

            {result.materials.length > 0 && (
              <>
                <Typography variant="subtitle2" sx={{ mt: 1 }}>Материалы ({result.materials.length})</Typography>
                <Table size="small">
                  <TableBody>
                    {result.materials.map((m) => (
                      <TableRow key={m.code}>
                        <TableCell><code>{m.code}</code></TableCell>
                        <TableCell>{m.name}</TableCell>
                        <TableCell align="right">{formatMoney(m.price)}/{m.unit}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}

            {newWorks.length > 0 && (
              <>
                <Typography variant="subtitle2" sx={{ mt: 2 }}>Новые подуслуги ({newWorks.length})</Typography>
                <Table size="small">
                  <TableBody>
                    {newWorks.map((w) => (
                      <TableRow key={w.code}>
                        <TableCell><code>{w.code}</code></TableCell>
                        <TableCell>{w.name}</TableCell>
                        <TableCell>{categoryName(w.categoryId)}</TableCell>
                        <TableCell align="right">{w.laborHours} н/ч</TableCell>
                        <TableCell>{w.dedupe === 'once' ? 'один раз' : 'по жалобе'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}

            {reusedWorks.length > 0 && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="subtitle2">Переиспользованы существующие ({reusedWorks.length})</Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                  {reusedWorks.map((w) => <Chip key={w.code} size="small" variant="outlined" label={`${w.code} · ${w.name}`} />)}
                </Box>
              </Box>
            )}

            <Typography variant="subtitle2" sx={{ mt: 2 }}>Набор: {result.kit.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              <code>{result.kit.code}</code> · {result.kit.serviceKind === 'upgrade' ? 'апгрейд (без сезонной наценки)' : 'ремонт'} · работ в наборе: {result.kit.items.length}
            </Typography>

            {result.usage && (
              <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 1.5 }}>
                Стоимость запроса к ИИ: ${result.usage.costUsd.toFixed(4)} ({result.usage.inputTokens}+{result.usage.outputTokens} токенов)
              </Typography>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" disabled={!result} onClick={() => result && onApply(result)}>
          Добавить в прайс
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ==== Диалог категории ====
function CategoryDialog({ category, onClose, onSave }: { category: WorkCategory; onClose: () => void; onSave: (c: WorkCategory) => void }) {
  const [c, setC] = useState<WorkCategory>(category)
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Категория</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <LocalizedField label="Название" value={c.name} required onChange={(name) => setC({ ...c, name })} />
          <TextField label="Порядок" type="number" size="small" value={c.order} onChange={(e) => setC({ ...c, order: Number(e.target.value) })} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" onClick={() => onSave(c)} disabled={!c.name.uk}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}

// ==== Диалог истории цен (архив версий прайса) ====
function PriceArchiveDialog({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<PriceArchiveEntry[] | null>(null)

  useEffect(() => { pricingService.listArchive().then(setEntries) }, [])

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>История цен (архив версий)</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Каждый раз при сохранении прайса предыдущая версия попадает в архив. Здесь видно, когда версия
          была заменена, кем, и какая была ставка нормо-часа.
        </Typography>
        {entries === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
        ) : entries.length === 0 ? (
          <Alert severity="info">Архив пуст — версии появятся после следующих сохранений прайса.</Alert>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>Заменена</TableCell><TableCell>Кем заменена</TableCell>
                <TableCell align="right">Ставка/год</TableCell><TableCell align="right">Работ</TableCell>
                <TableCell align="right">Наборов</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.archiveId} hover>
                    <TableCell>{new Date(e.archivedAt).toLocaleString('ru-RU')}</TableCell>
                    <TableCell>{e.supersededBy || '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(resolveLaborRate(e.settings))}</TableCell>
                    <TableCell align="right">{e.works?.length ?? 0}</TableCell>
                    <TableCell align="right">{e.kits?.length ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Закрыть</Button>
      </DialogActions>
    </Dialog>
  )
}
