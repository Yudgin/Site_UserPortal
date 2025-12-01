import { Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import { Box, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'

// Create home icon with house symbol
const createHomeIcon = () => {
  return L.divIcon({
    className: 'custom-home-marker',
    html: `
      <div style="
        background-color: #1976d2;
        border: 3px solid white;
        border-radius: 50%;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      ">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white">
          <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
        </svg>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -36],
  })
}

interface HomeMarkerProps {
  position: { lat: number; lng: number }
  name: string
}

export default function HomeMarker({ position, name }: HomeMarkerProps) {
  const { t } = useTranslation()

  return (
    <Marker
      position={[position.lat, position.lng]}
      icon={createHomeIcon()}
    >
      <Popup>
        <Box sx={{ minWidth: 150 }}>
          <Typography variant="subtitle1" fontWeight="bold">
            #0 {t('reservoirs.basePoint')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {name}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
          </Typography>
        </Box>
      </Popup>
    </Marker>
  )
}
