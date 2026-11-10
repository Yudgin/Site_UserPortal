// Результат «Тестовий чек» на /fops: чек продажи на 10 грн и автоматический чек возврата к нему.
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material'
import type { TestReceiptInfo, TestRefund } from '@/api/endpoints/fopsAdmin'

export interface TestReceiptResult {
  fopName: string
  ok: boolean
  sale?: TestReceiptInfo
  refund?: TestRefund
  error?: string
}

const ReceiptLines = ({ r }: { r: TestReceiptInfo }) => (
  <>
    {r.fiscalCode && <Typography variant="body2">Фіскальний код: <b>{r.fiscalCode}</b></Typography>}
    {r.status && r.status !== 'DONE' && <Typography variant="body2" color="text.secondary">Статус: {r.status}</Typography>}
    {r.taxUrl && <Typography variant="body2"><a href={r.taxUrl} target="_blank" rel="noreferrer">Переглянути чек</a></Typography>}
  </>
)

const SaleBlock = ({ sale }: { sale: TestReceiptInfo }) => {
  const text = sale.status === 'DONE'
    ? 'Чек продажу на 10 грн виписано (реальний).'
    : sale.status === 'ERROR' || sale.status === 'CANCELLED'
      ? 'Checkbox не зареєстрував чек продажу в податковій.'
      : 'Чек продажу на 10 грн створено, податкова ще його реєструє.'
  return (
    <>
      <Alert severity={sale.status === 'DONE' ? 'success' : sale.status === 'ERROR' || sale.status === 'CANCELLED' ? 'error' : 'info'}>{text}</Alert>
      <ReceiptLines r={sale} />
    </>
  )
}

const RefundBlock = ({ refund }: { refund?: TestRefund }) => {
  if (!refund) {
    return <Alert severity="warning">Сервер не повідомив про чек повернення. Перевірте кабінет Checkbox і за потреби зробіть повернення там.</Alert>
  }
  if (refund.skipped === 'sale_pending') {
    return (
      <Alert severity="warning">
        Податкова ще не зареєструвала чек продажу, тому повернення автоматично не створено. Коли чек продажу зареєструється,
        зробіть чек повернення в кабінеті Checkbox.
      </Alert>
    )
  }
  if (refund.skipped) return <Alert severity="info">Чек продажу не зареєстровано, тому повертати нічого.</Alert>
  if (refund.error) {
    return (
      <Alert severity="warning">
        <Box sx={{ whiteSpace: 'pre-wrap' }}>Чек повернення не вдалося створити. {refund.error}</Box>
        <Box sx={{ mt: 0.5 }}>Зробіть його вручну в кабінеті Checkbox.</Box>
      </Alert>
    )
  }
  const done = refund.status === 'DONE'
  return (
    <>
      <Alert severity={done ? 'success' : 'info'}>
        {done
          ? 'Чек повернення на 10 грн створено автоматично: продаж і повернення разом дають нуль.'
          : 'Чек повернення на 10 грн створено автоматично, податкова ще його реєструє.'}
      </Alert>
      <ReceiptLines r={refund} />
    </>
  )
}

export default function TestReceiptDialog({ result, onClose }: { result: TestReceiptResult | null; onClose: () => void }) {
  return (
    <Dialog open={!!result} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Тестовий чек · {result?.fopName}</DialogTitle>
      <DialogContent dividers>
        {result?.ok ? (
          <Stack spacing={1}>
            <SaleBlock sale={result.sale || {}} />
            <RefundBlock refund={result.refund} />
            <Typography variant="caption" color="text.secondary">
              Гроші не списувались: обидва чеки — лише записи в касі. Зміна на касі лишається відкритою: вона закриється
              сама, якщо в кабінеті Checkbox увімкнене автоматичне закриття змін, інакше закрийте її там.
            </Typography>
          </Stack>
        ) : (
          <Alert severity="error"><Box sx={{ whiteSpace: 'pre-wrap' }}>{result?.error}</Box></Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  )
}
