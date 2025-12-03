import { Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import { Box, Typography, Button, Chip } from '@mui/material'
import { OpenInNew as OpenIcon } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { Reservoir } from '@/types/models'

// Custom marker icon for reservoirs
const reservoirIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

interface ReservoirMarkerProps {
  reservoir: Reservoir
  onClick?: (reservoir: Reservoir) => void
  onRename?: (reservoir: Reservoir) => void
  onShare?: (reservoir: Reservoir) => void
}

export default function ReservoirMarker({
  reservoir,
  onClick,
  onRename,
  onShare,
}: ReservoirMarkerProps) {
  const { t } = useTranslation()

  return (
    <Marker
      position={[reservoir.basePoint.lat, reservoir.basePoint.lng]}
      icon={reservoirIcon}
    >
      <Popup>
        <Box sx={{ minWidth: 220 }}>
          <Typography variant="subtitle1" fontWeight="bold" sx={{ color: '#1E293B' }}>
            {reservoir.name}
          </Typography>

          <Box sx={{ mt: 1 }}>
            <Chip
              label={`${reservoir.pointsCount} ${t('points.title')}`}
              size="small"
              sx={{
                backgroundColor: '#2196F3',
                color: '#fff',
                fontWeight: 500,
              }}
            />
          </Box>

          <Typography
            variant="caption"
            sx={{
              display: 'block',
              mt: 1,
              color: '#64748B',
            }}
          >
            {t('reservoirs.basePoint')}: {reservoir.basePoint.lat.toFixed(5)}, {reservoir.basePoint.lng.toFixed(5)}
          </Typography>

          <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {onClick && (
              <Button
                size="small"
                variant="contained"
                startIcon={<OpenIcon />}
                onClick={() => onClick(reservoir)}
                fullWidth
              >
                {t('common.open')}
              </Button>
            )}
            {onRename && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => onRename(reservoir)}
                fullWidth
              >
                {t('reservoirs.rename')}
              </Button>
            )}
            {onShare && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => onShare(reservoir)}
                fullWidth
              >
                {t('reservoirs.share')}
              </Button>
            )}
          </Box>
        </Box>
      </Popup>
    </Marker>
  )
}
