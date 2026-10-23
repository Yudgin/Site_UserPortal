// Діалог «Запросити в чат з помічником» (server/chatInvites.js). Два кроки:
//  1) співробітник вказує тему (бачить клієнт), що вже відомо (для помічника) і телефон → «Далі»: сервер
//     перекладає тему українською і показує точний текст SMS (нічого ще не створено);
//  2) «Надіслати»: сервер створює чат /c/<id> з першим повідомленням помічника і надсилає SMS.
// Переиспользуемый: открыть можно откуда угодно (инбокс, заявка, звонок оператора) с префиллом полей.
// Монтировать условно ({open && <ChatInviteDialog …/>}), чтобы каждое открытие начиналось с чистой формы.
import { useState } from 'react'
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField, MenuItem, Alert,
  FormControlLabel, Switch, Typography, Box, CircularProgress,
} from '@mui/material'
import { ContentCopy as CopyIcon, OpenInNew as OpenIcon } from '@mui/icons-material'
import { chatInviteApi, newInviteClientKey, type ChatInvitePreview, type ChatInviteResult } from '@/api/endpoints/chatInvites'
import type { ChatInviteMode, ChatInviteSource } from '@/types/chat'

const TOPIC_MAX = 80
const DETAILS_MAX = 2000

const SMS_STATUS: Record<string, string> = {
  sent: 'SMS надіслано.',
  failed: 'SMS не надіслано',
  skipped: 'Без SMS — передайте посилання клієнту самі.',
  pending: 'SMS надсилається…',
}

export default function ChatInviteDialog({ open, onClose, phone: phone0 = '', name: name0 = '', topic: topic0 = '', details: details0 = '', serviceRequestId, source = 'portal', onCreated }: {
  open: boolean
  onClose: () => void
  phone?: string
  name?: string
  topic?: string
  details?: string
  serviceRequestId?: string // з заявки: телефон за замовчуванням — клієнта заявки
  source?: ChatInviteSource
  onCreated?: (invite: ChatInviteResult) => void
}) {
  const [phone, setPhone] = useState(phone0)
  const [name, setName] = useState(name0)
  const [topic, setTopic] = useState(topic0)
  const [details, setDetails] = useState(details0)
  const [mode, setMode] = useState<ChatInviteMode>('knowledge')
  const [sendSms, setSendSms] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<ChatInvitePreview | null>(null)
  const [finalTopic, setFinalTopic] = useState('')
  const [result, setResult] = useState<ChatInviteResult | null>(null)
  const [copied, setCopied] = useState(false)
  // Один ключ на крок «Надіслати»: повторне натискання/ретрай не створить друге запрошення і другий SMS.
  // «Назад» (зміна полів) — новий ключ: це вже інше запрошення.
  const [clientKey, setClientKey] = useState(newInviteClientKey)

  const topicTrim = topic.trim()
  const canNext = topicTrim.length >= 3 && topicTrim.length <= TOPIC_MAX && details.length <= DETAILS_MAX
    && (!sendSms || !!phone.trim() || !!serviceRequestId)

  const base = () => ({
    details: details.trim() || undefined,
    phone: phone.trim() || undefined,
    name: name.trim() || undefined,
    mode,
    deliver: sendSms ? 'sms' as const : 'none' as const,
    serviceRequestId,
    source,
  })

  // Перевірка на сервері (переклад теми, права на SMS, точний текст SMS). confirmed — тема вже відредагована
  // співробітником на кроці 2: сервер її не переписує, лише перевіряє.
  const check = async (t: string, confirmed: boolean) => {
    if (busy) return
    setBusy(true)
    setError('')
    const r = await chatInviteApi.preview({ ...base(), topic: t, topicConfirmed: confirmed })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setPreview(r.data)
    setFinalTopic(r.data.topic)
  }
  const next = () => { if (canNext) check(topicTrim, false) }
  const edited = !!preview && finalTopic.trim() !== preview.topic

  const submit = async () => {
    const t = finalTopic.trim()
    if (!t || busy) return
    setBusy(true)
    setError('')
    const r = await chatInviteApi.create({ ...base(), topic: t, topicConfirmed: true, topicInput: topicTrim !== t ? topicTrim : undefined, clientKey })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setResult(r.data)
    onCreated?.(r.data)
  }

  const copy = async () => {
    if (!result) return
    try { await navigator.clipboard.writeText(result.url); setCopied(true) } catch { setCopied(false) }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Запросити в чат з помічником</DialogTitle>
      <DialogContent dividers>
        {result ? (
          <Stack spacing={2}>
            <Alert severity={result.sms.status === 'failed' ? 'warning' : 'success'}>
              {result.created ? 'Чат створено, перше повідомлення помічника вже в ньому.' : 'Це запрошення вже було створено.'}{' '}
              {SMS_STATUS[result.sms.status] || ''}
              {result.sms.status === 'failed' && result.sms.error ? ` (${result.sms.error}). Скопіюйте посилання і надішліть іншим способом.` : ''}
            </Alert>
            <Box>
              <Typography variant="caption" color="text.secondary">Посилання для клієнта</Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{result.url}</Typography>
            </Box>
            {result.sms.text && (
              <Box>
                <Typography variant="caption" color="text.secondary">Текст SMS</Typography>
                <Typography variant="body2">{result.sms.text}</Typography>
              </Box>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Button startIcon={<CopyIcon />} onClick={copy}>{copied ? 'Скопійовано' : 'Копіювати посилання'}</Button>
              <Button startIcon={<OpenIcon />} href={result.url} target="_blank" rel="noopener">Відкрити чат</Button>
            </Stack>
          </Stack>
        ) : preview ? (
          <Stack spacing={2}>
            {preview.topicChanged && (
              <Alert severity="info">Тему переписано українською — її побачить клієнт. Перевірте й за потреби виправте.</Alert>
            )}
            <TextField label="Тема для клієнта" value={finalTopic} onChange={(e) => setFinalTopic(e.target.value)}
              inputProps={{ maxLength: TOPIC_MAX }} helperText="Українською, без посилань і номерів" />
            {preview.deliver === 'sms' ? (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  SMS на {preview.phone} · {preview.smsSegments} {preview.smsSegments === 1 ? 'частина' : preview.smsSegments < 5 ? 'частини' : 'частин'} (оплачується кожна) · посилання з’явиться після створення
                </Typography>
                <Typography variant="body2" color={edited ? 'text.disabled' : undefined}>{preview.smsText}</Typography>
                {edited && <Typography variant="caption" color="warning.main">Тему змінено — натисніть «Перевірити», щоб побачити новий текст SMS.</Typography>}
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">Без SMS: після створення скопіюйте посилання і надішліть клієнту самі.</Typography>
            )}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Клієнт отримає посилання на чат, де помічник одразу почне розмову на цю тему й допоможе за базою знань.
            </Typography>
            <TextField label="Тема розмови (бачить клієнт)" required value={topic} onChange={(e) => setTopic(e.target.value)}
              placeholder="Кришка для Solo V2" inputProps={{ maxLength: TOPIC_MAX }}
              helperText={`Коротко — піде в SMS і в шапку чату; якщо напишете російською, помічник перекладе (${topicTrim.length}/${TOPIC_MAX})`} />
            <TextField label="Що вже відомо, які бувають варіанти (для помічника)" multiline minRows={3} value={details}
              onChange={(e) => setDetails(e.target.value)} inputProps={{ maxLength: DETAILS_MAX }}
              placeholder="Наприклад: кораблик купили приблизно 2019 року; кришки бувають з двома защіпками і на магнітах"
              helperText="Помічник спиратиметься на це в розмові. Клієнту не показується, але може потрапити у відповіді — не пишіть того, що клієнту бачити не можна." />
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
              <TextField label="Телефон" required={sendSms && !serviceRequestId} value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="+380…" helperText={serviceRequestId && !phone.trim() ? 'Порожньо — номер клієнта заявки' : ' '} />
              <TextField label="Імʼя (необовʼязково)" value={name} onChange={(e) => setName(e.target.value)} helperText=" " />
            </Box>
            <TextField select label="Помічник" value={mode} onChange={(e) => setMode(e.target.value as ChatInviteMode)}>
              <MenuItem value="knowledge">Консультація за базою знань</MenuItem>
              <MenuItem value="estimate">Оцінка вартості ремонту за прайсом</MenuItem>
            </TextField>
            <FormControlLabel control={<Switch checked={sendSms} onChange={(e) => setSendSms(e.target.checked)} />}
              label="Надіслати SMS із запрошенням" />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {preview && !result && <Button onClick={() => { setPreview(null); setError(''); setClientKey(newInviteClientKey()) }} disabled={busy}>Назад</Button>}
        <Button onClick={onClose} disabled={busy}>{result ? 'Закрити' : 'Скасувати'}</Button>
        {!result && !preview && (
          <Button variant="contained" onClick={next} disabled={!canNext || busy} startIcon={busy ? <CircularProgress size={16} /> : undefined}>
            Далі
          </Button>
        )}
        {!result && preview && edited && (
          <Button variant="contained" onClick={() => check(finalTopic.trim(), true)} disabled={!finalTopic.trim() || busy} startIcon={busy ? <CircularProgress size={16} /> : undefined}>
            Перевірити
          </Button>
        )}
        {!result && preview && !edited && (
          <Button variant="contained" onClick={submit} disabled={!finalTopic.trim() || busy} startIcon={busy ? <CircularProgress size={16} /> : undefined}>
            {preview.deliver === 'sms' ? 'Створити і надіслати SMS' : 'Створити посилання'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
