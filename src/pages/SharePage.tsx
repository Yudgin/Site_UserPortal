import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Container,
  Paper,
  Box,
  Typography,
  Button,
  List,
  ListItem,
  ListItemText,
  Alert,
} from '@mui/material'
import { DirectionsBoat, Home as HomeIcon } from '@mui/icons-material'
import LoadingSpinner from '@/components/common/LoadingSpinner'
import MapContainer from '@/components/map/MapContainer'
import HomeMarker from '@/components/map/HomeMarker'
import { Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import { reservoirsApi } from '@/api/endpoints/reservoirs'
import { useAuthStore } from '@/store/authStore'
import { useBoatStore } from '@/store/boatStore'
import LanguageSelector from '@/components/common/LanguageSelector'

// Create numbered marker icon for preview
const createNumberedIcon = (number: number) => {
  return L.divIcon({
    className: 'custom-numbered-marker',
    html: `
      <div style="
        background-color: #388e3c;
        border: 3px solid white;
        border-radius: 50%;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        color: white;
        font-weight: bold;
        font-size: ${number > 99 ? '10px' : '14px'};
      ">${number}</div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32],
  })
}

interface SharedData {
  reservoir: {
    name: string
    basePoint: { lat: number; lng: number }
  }
  points: Array<{
    name: string
    coordinates: { lat: number; lng: number }
  }>
}

export default function SharePage() {
  const { t } = useTranslation()
  const { shareKey } = useParams<{ shareKey: string }>()
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const { getSelectedBoat } = useBoatStore()
  const selectedBoat = getSelectedBoat()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<SharedData | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (shareKey) {
      loadSharedData()
    }
  }, [shareKey])

  const loadSharedData = async () => {
    if (!shareKey) return

    setLoading(true)
    setError(null)

    const result = await reservoirsApi.getShared(shareKey)

    if (result.success && result.data) {
      setData({
        reservoir: result.data.reservoir,
        points: result.data.points as SharedData['points'],
      })
    } else {
      setError(result.error?.message || 'Failed to load shared data')
    }

    setLoading(false)
  }

  const handleImport = async () => {
    if (!user || !selectedBoat) {
      // Redirect to login with return URL
      navigate(`/login?redirect=/share/${shareKey}`)
      return
    }

    if (!shareKey) return

    setImporting(true)

    // Import reservoir to the selected boat
    const result = await reservoirsApi.importShared(
      shareKey,
      selectedBoat.credentials.boatId,
      selectedBoat.credentials.boatPassword
    )

    if (result.success) {
      navigate('/')
    } else {
      setError(result.error?.message || 'Failed to import reservoir')
    }

    setImporting(false)
  }

  if (loading) {
    return <LoadingSpinner fullScreen />
  }

  if (error || !data) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
      >
        <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 400 }}>
          <Typography variant="h6" color="error" gutterBottom>
            {t('common.error')}
          </Typography>
          <Typography color="text.secondary">
            {error || 'Share link is invalid or expired'}
          </Typography>
          <Button variant="contained" sx={{ mt: 3 }} onClick={() => navigate('/')}>
            {t('common.back')}
          </Button>
        </Paper>
      </Box>
    )
  }

  const mapCenter: [number, number] = [data.reservoir.basePoint.lat, data.reservoir.basePoint.lng]

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 2 }}>
        <LanguageSelector />
      </Box>

      <Container maxWidth="md" sx={{ flex: 1, pb: 4 }}>
        <Paper sx={{ p: 3 }}>
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <DirectionsBoat sx={{ fontSize: 48, color: 'primary.main' }} />
            <Typography variant="h5" fontWeight="bold" sx={{ mt: 1 }}>
              {t('share.importTitle')}
            </Typography>
          </Box>

          <Alert severity="info" sx={{ mb: 3 }}>
            {t('share.importDescription')}
          </Alert>

          {/* Reservoir Info */}
          <Typography variant="h6" gutterBottom>
            {data.reservoir.name}
          </Typography>

          {/* Map Preview */}
          <Box sx={{ height: 300, mb: 3 }}>
            <MapContainer center={mapCenter} zoom={13}>
              {/* Home marker (base point) */}
              <HomeMarker
                position={data.reservoir.basePoint}
                name={data.reservoir.name}
              />
              {/* Points with numbers */}
              {data.points.map((point, index) => (
                <Marker
                  key={index}
                  position={[point.coordinates.lat, point.coordinates.lng]}
                  icon={createNumberedIcon(index + 1)}
                >
                  <Popup>#{index + 1} {point.name}</Popup>
                </Marker>
              ))}
            </MapContainer>
          </Box>

          {/* Points List */}
          <Typography variant="subtitle1" gutterBottom>
            {t('points.title')} ({data.points.length})
          </Typography>

          <List dense sx={{ maxHeight: 200, overflow: 'auto', bgcolor: 'grey.50', borderRadius: 1 }}>
            {/* Base point */}
            <ListItem sx={{ bgcolor: 'primary.light', color: 'white', borderRadius: 1, mb: 0.5 }}>
              <HomeIcon fontSize="small" sx={{ mr: 1 }} />
              <ListItemText
                primary={t('reservoirs.basePoint')}
                secondary={
                  <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.8)' }}>
                    {data.reservoir.basePoint.lat.toFixed(5)}, {data.reservoir.basePoint.lng.toFixed(5)}
                  </Typography>
                }
              />
            </ListItem>
            {/* Regular points */}
            {data.points.map((point, index) => (
              <ListItem key={index}>
                <Box
                  sx={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    bgcolor: 'success.main',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 'bold',
                    mr: 1,
                  }}
                >
                  {index + 1}
                </Box>
                <ListItemText
                  primary={point.name}
                  secondary={`${point.coordinates.lat.toFixed(5)}, ${point.coordinates.lng.toFixed(5)}`}
                />
              </ListItem>
            ))}
          </List>

          {/* Actions */}
          <Box sx={{ mt: 3, display: 'flex', gap: 2, justifyContent: 'center' }}>
            <Button variant="outlined" onClick={() => navigate('/')}>
              {t('share.cancel')}
            </Button>
            <Button
              variant="contained"
              onClick={handleImport}
              disabled={importing}
            >
              {importing ? t('common.loading') : t('share.accept')}
            </Button>
          </Box>

          {!user ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, textAlign: 'center' }}>
              {t('share.loginRequired')}
            </Typography>
          ) : selectedBoat && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, textAlign: 'center' }}>
              {t('share.importTo')}: <strong>{selectedBoat.info.name || selectedBoat.credentials.boatId}</strong>
            </Typography>
          )}
        </Paper>
      </Container>
    </Box>
  )
}
