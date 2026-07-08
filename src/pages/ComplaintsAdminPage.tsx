import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, IconButton, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, MenuItem, Switch, FormControlLabel, Collapse, Chip, Alert, Snackbar,
  CircularProgress, Divider, Stack,
} from '@mui/material'
import {
  Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, Home as HomeIcon,
  ReportProblem as ComplaintIcon, Save as SaveIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { usePricingStore } from '@/store/pricingStore'
import { isAdminEmail } from '@/config/access'
import { complaintTemplateService } from '@/api/complaintTemplateService'
import { tName, formatMoney, buildCatalog, workTurnkeyPrice } from '@/utils/pricing'
import { BOAT_MODELS } from '@/types/clientBoat'
import { SEVERITY_LABELS, SEVERITY_ORDER } from '@/types/complaint'
import type { ComplaintTemplate, RepairVariant, VariantSeverity } from '@/types/complaint'
import type { Lang, LocalizedText, Work } from '@/types/pricing'

const LANGS: { code: Lang; label: string }[] = [
  { code: 'uk', label: 'UA' }, { code: 'ru', label: 'RU' }, { code: 'en', label: 'EN' },
]
const emptyLoc = (): LocalizedText => ({ uk: '' })
const genId = (p: string): string => `${p}-${Math.random().toString(36).slice(2, 8)}`

function LocalizedField({ label, value, onChange }: { label: string; value: LocalizedText; onChange: (v: LocalizedText) => void }) {
  const [open, setOpen] = useState(false)
  const set = (l: Lang, v: string) => onChange({ ...value, [l]: v })
  return (
    <Box>
      <TextField label={`${label} (UA)`} value={value.uk || ''} size="small" fullWidth onChange={(e) => set('uk', e.target.value)} />
      <Button size="small" onClick={() => setOpen(!open)} sx={{ mt: 0.5 }}>{open ? 'Скрыть переводы' : 'Переводы'}</Button>
      <Collapse in={open}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mt: 1 }}>
          {LANGS.filter((l) => l.code !== 'uk').map((l) => (
            <TextField key={l.code} label={l.label} value={(value as Record<string, string>)[l.code] || ''} size="small"
              onChange={(e) => set(l.code, e.target.value)} />
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}

// Мультивыбор работ по коду
function WorkMultiSelect({ label, works, value, onChange }: {
  label: string; works: Work[]; value: string[]; onChange: (codes: string[]) => void
}) {
  return (
    <TextField select size="small" fullWidth label={label} value={value}
      SelectProps={{ multiple: true, renderValue: (sel) => (sel as string[]).join(', ') || '—' }}
      onChange={(e) => onChange(typeof e.target.value === 'string' ? e.target.value.split(',') : (e.target.value as unknown as string[]))}>
      {works.filter((w) => w.active).map((w) => (
        <MenuItem key={w.code} value={w.code}>{tName(w.name, 'uk')} [{w.code}]</MenuItem>
      ))}
    </TextField>
  )
}

const blank = (): ComplaintTemplate => ({
  id: '', symptom: emptyLoc(), keywords: [], diagnosticWorkCodes: [],
  variants: [{ id: genId('v'), label: emptyLoc(), severity: 'likely', workCodes: [] }],
  relatedModels: [], active: true, updatedAt: '', updatedBy: null,
})

export default function ComplaintsAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const { catalog, loadFromServer } = usePricingStore()
  const [items, setItems] = useState<ComplaintTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ComplaintTemplate | null>(null)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' })

  const reload = async () => { setLoading(true); setItems(await complaintTemplateService.listAll()); setLoading(false) }
  useEffect(() => { reload(); loadFromServer() }, [loadFromServer])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ только для администратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На главную</Button>
      </Container>
    )
  }

  const works = catalog.works
  const indexed = buildCatalog(catalog)
  const notify = (message: string, severity: 'success' | 'error' = 'success') => setSnackbar({ open: true, message, severity })

  const variantTotal = (v: RepairVariant, diag: string[]): number => {
    const codes = [...diag, ...v.workCodes]
    return codes.reduce((acc, code) => {
      const w = works.find((x) => x.code === code)
      return acc + (w ? workTurnkeyPrice(w, indexed, catalog.settings) : 0)
    }, 0)
  }

  const remove = async (id: string) => {
    if (await complaintTemplateService.delete(id)) { setItems((a) => a.filter((x) => x.id !== id)); notify('Удалено') }
    else notify('Не удалось удалить', 'error')
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ComplaintIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">Жалобы → работы</Typography>
          <Chip size="small" variant="outlined" label={`${items.length}`} />
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing(blank())}>Добавить шаблон</Button>
        </Box>
      </Box>

      <Container maxWidth="lg" sx={{ pb: 6 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Симптом → диагностика (нужна всегда) + варианты ремонта (лучший/вероятный/худший). Используется
          ИИ-оценкой: по описанию проблемы показывает «возможно это, или это» с ценами.
        </Typography>
        <Paper sx={{ p: { xs: 1, sm: 2 } }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead><TableRow>
                  <TableCell>Симптом</TableCell><TableCell align="center">Диагностика</TableCell>
                  <TableCell align="center">Вариантов</TableCell><TableCell>Модели</TableCell><TableCell align="right">Действия</TableCell>
                </TableRow></TableHead>
                <TableBody>
                  {items.map((t) => (
                    <TableRow key={t.id} sx={{ opacity: t.active ? 1 : 0.5 }}>
                      <TableCell>{tName(t.symptom, 'uk')}</TableCell>
                      <TableCell align="center">{t.diagnosticWorkCodes.length}</TableCell>
                      <TableCell align="center">{t.variants.length}</TableCell>
                      <TableCell>{t.relatedModels.length ? t.relatedModels.join(', ') : 'усі'}</TableCell>
                      <TableCell align="right">
                        <IconButton size="small" onClick={() => setEditing(structuredClone(t))}><EditIcon fontSize="small" /></IconButton>
                        <IconButton size="small" onClick={() => remove(t.id)}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                  {items.length === 0 && (
                    <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>Пока нет шаблонов жалоб.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Container>

      {editing && (
        <TemplateDialog template={editing} works={works} variantTotal={variantTotal}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setItems((list) => list.some((x) => x.id === saved.id) ? list.map((x) => x.id === saved.id ? saved : x) : [saved, ...list])
            setEditing(null); notify('Сохранено')
          }}
          onError={() => notify('Не удалось сохранить (нужны права администратора)', 'error')} />
      )}
      <Snackbar open={snackbar.open} autoHideDuration={3000} onClose={() => setSnackbar((s) => ({ ...s, open: false }))}>
        <Alert severity={snackbar.severity}>{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  )
}

function TemplateDialog({ template, works, variantTotal, onClose, onSaved, onError }: {
  template: ComplaintTemplate; works: Work[]
  variantTotal: (v: RepairVariant, diag: string[]) => number
  onClose: () => void; onSaved: (t: ComplaintTemplate) => void; onError: () => void
}) {
  const [t, setT] = useState<ComplaintTemplate>(template)
  const [saving, setSaving] = useState(false)

  const setVariant = (i: number, patch: Partial<RepairVariant>) =>
    setT((prev) => ({ ...prev, variants: prev.variants.map((v, idx) => idx === i ? { ...v, ...patch } : v) }))

  const save = async () => {
    setSaving(true)
    const res = await complaintTemplateService.save(t)
    setSaving(false)
    if (res) onSaved({ ...t, id: res.id })
    else onError()
  }

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Шаблон жалобы</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <LocalizedField label="Симптом (как описывает клиент)" value={t.symptom} onChange={(symptom) => setT({ ...t, symptom })} />
          <TextField size="small" label="Ключевые слова (через запятую)" value={t.keywords.join(', ')}
            onChange={(e) => setT({ ...t, keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            helperText="Для сопоставления описания клиента с шаблоном (напр.: намотка, звук, мотор)" />
          <WorkMultiSelect label="Диагностика (работы в любом случае)" works={works}
            value={t.diagnosticWorkCodes} onChange={(diagnosticWorkCodes) => setT({ ...t, diagnosticWorkCodes })} />
          <TextField select size="small" fullWidth label="Модели корабликов (пусто = все)" value={t.relatedModels}
            SelectProps={{ multiple: true, renderValue: (sel) => (sel as string[]).join(', ') || 'усі' }}
            onChange={(e) => setT({ ...t, relatedModels: typeof e.target.value === 'string' ? e.target.value.split(',') : (e.target.value as unknown as string[]) })}>
            {BOAT_MODELS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
          </TextField>

          <Divider textAlign="left"><Typography variant="caption">Варианты ремонта</Typography></Divider>
          {[...t.variants].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)).map((v) => {
            const i = t.variants.findIndex((x) => x.id === v.id)
            return (
              <Paper key={v.id} variant="outlined" sx={{ p: 1.5 }}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1 }}>
                  <TextField select size="small" label="Случай" sx={{ width: 150 }} value={v.severity}
                    onChange={(e) => setVariant(i, { severity: e.target.value as VariantSeverity })}>
                    {SEVERITY_ORDER.map((s) => <MenuItem key={s} value={s}>{SEVERITY_LABELS[s]}</MenuItem>)}
                  </TextField>
                  <Box sx={{ flex: 1 }}><LocalizedField label="Что делаем" value={v.label} onChange={(label) => setVariant(i, { label })} /></Box>
                  <Chip label={formatMoney(variantTotal(v, t.diagnosticWorkCodes))} size="small" color="primary" variant="outlined" />
                  <IconButton size="small" onClick={() => setT({ ...t, variants: t.variants.filter((x) => x.id !== v.id) })}><DeleteIcon fontSize="small" /></IconButton>
                </Box>
                <WorkMultiSelect label="Работы этого варианта" works={works} value={v.workCodes}
                  onChange={(workCodes) => setVariant(i, { workCodes })} />
              </Paper>
            )
          })}
          <Button size="small" startIcon={<AddIcon />}
            onClick={() => setT({ ...t, variants: [...t.variants, { id: genId('v'), label: emptyLoc(), severity: 'worst', workCodes: [] }] })}>
            Добавить вариант
          </Button>

          <FormControlLabel control={<Switch checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} />} label="Активен" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" startIcon={saving ? <CircularProgress size={18} /> : <SaveIcon />} onClick={save} disabled={saving || !t.symptom.uk}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}
