import { useState } from 'react'
import {
  Box, TextField, Button, Paper, Typography, CircularProgress, Alert, Divider,
  Accordion, AccordionSummary, AccordionDetails, List, ListItem, ListItemText, Chip,
} from '@mui/material'
import {
  AutoAwesome as AiIcon, Check as AcceptIcon, Close as RejectIcon,
  ExpandMore as ExpandMoreIcon, History as HistoryIcon,
} from '@mui/icons-material'
import { aiApi, AiHistoryEntry, AiTextContext } from '@/api/endpoints/ai'

interface AiTextEditorProps {
  value: string
  onChange: (v: string) => void
  label?: string
  context: AiTextContext // тип текста для ИИ (terms, diagnostics, generic)
  lang?: string // язык редактируемого текста
  history?: AiHistoryEntry[]
  onHistoryChange?: (h: AiHistoryEntry[]) => void
  reference?: string // доп. справочный контекст (жалоба + переписка) — ИИ опирается, не копирует
  minRows?: number
  placeholder?: string
}

// Переиспользуемое текстовое поле с ИИ-ассистентом.
// Под полем — промпт «что поменять»; ИИ получает текущий текст + промпт + историю правок
// и возвращает новую версию, которую можно принять или отклонить.
export default function AiTextEditor({
  value, onChange, label, context, lang = 'uk', history = [], onHistoryChange,
  reference, minRows = 6, placeholder,
}: AiTextEditorProps) {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleImprove = async () => {
    if (!prompt.trim()) return
    setLoading(true)
    setError(null)
    setPreview(null)
    const result = await aiApi.improveText({ currentText: value, userPrompt: prompt, history, context, reference, lang })
    setLoading(false)
    if (result.success && result.data) {
      setPreview(result.data.text)
    } else {
      setError(result.error?.message || 'Не удалось обработать запрос')
    }
  }

  const accept = () => {
    if (preview === null) return
    onChange(preview)
    onHistoryChange?.([
      ...history,
      { prompt, resultPreview: preview.slice(0, 140), at: new Date().toISOString() },
    ])
    setPrompt('')
    setPreview(null)
  }

  const reject = () => setPreview(null)

  return (
    <Box>
      <TextField
        label={label} value={value} onChange={(e) => onChange(e.target.value)}
        multiline minRows={minRows} fullWidth placeholder={placeholder}
      />

      {/* Блок ИИ-ассистента */}
      <Paper variant="outlined" sx={{ mt: 1.5, p: 1.5, bgcolor: 'action.hover' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <AiIcon fontSize="small" color="primary" />
          <Typography variant="subtitle2">Помощник ИИ</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            size="small" fullWidth multiline maxRows={3} value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Что изменить? Напр.: «сделай текст короче и добавь пункт про сроки возврата»"
            sx={{ flex: 1, minWidth: 240 }}
          />
          <Button
            variant="contained" onClick={handleImprove} disabled={loading || !prompt.trim()}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <AiIcon />}
            sx={{ flexShrink: 0 }}
          >
            Применить ИИ
          </Button>
        </Box>

        {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}

        {preview !== null && (
          <Paper variant="outlined" sx={{ mt: 1.5, p: 1.5 }}>
            <Typography variant="caption" color="text.secondary">Предложение ИИ:</Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-line', my: 1 }}>{preview}</Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button size="small" variant="contained" color="success" startIcon={<AcceptIcon />} onClick={accept}>
                Принять
              </Button>
              <Button size="small" variant="outlined" startIcon={<RejectIcon />} onClick={reject}>
                Отклонить
              </Button>
            </Box>
          </Paper>
        )}

        {history.length > 0 && (
          <Accordion sx={{ mt: 1, boxShadow: 'none', bgcolor: 'transparent' }} disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <HistoryIcon fontSize="small" color="action" />
                <Typography variant="body2">История правок</Typography>
                <Chip size="small" label={history.length} />
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0 }}>
              <Divider />
              <List dense>
                {[...history].reverse().map((h, i) => (
                  <ListItem key={i} sx={{ px: 0 }}>
                    <ListItemText
                      primary={h.prompt}
                      secondary={h.at ? new Date(h.at).toLocaleString() : undefined}
                    />
                  </ListItem>
                ))}
              </List>
            </AccordionDetails>
          </Accordion>
        )}
      </Paper>
    </Box>
  )
}
