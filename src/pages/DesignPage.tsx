import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  CardActionArea,
  Divider,
  IconButton,
  Chip,
  CircularProgress,
} from '@mui/material'
import {
  GridOn as PixelIcon,
  DirectionsBoat as BoatIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material'
import { pixelDesignService, PixelDesign, decodePixels } from '@/api/pixelDesignService'
import { boatConfigService, SavedBoatConfig } from '@/api/boatConfigService'
import { BOAT_COLOR_OPTIONS } from './BoatConfiguratorPage'

// Component to render pixel design preview
function PixelPreview({ design }: { design: PixelDesign }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    try {
      const pixels = decodePixels(design.pixels, design.width, design.height)

      // Set canvas size
      canvas.width = design.width
      canvas.height = design.height

      // White background
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, design.width, design.height)

      // Draw black pixels
      ctx.fillStyle = '#000000'
      for (let y = 0; y < design.height; y++) {
        for (let x = 0; x < design.width; x++) {
          if (pixels[y]?.[x]) {
            ctx.fillRect(x, y, 1, 1)
          }
        }
      }
    } catch (err) {
      console.error('Error rendering preview:', err)
    }
  }, [design])

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: 'auto',
        imageRendering: 'pixelated',
        border: '1px solid #e0e0e0',
        borderRadius: 4,
        backgroundColor: '#fff',
      }}
    />
  )
}

export default function DesignPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [pixelDesigns, setPixelDesigns] = useState<PixelDesign[]>([])
  const [boatConfigs, setBoatConfigs] = useState<SavedBoatConfig[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDesigns()
  }, [])

  const loadDesigns = async () => {
    setLoading(true)
    const [pixels, boats] = await Promise.all([
      pixelDesignService.getUserDesigns(),
      boatConfigService.getUserConfigs(),
    ])
    setPixelDesigns(pixels)
    setBoatConfigs(boats)
    setLoading(false)
  }

  const handleDeletePixelDesign = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (await pixelDesignService.deleteDesign(id)) {
      setPixelDesigns(prev => prev.filter(d => d.id !== id))
    }
  }

  const handleDeleteBoatConfig = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (await boatConfigService.deleteConfig(id)) {
      setBoatConfigs(prev => prev.filter(c => c.id !== id))
    }
  }

  // Get boat color from config code
  const getBoatColorFromCode = (code: string): string => {
    try {
      const colorIndex = parseInt(code[0], 36)
      return BOAT_COLOR_OPTIONS[colorIndex]?.displayColor || '#FF6B00'
    } catch {
      return '#FF6B00'
    }
  }

  const designItems = [
    {
      title: t('design.remoteDesign'),
      description: t('design.remoteDesignDesc'),
      icon: <PixelIcon sx={{ fontSize: 48 }} />,
      path: '/pixel-editor',
      color: '#2196F3',
    },
    {
      title: t('design.boatDesign'),
      description: t('design.boatDesignDesc'),
      icon: <BoatIcon sx={{ fontSize: 48 }} />,
      path: '/configurator',
      color: '#FF9800',
    },
  ]

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 3 }}>
        {t('design.title')}
      </Typography>

      {/* Design Tools */}
      <Grid container spacing={3}>
        {designItems.map((item) => (
          <Grid item xs={12} sm={6} md={4} key={item.path}>
            <Card
              sx={{
                height: '100%',
                transition: 'transform 0.2s, box-shadow 0.2s',
                '&:hover': {
                  transform: 'translateY(-4px)',
                  boxShadow: 6,
                },
              }}
            >
              <CardActionArea
                onClick={() => navigate(item.path)}
                sx={{ height: '100%' }}
              >
                <CardContent
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    textAlign: 'center',
                    py: 4,
                  }}
                >
                  <Box
                    sx={{
                      width: 80,
                      height: 80,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: `linear-gradient(135deg, ${item.color}20 0%, ${item.color}40 100%)`,
                      color: item.color,
                      mb: 2,
                    }}
                  >
                    {item.icon}
                  </Box>
                  <Typography variant="h6" gutterBottom>
                    {item.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {item.description}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Saved Designs Section */}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : (pixelDesigns.length > 0 || boatConfigs.length > 0) && (
        <>
          <Divider sx={{ my: 4 }} />
          <Typography variant="h5" sx={{ mb: 3 }}>
            {t('design.savedDesigns')}
          </Typography>

          {/* Saved Pixel Designs */}
          {pixelDesigns.length > 0 && (
            <Box sx={{ mb: 4 }}>
              <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                <PixelIcon color="primary" />
                {t('design.remoteDesign')}
              </Typography>
              <Grid container spacing={2}>
                {pixelDesigns.map((design) => (
                  <Grid item xs={6} sm={4} md={3} lg={2} key={design.id}>
                    <Card sx={{ height: '100%' }}>
                      <CardActionArea onClick={() => navigate(`/pixel-editor/${design.id}`)}>
                        <Box sx={{ p: 1, bgcolor: '#f5f5f5' }}>
                          <PixelPreview design={design} />
                        </Box>
                        <CardContent sx={{ py: 1, px: 1.5 }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Box sx={{ overflow: 'hidden' }}>
                              <Typography variant="body2" noWrap title={design.name}>
                                {design.name}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {new Date(design.createdAt).toLocaleDateString()}
                              </Typography>
                            </Box>
                            <IconButton
                              size="small"
                              onClick={(e) => handleDeletePixelDesign(e, design.id)}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </Box>
          )}

          {/* Saved Boat Configs */}
          {boatConfigs.length > 0 && (
            <Box>
              <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                <BoatIcon sx={{ color: '#FF9800' }} />
                {t('design.boatDesign')}
              </Typography>
              <Grid container spacing={2}>
                {boatConfigs.map((config) => (
                  <Grid item xs={12} sm={6} md={4} lg={3} key={config.id}>
                    <Card>
                      <CardActionArea onClick={() => navigate(`/configurator/result/${config.code}`)}>
                        <CardContent>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <Box>
                              <Typography variant="subtitle1" noWrap sx={{ maxWidth: 150 }}>
                                {config.name}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {new Date(config.createdAt).toLocaleDateString()}
                              </Typography>
                            </Box>
                            <IconButton
                              size="small"
                              onClick={(e) => handleDeleteBoatConfig(e, config.id)}
                              sx={{ ml: 1 }}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Box>
                          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Box
                              sx={{
                                width: 20,
                                height: 20,
                                borderRadius: '50%',
                                backgroundColor: getBoatColorFromCode(config.code),
                                border: '1px solid #ccc',
                              }}
                            />
                            <Chip
                              size="small"
                              label={config.code}
                              sx={{ fontFamily: 'monospace' }}
                            />
                          </Box>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </Box>
          )}
        </>
      )}
    </Box>
  )
}
