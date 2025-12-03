import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Paper,
  Grid,
  Button,
  TextField,
  IconButton,
  Snackbar,
  Alert,
  Divider,
} from '@mui/material'
import {
  ContentCopy as CopyIcon,
  Edit as EditIcon,
  Share as ShareIcon,
} from '@mui/icons-material'
import { useState } from 'react'
import {
  decodeConfiguration,
  BOAT_COLOR_OPTIONS,
  STICKER_COLOR_OPTIONS,
  LEFT_GROUP1,
  LEFT_GROUP2,
  TOP_CONFIG,
  BACK_CONFIG,
  type StickerPosition,
  type StickerGroup,
} from './BoatConfiguratorPage'

// Get sticker path with color folder
const getStickerPath = (viewType: 'left' | 'top' | 'back', group: string | null, num: number, colorFolder?: string) => {
  const colorPath = colorFolder && colorFolder !== 'none' ? `${colorFolder}/` : ''
  if (viewType === 'left' && group) {
    return `/boat/left/${group}/${colorPath}sticker-${num}.png`
  }
  return `/boat/${viewType}/${colorPath}sticker-${num}.png`
}

// Render sticker with clipPath for results view (no filter - uses pre-colored images)
const renderStickerWithClipPath = (
  stickerNum: number,
  src: string,
  pos: StickerPosition,
  config: StickerGroup,
  groupPrefix?: string
) => {
  const { viewBox } = config
  const clipId = `result-clip-${groupPrefix ? groupPrefix + '-' : ''}${stickerNum}`

  return (
    <svg
      viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          {pos.clipPath ? (
            <path d={pos.clipPath} />
          ) : (
            <rect x={pos.x} y={pos.y} width={pos.width} height={pos.height} />
          )}
        </clipPath>
      </defs>
      <g style={{ clipPath: `url(#${clipId})` }}>
        <image
          href={src}
          x={pos.x}
          y={pos.y}
          width={pos.width}
          height={pos.height}
          preserveAspectRatio="none"
        />
      </g>
    </svg>
  )
}

export default function BoatConfiguratorResultPage() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [copySuccess, setCopySuccess] = useState(false)

  const config = code ? decodeConfiguration(code) : null

  if (!config) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h5" color="error" gutterBottom>
          {t('configurator.invalidCode', 'Недействительный код конфигурации')}
        </Typography>
        <Button variant="contained" onClick={() => navigate('/configurator')}>
          {t('configurator.backToConfigurator', 'Вернуться к конфигуратору')}
        </Button>
      </Box>
    )
  }

  const boatColor = BOAT_COLOR_OPTIONS[config.boatColorIndex] || BOAT_COLOR_OPTIONS[0]
  const shareUrl = `${window.location.origin}/configurator/result/${code}`

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopySuccess(true)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopySuccess(true)
    }
  }

  // Render a single boat view
  const renderBoatView = (
    viewType: 'left' | 'top' | 'back',
    title: string
  ) => {
    return (
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold', textAlign: 'center' }}>
          {title}
        </Typography>
        <Box
          sx={{
            position: 'relative',
            width: '100%',
            backgroundColor: '#f0f0f0',
            borderRadius: 1,
          }}
        >
          <img
            src={`/boat/${viewType}/base.png`}
            alt={`Boat ${viewType}`}
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              filter: boatColor.filter,
            }}
          />

          {/* Stickers for left view */}
          {viewType === 'left' && (
            <>
              {config.leftGroup1.sticker && LEFT_GROUP1.stickers[config.leftGroup1.sticker] &&
                renderStickerWithClipPath(
                  config.leftGroup1.sticker,
                  getStickerPath('left', 'group1', config.leftGroup1.sticker, STICKER_COLOR_OPTIONS[config.leftGroup1.colorIndex]?.filter),
                  LEFT_GROUP1.stickers[config.leftGroup1.sticker],
                  LEFT_GROUP1,
                  'result-g1'
                )
              }
              {config.leftGroup2.sticker && LEFT_GROUP2.stickers[config.leftGroup2.sticker] &&
                renderStickerWithClipPath(
                  config.leftGroup2.sticker,
                  getStickerPath('left', 'group2', config.leftGroup2.sticker, STICKER_COLOR_OPTIONS[config.leftGroup2.colorIndex]?.filter),
                  LEFT_GROUP2.stickers[config.leftGroup2.sticker],
                  LEFT_GROUP2,
                  'result-g2'
                )
              }
            </>
          )}

          {/* Sticker for top view */}
          {viewType === 'top' && config.topSticker.sticker && TOP_CONFIG.stickers[config.topSticker.sticker] &&
            renderStickerWithClipPath(
              config.topSticker.sticker,
              getStickerPath('top', null, config.topSticker.sticker, STICKER_COLOR_OPTIONS[config.topSticker.colorIndex]?.filter),
              TOP_CONFIG.stickers[config.topSticker.sticker],
              TOP_CONFIG,
              'result-top'
            )
          }

          {/* Sticker for back view */}
          {viewType === 'back' && config.backSticker.sticker && BACK_CONFIG.stickers[config.backSticker.sticker] &&
            renderStickerWithClipPath(
              config.backSticker.sticker,
              getStickerPath('back', null, config.backSticker.sticker, STICKER_COLOR_OPTIONS[config.backSticker.colorIndex]?.filter),
              BACK_CONFIG.stickers[config.backSticker.sticker],
              BACK_CONFIG,
              'result-back'
            )
          }
        </Box>
      </Paper>
    )
  }

  return (
    <Box sx={{ p: 2, maxWidth: 1200, mx: 'auto' }}>
      <Typography variant="h5" gutterBottom textAlign="center">
        {t('configurator.result', 'Результат конфигурации')}
      </Typography>

      {/* Boat Views */}
      <Grid container spacing={2} sx={{ mb: 4 }}>
        <Grid item xs={12} md={4}>
          {renderBoatView('left', t('configurator.viewLeft', 'Вид сбоку'))}
        </Grid>
        <Grid item xs={12} md={4}>
          {renderBoatView('top', t('configurator.viewTop', 'Вид сверху'))}
        </Grid>
        <Grid item xs={12} md={4}>
          {renderBoatView('back', t('configurator.viewBack', 'Вид сзади'))}
        </Grid>
      </Grid>

      {/* Configuration Code */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          {t('configurator.configCode', 'Код конфигурации')}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <TextField
            value={code}
            fullWidth
            InputProps={{
              readOnly: true,
              sx: { fontFamily: 'monospace', fontSize: '1.5rem', textAlign: 'center' },
            }}
          />
          <IconButton onClick={() => copyToClipboard(code || '')} color="primary">
            <CopyIcon />
          </IconButton>
        </Box>

        <Divider sx={{ my: 2 }} />

        <Typography variant="h6" gutterBottom>
          {t('configurator.shareLink', 'Ссылка для обмена')}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <TextField
            value={shareUrl}
            fullWidth
            InputProps={{
              readOnly: true,
              sx: { fontSize: '0.9rem' },
            }}
          />
          <IconButton onClick={() => copyToClipboard(shareUrl)} color="primary">
            <ShareIcon />
          </IconButton>
        </Box>
      </Paper>

      {/* Configuration Details */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          {t('configurator.details', 'Детали конфигурации')}
        </Typography>

        <Grid container spacing={2}>
          {/* Boat Color */}
          <Grid item xs={12} sm={6} md={3}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box
                sx={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  backgroundColor: boatColor.displayColor,
                  border: '2px solid #ccc',
                }}
              />
              <Typography>
                {t('configurator.boatColor', 'Цвет корпуса')}: {boatColor.name}
              </Typography>
            </Box>
          </Grid>

          {/* Left Group 1 */}
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="body2" color="textSecondary">
              {t('configurator.leftGroup1', 'Левый вид (группа 1)')}:
            </Typography>
            {config.leftGroup1.sticker ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: STICKER_COLOR_OPTIONS[config.leftGroup1.colorIndex]?.displayColor || '#888',
                    border: '1px solid #ccc',
                  }}
                />
                <Typography>
                  Наклейка {config.leftGroup1.sticker}
                </Typography>
              </Box>
            ) : (
              <Typography color="textSecondary">Не выбрано</Typography>
            )}
          </Grid>

          {/* Left Group 2 */}
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="body2" color="textSecondary">
              {t('configurator.leftGroup2', 'Левый вид (группа 2)')}:
            </Typography>
            {config.leftGroup2.sticker ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: STICKER_COLOR_OPTIONS[config.leftGroup2.colorIndex]?.displayColor || '#888',
                    border: '1px solid #ccc',
                  }}
                />
                <Typography>
                  Наклейка {config.leftGroup2.sticker}
                </Typography>
              </Box>
            ) : (
              <Typography color="textSecondary">Не выбрано</Typography>
            )}
          </Grid>

          {/* Top Sticker */}
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="body2" color="textSecondary">
              {t('configurator.topSticker', 'Вид сверху')}:
            </Typography>
            {config.topSticker.sticker ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: STICKER_COLOR_OPTIONS[config.topSticker.colorIndex]?.displayColor || '#888',
                    border: '1px solid #ccc',
                  }}
                />
                <Typography>
                  Наклейка {config.topSticker.sticker}
                </Typography>
              </Box>
            ) : (
              <Typography color="textSecondary">Не выбрано</Typography>
            )}
          </Grid>

          {/* Back Sticker */}
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="body2" color="textSecondary">
              {t('configurator.backSticker', 'Вид сзади')}:
            </Typography>
            {config.backSticker.sticker ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: STICKER_COLOR_OPTIONS[config.backSticker.colorIndex]?.displayColor || '#888',
                    border: '1px solid #ccc',
                  }}
                />
                <Typography>
                  Наклейка {config.backSticker.sticker}
                </Typography>
              </Box>
            ) : (
              <Typography color="textSecondary">Не выбрано</Typography>
            )}
          </Grid>
        </Grid>
      </Paper>

      {/* Action Buttons */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          startIcon={<EditIcon />}
          onClick={() => navigate('/configurator')}
        >
          {t('configurator.editConfig', 'Изменить конфигурацию')}
        </Button>
        <Button
          variant="contained"
          startIcon={<CopyIcon />}
          onClick={() => copyToClipboard(code || '')}
        >
          {t('configurator.copyCode', 'Копировать код')}
        </Button>
      </Box>

      {/* Copy Success Snackbar */}
      <Snackbar
        open={copySuccess}
        autoHideDuration={2000}
        onClose={() => setCopySuccess(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setCopySuccess(false)}>
          {t('configurator.copied', 'Скопировано!')}
        </Alert>
      </Snackbar>
    </Box>
  )
}
