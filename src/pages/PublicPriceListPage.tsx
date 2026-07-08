import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box, Container, Paper, Typography, Table, TableBody, TableCell, TableRow, TableHead,
  TableContainer, Collapse, Button, Chip, Divider, IconButton, Stack, Alert, CircularProgress,
} from '@mui/material'
import {
  ExpandMore as ExpandIcon, Calculate as RateIcon, LocalOffer as KitIcon,
  DirectionsBoat as BoatIcon, ArrowForward as ArrowIcon,
} from '@mui/icons-material'
import { usePricingStore } from '@/store/pricingStore'
import {
  tName, formatMoney, computeLaborRate, resolveActiveSeason, currentMonth,
  workPriceAtSeasonCoef, seasonPriceCoefs, expandKit,
} from '@/utils/pricing'
import type { RateLine } from '@/utils/pricing'

// Артикул-константа: статья «как избежать наценки высокого сезона»
const SURCHARGE_ARTICLE_ID = 'season-surcharge-avoidance'

export default function PublicPriceListPage() {
  const navigate = useNavigate()
  const { catalog, indexed, loadFromServer, isLoading } = usePricingStore()
  const [rateOpen, setRateOpen] = useState(false)
  const [openKit, setOpenKit] = useState<string | null>(null)

  useEffect(() => { loadFromServer() }, [loadFromServer])

  const settings = catalog.settings
  const season = resolveActiveSeason(settings, currentMonth())
  const rateComp = settings.rateBreakdown ? computeLaborRate(settings.rateBreakdown) : null
  const rate = rateComp ? rateComp.rate : settings.laborRatePerHour
  const coefs = seasonPriceCoefs(settings)
  const hasSeasons = coefs.low < 1 || coefs.high > 1

  const cats = [...catalog.categories].sort((a, b) => a.order - b.order)
  const publicWorks = catalog.works.filter((w) => w.active && w.publicVisible)
  const kits = catalog.kits.filter((k) => k.active)

  if (isLoading && !catalog.works.length) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', py: { xs: 3, md: 5 } }}>
      <Container maxWidth="md">
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <BoatIcon color="primary" />
          <Typography variant="h5">Прайс-лист сервісу</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Кожну роботу рахуємо в нормо-годинах — прозоро й без прихованих сум. Ціни орієнтовні:
          точний кошторис складе майстер після діагностики.
        </Typography>

        {/* Ставка нормо-часа с расшифровкой */}
        <Paper sx={{ p: { xs: 2, md: 2.5 }, mb: 3 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
            <Stack direction="row" spacing={1.5} alignItems="baseline">
              <RateIcon color="primary" />
              <Typography variant="h6">Ставка нормо-години: {formatMoney(rate)}</Typography>
            </Stack>
            {rateComp && (
              <Button size="small" endIcon={<ExpandIcon sx={{ transform: rateOpen ? 'rotate(180deg)' : 'none', transition: '.2s' }} />}
                onClick={() => setRateOpen(!rateOpen)}>
                {rateOpen ? 'Сховати' : 'З чого складається'}
              </Button>
            )}
          </Stack>
          {rateComp && (
            <Collapse in={rateOpen}>
              <Divider sx={{ my: 1.5 }} />
              <RateWaterfall lines={rateComp.lines} rate={rateComp.rate} />
            </Collapse>
          )}
        </Paper>

        {/* Пояснение 3 цен + активный сезон + мягкая философия */}
        {hasSeasons && (
          <Alert severity={season.coefficient > 1 ? 'warning' : 'info'} sx={{ mb: 3 }}>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              У таблиці — три ціни: <b>звичайна</b>, у <b>міжсезоння</b> (дешевше) та у <b>високий сезон</b>.
              Сезонний коефіцієнт діє <b>лише на роботи</b>, не на матеріали.
            </Typography>
            {season.coefficient > 1 ? (
              <Typography variant="body2">
                Зараз високий сезон (×{season.coefficient}). Наша мета — не заробити на вас якнайбільше, а
                розумно розподілити ресурси сервісу, щоб допомогти якомога більшій кількості клієнтів у стислі
                строки. Якщо кораблик справний, ремонт можна зробити вигідніше.{' '}
                <Box component="span" sx={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 600 }}
                  onClick={() => navigate(`/help/${SURCHARGE_ARTICLE_ID}`)}>
                  Як уникнути націнки високого сезону?
                </Box>
              </Typography>
            ) : (
              <Typography variant="body2">
                Зараз міжсезоння (×{season.coefficient}) — вигідний час для планового ремонту.
              </Typography>
            )}
          </Alert>
        )}

        {/* Льготные наборы */}
        {kits.length > 0 && (
          <Paper sx={{ p: { xs: 1.5, md: 2 }, mb: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <KitIcon color="secondary" />
              <Typography variant="subtitle1">Готові набори</Typography>
            </Stack>
            {kits.map((k) => {
              const items = expandKit(k, indexed)
              const kitExempt = k.seasonMode === 'critical' || k.seasonMode === 'benefit'
              const kitTotal = (coef: number) => items.reduce((acc, { work, qty }) => acc + workPriceAtSeasonCoef(work, indexed, settings, coef, kitExempt) * qty, 0)
              const isOpen = openKit === k.id
              return (
                <Box key={k.id} sx={{ borderTop: `1px solid`, borderColor: 'divider', py: 1 }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
                      <IconButton size="small" onClick={() => setOpenKit(isOpen ? null : k.id)}>
                        <ExpandIcon sx={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: '.2s' }} />
                      </IconButton>
                      <Typography sx={{ fontWeight: 600 }}>{tName(k.name, 'uk')}</Typography>
                      {k.seasonMode === 'benefit' && <Chip size="small" color="secondary" variant="outlined" label="пільговий" />}
                      {k.seasonMode === 'critical' && <Chip size="small" color="success" variant="outlined" label="критичний" />}
                    </Stack>
                    {hasSeasons ? (
                      <Box sx={{ textAlign: 'right', flexShrink: 0, lineHeight: 1.3 }}>
                        <Typography variant="caption" sx={{ color: 'success.main', display: 'block' }}>міжсез. {formatMoney(kitTotal(coefs.low))}</Typography>
                        <Typography sx={{ fontWeight: 700 }}>{formatMoney(kitTotal(coefs.normal))}</Typography>
                        <Typography variant="caption" sx={{ color: kitExempt ? 'success.main' : 'warning.main', display: 'block' }}>вис. {formatMoney(kitTotal(coefs.high))}</Typography>
                      </Box>
                    ) : (
                      <Typography sx={{ fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>{formatMoney(kitTotal(1))}</Typography>
                    )}
                  </Stack>
                  <Collapse in={isOpen}>
                    <Table size="small" sx={{ mt: 1, mb: 1 }}>
                      <TableBody>
                        {items.map(({ work, qty }) => (
                          <TableRow key={work.id}>
                            <TableCell sx={{ pl: 6 }}>{tName(work.name, 'uk')}{qty > 1 ? ` ×${qty}` : ''}</TableCell>
                            <TableCell align="right">{formatMoney(workPriceAtSeasonCoef(work, indexed, settings, coefs.normal, kitExempt) * qty)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Collapse>
                </Box>
              )
            })}
          </Paper>
        )}

        {/* Работы по категориям */}
        {cats.map((cat) => {
          const works = publicWorks.filter((w) => w.categoryId === cat.id)
          if (!works.length) return null
          return (
            <Paper key={cat.id} sx={{ mb: 2, overflow: 'hidden' }}>
              <Box sx={{ px: 2, py: 1.2, bgcolor: 'action.hover' }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{tName(cat.name, 'uk')}</Typography>
              </Box>
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Робота</TableCell>
                      {hasSeasons && <TableCell align="right" sx={{ color: 'success.main' }}>Міжсезоння</TableCell>}
                      <TableCell align="right">Звичайна</TableCell>
                      {hasSeasons && <TableCell align="right" sx={{ color: 'warning.main' }}>Високий сезон</TableCell>}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {works.map((w) => {
                      const exempt = !!w.waivesHighSeasonSurcharge || !!w.criticalNoSurcharge
                      return (
                        <TableRow key={w.id} hover>
                          <TableCell>
                            {tName(w.name, 'uk')}
                            {w.criticalNoSurcharge && (
                              <Chip size="small" color="success" variant="outlined" label="без націнки сезону" sx={{ ml: 1 }} />
                            )}
                          </TableCell>
                          {hasSeasons && (
                            <TableCell align="right" sx={{ color: 'success.main' }}>
                              {formatMoney(workPriceAtSeasonCoef(w, indexed, settings, coefs.low))}
                            </TableCell>
                          )}
                          <TableCell align="right" sx={{ fontWeight: 600 }}>
                            {formatMoney(workPriceAtSeasonCoef(w, indexed, settings, coefs.normal))}
                          </TableCell>
                          {hasSeasons && (
                            <TableCell align="right" sx={{ color: exempt ? 'success.main' : 'warning.main' }}>
                              {formatMoney(workPriceAtSeasonCoef(w, indexed, settings, coefs.high))}
                            </TableCell>
                          )}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          )
        })}

        {publicWorks.length === 0 && (
          <Alert severity="info">Прайс-лист поки заповнюється. Опишіть проблему — і ми дамо орієнтовну оцінку.</Alert>
        )}

        {/* CTA */}
        <Paper sx={{ p: 3, mt: 3, textAlign: 'center', bgcolor: 'primary.main', color: 'primary.contrastText' }}>
          <Typography variant="h6" sx={{ mb: 1 }}>Не знайшли свою роботу?</Typography>
          <Typography variant="body2" sx={{ mb: 2, opacity: 0.9 }}>
            Опишіть проблему своїми словами — помічник підготує орієнтовну оцінку саме для вашого кораблика.
          </Typography>
          <Button variant="contained" color="secondary" endIcon={<ArrowIcon />} onClick={() => navigate('/questionnaire')}>
            Отримати оцінку
          </Button>
        </Paper>
      </Container>
    </Box>
  )
}

// Водоспад расшифровки ставки: базовая зарплата + проценты (налоги/утримання/прибуток)
function RateWaterfall({ lines, rate }: { lines: RateLine[]; rate: number }) {
  return (
    <Box>
      <Table size="small">
        <TableBody>
          {lines.map((l, i) => (
            <TableRow key={i}>
              <TableCell sx={{ border: 0, py: 0.4 }}>
                {tName(l.name, 'uk')}
                {l.kind === 'percent' && l.percent != null && (
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                    ({l.percent}%{l.base === 'revenue' ? ' з обороту' : l.base === 'salary' ? ' від зарплати' : ''})
                  </Typography>
                )}
              </TableCell>
              <TableCell align="right" sx={{ border: 0, py: 0.4 }}>+{formatMoney(l.amount)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell sx={{ fontWeight: 700, borderTop: '2px solid', borderColor: 'divider' }}>Разом ставка нормо-години</TableCell>
            <TableCell align="right" sx={{ fontWeight: 700, borderTop: '2px solid', borderColor: 'divider' }}>{formatMoney(rate)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Показуємо, як формується година роботи: оплата майстру, податки, утримання сервісу та норма прибутку.
      </Typography>
    </Box>
  )
}
