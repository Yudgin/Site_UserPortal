// Хаб заявки: «Роботи і калькуляції майстрів» — ЛИШЕ перегляд (етап 1). Роботи (хто що робить) і калькуляції
// майстрів складають у застосунку «RunFerry Сервіс», пише тільки сервер; тут — живий список (onSnapshot):
// виконавець, напрям, вид, сума, стан, коментарі, рядки (розгортаються) і посилання на похідні калькуляції клієнту
// («на основі цього складено: варіант/факт»).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Paper, Stack, Typography, Chip, Box, Button, Collapse, Table, TableHead, TableBody, TableRow, TableCell,
  Alert, Divider, CircularProgress,
} from '@mui/material'
import { Engineering as WorksIcon, ExpandMore as ExpandIcon, ExpandLess as CollapseIcon } from '@mui/icons-material'
import { masterEstimateService } from '@/api/masterEstimateService'
import { formatMoney } from '@/utils/pricing'
import {
  WORK_KIND_LABELS, WORK_STATUS_LABELS, MASTER_ESTIMATE_KIND_LABELS, MASTER_ESTIMATE_DIRECTION_LABELS,
  MASTER_ESTIMATE_STATUS_LABELS, MASTER_ESTIMATE_DERIVED_LABELS,
  type ServiceWork, type MasterEstimate, type MasterEstimateDerived, type WorkStatus, type MasterEstimateStatus,
} from '@/types/masterEstimate'

type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'

const WORK_STATUS_COLORS: Record<WorkStatus, ChipColor> = {
  planned: 'default',
  in_progress: 'primary',
  done: 'success',
  cancelled: 'default',
}

const ME_STATUS_COLORS: Record<MasterEstimateStatus, ChipColor> = {
  draft: 'default',
  submitted: 'warning', // чекає розгляду власником/директором
  accepted: 'success',
  returned: 'error',
  cancelled: 'default',
}

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString('uk-UA') : '')

interface Props {
  serviceRequestId: string
  // null — усі калькуляції заявки (власник/директор/бухгалтер); uid — лише свої (майстер; так вимагають правила).
  performerUid: string | null
  offerId?: string | null // пропозиція заявки — куди веде посилання «варіант»
  actualEstimateId?: string | null
  actualPaid?: boolean // оплачений факт — відкриваємо сторінку кошторису, а не редактор
}

export default function MasterWorksSection({ serviceRequestId, performerUid, offerId, actualEstimateId, actualPaid }: Props) {
  const navigate = useNavigate()
  const [works, setWorks] = useState<ServiceWork[] | null>(null) // null — ще вантажиться
  const [estimates, setEstimates] = useState<MasterEstimate[] | null>(null)
  const [worksError, setWorksError] = useState(false)
  const [estimatesError, setEstimatesError] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({}) // розгорнуті рядки калькуляцій

  useEffect(() => {
    setWorks(null); setWorksError(false)
    return masterEstimateService.subscribeWorks(
      serviceRequestId,
      (w) => { setWorks(w); setWorksError(false) },
      () => { setWorks([]); setWorksError(true) },
    )
  }, [serviceRequestId])

  useEffect(() => {
    setEstimates(null); setEstimatesError(false)
    return masterEstimateService.subscribeByRequest(
      serviceRequestId, performerUid,
      (e) => { setEstimates(e); setEstimatesError(false) },
      () => { setEstimates([]); setEstimatesError(true) },
    )
  }, [serviceRequestId, performerUid])

  const workById = useMemo(() => new Map((works || []).map((w) => [w.id, w])), [works])

  // Куди веде похідна калькуляція клієнту: варіант — редактор пропозиції заявки; факт — редактор факту
  // (оплачений — сторінка кошторису).
  const derivedHref = (d: MasterEstimateDerived): string | null => {
    if (d.type === 'variant') return offerId ? `/offer-editor?offer=${offerId}` : null
    if (d.type === 'actual') {
      return actualPaid && d.id === actualEstimateId
        ? `/estimate/${d.id}`
        : `/actual-estimate?request=${serviceRequestId}&edit=${d.id}`
    }
    return null
  }

  const loading = works === null || estimates === null
  const empty = !loading && !worksError && !estimatesError && (works || []).length === 0 && (estimates || []).length === 0

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <WorksIcon fontSize="small" color="primary" />
        <Typography variant="subtitle1">Роботи і калькуляції майстрів</Typography>
      </Stack>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}><CircularProgress size={22} /></Box>
      ) : empty ? (
        <Typography variant="body2" color="text.secondary">
          Робіт і калькуляцій майстрів ще немає — їх складають у застосунку «RunFerry Сервіс»
        </Typography>
      ) : (
        <Stack spacing={2}>
          {(worksError || estimatesError) && (
            <Alert severity="warning">
              Не вдалося завантажити {worksError && estimatesError ? 'роботи і калькуляції майстрів' : worksError ? 'роботи' : 'калькуляції майстрів'} — немає доступу або правила доступу ще не оновлено.
            </Alert>
          )}

          {/* Роботи по заявці */}
          {(works || []).length > 0 && (
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>Роботи</Typography>
              <Stack spacing={0.75} divider={<Divider flexItem />}>
                {(works || []).map((w) => {
                  const kindLabel = WORK_KIND_LABELS[w.kind] || w.kind
                  return (
                    <Stack key={w.id} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }} useFlexGap>
                      <Box sx={{ flex: 1, minWidth: 180 }}>
                        <Typography variant="body2">{w.title || kindLabel}</Typography>
                        {w.title && w.title !== kindLabel && (
                          <Typography variant="caption" color="text.secondary">{kindLabel}</Typography>
                        )}
                      </Box>
                      <Typography variant="body2" color={w.assigneeName ? 'text.primary' : 'text.secondary'}>
                        {w.assigneeName || 'не призначено'}
                      </Typography>
                      <Chip size="small" color={WORK_STATUS_COLORS[w.status] || 'default'}
                        variant={w.status === 'cancelled' ? 'outlined' : 'filled'}
                        label={WORK_STATUS_LABELS[w.status] || w.status} />
                    </Stack>
                  )
                })}
              </Stack>
            </Box>
          )}

          {/* Калькуляції майстрів */}
          {(estimates || []).length > 0 && (
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>Калькуляції майстрів</Typography>
              <Stack spacing={1}>
                {(estimates || []).map((me) => {
                  const isOpen = !!open[me.id]
                  const work = me.workId ? workById.get(me.workId) : undefined
                  const lines = me.lines || []
                  const derived = me.derived || []
                  return (
                    <Box key={me.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25, opacity: me.status === 'cancelled' ? 0.6 : 1 }}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }} useFlexGap>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{me.performerName || me.performerUid}</Typography>
                        <Chip size="small" variant="outlined" label={MASTER_ESTIMATE_DIRECTION_LABELS[me.direction] || me.direction} />
                        <Chip size="small" variant="outlined" label={MASTER_ESTIMATE_KIND_LABELS[me.kind] || me.kind} />
                        {work && <Typography variant="caption" color="text.secondary">{work.title || WORK_KIND_LABELS[work.kind]}</Typography>}
                        <Box sx={{ flex: 1 }} />
                        <Typography variant="body2" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{formatMoney(me.total || 0)}</Typography>
                        <Chip size="small" color={ME_STATUS_COLORS[me.status] || 'default'}
                          variant={me.status === 'cancelled' ? 'outlined' : 'filled'}
                          label={MASTER_ESTIMATE_STATUS_LABELS[me.status] || me.status} />
                      </Stack>

                      {me.comment && (
                        <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>{me.comment}</Typography>
                      )}
                      {me.reviewComment && (
                        <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }} color={me.status === 'returned' ? 'error.main' : 'text.secondary'}>
                          Коментар при розгляді: {me.reviewComment}
                        </Typography>
                      )}
                      {me.basedOn?.type === 'clientEstimate' && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                          Складено на основі калькуляції клієнту
                        </Typography>
                      )}
                      {derived.length > 0 && (
                        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.75, flexWrap: 'wrap' }} useFlexGap>
                          <Typography variant="caption" color="text.secondary">На основі цього складено:</Typography>
                          {derived.map((d, i) => {
                            const href = derivedHref(d)
                            return (
                              <Chip key={`${d.type}-${d.id}-${i}`} size="small" color="primary" variant="outlined"
                                label={`${MASTER_ESTIMATE_DERIVED_LABELS[d.type] || d.type}${d.at ? ` · ${fmtDate(d.at)}` : ''}`}
                                clickable={!!href} onClick={href ? () => navigate(href) : undefined} />
                            )
                          })}
                        </Stack>
                      )}

                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5, flexWrap: 'wrap' }} useFlexGap>
                        <Button size="small" disabled={!lines.length}
                          endIcon={isOpen ? <CollapseIcon /> : <ExpandIcon />}
                          onClick={() => setOpen((o) => ({ ...o, [me.id]: !o[me.id] }))}>
                          Рядки ({lines.length})
                        </Button>
                        {(me.updatedAt || me.createdAt) && (
                          <Typography variant="caption" color="text.secondary">оновлено {fmtDate(me.updatedAt || me.createdAt)}</Typography>
                        )}
                      </Stack>
                      <Collapse in={isOpen} unmountOnExit>
                        <Box sx={{ overflowX: 'auto' }}>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell>Назва</TableCell>
                                <TableCell align="right">К-сть</TableCell>
                                <TableCell align="right">Сума</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {lines.map((l, i) => (
                                <TableRow key={i}>
                                  <TableCell>
                                    {l.title}
                                    {l.note && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{l.note}</Typography>}
                                  </TableCell>
                                  <TableCell align="right">{l.qty}</TableCell>
                                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{formatMoney(l.amount || 0)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </Box>
                      </Collapse>
                    </Box>
                  )
                })}
              </Stack>
            </Box>
          )}
        </Stack>
      )}
    </Paper>
  )
}
