// Клиентская страница ВЫБОРА ВАРИАНТА (стадия 2, открывается по ссылке /offer/:id).
//
// Клиент видит один или несколько вариантов ремонта, предложенных мастером, и выбирает ОДИН путь.
// После выбора мастер собирает фактическую калькуляцию по выбранному варианту и присылает ссылку
// на оплату (/estimate/:id).
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip, Stack, Divider,
} from '@mui/material'
import { CheckCircle as CheckIcon } from '@mui/icons-material'
import { paymentsApi, OfferPublicView } from '@/api/endpoints/payments'
import { formatMoney } from '@/utils/pricing'
import EstimateSectionsView from '@/components/EstimateSectionsView'

export default function OfferSharePage() {
  const { id = '' } = useParams<{ id: string }>()
  const [data, setData] = useState<OfferPublicView | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    try {
      const v = await paymentsApi.getOfferPublic(id)
      setData(v)
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const choose = async (variantId: string) => {
    setBusy(variantId); setErr('')
    try {
      await paymentsApi.chooseVariant(id, variantId)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setBusy('')
    }
  }

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>
  if (notFound || !data) {
    return <Container maxWidth="sm" sx={{ py: 8 }}><Alert severity="error">Пропозицію не знайдено.</Alert></Container>
  }

  const { offer, variants } = data
  const single = variants.length === 1
  const selectedId = offer.selectedVariantId
  const locked = offer.status === 'locked' // мастер уже собрал факт по выбранному — переизбор закрыт

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" gutterBottom>{single ? 'Ваш кошторис' : 'Оберіть варіант ремонту'}</Typography>
      {offer.title && <Typography variant="subtitle1" color="text.secondary" sx={{ mb: 1 }}>{offer.title}</Typography>}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {single
          ? 'Підтвердіть кошторис — після цього майстер підготує фактичний рахунок до оплати.'
          : 'Ми підготували кілька варіантів. Оберіть той, що вам підходить — за ним ми складемо фінальний рахунок.'}
      </Typography>

      {selectedId && (
        <Alert severity="success" icon={<CheckIcon />} sx={{ mb: 3 }}>
          {locked
            ? 'Ваш вибір зафіксовано. Майстер готує фактичний кошторис і надішле посилання для оплати.'
            : <>Ви обрали варіант. Майстер підготує фактичний кошторис за цим шляхом і надішле посилання для оплати.{!single && ' За потреби можна змінити вибір нижче.'}</>}
        </Alert>
      )}
      {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

      <Stack spacing={2}>
        {variants.map((v) => {
          const isSelected = selectedId === v.id
          return (
            <Paper key={v.id} sx={{ p: 2, border: isSelected ? '2px solid' : '1px solid', borderColor: isSelected ? 'success.main' : 'divider' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1 }}>
                <Typography variant="h6">
                  {v.variantLabel || 'Варіант'}
                  {isSelected && <Chip color="success" size="small" icon={<CheckIcon />} label="обрано" sx={{ ml: 1 }} />}
                </Typography>
                <Typography variant="h6" color="primary">{formatMoney(v.total)}</Typography>
              </Box>
              <EstimateSectionsView lines={v.lines} sections={v.sections} total={v.total} currency={v.currency} />
              <Box sx={{ mt: 1.5 }}>
                <Button
                  variant={isSelected ? 'outlined' : 'contained'}
                  color={isSelected ? 'success' : 'primary'}
                  disabled={!!busy || locked || isSelected}
                  onClick={() => choose(v.id)}
                >
                  {busy === v.id ? 'Зберігаємо…' : isSelected ? 'Обрано' : single ? 'Підтвердити кошторис' : 'Обрати цей варіант'}
                </Button>
              </Box>
            </Paper>
          )
        })}
      </Stack>

      <Divider sx={{ my: 3 }} />
      <Typography variant="caption" color="text.secondary">
        Це попередній кошторис. Фінальна сума за фактично виконаними роботами може відрізнятися —
        ми повідомимо й погодимо з вами перед оплатою.
      </Typography>
    </Container>
  )
}
