import { Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import { Box, Typography, Button, Chip } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { Point } from '@/types/models'

// Create numbered marker icon
const createNumberedIcon = (number: number, isSelected: boolean = false) => {
  const bgColor = isSelected ? '#d32f2f' : '#388e3c' // red if selected, green otherwise

  return L.divIcon({
    className: 'custom-numbered-marker',
    html: `
      <div style="
        background-color: ${bgColor};
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

interface PointMarkerProps {
  point: Point
  isSelected?: boolean
  onShowHistory?: (point: Point) => void
  onDelete?: (point: Point) => void
}

export default function PointMarker({
  point,
  isSelected = false,
  onShowHistory,
  onDelete,
}: PointMarkerProps) {
  const { t } = useTranslation()

  return (
    <Marker
      position={[point.coordinates.lat, point.coordinates.lng]}
      icon={createNumberedIcon(point.number, isSelected)}
    >
      <Popup>
        <Box sx={{ minWidth: 200 }}>
          <Typography variant="subtitle1" fontWeight="bold">
            #{point.number} {point.name}
          </Typography>

          {point.depth && (
            <Chip
              label={`${point.depth} ${t('common.meters')}`}
              size="small"
              color="info"
              variant="outlined"
              sx={{ mt: 1 }}
            />
          )}

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {t('points.coordinates')}: {point.coordinates.lat.toFixed(5)}, {point.coordinates.lng.toFixed(5)}
          </Typography>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {new Date(point.createdAt).toLocaleDateString()}
          </Typography>

          <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {onShowHistory && (
              <Button
                size="small"
                variant="contained"
                onClick={() => onShowHistory(point)}
              >
                {t('deliveries.title')}
              </Button>
            )}
            {onDelete && (
              <Button
                size="small"
                variant="outlined"
                color="error"
                onClick={() => onDelete(point)}
              >
                {t('common.delete')}
              </Button>
            )}
          </Box>
        </Box>
      </Popup>
    </Marker>
  )
}
