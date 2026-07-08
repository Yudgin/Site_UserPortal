import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Box, Container, Paper, Typography, Button, Tabs, Tab, Alert, Snackbar,
  CircularProgress, Chip,
} from '@mui/material'
import {
  Save as SaveIcon, Home as HomeIcon, Description as TermsIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import AiTextEditor from '@/components/common/AiTextEditor'
import { serviceContentService, SERVICE_CONTENT_KEYS } from '@/api/serviceContentService'
import { AiHistoryEntry } from '@/api/endpoints/ai'
import type { Lang, LocalizedText } from '@/types/pricing'

const LANGS: { code: Lang; label: string }[] = [
  { code: 'uk', label: 'Українська' }, { code: 'ru', label: 'Русский' }, { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' }, { code: 'pl', label: 'Polski' }, { code: 'ro', label: 'Română' },
]

export default function ServiceContentAdminPage() {
  const navigate = useNavigate()
  const { i18n } = useTranslation()
  const { user } = useAuthStore()

  const [content, setContent] = useState<LocalizedText>({ uk: '' })
  const [aiHistory, setAiHistory] = useState<AiHistoryEntry[]>([])
  const [activeLang, setActiveLang] = useState<Lang>('uk')
  const [loading, setLoading] = useState(true)
  const [persisted, setPersisted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false, message: '', severity: 'success',
  })

  useEffect(() => {
    ;(async () => {
      const doc = await serviceContentService.load(SERVICE_CONTENT_KEYS.terms)
      if (doc) {
        setContent(doc.content || { uk: '' })
        setAiHistory(doc.aiHistory || [])
        setPersisted(true)
      } else {
        // Первичное наполнение из текущих переводов i18n (service.termsText)
        const seed: LocalizedText = { uk: '' }
        for (const l of LANGS) {
          const v = i18n.getFixedT(l.code)('service.termsText')
          if (v && v !== 'service.termsText') (seed as Record<string, string>)[l.code] = v
        }
        setContent(seed)
      }
      setLoading(false)
    })()
  }, [i18n])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ только для администратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На главную</Button>
      </Container>
    )
  }

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
  }

  const handleSave = async () => {
    setSaving(true)
    const ok = await serviceContentService.save(SERVICE_CONTENT_KEYS.terms, { content, aiHistory })
    setSaving(false)
    setPersisted(ok || persisted)
    setSnackbar({
      open: true,
      message: ok ? 'Соглашение сохранено' : 'Не удалось сохранить (нужны права администратора)',
      severity: ok ? 'success' : 'error',
    })
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TermsIcon color="primary" sx={{ fontSize: 28 }} />
          <Typography variant="h5">Текст соглашения сервиса</Typography>
          <Chip size="small" label={persisted ? 'сохранён в базе' : 'ещё не сохранён'}
            color={persisted ? 'success' : 'warning'} variant="outlined" />
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Главная</Button>
          <Button variant="contained" startIcon={saving ? <CircularProgress size={18} /> : <SaveIcon />}
            onClick={handleSave} disabled={saving}>Сохранить</Button>
        </Box>
      </Box>

      <Container maxWidth="md" sx={{ pb: 6 }}>
        <Paper sx={{ p: { xs: 1.5, sm: 3 } }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Этот текст клиент видит и принимает в заявке перед началом обслуживания. Отредактируйте вручную
            или опишите ИИ, что изменить. Правки по каждому языку — на отдельной вкладке.
          </Typography>

          <Tabs value={activeLang} onChange={(_, v) => setActiveLang(v)} variant="scrollable" scrollButtons="auto" sx={{ mb: 2 }}>
            {LANGS.map((l) => <Tab key={l.code} value={l.code} label={l.label} />)}
          </Tabs>

          <AiTextEditor
            key={activeLang}
            label={`Текст соглашения (${activeLang.toUpperCase()})`}
            value={(content as Record<string, string>)[activeLang] || ''}
            onChange={(v) => setContent((c) => ({ ...c, [activeLang]: v }))}
            context="terms"
            lang={activeLang}
            history={aiHistory}
            onHistoryChange={setAiHistory}
            minRows={10}
            placeholder="Введите текст условий обслуживания…"
          />
        </Paper>
      </Container>

      <Snackbar open={snackbar.open} autoHideDuration={3000} onClose={() => setSnackbar((s) => ({ ...s, open: false }))}>
        <Alert severity={snackbar.severity}>{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  )
}
