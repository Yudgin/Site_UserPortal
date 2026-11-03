// Готовность к продажам и настройки магазина (system/shopSales) на странице «Замовлення з сайту».
// Проверка готовности спрашивает банк и кассу, поэтому идёт при открытии вкладки и по кнопке, а не при каждом входе на страницу.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Divider, FormControlLabel, IconButton, MenuItem, Paper, Stack, Switch, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material'
import { Add as AddIcon, Delete as DeleteIcon, Refresh as RefreshIcon, Save as SaveIcon } from '@mui/icons-material'
import { shopAdminApi } from '@/api/endpoints/shopAdmin'
import { fopsAdminApi, type FopAdmin } from '@/api/endpoints/fopsAdmin'
import { npTemplateService } from '@/api/npTemplateService'
import { userProfileService } from '@/api/userProfileService'
import { isAdminEmail } from '@/config/access'
import { formatMoney } from '@/utils/pricing'
import type { NpTemplate } from '@/types/npTemplate'
import type { UserProfile } from '@/types/access'
import { SHOP_MODES, fmtShopDate, type ShopCheckStatus, type ShopReadiness, type ShopSalesMode, type ShopSalesSettings, type ShopSkuRule } from '@/types/shopOrder'

const CHECK_CHIP: Record<ShopCheckStatus, { label: string; color: 'success' | 'error' | 'warning' | 'default' }> = {
  ok: { label: 'Готово', color: 'success' },
  bad: { label: 'Помилка', color: 'error' },
  unknown: { label: 'Невідомо', color: 'warning' },
  none: { label: 'Не задано', color: 'default' },
}

const PROBLEM_TEXT: Record<string, string> = {
  siteBaseUrl: 'адреса сайту',
  offerVersion: 'версія оферти',
  ownerTest: 'перевірка сповіщень',
  ownerPhone: 'телефон для запасних SMS',
  fopGate: 'ФОП не проходить перевірку',
  monoAcquire: 'кабінет monobank',
  checkbox: 'каса Checkbox',
  autoCloseShift: 'автозакриття зміни в Checkbox',
  npTemplate: 'шаблон Нової Пошти',
  items: 'позиції на продаж',
}

const FOP_MISSING_TEXT: Record<string, string> = {
  fop: 'ФОП не вибрано',
  active: 'ФОП вимкнено',
  seller: 'реквізити продавця',
  'novaPoshta.apiKey': 'ключ НП',
  'novaPoshta.senderRef': 'відправник НП',
  'novaPoshta.contactRef': 'контактна особа НП',
  'novaPoshta.senderPhone': 'телефон відправника НП',
  'novaPoshta.cityRef': 'місто відправника НП',
  'novaPoshta.warehouseRef': 'відділення відправника НП',
  'methods.monoAcquire': 'галочка «Еквайринг monobank»',
  'monoAcquire.token': 'токен monobank',
  'checkbox.licenseKey': 'ключ каси Checkbox',
  'checkbox.cashier': 'вхід касира Checkbox',
  SHOP_CALLBACK_BASE_URL: 'адреса колбеків на сервері (SHOP_CALLBACK_BASE_URL)',
}

const ITEM_PROBLEM_TEXT: Record<string, string> = {
  'material-errors': 'артикул задвоєний у прайсі',
  'no-material': 'немає в прайсі',
  'not-published': 'картку не опубліковано',
  'no-card-data': 'немає даних картки',
  'price-out-of-range': 'ціна поза межами',
}

const FIELD_TEXT: Record<string, string> = {
  mode: 'режим',
  fopId: 'ФОП',
  npTemplateId: 'шаблон НП',
  siteBaseUrl: 'адреса сайту',
  offerVersion: 'версія оферти',
  cardReceiptLabel: 'підпис оплати в чеку',
  ownerPhone: 'телефон для SMS',
  methods: 'способи оплати',
  limits: 'ліміти',
  skus: 'позиції',
  staffUids: 'доступ співробітників',
}

// Умолчания для первого сохранения: документа настроек ещё нет. Режим остаётся «Вимкнено».
const FIRST_SITE_URL = 'https://runferry.ua'
const FIRST_SKUS: Record<string, ShopSkuRule> = {
  'V2-LID-R': { enabled: true, inStock: true, stock: null, minUah: 600, maxUah: 1200 },
  'V2-LID-RM': { enabled: true, inStock: true, stock: null, minUah: 700, maxUah: 1300 },
  'V2-LID-H': { enabled: true, inStock: true, stock: null, minUah: 650, maxUah: 1250 },
}
const SKU_RE = /^[A-Z0-9-]{1,10}$/
const LIMIT_FIELDS = ['unpaidPerDay', 'payAttemptsPerOrder'] as const

type SkuDraft = { enabled: boolean; inStock: boolean; stock: string; minUah: string; maxUah: string }
const TEXT_FIELDS = ['fopId', 'npTemplateId', 'siteBaseUrl', 'offerVersion', 'cardReceiptLabel', 'ownerPhone'] as const
type Draft = Record<(typeof TEXT_FIELDS)[number] | (typeof LIMIT_FIELDS)[number] | 'piiPaidDays', string> & { card: boolean; skus: Record<string, SkuDraft>; staffUids: string[] }

const numText = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
const skuDraft = (r: ShopSkuRule): SkuDraft => ({ enabled: r.enabled, inStock: r.inStock, stock: numText(r.stock), minUah: numText(r.minUah), maxUah: numText(r.maxUah) })

const draftOf = (cfg: ShopSalesSettings | null): Draft => ({
  fopId: cfg?.fopId || '',
  npTemplateId: cfg?.npTemplateId || '',
  siteBaseUrl: cfg ? cfg.siteBaseUrl || '' : FIRST_SITE_URL,
  offerVersion: cfg?.offerVersion || '',
  cardReceiptLabel: cfg?.cardReceiptLabel || '',
  ownerPhone: cfg?.ownerPhone || '',
  card: cfg?.methods?.card === true,
  unpaidPerDay: numText(cfg?.limits?.unpaidPerDay),
  payAttemptsPerOrder: numText(cfg?.limits?.payAttemptsPerOrder),
  piiPaidDays: numText(cfg?.limits?.piiPaidDays),
  skus: Object.fromEntries(Object.entries(cfg ? cfg.skus || {} : FIRST_SKUS).map(([sku, r]) => [sku, skuDraft(r)])),
  staffUids: cfg?.staffUids || [],
})

const sameList = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

const wholeOf = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN)
const amountOf = (s: string) => {
  const n = Number(s.trim().replace(',', '.'))
  return s.trim() && Number.isFinite(n) && n > 0 ? n : NaN
}

// Только то, что изменилось: skus заменяются целиком, лишняя отправка затёрла бы склад, который уменьшает оплата.
function patchOf(d: Draft, cfg: ShopSalesSettings | null): { patch: Partial<ShopSalesSettings>; error?: string } {
  const patch: Partial<ShopSalesSettings> = {}
  for (const k of TEXT_FIELDS) if (d[k].trim() !== (cfg?.[k] || '')) patch[k] = d[k].trim()
  if (d.card !== (cfg?.methods?.card === true)) patch.methods = { card: d.card }
  if (!sameList(d.staffUids, cfg?.staffUids || [])) patch.staffUids = d.staffUids

  const limits: Record<string, number | null> = {}
  for (const k of LIMIT_FIELDS) {
    if (d[k].trim() === numText(cfg?.limits?.[k])) continue
    const n = wholeOf(d[k])
    if (Number.isNaN(n)) return { patch, error: 'Ліміти: вкажіть ціле число' }
    limits[k] = n
  }
  if (d.piiPaidDays.trim() !== numText(cfg?.limits?.piiPaidDays)) {
    const n = wholeOf(d.piiPaidDays)
    if (d.piiPaidDays.trim() && !(n > 0)) return { patch, error: 'Строк зберігання: ціле число днів або порожньо' }
    limits.piiPaidDays = d.piiPaidDays.trim() ? n : null
  }
  if (Object.keys(limits).length) patch.limits = limits

  const skus: Record<string, ShopSkuRule> = {}
  for (const [sku, r] of Object.entries(d.skus)) {
    if (!SKU_RE.test(sku)) return { patch, error: `Артикул «${sku}»: великі латинські літери, цифри і дефіс, до 10 знаків` }
    const stock = r.stock.trim() ? wholeOf(r.stock) : null
    const minUah = amountOf(r.minUah)
    const maxUah = amountOf(r.maxUah)
    if (Number.isNaN(stock)) return { patch, error: `${sku}: залишок це ціле число або порожньо` }
    if (Number.isNaN(minUah) || Number.isNaN(maxUah) || minUah > maxUah) return { patch, error: `${sku}: перевірте межі ціни` }
    skus[sku] = { ...(cfg?.skus || {})[sku], enabled: r.enabled, inStock: r.inStock, stock, minUah, maxUah }
  }
  const sameSkus = !!cfg && JSON.stringify(d.skus) === JSON.stringify(draftOf(cfg).skus)
  if (!sameSkus) patch.skus = skus
  return { patch }
}

const CheckChip = ({ status }: { status: ShopCheckStatus }) => <Chip size="small" color={CHECK_CHIP[status].color} label={CHECK_CHIP[status].label} />

function Line({ label, status, children }: { label: string; status: ShopCheckStatus; children?: ReactNode }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ py: 0.75 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 190 }}>{label}</Typography>
      <Box sx={{ minWidth: 88 }}><CheckChip status={status} /></Box>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}><Typography variant="body2" color="text.secondary" component="div">{children}</Typography></Box>
    </Stack>
  )
}

export default function ShopSetupPanel({ full, mode, onChanged, notify }: { full: boolean; mode: ShopSalesMode | null; onChanged: () => void; notify: (msg: string, sev?: 'success' | 'error') => void }) {
  const navigate = useNavigate()
  const [ready, setReady] = useState<ShopReadiness | null>(null)
  const [readyLoading, setReadyLoading] = useState(true)
  const [readyErr, setReadyErr] = useState('')
  const [cfg, setCfg] = useState<ShopSalesSettings | null>(null)
  const [cfgErr, setCfgErr] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [fops, setFops] = useState<FopAdmin[]>([])
  const [templates, setTemplates] = useState<NpTemplate[]>([])
  const [staff, setStaff] = useState<UserProfile[]>([])
  const [newSku, setNewSku] = useState('')
  const [formErr, setFormErr] = useState('')
  const [busy, setBusy] = useState('')

  const loadReadiness = useCallback(async () => {
    setReadyLoading(true)
    const r = await shopAdminApi.readiness()
    if (r.ok) { setReady(r.data); setReadyErr('') } else setReadyErr(r.error)
    setReadyLoading(false)
  }, [])

  const loadSettings = useCallback(async () => {
    const r = await shopAdminApi.settings()
    if (r.ok) {
      setCfg(r.data.settings)
      setDraft(draftOf(r.data.settings))
      setCfgErr('')
    } else setCfgErr(r.error)
  }, [])

  useEffect(() => { loadReadiness() }, [loadReadiness])
  useEffect(() => { if (full) loadSettings() }, [full, loadSettings])
  // Справочники владельца: директору эти маршруты закрыты.
  useEffect(() => {
    if (!full) return
    fopsAdminApi.list().then(setFops)
    npTemplateService.list().then(setTemplates)
    userProfileService.listActive().then((all) => setStaff(all.filter((u) => (u.role === 'director' || u.role === 'owner') && !isAdminEmail(u.email))))
  }, [full])

  const fieldsText = (fields: string[]) => (fields.length ? `: ${fields.map((f) => FIELD_TEXT[f] || f).join(', ')}` : '')

  const changeMode = async (next: ShopSalesMode) => {
    const hint = SHOP_MODES.find((m) => m.mode === next)
    if (next !== 'off' && !window.confirm(`Режим «${hint?.label}»?\n\n${hint?.hint}.`)) return
    setBusy('mode')
    const r = await shopAdminApi.saveSettings({ mode: next })
    setBusy('')
    if (!r.ok) { notify(`${r.error}${fieldsText(r.fields)}`, 'error'); return }
    setCfg(r.data.settings)
    notify(`Режим: ${hint?.label}`)
    onChanged()
    loadReadiness()
  }

  const save = async () => {
    if (!draft) return
    setFormErr('')
    const { patch, error } = patchOf(draft, cfg)
    if (error) { setFormErr(error); return }
    if (!Object.keys(patch).length) { notify('Змін немає'); return }
    setBusy('save')
    // Пока открыта форма, оплата могла уменьшить склад: что владелец не трогал, берём свежим.
    if (patch.skus) {
      const fresh = await shopAdminApi.settings()
      if (!fresh.ok) { setBusy(''); setFormErr(fresh.error); return }
      for (const [sku, rule] of Object.entries(patch.skus)) {
        const before = (cfg?.skus || {})[sku]
        const now = (fresh.data.settings?.skus || {})[sku]
        if (!before || !now) continue
        if ((rule.stock ?? null) === (before.stock ?? null)) rule.stock = now.stock ?? null
        if (rule.inStock === before.inStock) rule.inStock = now.inStock
      }
    }
    const r = await shopAdminApi.saveSettings(patch)
    setBusy('')
    if (!r.ok) { setFormErr(`${r.error}${fieldsText(r.fields)}`); return }
    setCfg(r.data.settings)
    setDraft(draftOf(r.data.settings))
    notify('Налаштування збережено')
    onChanged()
    loadReadiness()
  }

  const testAlert = async () => {
    setBusy('test')
    const r = await shopAdminApi.testAlert()
    setBusy('')
    const smsText = (sms?: string) => (sms === 'sent' ? ' SMS надіслано.' : sms === 'failed' ? ' SMS не надіслано.' : ' Телефон для SMS не задано.')
    if (r.ok) notify(`Telegram доставив перевірку.${smsText(r.data.sms)}`)
    else notify(`${r.error}.${smsText(r.sms)}`, 'error')
    loadReadiness()
  }

  const dailyReset = async () => {
    if (!window.confirm('Скинути лічильник неоплачених замовлень за сьогодні?')) return
    setBusy('reset')
    const r = await shopAdminApi.dailyReset()
    setBusy('')
    if (r.ok) notify('Лічильник скинуто')
    else notify(r.error, 'error')
    onChanged()
    loadReadiness()
  }

  const setField = (k: keyof Draft, v: string | boolean) => setDraft((d) => (d ? { ...d, [k]: v } : d))
  const setSku = (sku: string, patch: Partial<SkuDraft>) => setDraft((d) => (d ? { ...d, skus: { ...d.skus, [sku]: { ...d.skus[sku], ...patch } } } : d))
  const removeSku = (sku: string) => setDraft((d) => {
    if (!d) return d
    const { [sku]: _gone, ...skus } = d.skus
    return { ...d, skus }
  })
  const addSku = () => {
    const sku = newSku.trim().toUpperCase()
    if (!SKU_RE.test(sku) || draft?.skus[sku]) { setFormErr('Артикул: великі латинські літери, цифри і дефіс, до 10 знаків, без повторів'); return }
    setFormErr('')
    setSku(sku, { enabled: false, inStock: true, stock: '', minUah: '', maxUah: '' })
    setNewSku('')
  }

  const parts = templates.filter((t) => t.scenario === 'parts' && (t.active !== false || t.id === draft?.npTemplateId))
  const toggleStaff = (uid: string, on: boolean) => setDraft((d) => (d ? { ...d, staffUids: on ? [...new Set([...d.staffUids, uid])] : d.staffUids.filter((u) => u !== uid) } : d))
  // В списке может остаться выключенный сотрудник: его видно, чтобы владелец мог убрать.
  const staffRows = [...staff.map((u) => ({ uid: u.uid, label: u.displayName || u.email || u.uid })), ...(draft?.staffUids || []).filter((uid) => !staff.some((u) => u.uid === uid)).map((uid) => ({ uid, label: `${uid} (неактивний)` }))]

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>Режим продажів</Typography>
        <ToggleButtonGroup size="small" exclusive value={mode} disabled={!full || !mode || busy === 'mode'} onChange={(_, v) => v && changeMode(v)} sx={{ flexWrap: 'wrap', mb: 1 }}>
          {SHOP_MODES.map((m) => <ToggleButton key={m.mode} value={m.mode}>{m.label}</ToggleButton>)}
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary">{SHOP_MODES.find((m) => m.mode === mode)?.hint}</Typography>
        {!full && <Typography variant="caption" color="text.secondary">Змінити режим може лише власник. Аварійна кнопка вимкнення є вгорі сторінки.</Typography>}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="subtitle1">Готовність</Typography>
          <Button size="small" startIcon={<RefreshIcon />} disabled={readyLoading} onClick={loadReadiness}>{readyLoading ? 'Перевіряємо…' : 'Перевірити ще раз'}</Button>
        </Stack>
        {readyErr && <Alert severity="error" sx={{ mb: 1 }}>{readyErr}</Alert>}
        {!ready && readyLoading && <Box sx={{ textAlign: 'center', py: 4 }}><CircularProgress /></Box>}
        {ready && (
          <>
            {ready.ready
              ? <Alert severity="success" sx={{ mb: 1 }}>Усе, що бачить портал, готове. Відповіді банку, бухгалтера і текст оферти перевіряються окремо за чек-листом.</Alert>
              : <Alert severity="warning" sx={{ mb: 1 }}>Ще не готово: {ready.problems.map((p) => PROBLEM_TEXT[p] || p).join(', ')}.</Alert>}
            <Stack divider={<Divider flexItem />}>
              <Line label="ФОП" status={!ready.fop ? 'none' : ready.sellable.card.ok ? 'ok' : 'bad'}>
                {ready.fop?.name || 'Не вибрано'}
                {!!ready.fop && !ready.sellable.card.ok && !!ready.sellable.card.missing?.length && ` · бракує:${ready.sellable.card.missing.map((m) => FOP_MISSING_TEXT[m] || m).join(', ')}`}
              </Line>
              <Line label="Продавець на сайті" status={ready.seller ? 'ok' : 'none'}>
                {ready.seller ? [ready.seller.name, `РНОКПП ${ready.seller.ipn}`, ready.seller.address, ready.seller.email, ready.seller.phone].join(' · ') : 'Заповніть реквізити на сторінці «ФОПи та ключі»'}
              </Line>
              <Line label="Кабінет monobank" status={ready.monoAcquire.status}>
                {[ready.monoAcquire.merchantName, ready.monoAcquire.edrpou && `ЄДРПОУ ${ready.monoAcquire.edrpou}`, ready.monoAcquire.message, ready.monoAcquire.note].filter(Boolean).join(' · ')}
              </Line>
              <Line label="Каса Checkbox" status={ready.checkbox.status}>
                {[ready.checkbox.cashier?.name, ready.checkbox.cashier?.organization, ready.checkbox.cashier?.edrpou && `ЄДРПОУ ${ready.checkbox.cashier.edrpou}`, ready.checkbox.cashier?.blocked && 'касира заблоковано', ready.checkbox.message, ready.checkbox.cashRegister?.fiscalNumber && `каса ${ready.checkbox.cashRegister.fiscalNumber}`].filter(Boolean).join(' · ')}
              </Line>
              <Line label="Зміна Checkbox" status={ready.checkbox.autoCloseShiftAt ? 'ok' : 'unknown'}>
                {ready.checkbox.autoCloseShiftAt ? `Автозакриття о ${ready.checkbox.autoCloseShiftAt}` : 'Автозакриття не видно: перевірте кабінет'}
                {ready.checkbox.shift?.status ? ` · зараз ${ready.checkbox.shift.status}` : ''}
              </Line>
              <Line label="Шаблон Нової Пошти" status={!ready.npTemplate.id ? 'none' : ready.npTemplate.problems.length ? 'bad' : 'ok'}>
                {[ready.npTemplate.name, ready.npTemplate.description, ready.npTemplate.weight ? `${ready.npTemplate.weight} кг` : '', ...ready.npTemplate.problemTexts].filter(Boolean).join(' · ')}
              </Line>
              <Line label="Сповіщення власнику" status={ready.ownerTestOkAt ? 'ok' : 'none'}>
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                  <span>{ready.ownerTestOkAt ? `Перевірено ${fmtShopDate(ready.ownerTestOkAt)}` : 'Не перевірено: без цього продажі не вмикаються'}</span>
                  {full && <Button size="small" disabled={busy === 'test'} onClick={testAlert}>{busy === 'test' ? 'Надсилаємо…' : 'Надіслати перевірку'}</Button>}
                </Stack>
              </Line>
              <Line label="Телефон для запасних SMS" status={ready.ownerPhoneSet ? 'ok' : 'none'} />
              <Line label="Сайт і оферта" status={ready.siteBaseUrl && ready.offerVersion ? 'ok' : 'none'}>
                {[ready.siteBaseUrl, ready.offerVersion && `оферта ${ready.offerVersion}`].filter(Boolean).join(' · ')}
              </Line>
              <Line label="Колбек банку" status={ready.callbackBaseUrlSet ? 'ok' : 'none'}>
                {ready.callbackBaseUrlSet ? 'Заданий на сервері' : 'SHOP_CALLBACK_BASE_URL не заданий на сервері'}
              </Line>
              <Line label="Неоплачені сьогодні" status={ready.today.unpaid >= ready.today.limit ? 'bad' : 'ok'}>
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                  <span>{ready.today.unpaid} із {ready.today.limit}{ready.today.unpaid >= ready.today.limit ? ': нові замовлення не приймаються до півночі' : ''}</span>
                  {full && ready.today.unpaid > 0 && <Button size="small" disabled={busy === 'reset'} onClick={dailyReset}>Скинути лічильник</Button>}
                </Stack>
              </Line>
            </Stack>

            {ready.items.length > 0 && (
              <TableContainer sx={{ mt: 1 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow><TableCell>Артикул</TableCell><TableCell align="right">Ціна</TableCell><TableCell align="right">Залишок</TableCell><TableCell>Стан</TableCell></TableRow>
                  </TableHead>
                  <TableBody>
                    {ready.items.map((i) => (
                      <TableRow key={i.sku}>
                        <TableCell sx={{ fontWeight: 600 }}>{i.sku}</TableCell>
                        <TableCell align="right">{i.priceUah !== null ? formatMoney(i.priceUah) : '—'}</TableCell>
                        <TableCell align="right">{i.stock ?? 'не рахуємо'}</TableCell>
                        <TableCell>
                          {i.problem ? <Chip size="small" color="error" label={ITEM_PROBLEM_TEXT[i.problem] || i.problem} />
                            : !i.enabled ? <Chip size="small" label="Вимкнено" />
                            : !i.inStock ? <Chip size="small" color="warning" label="Немає в наявності" />
                            : <Chip size="small" color="success" label="У продажу" />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        )}
      </Paper>

      {full && cfgErr && <Alert severity="error" action={<Button color="inherit" size="small" onClick={loadSettings}>Ще раз</Button>}>{cfgErr}</Alert>}

      {full && draft && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1.5 }}>Налаштування</Typography>
          {!cfg && <Alert severity="info" sx={{ mb: 2 }}>Налаштувань ще немає. Значення нижче будуть збережені після першого натискання «Зберегти», продажі лишаться вимкненими.</Alert>}
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField select fullWidth size="small" label="ФОП-продавець" value={draft.fopId} onChange={(e) => setField('fopId', e.target.value)}>
                <MenuItem value="">Не вибрано</MenuItem>
                {draft.fopId && !fops.some((f) => f.id === draft.fopId) && <MenuItem value={draft.fopId}>{draft.fopId}</MenuItem>}
                {fops.map((f) => <MenuItem key={f.id} value={f.id}>{f.name}{f.active ? '' : ' (вимкнено)'}</MenuItem>)}
              </TextField>
              <TextField select fullWidth size="small" label="Шаблон Нової Пошти" value={draft.npTemplateId} onChange={(e) => setField('npTemplateId', e.target.value)}
                helperText={<>Сценарій «комплектуючі». <Box component="span" sx={{ color: 'primary.main', cursor: 'pointer' }} onClick={() => navigate('/np-templates')}>Шаблони посилок</Box></>}>
                <MenuItem value="">Не вибрано</MenuItem>
                {draft.npTemplateId && !parts.some((t) => t.id === draft.npTemplateId) && <MenuItem value={draft.npTemplateId}>{draft.npTemplateId}</MenuItem>}
                {parts.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}{t.fopId !== draft.fopId ? ' (інший ФОП)' : ''}</MenuItem>)}
              </TextField>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField fullWidth size="small" label="Адреса сайту" value={draft.siteBaseUrl} onChange={(e) => setField('siteBaseUrl', e.target.value)} placeholder={FIRST_SITE_URL} />
              <TextField fullWidth size="small" label="Версія оферти" value={draft.offerVersion} onChange={(e) => setField('offerVersion', e.target.value)} helperText="Зміна вимагає нової згоди покупця" />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField fullWidth size="small" label="Підпис оплати в чеку" value={draft.cardReceiptLabel} onChange={(e) => setField('cardReceiptLabel', e.target.value)} helperText="Порожньо: «Інтернет еквайринг»" />
              <TextField fullWidth size="small" label="Телефон для запасних SMS" value={draft.ownerPhone} onChange={(e) => setField('ownerPhone', e.target.value)} placeholder="+380…" />
            </Stack>
            <FormControlLabel control={<Switch checked={draft.card} onChange={(e) => setField('card', e.target.checked)} />} label="Оплата карткою онлайн" />

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Хто ще бачить замовлення</Typography>
              <Typography variant="caption" color="text.secondary" component="div">Директори з дозволом бачать імена, телефони й адреси покупців, створюють накладні й можуть аварійно вимкнути продажі. Без позначки доступу немає.</Typography>
              {staffRows.length === 0
                ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>Активних директорів немає.</Typography>
                : staffRows.map((r) => (
                  <FormControlLabel key={r.uid} sx={{ display: 'flex' }} label={r.label}
                    control={<Checkbox size="small" checked={draft.staffUids.includes(r.uid)} onChange={(e) => toggleStaff(r.uid, e.target.checked)} />} />
                ))}
            </Box>

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Позиції на продаж</Typography>
              <Typography variant="caption" color="text.secondary">Ціна береться з прайсу. Межі ловлять помилку в прайсі: поза ними позиція зникає з продажу. Порожній залишок означає «не рахуємо».</Typography>
              <TableContainer>
                <Table size="small" sx={{ minWidth: 560 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Артикул</TableCell><TableCell>У продажу</TableCell><TableCell>Є в наявності</TableCell><TableCell>Залишок</TableCell><TableCell>Мін, грн</TableCell><TableCell>Макс, грн</TableCell><TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {Object.entries(draft.skus).map(([sku, r]) => (
                      <TableRow key={sku}>
                        <TableCell sx={{ fontWeight: 600 }}>{sku}</TableCell>
                        <TableCell><Checkbox size="small" checked={r.enabled} onChange={(e) => setSku(sku, { enabled: e.target.checked })} /></TableCell>
                        <TableCell><Checkbox size="small" checked={r.inStock} onChange={(e) => setSku(sku, { inStock: e.target.checked })} /></TableCell>
                        <TableCell><TextField size="small" value={r.stock} onChange={(e) => setSku(sku, { stock: e.target.value })} sx={{ width: 80 }} /></TableCell>
                        <TableCell><TextField size="small" value={r.minUah} onChange={(e) => setSku(sku, { minUah: e.target.value })} sx={{ width: 90 }} /></TableCell>
                        <TableCell><TextField size="small" value={r.maxUah} onChange={(e) => setSku(sku, { maxUah: e.target.value })} sx={{ width: 90 }} /></TableCell>
                        <TableCell align="right"><IconButton size="small" aria-label={`Прибрати ${sku}`} onClick={() => removeSku(sku)}><DeleteIcon fontSize="small" /></IconButton></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <TextField size="small" label="Новий артикул" value={newSku} onChange={(e) => setNewSku(e.target.value)} sx={{ width: 180 }} />
                <Button startIcon={<AddIcon />} disabled={!newSku.trim()} onClick={addSku}>Додати</Button>
              </Stack>
            </Box>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField fullWidth size="small" label="Неоплачених замовлень на день" value={draft.unpaidPerDay} onChange={(e) => setField('unpaidPerDay', e.target.value)} placeholder="40" />
              <TextField fullWidth size="small" label="Рахунків на замовлення" value={draft.payAttemptsPerOrder} onChange={(e) => setField('payAttemptsPerOrder', e.target.value)} placeholder="5" />
              <TextField fullWidth size="small" label="Стерти дані оплачених через, днів" value={draft.piiPaidDays} onChange={(e) => setField('piiPaidDays', e.target.value)} helperText="За словом бухгалтера. Порожньо: не стираємо" />
            </Stack>

            {formErr && <Alert severity="error">{formErr}</Alert>}
            <Stack direction="row" spacing={1}>
              <Button variant="contained" startIcon={<SaveIcon />} disabled={busy === 'save'} onClick={save}>{busy === 'save' ? 'Зберігаємо…' : 'Зберегти'}</Button>
              <Button disabled={busy === 'save'} onClick={() => { setDraft(draftOf(cfg)); setFormErr('') }}>Скасувати зміни</Button>
            </Stack>
          </Stack>
        </Paper>
      )}
    </Stack>
  )
}
