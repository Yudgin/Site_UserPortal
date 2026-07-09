// Админка оплат и чеков (для владельца/админа).
//
// Список платежей из коллекции payments (чтение — админ по правилам Firestore). Подсвечивает
// «гроші є, чек ні» (оплачено, но чек не выбит), позволяет повторно выбить чек по оплате и
// запустить реконсиляцию. Действия идут на backend с Firebase ID-токеном (сервер сверяет админа).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Button, Alert, Snackbar, CircularProgress, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Stack, FormControlLabel, Switch, Link,
} from '@mui/material'
import { Home as HomeIcon, Refresh as RefreshIcon, Receipt as ReceiptIcon, Autorenew as ReconcileIcon } from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { paymentsAdminService, PaymentRow } from '@/api/paymentsAdminService'
import { paymentsApi } from '@/api/endpoints/payments'
import { formatMoney } from '@/utils/pricing'

const receiptChip = (p: PaymentRow) => {
  if (p.receiptId) return <Chip size="small" color="success" label="чек ✓" />
  if (p.status !== 'paid') return <Chip size="small" variant="outlined" label="—" />
  if (p.receiptStatus === 'no-checkbox') return <Chip size="small" color="warning" label="ФОП без ПРРО" />
  if (p.receiptStatus === 'amount-mismatch') return <Chip size="small" color="error" label="сума!" />
  if (p.receiptStatus === 'error') return <Chip size="small" color="error" label="помилка чека" />
  return <Chip size="small" color="warning" label="немає чека" />
}

const statusChip = (s: string) => {
  if (s === 'paid') return <Chip size="small" color="success" variant="outlined" label="оплачено" />
  if (s === 'FAILURE') return <Chip size="small" color="error" variant="outlined" label="помилка" />
  if (s === 'EXPIRED') return <Chip size="small" color="error" variant="outlined" label="протерміновано" />
  if (s === 'pending' || s === 'WAITING_FOR_CLIENT' || s === 'WAITING_FOR_STORE_CONFIRM') return <Chip size="small" color="warning" variant="outlined" label={s === 'pending' ? 'очікує' : 'очікує банк'} />
  return <Chip size="small" variant="outlined" label={s} />
}

// Безопасное форматирование даты (не 'Invalid Date' на неожиданном формате)
const fmtDate = (s?: string): string => {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('uk-UA')
}

export default function PaymentsAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [onlyNoReceipt, setOnlyNoReceipt] = useState(false)
  const [busy, setBusy] = useState('') // orderId, по которому идёт действие
  const [reconciling, setReconciling] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' | 'info' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' | 'info' = 'success') => setSnack({ open: true, msg, sev })

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await paymentsAdminService.list(300))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const noReceipt = useMemo(() => rows.filter((p) => p.status === 'paid' && !p.receiptId), [rows])
  const shown = onlyNoReceipt ? noReceipt : rows

  const refiscalize = async (orderId: string) => {
    setBusy(orderId)
    try {
      const r = await paymentsApi.refiscalize(orderId)
      notify(r.receiptId ? 'Чек виписано' : `Чек не виписано (${r.receiptStatus || 'помилка'})`, r.receiptId ? 'success' : 'error')
      await load()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Помилка', 'error')
    } finally {
      setBusy('')
    }
  }

  const reconcile = async () => {
    setReconciling(true)
    try {
      const r = await paymentsApi.reconcile()
      notify(`Реконсиляція: перевірено ${r.checked}`, 'success')
      await load()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Помилка', 'error')
    } finally {
      setReconciling(false)
    }
  }

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для адміністратора.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Оплати та чеки</Typography>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>Оновити</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>

      {noReceipt.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }} action={
          <Button color="inherit" size="small" startIcon={<ReconcileIcon />} onClick={reconcile} disabled={reconciling}>
            {reconciling ? 'Реконсиляція…' : 'Добити чеки'}
          </Button>
        }>
          <b>{noReceipt.length}</b> оплат без чека («гроші є, чек ні»). Виправте кнопкою «Виписати чек» або запустіть реконсиляцію.
        </Alert>
      )}

      <FormControlLabel
        control={<Switch checked={onlyNoReceipt} onChange={(e) => setOnlyNoReceipt(e.target.checked)} />}
        label="Тільки без чека" sx={{ mb: 1 }}
      />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
      ) : shown.length === 0 ? (
        <Alert severity="info">Оплат поки немає.</Alert>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: 'action.hover' }}>
                <TableCell>Дата</TableCell>
                <TableCell>ФОП</TableCell>
                <TableCell>Метод</TableCell>
                <TableCell align="right">Сума</TableCell>
                <TableCell>Статус</TableCell>
                <TableCell>Чек</TableCell>
                <TableCell align="right">Дії</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((p) => (
                <TableRow key={p.orderId} hover>
                  <TableCell>{fmtDate(p.createdAt)}</TableCell>
                  <TableCell>{p.fopId}</TableCell>
                  <TableCell>{p.provider || p.method || '—'}</TableCell>
                  <TableCell align="right">{formatMoney(p.amount)}</TableCell>
                  <TableCell>{statusChip(p.status)}</TableCell>
                  <TableCell>
                    {receiptChip(p)}
                    {p.taxUrl && <Link href={p.taxUrl} target="_blank" rel="noreferrer" sx={{ ml: 1, fontSize: 12 }}>відкрити</Link>}
                  </TableCell>
                  <TableCell align="right">
                    {p.status === 'paid' && !p.receiptId && p.receiptStatus !== 'no-checkbox' && (
                      <Button size="small" variant="outlined" startIcon={<ReceiptIcon />} disabled={busy === p.orderId} onClick={() => refiscalize(p.orderId)}>
                        {busy === p.orderId ? '…' : 'Виписати чек'}
                      </Button>
                    )}
                    {p.estimateId && (
                      <Button size="small" onClick={() => navigate(`/estimate/${p.estimateId}`)}>кошторис</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Snackbar open={snack.open} autoHideDuration={6000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
