import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, TextField, IconButton, Button, ToggleButton,
  ToggleButtonGroup, Alert, CircularProgress, Chip, Dialog, DialogTitle, DialogContent,
  DialogActions, Snackbar, Divider,
} from '@mui/material'
import {
  Send as SendIcon, SupportAgent as ManagerIcon, ThumbUp as ThumbUpIcon,
  ThumbDown as ThumbDownIcon, AutoAwesome as AiIcon, Build as RepairIcon,
  Inventory2 as PartsIcon, CheckCircle as DoneIcon,
} from '@mui/icons-material'
import { chatSessionService } from '@/api/chatSessionService'
import { pricingService } from '@/api/pricingService'
import { knowledgeService } from '@/api/knowledgeService'
import { behaviorCorrectionService, feedbackService } from '@/api/feedbackService'
import { complaintTemplateService } from '@/api/complaintTemplateService'
import { serviceTaskService } from '@/api/serviceTaskService'
import { aiApi } from '@/api/endpoints/ai'
import { buildPriceContext, buildKnowledgeContext, buildComplaintContext, activeCorrections } from '@/utils/aiContext'
import { escalationDueDate } from '@/utils/workdays'
import type { ChatSession, ChatMessage, ChatAiUsage, ChatOutcome } from '@/types/chat'
import type { AiUsage, ChatMsgInput } from '@/api/endpoints/ai'
import type { FeedbackKind } from '@/types/feedback'

type Mode = 'estimate' | 'knowledge'

const genMsgId = (): string => Math.random().toString(36).slice(2, 10)

// Дисклеймер о неточности ответов ИИ (мягкий, украинский)
const DISCLAIMER = 'Відповіді формує автоматизований помічник — вони можуть бути неточними. ' +
  'Наша мета — допомогти вам, а не нав’язати ремонт. За потреби передамо діалог живому менеджеру.'

export default function ClientChatPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState<ChatSession | null>(null)
  const [mode, setMode] = useState<Mode>('estimate')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingSession, setLoadingSession] = useState(true)
  const [snackbar, setSnackbar] = useState('')
  const [fbOpen, setFbOpen] = useState(false)
  const [partsOpen, setPartsOpen] = useState(false)
  // Предложение комплектующих показываем ТОЛЬКО когда ИИ предложил самостоятельный ремонт;
  // при гарантии — «отримати безкоштовно», иначе — «замовити».
  const [partsOffer, setPartsOffer] = useState<{ show: boolean; warranty: 'yes' | 'no' | 'unknown' }>({ show: false, warranty: 'unknown' })
  const [ctxReady, setCtxReady] = useState(false)

  // Контекст для ИИ (загружается один раз)
  const priceCtx = useRef('')
  const knowledgeCtx = useRef('')
  const corrections = useRef<{ estimate: string[]; consultation: string[] }>({ estimate: [], consultation: [] })
  const autoFired = useRef<string | null>(null) // чтобы авто-ответ на интейк из опросника сработал один раз

  const scrollRef = useRef<HTMLDivElement>(null)

  // Загрузка контекста ИИ
  useEffect(() => {
    ;(async () => {
      const [priceDoc, articles, corr, complaints] = await Promise.all([
        pricingService.loadPriceList(),
        knowledgeService.listAll(),
        behaviorCorrectionService.listActive(),
        complaintTemplateService.listActive(),
      ])
      if (priceDoc) {
        priceCtx.current = buildPriceContext(priceDoc, 'uk')
        const cc = buildComplaintContext(complaints, priceDoc, 'uk')
        if (cc) priceCtx.current += '\n\n' + cc
        // Самопомощь и в режиме оценки: если проблему можно решить самому — предлагаем.
        const selfHelp = buildKnowledgeContext(articles.filter((a) => a.forSelfService && !a.forMasters), 'uk')
        if (selfHelp) priceCtx.current += '\n\nМОЖЛИВА САМОДОПОМОГА (якщо проблему реально вирішити самостійно — доброзичливо запропонуй це перед платним ремонтом; наша мета — допомогти):\n' + selfHelp
      }
      knowledgeCtx.current = buildKnowledgeContext(articles, 'uk')
      corrections.current = {
        estimate: activeCorrections(corr, 'estimate'),
        consultation: activeCorrections(corr, 'consultation'),
      }
      setCtxReady(true)
    })()
  }, [])

  // Загрузка/создание сессии
  useEffect(() => {
    ;(async () => {
      setLoadingSession(true)
      if (sessionId) {
        const s = await chatSessionService.load(sessionId)
        setSession(s)
      } else {
        const s = await chatSessionService.create({ lang: 'uk' })
        if (s) navigate(`/chat/${s.id}`, { replace: true })
      }
      setLoadingSession(false)
    })()
  }, [sessionId, navigate])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [session?.messages.length, sending])

  // Авто-ответ на интейк из опросника: сессия пришла с одним сообщением клиента и без ответа ИИ.
  // Хук должен стоять до ранних return, иначе нарушается порядок хуков (Rules of Hooks).
  useEffect(() => {
    if (!ctxReady || sending || !session) return
    const msgs = session.messages
    if (!msgs.length) return
    const hasAnyReply = msgs.some((m) => m.role !== 'client')
    const last = msgs[msgs.length - 1]
    if (last.role === 'client' && !hasAnyReply && autoFired.current !== session.id) {
      autoFired.current = session.id
      ;(async () => {
        setSending(true)
        await appendAiResponse()
        setSending(false)
      })()
    }
  }, [ctxReady, session, sending]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loadingSession) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>
  }
  if (!session) {
    return (
      <Container maxWidth="sm" sx={{ py: 8 }}>
        <Alert severity="error">Сесію не знайдено або посилання недійсне.</Alert>
      </Container>
    )
  }

  const visibleMessages = session.messages.filter((m) => !m.internal)
  const escalated = session.status === 'escalated'
  const resolved = session.status === 'resolved'

  // Один вызов ИИ по истории диалога (диспатч по режиму)
  const callAi = async (history: ChatMsgInput[]) => {
    const fail = { reply: 'Не вдалося отримати відповідь. Спробуйте ще раз.', needsManager: false, usage: undefined as AiUsage | undefined, offeredSelfRepair: false, warranty: 'unknown' as const }
    if (mode === 'estimate') {
      const res = await aiApi.estimateChat({ messages: history, priceContext: priceCtx.current, corrections: corrections.current.estimate })
      if (res.success && res.data) return { reply: res.data.reply, needsManager: res.data.needsManager, usage: res.data.usage, offeredSelfRepair: res.data.offeredSelfRepair, warranty: res.data.warranty }
      return { ...fail, reply: res.error?.message || fail.reply }
    }
    const res = await aiApi.knowledgeChat({
      messages: history, knowledgeContext: knowledgeCtx.current, corrections: corrections.current.consultation,
    })
    if (res.success && res.data) return { reply: res.data.reply, needsManager: res.data.needsManager, usage: res.data.usage, offeredSelfRepair: false, warranty: 'unknown' as const }
    return { ...fail, reply: res.error?.message || fail.reply }
  }

  // Дописать ответ ИИ и (при необходимости) эскалацию.
  // История для ИИ строится из СВЕЖЕГО снапшота сессии (не из устаревшего замыкания),
  // чтобы учесть сообщения, добавленные менеджером. extraClientMsg — новое сообщение
  // клиента, которое ещё не сохранено (ручной ввод).
  const appendAiResponse = async (extraClientMsg?: ChatMessage) => {
    const preload = (await chatSessionService.load(session.id)) || session
    const baseMessages = extraClientMsg ? [...preload.messages, extraClientMsg] : preload.messages
    const history: ChatMsgInput[] = baseMessages.filter((m) => !m.internal).map((m) => ({ role: m.role, text: m.text }))

    const { reply, needsManager, usage, offeredSelfRepair, warranty } = await callAi(history)
    setPartsOffer({ show: offeredSelfRepair, warranty })
    const aiMsg: ChatMessage = { id: genMsgId(), role: 'ai', text: reply, at: new Date().toISOString() }

    // Перечитать ещё раз перед сохранением — менеджер мог дописать пока ИИ отвечал
    const latest = (await chatSessionService.load(session.id)) || preload
    const tail = extraClientMsg ? [extraClientMsg, aiMsg] : [aiMsg]
    const merged: ChatSession = {
      ...latest,
      messages: [...latest.messages, ...tail],
      aiUsage: accumulateUsage(latest.aiUsage, usage),
    }
    if (needsManager && merged.status === 'active') applyEscalation(merged, 'Автоматичний помічник передав запит менеджеру')
    await chatSessionService.save(merged)
    setSession(merged)
  }

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setSending(true)
    const clientMsg: ChatMessage = { id: genMsgId(), role: 'client', text, at: new Date().toISOString() }
    setSession((s) => (s ? { ...s, messages: [...s.messages, clientMsg] } : s))
    await appendAiResponse(clientMsg)
    setSending(false)
  }

  const escalateManually = async () => {
    const latest = (await chatSessionService.load(session.id)) || session
    if (latest.status !== 'active') { setSession(latest); return }
    const merged: ChatSession = { ...latest }
    applyEscalation(merged, 'Клієнт попросив зв’язатися з менеджером')
    await chatSessionService.save(merged)
    setSession(merged)
    setSnackbar('Запит передано менеджеру. Відповімо протягом 48 робочих годин.')
  }

  // Зафиксировать исход переписки (для менеджера)
  const setOutcome = async (outcome: ChatOutcome, resolve = false) => {
    const latest = (await chatSessionService.load(session.id)) || session
    const merged: ChatSession = { ...latest, outcome, ...(resolve ? { status: 'resolved' as const } : {}) }
    await chatSessionService.save(merged)
    setSession(merged)
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}>
      <Container maxWidth="sm" sx={{ flex: 1, display: 'flex', flexDirection: 'column', py: 2, height: '100vh' }}>
        {/* Шапка */}
        <Paper sx={{ p: 2, mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <AiIcon color="primary" />
            <Typography variant="h6">Онлайн-помічник RunFerry</Typography>
          </Box>
          <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)} sx={{ mb: 1 }}>
            <ToggleButton value="estimate">Оцінка вартості</ToggleButton>
            <ToggleButton value="knowledge">Консультація</ToggleButton>
          </ToggleButtonGroup>
          <Alert severity="info" icon={false} sx={{ py: 0.5, fontSize: 13 }}>{DISCLAIMER}</Alert>
          {escalated && session.escalation && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              Запит передано менеджеру. Орієнтовна відповідь до {new Date(session.escalation.dueAt).toLocaleString('uk-UA')}.
            </Alert>
          )}
          {resolved && <Alert severity="success" sx={{ mt: 1 }}>Звернення закрито. Дякуємо!</Alert>}
        </Paper>

        {/* Лента сообщений */}
        <Paper ref={scrollRef} sx={{ flex: 1, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {visibleMessages.length === 0 && (
            <Box sx={{ m: 'auto', textAlign: 'center', color: 'text.secondary' }}>
              <Typography variant="body2">
                {mode === 'estimate'
                  ? 'Опишіть проблему з корабликом — і я орієнтовно оціню вартість ремонту.'
                  : 'Запитайте, як користуватися корабликом або як вирішити проблему самостійно.'}
              </Typography>
            </Box>
          )}
          {visibleMessages.map((m) => <MessageBubble key={m.id} msg={m} />)}
          {sending && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}>
              <CircularProgress size={16} /><Typography variant="caption">помічник друкує…</Typography>
            </Box>
          )}
        </Paper>

        {/* Ввод */}
        <Paper sx={{ p: 1, mt: 1 }}>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
            <TextField
              fullWidth multiline maxRows={4} size="small" placeholder="Ваше повідомлення…"
              value={input} onChange={(e) => setInput(e.target.value)} disabled={sending || resolved}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            />
            <IconButton color="primary" onClick={send} disabled={sending || !input.trim() || resolved}>
              <SendIcon />
            </IconButton>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
            <Button variant="contained" startIcon={<RepairIcon />} sx={{ flex: 1, minWidth: 180 }}
              onClick={() => { setOutcome('repair-request'); navigate(`/repair/new?chat=${session.id}`) }}>
              Оформити заявку на ремонт
            </Button>
            {partsOffer.show && (
              <Button variant="outlined" startIcon={<PartsIcon />} sx={{ flex: 1, minWidth: 180 }}
                color={partsOffer.warranty === 'yes' ? 'success' : 'primary'}
                onClick={() => setPartsOpen(true)} disabled={resolved}>
                {partsOffer.warranty === 'yes' ? 'Отримати комплектуючі безкоштовно' : 'Замовити комплектуючі'}
              </Button>
            )}
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5, flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
            <Button size="small" startIcon={<ManagerIcon />} onClick={escalateManually} disabled={escalated || resolved}>
              Зв'язатися з менеджером
            </Button>
            <Box>
              <Button size="small" color="success" startIcon={<DoneIcon />} disabled={resolved}
                onClick={() => { setOutcome('self-resolved', true); setSnackbar('Раді, що вдалося допомогти!') }}>
                Розібрався сам
              </Button>
              <Button size="small" color="inherit" onClick={() => setFbOpen(true)}>Відгук</Button>
            </Box>
          </Box>
        </Paper>
      </Container>

      {fbOpen && (
        <FeedbackDialog sessionId={session.id} onClose={() => setFbOpen(false)}
          onDone={() => { setFbOpen(false); setSnackbar('Дякуємо за відгук!') }} />
      )}
      {partsOpen && (
        <PartsDialog sessionId={session.id} contact={session.contact} free={partsOffer.warranty === 'yes'}
          onClose={() => setPartsOpen(false)}
          onDone={() => { setPartsOpen(false); setOutcome('parts-shipment'); setSnackbar('Заявку на комплектуючі прийнято — ми зв’яжемося з вами.') }} />
      )}
      <Snackbar open={!!snackbar} autoHideDuration={4000} onClose={() => setSnackbar('')}
        message={snackbar} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Box>
  )
}

// Прибавить usage одного вызова ИИ к накопленному по сессии
function accumulateUsage(prev: ChatAiUsage | undefined, u: AiUsage | undefined): ChatAiUsage | undefined {
  if (!u) return prev
  return {
    calls: (prev?.calls || 0) + 1,
    inputTokens: (prev?.inputTokens || 0) + u.inputTokens,
    outputTokens: (prev?.outputTokens || 0) + u.outputTokens,
    costUsd: (prev?.costUsd || 0) + u.costUsd,
  }
}

// Проставить эскалацию на объект сессии (мутирует переданный merged)
function applyEscalation(s: ChatSession, reason: string) {
  const now = new Date()
  s.status = 'escalated'
  s.escalation = {
    escalatedAt: now.toISOString(),
    reason,
    dueAt: escalationDueDate(now).toISOString(),
    resolvedAt: null,
    managerEmail: null,
  }
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isClient = msg.role === 'client'
  const isManager = msg.role === 'manager'
  return (
    <Box sx={{ display: 'flex', justifyContent: isClient ? 'flex-end' : 'flex-start' }}>
      <Box sx={{ maxWidth: '80%' }}>
        {!isClient && (
          <Typography variant="caption" color={isManager ? 'secondary.main' : 'text.secondary'} sx={{ ml: 1 }}>
            {isManager ? 'Менеджер' : 'Помічник'}
          </Typography>
        )}
        <Paper
          elevation={0}
          sx={{
            px: 1.5, py: 1, borderRadius: 2, whiteSpace: 'pre-line',
            bgcolor: isClient ? 'primary.main' : isManager ? 'secondary.light' : 'grey.100',
            color: isClient ? 'primary.contrastText' : 'text.primary',
          }}
        >
          <Typography variant="body2">{msg.text}</Typography>
        </Paper>
      </Box>
    </Box>
  )
}

// Форма отзыва клиента
function FeedbackDialog({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: () => void }) {
  const [helpful, setHelpful] = useState<boolean | null>(null)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    const kind: FeedbackKind = helpful === true ? 'helpful' : helpful === false ? 'not-helpful' : 'suggestion'
    await feedbackService.create({ sessionId, kind, helpful, text: text.trim(), contact: null })
    setSaving(false)
    onDone()
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Ваш відгук</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" gutterBottom>Чи допомогло спілкування?</Typography>
        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <Chip icon={<ThumbUpIcon />} label="Так" color={helpful === true ? 'success' : 'default'}
            variant={helpful === true ? 'filled' : 'outlined'} onClick={() => setHelpful(true)} />
          <Chip icon={<ThumbDownIcon />} label="Ні" color={helpful === false ? 'error' : 'default'}
            variant={helpful === false ? 'filled' : 'outlined'} onClick={() => setHelpful(false)} />
        </Box>
        <Divider sx={{ mb: 2 }} />
        <TextField fullWidth multiline minRows={3} label="Що можна покращити? (необов'язково)"
          value={text} onChange={(e) => setText(e.target.value)} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Скасувати</Button>
        <Button variant="contained" onClick={submit} disabled={saving || (helpful === null && !text.trim())}>
          Надіслати
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// Заявка на отправку/заказ комплектующих клиенту (создаёт задачу сервиса).
// free=true — гарантийный случай (бесплатно + доставка за наш счёт); иначе — платный заказ.
function PartsDialog({ sessionId, contact, free, onClose, onDone }: {
  sessionId: string
  contact: { name?: string; phone?: string } | null
  free: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [details, setDetails] = useState('')
  const [name, setName] = useState(contact?.name || '')
  const [phone, setPhone] = useState(contact?.phone || '')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    const c = (name.trim() || phone.trim())
      ? { ...(name.trim() ? { name: name.trim() } : {}), ...(phone.trim() ? { phone: phone.trim() } : {}) }
      : null
    await serviceTaskService.create({
      type: 'parts-shipment',
      title: free ? 'Комплектуючі за гарантією (безкоштовно)' : 'Замовлення комплектуючих (платно)',
      details: `${free ? '[ГАРАНТІЯ, безкоштовно + доставка наша] ' : '[Платне замовлення] '}${details.trim()}`,
      contact: c,
      sessionId,
      origin: 'client',
      assignee: null,
    })
    setSaving(false)
    onDone()
  }

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{free ? 'Отримати комплектуючі (безкоштовно)' : 'Замовити комплектуючі'}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {free
            ? 'Ваш кораблик на гарантії — комплектуючі та доставку оплачуємо ми. Опишіть, яка деталь потрібна.'
            : 'Опишіть, які комплектуючі потрібні (модель деталі, що саме замінюєте). Ми узгодимо вартість і доставку.'}
        </Typography>
        <TextField fullWidth multiline minRows={3} label="Які комплектуючі потрібні?" value={details}
          onChange={(e) => setDetails(e.target.value)} sx={{ mb: 2 }} />
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: '1fr 1fr' }}>
          <TextField size="small" label="Ім'я" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField size="small" label="Телефон" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Скасувати</Button>
        <Button variant="contained" onClick={submit} disabled={saving || !details.trim()}>Надіслати запит</Button>
      </DialogActions>
    </Dialog>
  )
}
