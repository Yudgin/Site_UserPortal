import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, IconButton, Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Switch, FormControlLabel, Collapse, Chip, Alert, Snackbar, CircularProgress,
  Divider, Tabs, Tab,
} from '@mui/material'
import {
  Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon, Save as SaveIcon,
  Home as HomeIcon, MenuBook as KnowledgeIcon, CloudUpload as UploadIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import AiTextEditor from '@/components/common/AiTextEditor'
import { knowledgeService, newKnowledgeId } from '@/api/knowledgeService'
import { AiHistoryEntry } from '@/api/endpoints/ai'
import type { Lang, LocalizedText } from '@/types/pricing'
import type { KnowledgeArticle, KnowledgeVideo, KnowledgeImage } from '@/types/knowledge'

const LANGS: { code: Lang; label: string }[] = [
  { code: 'uk', label: 'UA' }, { code: 'ru', label: 'RU' }, { code: 'en', label: 'EN' },
  { code: 'de', label: 'DE' }, { code: 'pl', label: 'PL' }, { code: 'ro', label: 'RO' },
]

const emptyLocalized = (): LocalizedText => ({ uk: '' })
const t = (v: LocalizedText | undefined) => v?.uk || ''

// Локализованное поле: украинский + сворачиваемые остальные языки
function LocalizedField({ label, value, onChange }: { label: string; value: LocalizedText; onChange: (v: LocalizedText) => void }) {
  const [open, setOpen] = useState(false)
  const set = (lang: Lang, v: string) => onChange({ ...value, [lang]: v })
  return (
    <Box>
      <TextField label={`${label} (UA)`} value={value.uk || ''} size="small" fullWidth onChange={(e) => set('uk', e.target.value)} />
      <Button size="small" onClick={() => setOpen(!open)} sx={{ mt: 0.5 }}>{open ? 'Скрыть переводы' : 'Другие языки'}</Button>
      <Collapse in={open}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1, mt: 1 }}>
          {LANGS.filter((l) => l.code !== 'uk').map((l) => (
            <TextField key={l.code} label={l.label} value={(value as Record<string, string>)[l.code] || ''} size="small"
              onChange={(e) => set(l.code, e.target.value)} />
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}

const blankArticle = (): KnowledgeArticle => ({
  // id генерируем сразу — чтобы изображения грузились в стабильный путь knowledge/{id} ещё до сохранения
  id: newKnowledgeId(), title: emptyLocalized(), body: emptyLocalized(),
  forConsultation: true, forSelfService: false, tags: [], relatedWorkCodes: [],
  images: [], videos: [], links: [], active: true, updatedAt: '', updatedBy: null,
})

export default function KnowledgeAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [articles, setArticles] = useState<KnowledgeArticle[]>([])
  const [editing, setEditing] = useState<KnowledgeArticle | null>(null)
  const [loading, setLoading] = useState(true)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false, message: '', severity: 'success',
  })

  const reload = async () => {
    setLoading(true)
    setArticles(await knowledgeService.listAll())
    setLoading(false)
  }
  useEffect(() => { reload() }, [])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ только для администратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На главную</Button>
      </Container>
    )
  }

  const notify = (message: string, severity: 'success' | 'error' = 'success') => setSnackbar({ open: true, message, severity })

  const remove = async (id: string) => {
    const ok = await knowledgeService.delete(id)
    if (ok) { setArticles((a) => a.filter((x) => x.id !== id)); notify('Статья удалена') }
    else notify('Не удалось удалить', 'error')
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <KnowledgeIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">База знаний</Typography>
          <Chip size="small" label={`${articles.length} статей`} variant="outlined" />
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing(blankArticle())}>Добавить статью</Button>
        </Box>
      </Box>

      <Container maxWidth="lg" sx={{ pb: 6 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Единая база: «Консультация» — эксплуатация (зарядка АКБ, настройка); «Самопомощь» — как сделать самому
          (альтернатива платному ремонту). ИИ подбирает материалы по контексту.
        </Typography>
        <Paper sx={{ p: { xs: 1, sm: 2 } }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Заголовок</TableCell><TableCell>Признаки</TableCell>
                    <TableCell align="center">Картинки/видео/ссылки</TableCell><TableCell align="right">Действия</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {articles.map((a) => (
                    <TableRow key={a.id} sx={{ opacity: a.active ? 1 : 0.5 }}>
                      <TableCell>{t(a.title)}</TableCell>
                      <TableCell>
                        {a.forConsultation && <Chip size="small" label="консультация" color="info" variant="outlined" sx={{ mr: 0.5 }} />}
                        {a.forSelfService && <Chip size="small" label="самопомощь" color="success" variant="outlined" sx={{ mr: 0.5 }} />}
                        {a.forMasters && <Chip size="small" label="мастерам" color="warning" variant="outlined" />}
                      </TableCell>
                      <TableCell align="center">{(a.images || []).length}/{a.videos.length}/{a.links.length}</TableCell>
                      <TableCell align="right">
                        <IconButton size="small" onClick={() => setEditing(structuredClone(a))}><EditIcon fontSize="small" /></IconButton>
                        <IconButton size="small" onClick={() => remove(a.id)}><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                  {articles.length === 0 && (
                    <TableRow><TableCell colSpan={4} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      Пока нет статей. Добавьте первую — ИИ поможет с текстом.
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      </Container>

      {editing && (
        <ArticleDialog
          article={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setArticles((list) => {
              const exists = list.some((x) => x.id === saved.id)
              return exists ? list.map((x) => (x.id === saved.id ? saved : x)) : [saved, ...list]
            })
            setEditing(null)
            notify('Статья сохранена')
          }}
          onError={() => notify('Не удалось сохранить (нужны права администратора)', 'error')}
        />
      )}

      <Snackbar open={snackbar.open} autoHideDuration={3000} onClose={() => setSnackbar((s) => ({ ...s, open: false }))}>
        <Alert severity={snackbar.severity}>{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  )
}

// ==== Диалог статьи ====
function ArticleDialog({ article, onClose, onSaved, onError }: {
  article: KnowledgeArticle
  onClose: () => void
  onSaved: (a: KnowledgeArticle) => void
  onError: () => void
}) {
  const [a, setA] = useState<KnowledgeArticle>(article)
  const [bodyLang, setBodyLang] = useState<Lang>('uk')
  const [aiHistory, setAiHistory] = useState<AiHistoryEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')

  const handleUpload = async (files: FileList | null) => {
    if (!files || !files.length) return
    setUploading(true); setUploadErr('')
    const added: KnowledgeImage[] = []
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue
      if (f.size > 8 * 1024 * 1024) { setUploadErr('Зображення завелике (макс. 8 МБ).'); continue }
      const res = await knowledgeService.uploadImage(a.id, f)
      if (res) added.push(res)
      else setUploadErr('Не вдалося завантажити (перевірте права адміністратора / підключення).')
    }
    if (added.length) setA((prev) => ({ ...prev, images: [...(prev.images || []), ...added] }))
    setUploading(false)
  }
  const removeImage = (i: number) => {
    const img = (a.images || [])[i]
    setA((prev) => ({ ...prev, images: (prev.images || []).filter((_, idx) => idx !== i) }))
    if (img?.path) knowledgeService.deleteImage(img.path) // best-effort очистка Storage
  }
  const setCaption = (i: number, caption: string) =>
    setA((prev) => ({ ...prev, images: (prev.images || []).map((im, idx) => (idx === i ? { ...im, caption } : im)) }))

  const setBody = (v: string) => setA((prev) => ({ ...prev, body: { ...prev.body, [bodyLang]: v } }))
  const setVideo = (i: number, patch: Partial<KnowledgeVideo>) =>
    setA((prev) => ({ ...prev, videos: prev.videos.map((v, idx) => (idx === i ? { ...v, ...patch } : v)) }))

  const handleSave = async () => {
    setSaving(true)
    const res = await knowledgeService.save(a)
    setSaving(false)
    if (res) onSaved({ ...a, id: res.id })
    else onError()
  }

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Статья базы знаний</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <LocalizedField label="Заголовок" value={a.title} onChange={(title) => setA({ ...a, title })} />

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Текст статьи</Typography>
            <Tabs value={bodyLang} onChange={(_, v) => setBodyLang(v)} variant="scrollable" scrollButtons="auto" sx={{ mb: 1 }}>
              {LANGS.map((l) => <Tab key={l.code} value={l.code} label={l.label} />)}
            </Tabs>
            <AiTextEditor
              key={bodyLang}
              value={(a.body as Record<string, string>)[bodyLang] || ''}
              onChange={setBody}
              context="knowledge"
              lang={bodyLang}
              history={aiHistory}
              onHistoryChange={setAiHistory}
              minRows={8}
              placeholder="Пошаговая инструкция…"
            />
          </Box>

          <Divider />
          <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            <FormControlLabel control={<Switch checked={a.forConsultation} onChange={(e) => setA({ ...a, forConsultation: e.target.checked })} />} label="Консультация (эксплуатация)" />
            <FormControlLabel control={<Switch checked={a.forSelfService} onChange={(e) => setA({ ...a, forSelfService: e.target.checked })} />} label="Самопомощь (сделать самому)" />
            <FormControlLabel control={<Switch checked={!!a.forMasters} onChange={(e) => setA({ ...a, forMasters: e.target.checked })} />} label="Только для мастеров (клиентам не показывать)" />
            <FormControlLabel control={<Switch checked={a.active} onChange={(e) => setA({ ...a, active: e.target.checked })} />} label="Активна" />
          </Box>

          <TextField label="Теги (через запятую)" size="small" value={a.tags.join(', ')}
            onChange={(e) => setA({ ...a, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
          <TextField label="Связанные коды работ (через запятую)" size="small" value={a.relatedWorkCodes.join(', ')}
            onChange={(e) => setA({ ...a, relatedWorkCodes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            helperText="Коды работ прайса, к которым относится статья (напр. W-AUTO)" />

          <Divider textAlign="left"><Typography variant="caption">Иллюстрации</Typography></Divider>
          {uploadErr && <Alert severity="error" sx={{ py: 0 }}>{uploadErr}</Alert>}
          {(a.images || []).length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
              {(a.images || []).map((img, i) => (
                <Box key={i} sx={{ width: 180, border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
                  <Box sx={{ position: 'relative' }}>
                    <Box component="img" src={img.url} alt={img.caption || ''}
                      sx={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 1, display: 'block' }} />
                    <IconButton size="small" onClick={() => removeImage(i)}
                      sx={{ position: 'absolute', top: 2, right: 2, bgcolor: 'rgba(255,255,255,0.85)', '&:hover': { bgcolor: 'white' } }}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                  <TextField size="small" fullWidth variant="standard" placeholder="Підпис…" value={img.caption || ''}
                    onChange={(e) => setCaption(i, e.target.value)} sx={{ mt: 0.5 }} />
                </Box>
              ))}
            </Box>
          )}
          <Button component="label" size="small" disabled={uploading}
            startIcon={uploading ? <CircularProgress size={16} /> : <UploadIcon />}>
            {uploading ? 'Завантаження…' : 'Додати зображення'}
            <input type="file" hidden accept="image/*" multiple
              onChange={(e) => { handleUpload(e.target.files); e.target.value = '' }} />
          </Button>

          <Divider textAlign="left"><Typography variant="caption">Видео</Typography></Divider>
          {a.videos.map((v, i) => (
            <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField size="small" label="Название" value={v.title} sx={{ flex: 1 }} onChange={(e) => setVideo(i, { title: e.target.value })} />
              <TextField size="small" label="URL" value={v.url} sx={{ flex: 2 }} onChange={(e) => setVideo(i, { url: e.target.value })} />
              <IconButton size="small" onClick={() => setA({ ...a, videos: a.videos.filter((_, idx) => idx !== i) })}><DeleteIcon fontSize="small" /></IconButton>
            </Box>
          ))}
          <Button size="small" startIcon={<AddIcon />} onClick={() => setA({ ...a, videos: [...a.videos, { title: '', url: '' }] })}>Добавить видео</Button>

          <TextField label="Ссылки (по одной в строке)" size="small" multiline minRows={2} value={a.links.join('\n')}
            onChange={(e) => setA({ ...a, links: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="contained" startIcon={saving ? <CircularProgress size={18} /> : <SaveIcon />}
          onClick={handleSave} disabled={saving || !a.title.uk}>Сохранить</Button>
      </DialogActions>
    </Dialog>
  )
}
