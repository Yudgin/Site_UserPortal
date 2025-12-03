import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Typography,
  Paper,
  ToggleButton,
  ToggleButtonGroup,
  Grid,
  Card,
  CardActionArea,
  CardMedia,
  Button,
} from '@mui/material'
import {
  Visibility as LeftIcon,
  VerticalAlignTop as TopIcon,
  ArrowBack as BackIcon,
  CheckCircle as FinishIcon,
  Search as SearchIcon,
} from '@mui/icons-material'

export type ViewType = 'left' | 'top' | 'back'

export interface ColorOption {
  name: string
  filter: string
  displayColor: string
}

export interface StickerSelection {
  sticker: number | null
  colorIndex: number
}

// Configuration encoding/decoding
export interface BoatConfiguration {
  boatColorIndex: number
  leftGroup1: StickerSelection
  leftGroup2: StickerSelection
  topSticker: StickerSelection
  backSticker: StickerSelection
}

// Encode configuration to a compact code
export function encodeConfiguration(config: BoatConfiguration): string {
  const parts = [
    config.boatColorIndex.toString(36),
    (config.leftGroup1.sticker || 0).toString(36),
    config.leftGroup1.colorIndex.toString(36),
    (config.leftGroup2.sticker || 0).toString(36),
    config.leftGroup2.colorIndex.toString(36),
    (config.topSticker.sticker || 0).toString(36),
    config.topSticker.colorIndex.toString(36),
    (config.backSticker.sticker || 0).toString(36),
    config.backSticker.colorIndex.toString(36),
  ]
  return parts.join('')
}

// Decode configuration from code
export function decodeConfiguration(code: string): BoatConfiguration | null {
  try {
    // Remove any spaces or dashes
    const cleanCode = code.replace(/[-\s]/g, '')
    if (cleanCode.length !== 9) return null

    const values = cleanCode.split('').map(c => parseInt(c, 36))
    if (values.some(isNaN)) return null

    return {
      boatColorIndex: values[0],
      leftGroup1: { sticker: values[1] || null, colorIndex: values[2] },
      leftGroup2: { sticker: values[3] || null, colorIndex: values[4] },
      topSticker: { sticker: values[5] || null, colorIndex: values[6] },
      backSticker: { sticker: values[7] || null, colorIndex: values[8] },
    }
  } catch {
    return null
  }
}

// Color options for boat (hue-rotate based, works on colored images)
export const BOAT_COLOR_OPTIONS: ColorOption[] = [
  { name: 'orange', filter: 'none', displayColor: '#FF6B00' },
  { name: 'red', filter: 'hue-rotate(-30deg)', displayColor: '#FF0000' },
  { name: 'yellow', filter: 'hue-rotate(30deg)', displayColor: '#FFD700' },
  { name: 'green', filter: 'hue-rotate(90deg)', displayColor: '#00CC00' },
  { name: 'cyan', filter: 'hue-rotate(150deg)', displayColor: '#00CCCC' },
  { name: 'blue', filter: 'hue-rotate(180deg)', displayColor: '#0066FF' },
  { name: 'purple', filter: 'hue-rotate(240deg)', displayColor: '#9900FF' },
  { name: 'pink', filter: 'hue-rotate(300deg)', displayColor: '#FF00CC' },
  { name: 'lightGray', filter: 'saturate(0) brightness(1.4)', displayColor: '#C0C0C0' },
  { name: 'graphite', filter: 'saturate(0) brightness(0.5)', displayColor: '#4A4A4A' },
]

// Color options for stickers (gray/white images with orange accents)
// Using invert + sepia + saturate + hue-rotate for accurate colors
export const STICKER_COLOR_OPTIONS: ColorOption[] = [
  { name: 'original', filter: 'none', displayColor: '#888888' },
  { name: 'red', filter: 'brightness(0.9) sepia(1) hue-rotate(-50deg) saturate(6)', displayColor: '#FF0000' },
  { name: 'orange', filter: 'brightness(1) sepia(1) hue-rotate(-15deg) saturate(4)', displayColor: '#FF6B00' },
  { name: 'yellow', filter: 'brightness(1.1) sepia(1) hue-rotate(10deg) saturate(4)', displayColor: '#FFD700' },
  { name: 'green', filter: 'brightness(0.95) sepia(1) hue-rotate(70deg) saturate(5)', displayColor: '#00CC00' },
  { name: 'cyan', filter: 'brightness(1) sepia(1) hue-rotate(120deg) saturate(5)', displayColor: '#00CCCC' },
  { name: 'blue', filter: 'brightness(0.9) sepia(1) hue-rotate(170deg) saturate(6)', displayColor: '#0066FF' },
  { name: 'purple', filter: 'brightness(0.9) sepia(1) hue-rotate(220deg) saturate(6)', displayColor: '#9900FF' },
  { name: 'pink', filter: 'brightness(1) sepia(1) hue-rotate(280deg) saturate(5)', displayColor: '#FF00CC' },
  { name: 'white', filter: 'brightness(2) saturate(0)', displayColor: '#FFFFFF' },
  { name: 'black', filter: 'brightness(0.15) saturate(0)', displayColor: '#333333' },
]

export interface StickerPosition {
  x: number
  y: number
  width: number
  height: number
  clipPath?: string // SVG path for complex shapes, undefined = use rect
}

export interface StickerGroup {
  viewBox: { width: number; height: number }
  baseViewBox: { width: number; height: number }
  stickers: Record<number, StickerPosition>
}

// LEFT view configuration
export const LEFT_BASE_VIEWBOX = { width: 140.03, height: 78.77 }

export const LEFT_GROUP1: StickerGroup = {
  viewBox: { width: 111.39, height: 62.66 },
  baseViewBox: LEFT_BASE_VIEWBOX,
  stickers: {
    1: {
      x: 57.9, y: 18.19, width: 44.25, height: 19.8,
      clipPath: 'M57.9 18.19l32.23 0 -0.29 0.67c0,0 4.24,-0.13 5.04,-0.03 0.46,0.05 0.38,-0.31 0.23,-0.63l7.04 0 0 19.8 -44.25 0 0 -19.8z',
    },
    2: {
      x: 77.63, y: 18.2, width: 24.53, height: 19.79,
      clipPath: 'M77.63 18.2l14.04 0 -0.36 0.62c0,0 2.57,-0.05 3.2,-0.02 0.52,0.03 0.24,-0.43 0.1,-0.6l7.55 0 0 19.79 -24.53 0 0 -19.79z',
    },
    3: { x: 74.18, y: 24.94, width: 23.96, height: 9.58 },
    4: { x: 63.95, y: 27.46, width: 37.48, height: 5.14 },
    5: { x: 88.29, y: 21.98, width: 13.2, height: 13.03 },
    6: { x: 85.84, y: 21.22, width: 15.02, height: 14.94 },
    7: { x: 71.04, y: 27.58, width: 30.71, height: 4.5 },
    9: { x: 65.94, y: 18.78, width: 35.92, height: 19.16 },
    10: { x: 71.7, y: 28.06, width: 29.1, height: 2.56 },
    11: { x: 71.7, y: 21.54, width: 29.1, height: 12.76 },
  },
}

export const LEFT_GROUP2: StickerGroup = {
  viewBox: { width: 114.26, height: 64.27 },
  baseViewBox: LEFT_BASE_VIEWBOX,
  stickers: {
    1: {
      x: 30.88, y: 20.7, width: 28.44, height: 19.31,
      clipPath: 'M30.88 20.7l28.44 0 0 18.09c-3.5,0 -11.99,-0.04 -11.99,-0.04l0.45 1.26 -16.9 0 0 -17.22 5.2 4.18c0,0 8.91,-0.65 9.92,-0.78 1.01,-0.13 1.09,-4.96 1.09,-4.96l-16.2 -0.2 0 -0.33z',
    },
    2: {
      x: 35.23, y: 9.69, width: 30.89, height: 39.53,
      clipPath: 'M64.34 9.69l1.78 0 0 34.02c-4.62,-2.5 -9.39,-4.91 -10.62,-4.92 -2.55,-0.01 -15.04,-0.09 -15.04,-0.09l1.06 10.53 -6.29 0 0 -24.89 3.85 2.44c0,0 5.86,-0.48 6.42,-0.54 0.56,-0.06 2.37,-0.34 2.37,-0.34 0,0 -0.23,0.26 -0.15,0.36 0.07,0.1 0.58,0.2 1.36,0.03 0.78,-0.16 11.67,-8.97 11.67,-8.97l3.57 -7.62z',
    },
    3: {
      x: 30.88, y: 20.7, width: 32.22, height: 19.31,
      clipPath: 'M49.17 20.7l13.94 0 0 18.14c-6.1,-0.04 -18.23,-0.11 -18.23,-0.11l1.02 1.28 -15.02 0 0 -16.17 2.69 3.32 2.85 -0.21c0,0 8.36,-0.62 9.31,-0.73 0.95,-0.1 2.16,-0.32 2.16,-0.32 0,0 -0.28,0.23 -0.23,0.34 0.05,0.12 0.77,0.23 1.84,-0.08 0.88,-0.25 0,-4.13 -0.33,-5.48z',
    },
    4: {
      x: 24.96, y: 14.57, width: 32.22, height: 38.62,
      clipPath: 'M55.41 14.57l1.77 0 0 27.76c-1.72,-2.18 -3.11,-3.59 -3.85,-3.58 -3.32,0.01 -14.97,-0.08 -14.97,-0.08l-13.4 7.25 0 -19.52 12.07 0.49c0,0 7.28,-0.55 8.17,-0.65 0.9,-0.1 2.79,-0.36 2.79,-0.36 0,0 -0.35,0.23 -0.26,0.31 0.08,0.08 0.25,0.39 1.89,-0.03 1.22,-0.31 4.3,-7.79 5.79,-11.59z',
    },
    5: { x: 34.77, y: 31.3, width: 19.62, height: 3.17 },
    6: {
      x: 32.48, y: 22.72, width: 28.44, height: 19.31,
      clipPath: 'M45.79 22.72l15.13 0 0 16.45c-0.55,-0.25 -1.15,-0.39 -1.79,-0.38 -3.51,0.05 -15.22,-0.09 -15.22,-0.09l0.88 3.34 -12.32 0 0 -16.44 3.44 1.39c0,0 4.93,-0.38 6.66,-0.49 1.74,-0.12 2.92,-0.26 3.43,-0.3 0.25,-0.02 0.05,-1.73 -0.23,-3.46z',
    },
    7: { x: 30.34, y: 32.11, width: 24.97, height: 2.18 },
    8: {
      x: 30.34, y: 20.85, width: 28.98, height: 19.31,
      clipPath: 'M47.48 20.85l11.85 0 0 17.93c-4.68,-0.03 -14.7,-0.07 -14.7,-0.07l-0.57 1.45 -13.72 0 0 -15.8 1.99 1.24 3.92 1.36c0,0 9.22,-0.69 9.67,-0.77 0.27,-0.04 1.01,-3.01 1.55,-5.35z',
    },
    9: {
      x: 29.57, y: 19.17, width: 32.81, height: 25.48,
      clipPath: 'M46.34 19.17l16.04 0 0 20.64c-0.66,-0.61 -1.41,-1.02 -2.24,-1.01 -3.29,0.05 -20.92,-0.15 -20.92,-0.15l2.49 5.36c0,0 0.6,0.25 1.52,0.63l-13.67 0 0 -19.16 6.57 1.48c0,0 7.07,-0.5 8.31,-0.63 0.76,-0.08 1.45,-4.05 1.89,-7.17z',
    },
  },
}

// TOP view configuration with clipPath for complex shapes
export const TOP_CONFIG: StickerGroup = {
  viewBox: { width: 131.21, height: 73.81 },
  baseViewBox: { width: 117.64, height: 66.17 },
  stickers: {
    1: { x: 42.78, y: 30.23, width: 12.93, height: 13.1 },
    2: { x: 43.66, y: 25.71, width: 21.86, height: 22.14 },
    3: { x: 50.7, y: 30.49, width: 11.41, height: 11.48 },
    4: { x: 55.06, y: 24.41, width: 3.71, height: 25.35 },
    5: { x: 40.93, y: 30.43, width: 5.34, height: 13.34 },
    6: { x: 52.19, y: 25.18, width: 9.54, height: 23.84 },
    7: { x: 52.19, y: 25.18, width: 12.4, height: 23.84 },
    9: { x: 57.87, y: 24.6, width: 2.13, height: 24.36 },
    10: { x: 57.87, y: 24.6, width: 5.27, height: 24.36 },
    11: { x: 57.87, y: 24.6, width: 10.29, height: 24.36 },
    12: { x: 57.87, y: 24.6, width: 10.29, height: 24.36 },
    13: {
      x: 39.45, y: 17.4, width: 33.23, height: 38.73,
      clipPath: 'M39.45 17.4l0.18 0c2.09,3.16 6.44,5.74 6.44,5.74 0,0 1.02,-0.22 10.29,-0.64 3.94,-0.18 6.51,-2.49 8.15,-5.1l8.17 0 0 38.73 -12.54 0 -3.63 -4.93c0,0 -1.98,-0.08 -5.86,-0.3 -3.88,-0.22 -5.67,-0.48 -5.67,-0.48l-2.42 5.71 -3.11 0 0 -38.73z',
    },
    14: {
      x: 39.45, y: 17.4, width: 20.46, height: 38.73,
      clipPath: 'M39.45 17.4l3.15 0 3.08 5.77c0,0 3.43,-0.4 10.91,-0.68 1.3,-0.05 2.4,-0.33 3.31,-0.75l0 29.63c-0.77,-0.12 -1.68,-0.2 -2.74,-0.24 -9.96,-0.31 -12.36,-0.79 -12.36,-0.79l0.17 5.79 -5.52 0 0 -38.73z',
    },
    15: { x: 39.05, y: 22.44, width: 33.63, height: 28.8 },
    16: {
      x: 39.05, y: 18.21, width: 23.62, height: 37.16,
      clipPath: 'M39.05 18.21l4.97 0 1.17 5.06c0,0 1.05,-0.38 14.09,-0.89 1.34,-0.05 2.46,-0.17 3.39,-0.34l0 29.51c-0.67,-0.08 -1.4,-0.14 -2.21,-0.17 -12.17,-0.41 -15.83,-1.01 -15.83,-1.01l1.21 4.98 -6.79 0 0 -37.16z',
    },
  },
}

// BACK view configuration
export const BACK_CONFIG: StickerGroup = {
  viewBox: { width: 129.33, height: 72.75 },
  baseViewBox: { width: 122.55, height: 68.94 },
  stickers: {
    1: { x: 45.48, y: 27.49, width: 38.26, height: 12.02 },
    2: { x: 41.94, y: 28.68, width: 46.09, height: 3.58 },
    3: { x: 48.06, y: 28.22, width: 33.89, height: 4.03 },
    4: { x: 56.3, y: 26.62, width: 16.72, height: 14.58 },
    5: { x: 56.68, y: 27.26, width: 14.08, height: 12.98 },
    6: { x: 43.68, y: 28.37, width: 42.34, height: 6.67 },
  },
}

// Sticker numbers per view
export const VIEW_STICKERS = {
  left: {
    group1: [1, 2, 3, 4, 5, 6, 7, 9, 10, 11],
    group2: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  },
  top: {
    stickers: [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16],
  },
  back: {
    stickers: [1, 2, 3, 4, 5, 6],
  },
}

export default function BoatConfiguratorPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [view, setView] = useState<ViewType>('left')
  const [boatColorIndex, setBoatColorIndex] = useState(0)

  // For left view: two groups of stickers
  const [leftGroup1, setLeftGroup1] = useState<StickerSelection>({ sticker: null, colorIndex: 0 })
  const [leftGroup2, setLeftGroup2] = useState<StickerSelection>({ sticker: null, colorIndex: 0 })

  // For top/back views: single sticker selection
  const [topSticker, setTopSticker] = useState<StickerSelection>({ sticker: null, colorIndex: 0 })
  const [backSticker, setBackSticker] = useState<StickerSelection>({ sticker: null, colorIndex: 0 })

  const handleViewChange = (_: React.MouseEvent<HTMLElement>, newView: ViewType | null) => {
    if (newView) {
      setView(newView)
    }
  }

  const selectSticker = (group: 'group1' | 'group2' | 'single', stickerNum: number) => {
    if (view === 'left') {
      if (group === 'group1') {
        setLeftGroup1(prev => ({
          sticker: prev.sticker === stickerNum ? null : stickerNum,
          colorIndex: prev.colorIndex,
        }))
      } else {
        setLeftGroup2(prev => ({
          sticker: prev.sticker === stickerNum ? null : stickerNum,
          colorIndex: prev.colorIndex,
        }))
      }
    } else if (view === 'top') {
      setTopSticker(prev => ({
        sticker: prev.sticker === stickerNum ? null : stickerNum,
        colorIndex: prev.colorIndex,
      }))
    } else {
      setBackSticker(prev => ({
        sticker: prev.sticker === stickerNum ? null : stickerNum,
        colorIndex: prev.colorIndex,
      }))
    }
  }

  const changeStickerColor = (group: 'group1' | 'group2' | 'single', colorIndex: number) => {
    if (view === 'left') {
      if (group === 'group1') {
        setLeftGroup1(prev => ({ ...prev, colorIndex }))
      } else {
        setLeftGroup2(prev => ({ ...prev, colorIndex }))
      }
    } else if (view === 'top') {
      setTopSticker(prev => ({ ...prev, colorIndex }))
    } else {
      setBackSticker(prev => ({ ...prev, colorIndex }))
    }
  }

  const boatColor = BOAT_COLOR_OPTIONS[boatColorIndex]

  // Handle finish configuration
  const handleFinish = () => {
    const config: BoatConfiguration = {
      boatColorIndex,
      leftGroup1,
      leftGroup2,
      topSticker,
      backSticker,
    }
    const code = encodeConfiguration(config)
    navigate(`/configurator/result/${code}`)
  }

  // Get sticker image path
  const getStickerPath = (viewType: ViewType, group: string | null, num: number) => {
    if (viewType === 'left' && group) {
      return `/boat/left/${group}/sticker-${num}.png`
    }
    return `/boat/${viewType}/sticker-${num}.png`
  }

  // Render sticker preview with clipPath - zoomed to sticker area
  const renderStickerPreview = (
    num: number,
    config: StickerGroup,
    src: string,
    filter: string,
    group: string
  ) => {
    const pos = config.stickers[num]
    if (!pos) return null

    // Use unique clipId with group to avoid conflicts
    const clipId = `preview-clip-${group}-${num}`

    // Add padding around sticker for better view
    const padding = 1
    const vbX = pos.x - padding
    const vbY = pos.y - padding
    const vbW = pos.width + padding * 2
    const vbH = pos.height + padding * 2

    return (
      <svg
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        style={{
          width: '100%',
          height: '100%',
          filter: filter,
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

  // Get config for current view and group
  const getConfig = (group: 'group1' | 'group2' | 'single'): StickerGroup => {
    if (view === 'left') {
      return group === 'group1' ? LEFT_GROUP1 : LEFT_GROUP2
    } else if (view === 'top') {
      return TOP_CONFIG
    } else {
      return BACK_CONFIG
    }
  }

  // Render sticker selection grid
  const renderStickerGrid = (
    stickers: number[],
    group: 'group1' | 'group2' | 'single',
    selection: StickerSelection,
    title?: string
  ) => {
    const config = getConfig(group)

    return (
      <Box sx={{ mb: 3 }}>
        {title && (
          <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold' }}>
            {title}
          </Typography>
        )}
        <Grid container spacing={2}>
          {stickers.map((num) => {
            const isSelected = selection.sticker === num
            const stickerColor = STICKER_COLOR_OPTIONS[selection.colorIndex]
            const hasConfig = config.stickers[num]

            return (
              <Grid item xs={4} sm={3} md={2} key={num}>
                <Card
                  sx={{
                    border: isSelected ? '3px solid #2196F3' : '3px solid transparent',
                    borderRadius: 2,
                    transition: 'border-color 0.2s',
                  }}
                >
                  <CardActionArea onClick={() => selectSticker(group, num)}>
                    <Box
                      sx={{
                        height: 70,
                        backgroundColor: boatColor.displayColor,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        p: 0.5,
                        overflow: 'hidden',
                      }}
                    >
                      {hasConfig ? (
                        renderStickerPreview(
                          num,
                          config,
                          getStickerPath(view, view === 'left' ? group : null, num),
                          isSelected ? stickerColor.filter : 'none',
                          group
                        )
                      ) : (
                        <CardMedia
                          component="img"
                          image={getStickerPath(view, view === 'left' ? group : null, num)}
                          alt={`Sticker ${num}`}
                          sx={{
                            height: '100%',
                            width: '100%',
                            objectFit: 'contain',
                            filter: isSelected ? stickerColor.filter : 'none',
                          }}
                        />
                      )}
                    </Box>
                    <Box
                      sx={{
                        textAlign: 'center',
                        py: 0.5,
                        backgroundColor: isSelected ? '#2196F3' : '#eee',
                        color: isSelected ? '#fff' : '#333',
                        fontWeight: isSelected ? 'bold' : 'normal',
                        fontSize: '0.875rem',
                      }}
                    >
                      {num}
                    </Box>
                  </CardActionArea>
                </Card>
              </Grid>
            )
          })}
        </Grid>

        {/* Color picker for this group */}
        <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ color: '#666' }}>
            {t('configurator.selectColor')}:
          </Typography>
          {STICKER_COLOR_OPTIONS.map((color, idx) => (
            <Box
              key={color.name}
              onClick={() => changeStickerColor(group, idx)}
              sx={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                backgroundColor: color.displayColor,
                cursor: 'pointer',
                border: selection.colorIndex === idx ? '2px solid #333' : '2px solid transparent',
                transition: 'all 0.2s',
                '&:hover': { transform: 'scale(1.15)' },
              }}
            />
          ))}
        </Box>
      </Box>
    )
  }

  // Render sticker using SVG with clipPath
  const renderStickerWithClipPath = (
    stickerNum: number,
    src: string,
    pos: StickerPosition,
    config: StickerGroup,
    filter: string,
    groupPrefix?: string
  ) => {
    const { viewBox } = config
    const clipId = `clip-sticker-${groupPrefix ? groupPrefix + '-' : ''}${stickerNum}`

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
          filter: filter,
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

  return (
    <Box sx={{ p: 2, maxWidth: 1200, mx: 'auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h5">
          {t('configurator.title')}
        </Typography>
        <Button
          variant="outlined"
          size="small"
          startIcon={<SearchIcon />}
          onClick={() => navigate('/configurator/lookup')}
        >
          {t('configurator.haveCode', 'Есть код?')}
        </Button>
      </Box>

      {/* View Selector */}
      <Box sx={{ mb: 2, display: 'flex', justifyContent: 'center' }}>
        <ToggleButtonGroup
          value={view}
          exclusive
          onChange={handleViewChange}
          aria-label="boat view"
        >
          <ToggleButton value="left" aria-label="left view">
            <LeftIcon sx={{ mr: 1 }} />
            {t('configurator.viewLeft')}
          </ToggleButton>
          <ToggleButton value="top" aria-label="top view">
            <TopIcon sx={{ mr: 1 }} />
            {t('configurator.viewTop')}
          </ToggleButton>
          <ToggleButton value="back" aria-label="back view">
            <BackIcon sx={{ mr: 1 }} />
            {t('configurator.viewBack')}
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Boat Color Selector */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="subtitle2" gutterBottom sx={{ textAlign: 'center' }}>
          {t('configurator.selectColor')} ({t('configurator.title').toLowerCase()})
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1, flexWrap: 'wrap' }}>
          {BOAT_COLOR_OPTIONS.map((color, idx) => (
            <Box
              key={color.name}
              onClick={() => setBoatColorIndex(idx)}
              sx={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                backgroundColor: color.displayColor,
                cursor: 'pointer',
                border: boatColorIndex === idx ? '3px solid #333' : '3px solid transparent',
                boxShadow: boatColorIndex === idx ? '0 0 0 2px #fff, 0 0 0 4px #333' : 'none',
                transition: 'all 0.2s',
                '&:hover': { transform: 'scale(1.1)' },
              }}
            />
          ))}
        </Box>
      </Box>

      {/* Boat Preview */}
      <Paper
        sx={{
          mb: 3,
          p: 2,
          display: 'flex',
          justifyContent: 'center',
          backgroundColor: '#f5f5f5',
        }}
      >
        <Box
          sx={{
            position: 'relative',
            width: '100%',
            maxWidth: 700,
          }}
        >
          {/* Base boat image */}
          <img
            src={`/boat/${view}/base.png`}
            alt="Boat base"
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              filter: boatColor.filter,
            }}
          />

          {/* Stickers overlay for left view - using SVG with clipPath */}
          {view === 'left' && (
            <>
              {leftGroup1.sticker && LEFT_GROUP1.stickers[leftGroup1.sticker] &&
                renderStickerWithClipPath(
                  leftGroup1.sticker,
                  `/boat/left/group1/sticker-${leftGroup1.sticker}.png`,
                  LEFT_GROUP1.stickers[leftGroup1.sticker],
                  LEFT_GROUP1,
                  STICKER_COLOR_OPTIONS[leftGroup1.colorIndex].filter,
                  'g1'
                )
              }
              {leftGroup2.sticker && LEFT_GROUP2.stickers[leftGroup2.sticker] &&
                renderStickerWithClipPath(
                  leftGroup2.sticker,
                  `/boat/left/group2/sticker-${leftGroup2.sticker}.png`,
                  LEFT_GROUP2.stickers[leftGroup2.sticker],
                  LEFT_GROUP2,
                  STICKER_COLOR_OPTIONS[leftGroup2.colorIndex].filter,
                  'g2'
                )
              }
            </>
          )}

          {/* Sticker overlay for top view - using SVG with clipPath */}
          {view === 'top' && topSticker.sticker && TOP_CONFIG.stickers[topSticker.sticker] &&
            renderStickerWithClipPath(
              topSticker.sticker,
              `/boat/top/sticker-${topSticker.sticker}.png`,
              TOP_CONFIG.stickers[topSticker.sticker],
              TOP_CONFIG,
              STICKER_COLOR_OPTIONS[topSticker.colorIndex].filter
            )
          }

          {/* Sticker overlay for back view - using SVG with clipPath */}
          {view === 'back' && backSticker.sticker && BACK_CONFIG.stickers[backSticker.sticker] &&
            renderStickerWithClipPath(
              backSticker.sticker,
              `/boat/back/sticker-${backSticker.sticker}.png`,
              BACK_CONFIG.stickers[backSticker.sticker],
              BACK_CONFIG,
              STICKER_COLOR_OPTIONS[backSticker.colorIndex].filter
            )
          }
        </Box>
      </Paper>

      {/* Sticker Selection */}
      <Typography variant="h6" gutterBottom>
        {t('configurator.selectStickers')}
      </Typography>

      {view === 'left' && (
        <>
          {renderStickerGrid(VIEW_STICKERS.left.group1, 'group1', leftGroup1, 'Группа 1')}
          {renderStickerGrid(VIEW_STICKERS.left.group2, 'group2', leftGroup2, 'Группа 2')}
        </>
      )}

      {view === 'top' && renderStickerGrid(VIEW_STICKERS.top.stickers, 'single', topSticker)}

      {view === 'back' && renderStickerGrid(VIEW_STICKERS.back.stickers, 'single', backSticker)}

      {/* Finish Button */}
      <Box sx={{ mt: 4, display: 'flex', justifyContent: 'center' }}>
        <Button
          variant="contained"
          color="success"
          size="large"
          startIcon={<FinishIcon />}
          onClick={handleFinish}
          sx={{ px: 6, py: 1.5 }}
        >
          {t('configurator.finish', 'Завершить')}
        </Button>
      </Box>
    </Box>
  )
}
