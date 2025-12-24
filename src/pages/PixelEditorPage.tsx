import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Container,
  Paper,
  Box,
  Typography,
  Button,
  ButtonGroup,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Alert,
  CircularProgress,
  Snackbar,
} from '@mui/material'
import {
  Home as HomeIcon,
  Edit as PenIcon,
  Delete as EraserIcon,
  ClearAll as ClearIcon,
  InvertColors as InvertIcon,
  Download as DownloadIcon,
  Upload as UploadIcon,
  Undo as UndoIcon,
  Redo as RedoIcon,
  GridOn as GridIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
  Share as ShareIcon,
  ContentCopy as CopyIcon,
  Check as CheckIcon,
  Preview as PreviewIcon,
} from '@mui/icons-material'
import LanguageSelector from '@/components/common/LanguageSelector'
import { pixelDesignService, decodePixels } from '@/api/pixelDesignService'
import { useAuthStore } from '@/store/authStore'

const CANVAS_WIDTH = 128
const CANVAS_HEIGHT = 64
const DEFAULT_PIXEL_SIZE = 8
const MIN_PIXEL_SIZE = 4
const MAX_PIXEL_SIZE = 16

type Tool = 'pen' | 'eraser'

// Create empty pixel data (false = white, true = black)
const createEmptyPixels = (): boolean[][] => {
  return Array(CANVAS_HEIGHT).fill(null).map(() => Array(CANVAS_WIDTH).fill(false))
}

interface PixelEditorPageProps {
  isAdmin?: boolean
}

export default function PixelEditorPage({ isAdmin = false }: PixelEditorPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { designId } = useParams<{ designId?: string }>()
  const { user } = useAuthStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Pixel data (true = black, false = white)
  const [pixels, setPixels] = useState<boolean[][]>(createEmptyPixels)

  // History for undo/redo
  const [history, setHistory] = useState<boolean[][][]>([createEmptyPixels()])
  const [historyIndex, setHistoryIndex] = useState(0)

  // Tools and settings
  const [tool, setTool] = useState<Tool>('pen')
  const [brushSize, setBrushSize] = useState<1 | 2 | 4>(1)
  const [pixelSize, setPixelSize] = useState(DEFAULT_PIXEL_SIZE)
  const [showGrid, setShowGrid] = useState(true)
  const [isDrawing, setIsDrawing] = useState(false)

  // Import dialog
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Share/save state
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [designName, setDesignName] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedDesignId, setSavedDesignId] = useState<string | null>(null)
  const [shareLink, setShareLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isViewMode, setIsViewMode] = useState(false)
  const [designOwner, setDesignOwner] = useState<string | null>(null)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  })
  const [showPreview, setShowPreview] = useState(true)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)

  // Load design from URL if designId is present
  useEffect(() => {
    if (designId) {
      loadDesignFromUrl(designId)
    }
  }, [designId])

  const loadDesignFromUrl = async (id: string) => {
    setLoading(true)
    setLoadError(null)

    const design = await pixelDesignService.loadDesign(id)

    if (design) {
      const loadedPixels = decodePixels(design.pixels, design.width, design.height)
      setPixels(loadedPixels)
      setHistory([loadedPixels.map(row => [...row])])
      setHistoryIndex(0)
      setDesignName(design.name)
      setSavedDesignId(design.id)
      setDesignOwner(design.userEmail || design.userId)

      // Set view mode if not owner
      if (!user || design.userId !== user.id) {
        setIsViewMode(true)
      }
    } else {
      setLoadError(t('pixelEditor.designNotFound', 'Design not found'))
    }

    setLoading(false)
  }

  // Draw canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = CANVAS_WIDTH * pixelSize
    const height = CANVAS_HEIGHT * pixelSize

    canvas.width = width
    canvas.height = height

    // Clear canvas (white background)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    // Draw pixels
    ctx.fillStyle = '#000000'
    for (let y = 0; y < CANVAS_HEIGHT; y++) {
      for (let x = 0; x < CANVAS_WIDTH; x++) {
        if (pixels[y][x]) {
          ctx.fillRect(x * pixelSize, y * pixelSize, pixelSize, pixelSize)
        }
      }
    }

    // Draw grid
    if (showGrid && pixelSize >= 4) {
      ctx.strokeStyle = '#e0e0e0'
      ctx.lineWidth = 0.5

      // Vertical lines
      for (let x = 0; x <= CANVAS_WIDTH; x++) {
        ctx.beginPath()
        ctx.moveTo(x * pixelSize, 0)
        ctx.lineTo(x * pixelSize, height)
        ctx.stroke()
      }

      // Horizontal lines
      for (let y = 0; y <= CANVAS_HEIGHT; y++) {
        ctx.beginPath()
        ctx.moveTo(0, y * pixelSize)
        ctx.lineTo(width, y * pixelSize)
        ctx.stroke()
      }
    }
  }, [pixels, pixelSize, showGrid])

  useEffect(() => {
    drawCanvas()
  }, [drawCanvas])

  // Draw preview on pult
  const drawPreview = useCallback(() => {
    const canvas = previewCanvasRef.current
    if (!canvas || !showPreview) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Screen position on pult (detected from image analysis)
    // These values position the design on the LCD screen area
    const screenLeft = 0.302
    const screenTop = 0.659
    const screenWidth = 0.404
    const screenHeight = 0.149

    const pultImg = new Image()
    pultImg.onload = () => {
      // Set canvas size to match pult image (scaled down for display)
      const scale = 0.6
      canvas.width = pultImg.width * scale
      canvas.height = pultImg.height * scale

      // Draw pult
      ctx.drawImage(pultImg, 0, 0, canvas.width, canvas.height)

      // Calculate screen position
      const sx = canvas.width * screenLeft
      const sy = canvas.height * screenTop
      const sw = canvas.width * screenWidth
      const sh = canvas.height * screenHeight

      // Draw LCD background (green tint)
      ctx.fillStyle = '#a8d8a8'
      ctx.fillRect(sx, sy, sw, sh)

      // Draw pixels on screen
      const pixelW = sw / CANVAS_WIDTH
      const pixelH = sh / CANVAS_HEIGHT

      ctx.fillStyle = '#1a3a1a' // Dark green for pixels
      for (let y = 0; y < CANVAS_HEIGHT; y++) {
        for (let x = 0; x < CANVAS_WIDTH; x++) {
          if (pixels[y][x]) {
            ctx.fillRect(
              sx + x * pixelW,
              sy + y * pixelH,
              pixelW,
              pixelH
            )
          }
        }
      }
    }
    pultImg.src = '/pult-preview.png'
  }, [pixels, showPreview])

  useEffect(() => {
    drawPreview()
  }, [drawPreview])

  // Get pixel coordinates from mouse event
  const getPixelCoords = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null

    const rect = canvas.getBoundingClientRect()
    const x = Math.floor((e.clientX - rect.left) / pixelSize)
    const y = Math.floor((e.clientY - rect.top) / pixelSize)

    if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT) {
      return { x, y }
    }
    return null
  }

  // Save state to history
  const saveToHistory = (newPixels: boolean[][]) => {
    const newHistory = history.slice(0, historyIndex + 1)
    newHistory.push(newPixels.map(row => [...row]))
    setHistory(newHistory)
    setHistoryIndex(newHistory.length - 1)
  }

  // Set pixel (with brush size support)
  const setPixel = (x: number, y: number, value: boolean) => {
    setPixels(prev => {
      const newPixels = prev.map(row => [...row])
      // Draw a block of pixels based on brush size
      for (let dy = 0; dy < brushSize; dy++) {
        for (let dx = 0; dx < brushSize; dx++) {
          const px = x + dx
          const py = y + dy
          if (px >= 0 && px < CANVAS_WIDTH && py >= 0 && py < CANVAS_HEIGHT) {
            newPixels[py][px] = value
          }
        }
      }
      return newPixels
    })
  }

  // Handle mouse events
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getPixelCoords(e)
    if (!coords) return

    setIsDrawing(true)
    const value = tool === 'pen'
    setPixel(coords.x, coords.y, value)
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return

    const coords = getPixelCoords(e)
    if (!coords) return

    const value = tool === 'pen'
    setPixel(coords.x, coords.y, value)
  }

  const handleMouseUp = () => {
    if (isDrawing) {
      setIsDrawing(false)
      saveToHistory(pixels)
    }
  }

  const handleMouseLeave = () => {
    if (isDrawing) {
      setIsDrawing(false)
      saveToHistory(pixels)
    }
  }

  // Undo
  const handleUndo = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      setPixels(history[newIndex].map(row => [...row]))
    }
  }

  // Redo
  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1
      setHistoryIndex(newIndex)
      setPixels(history[newIndex].map(row => [...row]))
    }
  }

  // Clear canvas
  const handleClear = () => {
    const newPixels = createEmptyPixels()
    setPixels(newPixels)
    saveToHistory(newPixels)
  }

  // Invert colors
  const handleInvert = () => {
    const newPixels = pixels.map(row => row.map(pixel => !pixel))
    setPixels(newPixels)
    saveToHistory(newPixels)
  }

  // Export to LBM format (1bit)
  const exportToLBM = (): string => {
    const lines: string[] = []

    // Header: width, height (for lcdwidth <= 255)
    lines.push(`${CANVAS_WIDTH},${CANVAS_HEIGHT},`)

    // Convert pixels to bytes
    // Group by 8 rows vertically, each column = 1 byte
    for (let y = 0; y < CANVAS_HEIGHT; y += 8) {
      const rowBytes: string[] = []
      for (let x = 0; x < CANVAS_WIDTH; x++) {
        let value = 0
        for (let z = 0; z < 8; z++) {
          if (y + z < CANVAS_HEIGHT) {
            // Black pixel (true) = bit set to 1
            if (pixels[y + z][x]) {
              value += 1 << z
            }
          }
        }
        rowBytes.push(`0x${value.toString(16).padStart(2, '0')},`)
      }
      lines.push(rowBytes.join(''))
    }

    return lines.join('\n')
  }

  // Download LBM file
  const handleDownload = () => {
    const lbmContent = exportToLBM()
    const blob = new Blob([lbmContent], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'image.lbm'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Import image
  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const img = new Image()
    img.onload = () => {
      // Create a temporary canvas to read pixel data
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = CANVAS_WIDTH
      tempCanvas.height = CANVAS_HEIGHT
      const ctx = tempCanvas.getContext('2d')
      if (!ctx) return

      // Draw image scaled to canvas size
      ctx.drawImage(img, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

      // Get pixel data
      const imageData = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
      const data = imageData.data

      // Convert to monochrome
      const newPixels = createEmptyPixels()
      for (let y = 0; y < CANVAS_HEIGHT; y++) {
        for (let x = 0; x < CANVAS_WIDTH; x++) {
          const i = (y * CANVAS_WIDTH + x) * 4
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          // Convert to grayscale and threshold
          const gray = (r + g + b) / 3
          newPixels[y][x] = gray < 128 // Black if dark
        }
      }

      setPixels(newPixels)
      saveToHistory(newPixels)
      setImportDialogOpen(false)
    }

    img.src = URL.createObjectURL(file)
    e.target.value = '' // Reset input
  }

  // Export as PNG
  const handleExportPNG = () => {
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = CANVAS_WIDTH
    tempCanvas.height = CANVAS_HEIGHT
    const ctx = tempCanvas.getContext('2d')
    if (!ctx) return

    // White background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

    // Draw black pixels
    ctx.fillStyle = '#000000'
    for (let y = 0; y < CANVAS_HEIGHT; y++) {
      for (let x = 0; x < CANVAS_WIDTH; x++) {
        if (pixels[y][x]) {
          ctx.fillRect(x, y, 1, 1)
        }
      }
    }

    // Download
    const url = tempCanvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = 'image.png'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // Save design and get share link
  const handleSaveDesign = async () => {
    setSaving(true)

    const result = await pixelDesignService.saveDesign(pixels, designName || undefined)

    if (result) {
      setSavedDesignId(result.id)
      const link = `${window.location.origin}/pixel-editor/${result.id}`
      setShareLink(link)
      setSnackbar({
        open: true,
        message: t('pixelEditor.designSaved', 'Design saved successfully'),
        severity: 'success',
      })
    } else {
      setSnackbar({
        open: true,
        message: t('pixelEditor.saveFailed', 'Failed to save design'),
        severity: 'error',
      })
    }

    setSaving(false)
  }

  // Copy link to clipboard
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  // Open share dialog
  const handleOpenShareDialog = () => {
    if (savedDesignId) {
      setShareLink(`${window.location.origin}/pixel-editor/${savedDesignId}`)
    }
    setShareDialogOpen(true)
  }

  // Create new design (reset)
  const handleNewDesign = () => {
    const newPixels = createEmptyPixels()
    setPixels(newPixels)
    setHistory([newPixels])
    setHistoryIndex(0)
    setSavedDesignId(null)
    setDesignName('')
    setShareLink('')
    setIsViewMode(false)
    setDesignOwner(null)
    navigate('/pixel-editor')
  }

  // Loading state
  if (loading) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }

  // Error state
  if (loadError) {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <img src="/logo.svg" alt="Logo" style={{ height: 80 }} />
            <Button variant="outlined" startIcon={<HomeIcon />} onClick={() => navigate('/')}>
              {t('common.home')}
            </Button>
          </Box>
          <LanguageSelector />
        </Box>
        <Container maxWidth="sm" sx={{ py: 4 }}>
          <Alert severity="error" sx={{ mb: 2 }}>{loadError}</Alert>
          <Button variant="contained" onClick={handleNewDesign}>
            {t('pixelEditor.createNew', 'Create new design')}
          </Button>
        </Container>
      </Box>
    )
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <img src="/logo.svg" alt="Logo" style={{ height: 80 }} />
          <Button variant="outlined" startIcon={<HomeIcon />} onClick={() => navigate('/')}>
            {t('common.home')}
          </Button>
        </Box>
        <LanguageSelector />
      </Box>

      <Container maxWidth="lg" sx={{ pb: 4 }}>
        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" gutterBottom>
            {t('pixelEditor.title', 'Pixel Editor')}
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            {t('pixelEditor.description', '128×64 monochrome image editor')}
          </Typography>

          {/* Toolbar */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2, alignItems: 'center' }}>
            {/* Drawing tools */}
            <ToggleButtonGroup
              value={tool}
              exclusive
              onChange={(_, value) => value && setTool(value)}
              size="small"
            >
              <ToggleButton value="pen">
                <Tooltip title={t('pixelEditor.pen', 'Pen')}>
                  <PenIcon />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="eraser">
                <Tooltip title={t('pixelEditor.eraser', 'Eraser')}>
                  <EraserIcon />
                </Tooltip>
              </ToggleButton>
            </ToggleButtonGroup>

            {/* Brush size */}
            <ToggleButtonGroup
              value={brushSize}
              exclusive
              onChange={(_, value) => value && setBrushSize(value)}
              size="small"
            >
              <ToggleButton value={1}>
                <Tooltip title={t('pixelEditor.brushSize1', '1×1')}>
                  <Box sx={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Box sx={{ width: 4, height: 4, bgcolor: 'currentColor' }} />
                  </Box>
                </Tooltip>
              </ToggleButton>
              <ToggleButton value={2}>
                <Tooltip title={t('pixelEditor.brushSize2', '2×2')}>
                  <Box sx={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Box sx={{ width: 8, height: 8, bgcolor: 'currentColor' }} />
                  </Box>
                </Tooltip>
              </ToggleButton>
              <ToggleButton value={4}>
                <Tooltip title={t('pixelEditor.brushSize4', '4×4')}>
                  <Box sx={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Box sx={{ width: 14, height: 14, bgcolor: 'currentColor' }} />
                  </Box>
                </Tooltip>
              </ToggleButton>
            </ToggleButtonGroup>

            {/* Undo/Redo */}
            <ButtonGroup size="small">
              <Tooltip title={t('pixelEditor.undo', 'Undo')}>
                <span>
                  <IconButton onClick={handleUndo} disabled={historyIndex === 0}>
                    <UndoIcon />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={t('pixelEditor.redo', 'Redo')}>
                <span>
                  <IconButton onClick={handleRedo} disabled={historyIndex === history.length - 1}>
                    <RedoIcon />
                  </IconButton>
                </span>
              </Tooltip>
            </ButtonGroup>

            {/* Clear and Invert */}
            <ButtonGroup size="small" variant="outlined">
              <Tooltip title={t('pixelEditor.clear', 'Clear')}>
                <Button onClick={handleClear}>
                  <ClearIcon />
                </Button>
              </Tooltip>
              <Tooltip title={t('pixelEditor.invert', 'Invert')}>
                <Button onClick={handleInvert}>
                  <InvertIcon />
                </Button>
              </Tooltip>
            </ButtonGroup>

            {/* Grid toggle */}
            <Tooltip title={t('pixelEditor.grid', 'Toggle grid')}>
              <ToggleButton
                value="grid"
                selected={showGrid}
                onChange={() => setShowGrid(!showGrid)}
                size="small"
              >
                <GridIcon />
              </ToggleButton>
            </Tooltip>

            {/* Preview toggle */}
            <Tooltip title={t('pixelEditor.preview', 'Preview on remote')}>
              <ToggleButton
                value="preview"
                selected={showPreview}
                onChange={() => setShowPreview(!showPreview)}
                size="small"
              >
                <PreviewIcon />
              </ToggleButton>
            </Tooltip>

            {/* Zoom */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 150 }}>
              <ZoomOutIcon fontSize="small" />
              <Slider
                value={pixelSize}
                onChange={(_, value) => setPixelSize(value as number)}
                min={MIN_PIXEL_SIZE}
                max={MAX_PIXEL_SIZE}
                step={1}
                size="small"
              />
              <ZoomInIcon fontSize="small" />
            </Box>

            {/* Import/Export */}
            <ButtonGroup size="small" variant="outlined">
              <Tooltip title={t('pixelEditor.import', 'Import image')}>
                <Button onClick={handleImportClick} disabled={isViewMode}>
                  <UploadIcon />
                </Button>
              </Tooltip>
              {isAdmin && (
                <>
                  <Tooltip title={t('pixelEditor.exportPNG', 'Export PNG')}>
                    <Button onClick={handleExportPNG}>
                      PNG
                    </Button>
                  </Tooltip>
                  <Tooltip title={t('pixelEditor.exportLBM', 'Export LBM')}>
                    <Button onClick={handleDownload} color="primary">
                      <DownloadIcon sx={{ mr: 0.5 }} />
                      LBM
                    </Button>
                  </Tooltip>
                </>
              )}
            </ButtonGroup>

            {/* Share */}
            <Tooltip title={t('pixelEditor.share', 'Save & Share')}>
              <Button
                variant="contained"
                color="secondary"
                size="small"
                onClick={handleOpenShareDialog}
                startIcon={<ShareIcon />}
              >
                {t('pixelEditor.share', 'Share')}
              </Button>
            </Tooltip>

            {/* New design button (shown when viewing saved design) */}
            {savedDesignId && (
              <Button
                variant="outlined"
                size="small"
                onClick={handleNewDesign}
              >
                {t('pixelEditor.createNew', 'New')}
              </Button>
            )}
          </Box>

          {/* View mode indicator */}
          {isViewMode && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {t('pixelEditor.viewMode', 'You are viewing a shared design')}
              {designOwner && ` (${t('pixelEditor.by', 'by')} ${designOwner})`}
            </Alert>
          )}

          {/* Design name (if saved) */}
          {savedDesignId && designName && (
            <Typography variant="subtitle1" sx={{ mb: 1 }}>
              {designName}
            </Typography>
          )}

          {/* Canvas container */}
          <Box
            sx={{
              overflow: 'auto',
              border: '2px solid',
              borderColor: 'divider',
              borderRadius: 1,
              p: 1,
              bgcolor: '#f5f5f5',
              display: 'inline-block',
            }}
          >
            <canvas
              ref={canvasRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              style={{
                cursor: tool === 'pen' ? 'crosshair' : 'cell',
                display: 'block',
              }}
            />
          </Box>

          {/* Info */}
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            {t('pixelEditor.info', 'Canvas size')}: {CANVAS_WIDTH}×{CANVAS_HEIGHT} px
          </Typography>

          {/* Preview on remote */}
          {showPreview && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <PreviewIcon />
                {t('pixelEditor.previewTitle', 'Preview on Remote')}
              </Typography>
              <Box
                sx={{
                  display: 'inline-block',
                  border: '2px solid',
                  borderColor: 'divider',
                  borderRadius: 2,
                  overflow: 'hidden',
                  bgcolor: '#1a1a1a',
                }}
              >
                <canvas
                  ref={previewCanvasRef}
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    height: 'auto',
                  }}
                />
              </Box>
            </Box>
          )}
        </Paper>
      </Container>

      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="image/*"
        onChange={handleFileChange}
      />

      {/* Import dialog */}
      <Dialog open={importDialogOpen} onClose={() => setImportDialogOpen(false)}>
        <DialogTitle>{t('pixelEditor.importTitle', 'Import Image')}</DialogTitle>
        <DialogContent>
          <Typography>
            {t('pixelEditor.importDescription', 'Select an image to import. It will be scaled to 128×64 and converted to monochrome.')}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleImportClick} variant="contained">{t('pixelEditor.selectFile', 'Select file')}</Button>
        </DialogActions>
      </Dialog>

      {/* Share dialog */}
      <Dialog open={shareDialogOpen} onClose={() => setShareDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('pixelEditor.shareTitle', 'Save & Share Design')}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField
              label={t('pixelEditor.designName', 'Design name')}
              value={designName}
              onChange={(e) => setDesignName(e.target.value)}
              fullWidth
              placeholder={t('pixelEditor.designNamePlaceholder', 'My design')}
            />

            {shareLink ? (
              <Box>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  {t('pixelEditor.shareLink', 'Share link')}:
                </Typography>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <TextField
                    value={shareLink}
                    fullWidth
                    size="small"
                    InputProps={{ readOnly: true }}
                  />
                  <Button
                    variant="outlined"
                    onClick={handleCopyLink}
                    startIcon={copied ? <CheckIcon /> : <CopyIcon />}
                  >
                    {copied ? t('pixelEditor.copied', 'Copied!') : t('share.copy', 'Copy')}
                  </Button>
                </Box>
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {t('pixelEditor.saveToGetLink', 'Save the design to get a shareable link')}
              </Typography>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShareDialogOpen(false)}>{t('common.close')}</Button>
          {!shareLink && (
            <Button
              onClick={handleSaveDesign}
              variant="contained"
              disabled={saving}
              startIcon={saving ? <CircularProgress size={20} /> : <ShareIcon />}
            >
              {t('common.save', 'Save')}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snackbar.severity} onClose={() => setSnackbar({ ...snackbar, open: false })}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  )
}
