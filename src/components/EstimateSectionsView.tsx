// Показ калькуляции РАЗРЕЗАМИ ПО ТРЕБОВАНИЯМ: группируем строки по секциям (complaintIndex),
// у каждого требования — заголовок, направление и подытог; снизу общий итог. Переиспользуется у
// мастера (полная смета) и на клиентской странице (SafeEstimate). Дженерик по типу строки.
import { Box, Stack, Typography, Chip, Table, TableBody, TableRow, TableCell, Divider } from '@mui/material'
import { tName, formatMoney } from '@/utils/pricing'
import { groupLinesBySection, type SectionRef } from '@/utils/estimateSections'
import type { EstimateLineType, LocalizedText } from '@/types/pricing'

interface ViewLine { type?: EstimateLineType; name: LocalizedText; qty: number; lineTotal: number; grossLineTotal?: number | null; complaintIndex?: number | null }

export default function EstimateSectionsView<L extends ViewLine>({ lines, sections, total, currency = 'грн', discount }: {
  lines: L[]
  sections: SectionRef[] | null | undefined
  total?: number
  currency?: string
  // Знижка кошторису: рядки показуються ПОВНИМИ цінами, знижка — окремим рядком унизу.
  discount?: { value: number; kind: 'pct' | 'uah'; amount: number; grossTotal: number } | null
}) {
  const shown = (l: ViewLine) => l.grossLineTotal ?? l.lineTotal
  const groups = groupLinesBySection(lines, sections)
  const multi = groups.length > 1 || !!groups[0]?.label

  return (
    <Stack spacing={multi ? 2 : 1}>
      {groups.map((g, gi) => (
        <Box key={gi}>
          {g.label && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Typography variant="subtitle2">{g.label}</Typography>
              {g.serviceKind && <Chip size="small" variant="outlined" color={g.serviceKind === 'upgrade' ? 'info' : 'default'}
                label={g.serviceKind === 'upgrade' ? 'апгрейд' : 'ремонт'} />}
              <Typography variant="subtitle2" sx={{ ml: 'auto' }}>{formatMoney(g.lines.reduce((a, l) => a + shown(l), 0))}</Typography>
            </Stack>
          )}
          <Table size="small">
            <TableBody>
              {g.lines.map((l, li) => (
                <TableRow key={li}>
                  <TableCell sx={{ border: 0, py: 0.3 }}>
                    {tName(l.name, 'uk')}
                    {l.type && l.type !== 'labor' && <Chip size="small" sx={{ ml: 1 }} label={l.type === 'material' ? 'матеріал' : 'послуга'} />}
                  </TableCell>
                  <TableCell sx={{ border: 0, py: 0.3 }} align="right">{l.qty}</TableCell>
                  <TableCell sx={{ border: 0, py: 0.3 }} align="right">{formatMoney(shown(l))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      ))}
      {total != null && (
        <>
          <Divider />
          {discount && discount.amount > 0 && (
            <>
              <Stack direction="row" justifyContent="space-between" sx={{ px: 1 }}>
                <Typography variant="body2" color="text.secondary">Без знижки</Typography>
                <Typography variant="body2" color="text.secondary">{formatMoney(discount.grossTotal)}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ px: 1 }}>
                <Typography variant="body2" color="error.main">
                  Знижка{discount.kind === 'pct' ? ` (${discount.value}%)` : ''}
                </Typography>
                <Typography variant="body2" color="error.main">−{formatMoney(discount.amount)}</Typography>
              </Stack>
            </>
          )}
          <Stack direction="row" justifyContent="space-between" sx={{ px: 1 }}>
            <Typography variant="subtitle1"><b>Разом</b></Typography>
            <Typography variant="subtitle1"><b>{formatMoney(total)} {currency === 'UAH' ? 'грн' : currency}</b></Typography>
          </Stack>
        </>
      )}
    </Stack>
  )
}
