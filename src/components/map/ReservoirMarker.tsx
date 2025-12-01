import { Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import { Box, Typography, Button, Chip } from '@mui/material'
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
        <Box sx={{ minWidth: 200 }}>
          <Typography variant="subtitle1" fontWeight="bold">
            {reservoir.name}
          </Typography>

          <Box sx={{ mt: 1 }}>
            <Chip
              label={`${reservoir.pointsCount} ${t('reservoirs.pointsCount')}`}
              size="small"
              color="primary"
              variant="outlined"
            />
          </Box>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {t('reservoirs.basePoint')}: {reservoir.basePoint.lat.toFixed(5)}, {reservoir.basePoint.lng.toFixed(5)}
          </Typography>

          <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {onClick && (
              <Button
                size="small"
                variant="contained"
                onClick={() => onClick(reservoir)}
              >
                {t('common.edit')}
              </Button>
            )}
            {onRename && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => onRename(reservoir)}
              >
                {t('reservoirs.rename')}
              </Button>
            )}
            {onShare && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => onShare(reservoir)}
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
