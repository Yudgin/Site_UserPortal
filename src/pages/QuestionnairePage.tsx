import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, TextField, MenuItem, Button, Stack, Divider,
  CircularProgress, Alert, FormControlLabel, Switch, Collapse,
} from '@mui/material'
import { AutoAwesome as AiIcon, DirectionsBoat as BoatIcon, Send as SendIcon } from '@mui/icons-material'
import { chatSessionService } from '@/api/chatSessionService'
import { clientBoatService } from '@/api/clientBoatService'
import { clientProfileService } from '@/api/clientProfileService'
import { aiApi } from '@/api/endpoints/ai'
import type { ChatMessage } from '@/types/chat'
import {
  BOAT_MODELS, ECHO_LABELS, SATISFACTION_LABELS, AUTOPILOT_PRESENCE_LABELS, WARRANTY_LABELS,
  type EchoType, type Satisfaction, type AutopilotPresence, type WarrantyStatus,
} from '@/types/clientBoat'

const genMsgId = (): string => Math.random().toString(36).slice(2, 10)

// Опросник приёмки (украинский). Клиент описывает кораблик и проблему; ИИ помогает
// сформулировать. На выходе — запись в базе клиентов + сессия оценки в чате.
export default function QuestionnairePage() {
  const navigate = useNavigate()

  // Кораблик
  const [model, setModel] = useState('')
  const [year, setYear] = useState('')
  const [echo, setEcho] = useState<EchoType>('none')
  const [autopilotPresence, setAutopilotPresence] = useState<AutopilotPresence>('unknown')
  const [autopilotModel, setAutopilotModel] = useState('')
  const [autopilotUpdated, setAutopilotUpdated] = useState(false)
  const [autopilotUpdateYear, setAutopilotUpdateYear] = useState('')
  const [satisfaction, setSatisfaction] = useState<Satisfaction>('unknown')
  const [warranty, setWarranty] = useState<WarrantyStatus>('unknown')
  const [wishes, setWishes] = useState('')

  // Проблема
  const [problem, setProblem] = useState('')
  const [whenOccurs, setWhenOccurs] = useState('')
  const [tried, setTried] = useState('')
  const [urgency, setUrgency] = useState('')

  // Контакт
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')

  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // ИИ помогает клиенту чётче сформулировать описание проблемы
  const improveProblem = async () => {
    if (!problem.trim()) return
    setAiLoading(true)
    setAiError('')
    const res = await aiApi.improveText({
      currentText: problem,
      userPrompt: 'Переформулюй опис несправності прикормочного кораблика чітко й коротко, ' +
        'збережи всі факти, додай уточнення що варто перевірити. Українською.',
      context: 'diagnostics',
      lang: 'uk',
    })
    setAiLoading(false)
    if (res.success && res.data) setProblem(res.data.text)
    else setAiError(res.error?.message || 'Не вдалося обробити текст')
  }

  const autopilotText = (): string => {
    if (autopilotPresence === 'none') return 'немає'
    if (autopilotPresence === 'unknown') return 'клієнт не знає, чи встановлено'
    return autopilotModel.trim() || 'встановлено, модель невідома'
  }

  // Текст первого сообщения для оценки: кораблик + проблема
  const compose = (): string => {
    const boat = [
      model && `модель: ${model}`,
      year && `рік: ${year}`,
      `ехолот: ${ECHO_LABELS[echo]}`,
      `автопілот: ${autopilotText()}`,
      autopilotPresence === 'yes'
        ? (autopilotUpdated ? `оновлення ПЗ автопілота: так${autopilotUpdateYear ? `, ${autopilotUpdateYear} р.` : ''}` : 'оновлення ПЗ автопілота: ні')
        : '',
    ].filter(Boolean).join(', ')
    const lines = [
      `Кораблик — ${boat}.`,
      `Гарантія: ${WARRANTY_LABELS[warranty]}.`,
      `Проблема: ${problem.trim()}.`,
      whenOccurs && `Виникає: ${whenOccurs}.`,
      tried && `Що вже пробували: ${tried}.`,
      urgency && `Терміновість: ${urgency}.`,
      wishes.trim() && `Побажання клієнта: ${wishes.trim()}.`,
    ].filter(Boolean)
    return lines.join('\n')
  }

  const submit = async () => {
    if (!problem.trim()) return
    setSubmitting(true)
    setAiError('')
    // Firestore не принимает undefined — собираем contact только из заполненных полей
    const contact = (name.trim() || phone.trim() || email.trim())
      ? {
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
        }
      : null

    const firstMsg: ChatMessage = { id: genMsgId(), role: 'client', text: compose(), at: new Date().toISOString() }
    const session = await chatSessionService.create({ lang: 'uk', contact, messages: [firstMsg] })
    if (!session) {
      setSubmitting(false)
      setAiError('Не вдалося створити звернення. Спробуйте ще раз.')
      return
    }

    // Запись в базе клиентов и корабликов (best-effort, не блокирует оценку)
    const apPresent = autopilotPresence === 'yes'
    const boat = await clientBoatService.create({
      contact,
      model: model.trim(),
      year: year.trim(),
      echo,
      autopilotPresence,
      autopilotModel: apPresent ? autopilotModel.trim() : '',
      autopilotUpdated: apPresent ? autopilotUpdated : false,
      autopilotUpdateYear: apPresent && autopilotUpdated ? autopilotUpdateYear.trim() : '',
      satisfaction,
      warranty,
      purchaseDate: null,
      wishes: wishes.trim(),
      source: 'questionnaire',
      externalId: null,
      sessionId: session.id,
    })

    // Профиль клиента по телефону (авто-слияние по номеру). Best-effort.
    if (phone.trim()) {
      await clientProfileService.upsertByPhone(phone, {
        name: name.trim(), email: email.trim(),
        sessionId: session.id, boatId: boat?.id ?? null,
      })
    }

    setSubmitting(false)
    navigate(`/chat/${session.id}`)
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', py: { xs: 3, md: 5 } }}>
      <Container maxWidth="sm">
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <BoatIcon color="primary" />
          <Typography variant="h5">Опишіть ваш кораблик і проблему</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Заповніть коротко — і ми одразу підготуємо орієнтовну оцінку. Дані про кораблик
          допоможуть нам вести вашу історію обслуговування. Помічник ІІ допоможе сформулювати.
        </Typography>

        <Paper sx={{ p: { xs: 2, md: 3 } }}>
          {/* ==== Кораблик ==== */}
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Ваш кораблик</Typography>
          <Stack spacing={2}>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
              <TextField select size="small" label="Модель" value={model} onChange={(e) => setModel(e.target.value)}>
                <MenuItem value="">— оберіть —</MenuItem>
                {BOAT_MODELS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
                <MenuItem value="Інша">Інша / не знаю</MenuItem>
              </TextField>
              <TextField size="small" label="Рік кораблика" value={year} onChange={(e) => setYear(e.target.value)}
                placeholder="напр. 2022" />
            </Box>

            <TextField select size="small" label="Ехолот / глибиномір" value={echo}
              onChange={(e) => setEcho(e.target.value as EchoType)}>
              {(Object.keys(ECHO_LABELS) as EchoType[]).map((k) => (
                <MenuItem key={k} value={k}>{ECHO_LABELS[k]}</MenuItem>
              ))}
            </TextField>

            <Box>
              <TextField select size="small" fullWidth label="Автопілот" value={autopilotPresence}
                onChange={(e) => setAutopilotPresence(e.target.value as AutopilotPresence)}>
                {(Object.keys(AUTOPILOT_PRESENCE_LABELS) as AutopilotPresence[]).map((k) => (
                  <MenuItem key={k} value={k}>{AUTOPILOT_PRESENCE_LABELS[k]}</MenuItem>
                ))}
              </TextField>
              <Collapse in={autopilotPresence === 'yes'}>
                <TextField size="small" fullWidth label="Модель автопілота (якщо знаєте)" value={autopilotModel}
                  onChange={(e) => setAutopilotModel(e.target.value)} sx={{ mt: 1 }}
                  helperText="Залиште порожнім, якщо автопілот стоїть, але модель невідома" />
                <FormControlLabel sx={{ mt: 1 }}
                  control={<Switch checked={autopilotUpdated} onChange={(e) => setAutopilotUpdated(e.target.checked)} />}
                  label="Оновлювали ПЗ автопілота" />
                <Collapse in={autopilotUpdated}>
                  <TextField size="small" fullWidth label="Рік оновлення" value={autopilotUpdateYear}
                    onChange={(e) => setAutopilotUpdateYear(e.target.value)} placeholder="напр. 2024" sx={{ mt: 1 }} />
                </Collapse>
              </Collapse>
            </Box>

            <TextField select size="small" label="Чи на гарантії кораблик?" value={warranty}
              onChange={(e) => setWarranty(e.target.value as WarrantyStatus)}
              helperText="Гарантія — 1 рік з дати продажу">
              {(Object.keys(WARRANTY_LABELS) as WarrantyStatus[]).map((k) => (
                <MenuItem key={k} value={k}>{WARRANTY_LABELS[k]}</MenuItem>
              ))}
            </TextField>
            <TextField select size="small" label="Чи задоволені корабликом загалом?" value={satisfaction}
              onChange={(e) => setSatisfaction(e.target.value as Satisfaction)}>
              {(Object.keys(SATISFACTION_LABELS) as Satisfaction[]).map((k) => (
                <MenuItem key={k} value={k}>{SATISFACTION_LABELS[k]}</MenuItem>
              ))}
            </TextField>
            <TextField size="small" multiline minRows={2} label="Загальні побажання (необов’язково)"
              value={wishes} onChange={(e) => setWishes(e.target.value)} />
          </Stack>

          {/* ==== Проблема ==== */}
          <Divider sx={{ my: 2.5 }} />
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Проблема</Typography>
          <TextField fullWidth multiline minRows={4} label="Опишіть, що не так" value={problem}
            onChange={(e) => setProblem(e.target.value)} placeholder="Напр.: кораблик не тримає курс, тягне вліво…" />
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1 }}>
            <Button size="small" startIcon={aiLoading ? <CircularProgress size={14} /> : <AiIcon />}
              onClick={improveProblem} disabled={aiLoading || !problem.trim()}>
              Допомогти сформулювати
            </Button>
            {aiError && <Typography variant="caption" color="error">{aiError}</Typography>}
          </Box>

          <Stack spacing={2} sx={{ mt: 2 }}>
            <TextField select size="small" label="Коли виникає" value={whenOccurs} onChange={(e) => setWhenOccurs(e.target.value)}>
              <MenuItem value="">—</MenuItem>
              <MenuItem value="при запуску">При запуску</MenuItem>
              <MenuItem value="на воді під навантаженням">На воді під навантаженням</MenuItem>
              <MenuItem value="при заряджанні">При заряджанні</MenuItem>
              <MenuItem value="постійно">Постійно</MenuItem>
              <MenuItem value="час від часу">Час від часу</MenuItem>
            </TextField>
            <TextField size="small" label="Що вже пробували (необов’язково)" value={tried} onChange={(e) => setTried(e.target.value)} />
            <TextField select size="small" label="Терміновість" value={urgency} onChange={(e) => setUrgency(e.target.value)}>
              <MenuItem value="">—</MenuItem>
              <MenuItem value="терміново, сезон">Терміново (сезон)</MenuItem>
              <MenuItem value="звичайна">Звичайна</MenuItem>
              <MenuItem value="можу зачекати">Можу зачекати</MenuItem>
            </TextField>
          </Stack>

          {/* ==== Контакт ==== */}
          <Divider sx={{ my: 2.5 }} />
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Контакт (необов’язково)</Typography>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <TextField size="small" label="Ім’я" value={name} onChange={(e) => setName(e.target.value)} />
            <TextField size="small" label="Телефон" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Box>
          <TextField size="small" fullWidth label="Email" value={email} onChange={(e) => setEmail(e.target.value)} sx={{ mt: 2 }} />

          <Alert severity="info" icon={false} sx={{ mt: 2.5, fontSize: 13 }}>
            Оцінка орієнтовна й формується автоматизованим помічником. Точний кошторис складе майстер
            після діагностики. За потреби передамо діалог менеджеру.
          </Alert>

          <Button fullWidth size="large" variant="contained" sx={{ mt: 2 }}
            startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : <SendIcon />}
            onClick={submit} disabled={submitting || !problem.trim()}>
            Отримати орієнтовну оцінку
          </Button>
        </Paper>
      </Container>
    </Box>
  )
}
