// История правок калькуляции: показывает, что менялось при каждом редактировании (added/changed/
// removed позиции + изменение суммы). Строим цепочку версий [прежние… → текущая] и для каждой пары
// считаем diff движком (compareEstimates). Видно всем — мастеру и клиенту. Свёрнуто по умолчанию.
import { useMemo, useState } from 'react'
import { Paper, Typography, Stack, Chip, Box, Button, Collapse } from '@mui/material'
import { History as HistoryIcon, ExpandMore as ExpandIcon } from '@mui/icons-material'
import { compareEstimates, tName, formatMoney } from '@/utils/pricing'
import type { Estimate } from '@/types/pricing'
import type { SafeEstimate, SafeEstimateVersion } from '@/api/endpoints/payments'

export default function EstimateHistory({ current, history }: {
  current: SafeEstimate
  history: SafeEstimateVersion[]
}) {
  const [open, setOpen] = useState(false)

  const edits = useMemo(() => {
    if (!history.length) return []
    // Цепочка версий по времени: прежние снимки + текущее состояние.
    const timeline: { at: string | null; total: number; lines: SafeEstimate['lines']; sections: SafeEstimate['sections'] }[] = [
      ...history.map((v) => ({ at: v.at, total: v.total, lines: v.lines, sections: v.sections })),
      { at: current.updatedAt || current.paidAt || null, total: current.total, lines: current.lines, sections: current.sections },
    ]
    const out: { at: string | null; cmp: ReturnType<typeof compareEstimates> }[] = []
    for (let i = 1; i < timeline.length; i++) {
      const cmp = compareEstimates(timeline[i - 1] as unknown as Estimate, timeline[i] as unknown as Estimate)
      out.push({ at: timeline[i].at, cmp })
    }
    return out.reverse() // новые правки сверху
  }, [history, current])

  if (!edits.length) return null
  const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }) : '')

  return (
    <Paper sx={{ p: 2, mb: 3 }}>
      <Button onClick={() => setOpen((o) => !o)} startIcon={<HistoryIcon />}
        endIcon={<ExpandIcon sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: '.2s' }} />}
        sx={{ textTransform: 'none', color: 'text.primary', justifyContent: 'flex-start', width: '100%' }}>
        Історія змін кошторису ({edits.length})
      </Button>
      <Collapse in={open}>
        <Stack spacing={2} sx={{ mt: 1.5 }} divider={<Box sx={{ borderTop: '0.5px solid', borderColor: 'divider' }} />}>
          {edits.map((e, i) => {
            const changed = e.cmp.added.length + e.cmp.changed.length + e.cmp.removed.length
            return (
              <Box key={i}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', mb: 0.5 }}>
                  <Typography variant="subtitle2">Редагування {edits.length - i}</Typography>
                  {e.at && <Typography variant="caption" color="text.secondary">{fmtDate(e.at)}</Typography>}
                  <Chip size="small" sx={{ ml: 'auto' }}
                    color={e.cmp.diffTotal > 0 ? 'warning' : e.cmp.diffTotal < 0 ? 'success' : 'default'}
                    label={`${formatMoney(e.cmp.prelimTotal)} → ${formatMoney(e.cmp.actualTotal)}`} />
                </Stack>
                {changed === 0 ? (
                  <Typography variant="body2" color="text.secondary">Склад робіт не змінився (правка інших полів).</Typography>
                ) : (
                  <Box sx={{ pl: 0.5 }}>
                    {e.cmp.added.map((d, k) => <Typography key={`a${k}`} variant="body2" color="warning.main">+ {tName(d.name, 'uk')} ({formatMoney(d.delta)})</Typography>)}
                    {e.cmp.changed.map((d, k) => <Typography key={`c${k}`} variant="body2">± {tName(d.name, 'uk')} ({d.delta >= 0 ? '+' : ''}{formatMoney(d.delta)})</Typography>)}
                    {e.cmp.removed.map((d, k) => <Typography key={`r${k}`} variant="body2" color="text.secondary">− {tName(d.name, 'uk')} ({formatMoney(d.delta)})</Typography>)}
                  </Box>
                )}
              </Box>
            )
          })}
        </Stack>
      </Collapse>
    </Paper>
  )
}
