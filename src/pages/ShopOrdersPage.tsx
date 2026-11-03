// Заказы с сайта runferry.ua (владелец, директор). Первый экран: что требует действия. Остальное на вкладке «Всі», настройки и готовность на своей.
// Настройки меняет только владелец по почте: директор видит режим и может лишь аварийно выключить продажи.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Chip, TextField, MenuItem, Tabs, Tab, Snackbar, Link,
} from '@mui/material'
import {
  Home as HomeIcon, Refresh as RefreshIcon, Search as SearchIcon, Storefront as ShopIcon, PowerSettingsNew as PowerIcon, Clear as ClearIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { useStaffGate } from '@/hooks/useStaffGate'
import { shopAdminApi } from '@/api/endpoints/shopAdmin'
import { formatMoney } from '@/utils/pricing'
import {
  SHOP_GUIDE_URL, SHOP_MODES, SHOP_STATE_LABELS, fmtShopDate, shopModeLabel,
  type ShopCounters, type ShopOrderRow, type ShopOrderState, type ShopSalesMode,
} from '@/types/shopOrder'
import { FlagChips, SkuPhoto, StateChip } from '@/components/ShopOrderBits'
import ShopSetupPanel from '@/components/ShopSetupPanel'

type ShopTab = 'action' | 'all' | 'setup'
const ALL_LIMIT = 200 // столько отдаёт сервер, старые заказы находятся поиском

function OrderRow({ row, onOpen }: { row: ShopOrderRow; onOpen: () => void }) {
  const needsTtn = (row.state === 'paid' || row.state === 'cod_confirmed') && !row.ttn && !row.flags.includes('ttn-unknown')
  return (
    <Paper sx={{ p: 1.5, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }} onClick={onOpen}>
      <Stack direction="row" spacing={1.5}>
        <SkuPhoto sku={row.sku} size={72} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>{row.sku}</Typography>
            <StateChip state={row.state} />
            {row.method === 'cod' && <Chip size="small" variant="outlined" label="Післяплата" />}
            {needsTtn && <Chip size="small" color="warning" variant="outlined" label="Створіть накладну" />}
            <FlagChips flags={row.flags} />
            <Typography variant="subtitle2" sx={{ ml: 'auto' }}>{formatMoney(row.total)}</Typography>
          </Stack>
          <Typography variant="body2">{row.titleUk}</Typography>
          <Typography variant="body2" color="text.secondary">
            {[row.orderNo, row.clientName, row.clientPhone].filter(Boolean).join(' · ')}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {[row.clientCityName, row.clientWarehouseName, row.ttn ? `ТТН ${row.ttn}` : '', fmtShopDate(row.createdAt)].filter(Boolean).join(' · ')}
          </Typography>
        </Box>
      </Stack>
    </Paper>
  )
}

export default function ShopOrdersPage() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const gate = useStaffGate((a) => a.isOwner || a.role === 'director', 'Доступ лише для власника та директора.')
  const allowed = !gate
  const full = isAdminEmail(user?.email)

  const [tab, setTab] = useState<ShopTab>('action')
  const [actionRows, setActionRows] = useState<ShopOrderRow[]>([])
  const [allRows, setAllRows] = useState<ShopOrderRow[]>([])
  const [counters, setCounters] = useState<ShopCounters | null>(null)
  const [mode, setMode] = useState<ShopSalesMode | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [stateFilter, setStateFilter] = useState<ShopOrderState | ''>('')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [found, setFound] = useState<ShopOrderRow[] | null>(null)
  const [searchErr, setSearchErr] = useState('')
  const [killing, setKilling] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' = 'success') => setSnack({ open: true, msg, sev })

  // Счётчики и режим нужны на любой вкладке; ответ устаревшего запроса не должен затереть новый.
  const lastLoad = useRef(0)
  const load = useCallback(async () => {
    const id = ++lastLoad.current
    setLoading(true)
    const [action, cfg, all] = await Promise.all([
      shopAdminApi.actionList(),
      shopAdminApi.settings(),
      tab === 'all' ? shopAdminApi.allOrders() : null,
    ])
    if (id !== lastLoad.current) return
    if (action.ok) { setActionRows(action.data.items); setCounters(action.data.counters) } else setCounters(null)
    setMode(cfg.ok ? cfg.data.settings?.mode || 'off' : null)
    if (all?.ok) setAllRows(all.data.items)
    const failed = [action, cfg, all].find((r) => r && !r.ok)
    setLoadErr(failed && !failed.ok ? failed.error : '')
    setLoading(false)
  }, [tab])
  useEffect(() => { if (allowed) load() }, [allowed, load])

  const shownAll = useMemo(() => (stateFilter ? allRows.filter((r) => r.state === stateFilter) : allRows), [allRows, stateFilter])

  if (gate) return gate

  const search = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchErr('')
    // В номере заказа есть буквы, в телефоне нет.
    const r = /[a-zа-я]/i.test(q) ? await shopAdminApi.findByOrderNo(q) : await shopAdminApi.findByPhone(q)
    setSearching(false)
    if (r.ok) setFound(r.data.items)
    else { setFound(null); setSearchErr(r.error) }
  }
  const clearSearch = () => { setQuery(''); setFound(null); setSearchErr('') }

  const live = counters?.liveInvoices ?? null
  // Сведения не пришли: кнопка остаётся, авария важнее точности.
  const canKill = mode !== 'off' || live === null || live > 0
  const killSales = async () => {
    if (!window.confirm(`Вимкнути продажі і зняти живі рахунки${live !== null ? ` (${live})` : ''}?\n\nНа сайті одразу зникне кнопка «Купити», а покупці вже не зможуть оплатити за виданими посиланнями.`)) return
    setKilling(true)
    const r = await shopAdminApi.disableAndRemoveInvoices()
    setKilling(false)
    if (!r.ok) notify(`${r.error}. Перевірте режим продажів`, 'error')
    else if (r.data.failed) notify(`Продажі вимкнено. Рахунків знято: ${r.data.total - r.data.failed} із ${r.data.total}. Решта діє до години, їх ще можуть оплатити`, 'error')
    else notify(`Продажі вимкнено. Рахунків знято: ${r.data.total}`)
    load()
  }

  const rowsOf = (rows: ShopOrderRow[], empty: string) => (rows.length === 0
    ? <Alert severity="info">{empty}</Alert>
    : <Stack spacing={1}>{rows.map((o) => <OrderRow key={o.id} row={o} onOpen={() => navigate(`/shop-orders/${o.id}`)} />)}</Stack>)

  return (
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        <ShopIcon color="primary" />
        <Typography variant="h5" sx={{ flexGrow: 1 }}>Замовлення з сайту</Typography>
        <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>Оновити</Button>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>Головна</Button>
      </Stack>

      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Chip size="small" variant="outlined" color={mode === 'live' ? 'success' : mode === 'hidden' ? 'warning' : 'default'}
          title={SHOP_MODES.find((m) => m.mode === mode)?.hint}
          label={`Продажі: ${mode ? shopModeLabel(mode) : 'невідомо'}`} />
        {counters && counters.liveInvoices > 0 && <Chip size="small" variant="outlined" label={`Живих рахунків: ${counters.liveInvoices}`} />}
        {counters && counters.unpaidToday > 0 && <Chip size="small" variant="outlined" label={`Неоплачених сьогодні: ${counters.unpaidToday}`} />}
        <Link href={SHOP_GUIDE_URL} target="_blank" rel="noreferrer" variant="body2">Пам'ятка</Link>
        {canKill && (
          <Button size="small" color="error" variant="outlined" startIcon={<PowerIcon />} disabled={killing} onClick={killSales} sx={{ ml: { sm: 'auto' } }}>
            {killing ? 'Вимикаємо…' : `Вимкнути і скасувати живі рахунки${live !== null ? ` (${live})` : ''}`}
          </Button>
        )}
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }} alignItems="flex-start">
        <TextField size="small" fullWidth placeholder="Пошук: телефон або номер замовлення RF-…" value={query}
          error={!!searchErr} helperText={searchErr || undefined}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search() }} />
        <Button variant="outlined" startIcon={<SearchIcon />} disabled={searching || !query.trim()} onClick={search}>Знайти</Button>
        {(found || searchErr) && <Button startIcon={<ClearIcon />} onClick={clearSearch}>Скинути</Button>}
      </Stack>

      {found ? (
        rowsOf(found, 'За цим запитом замовлень немає.')
      ) : (
        <>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2 }}>
            <Tab value="action" label={`Потрібна дія${counters ? ` (${counters.action})` : ''}`} />
            <Tab value="all" label="Всі" />
            <Tab value="setup" label={full ? 'Готовність і налаштування' : 'Готовність'} />
          </Tabs>

          {tab !== 'setup' && loadErr && (
            <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Ще раз</Button>}>{loadErr}</Alert>
          )}

          {tab === 'setup' ? (
            <ShopSetupPanel full={full} mode={mode} onChanged={load} notify={notify} />
          ) : loading ? (
            <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>
          ) : tab === 'action' ? (
            // Список не пришёл: пустой экран читался бы как «дел нет».
            counters ? rowsOf(actionRows, 'Зараз нічого робити не треба.') : null
          ) : (
            <>
              <TextField select size="small" label="Стан" value={stateFilter} onChange={(e) => setStateFilter(e.target.value as ShopOrderState | '')} sx={{ minWidth: 220, mb: 2 }}>
                <MenuItem value="">Усі</MenuItem>
                {(Object.keys(SHOP_STATE_LABELS) as ShopOrderState[]).map((s) => <MenuItem key={s} value={s}>{SHOP_STATE_LABELS[s]}</MenuItem>)}
              </TextField>
              {rowsOf(shownAll, 'Замовлень не знайдено.')}
              {allRows.length >= ALL_LIMIT && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  Показано останні {ALL_LIMIT}. Старіші знаходяться пошуком за телефоном або номером.
                </Typography>
              )}
            </>
          )}
        </>
      )}

      <Snackbar open={snack.open} autoHideDuration={8000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
