import { useEffect, useRef } from 'react'
import { MapContainer as LeafletMapContainer, TileLayer, useMap } from 'react-leaflet'
import { Box, ToggleButton, ToggleButtonGroup } from '@mui/material'
import { Satellite, Map as MapIcon } from '@mui/icons-material'
import { useSettingsStore } from '@/store/settingsStore'
import 'leaflet/dist/leaflet.css'

// ESRI Satellite tiles (free)
const ESRI_SATELLITE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ESRI_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'

// OpenStreetMap tiles
const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

interface MapContainerProps {
  children?: React.ReactNode
  center?: [number, number]
  zoom?: number
  style?: React.CSSProperties
  onMapReady?: (map: L.Map) => void
}

function MapTypeControl() {
  const { mapType, setMapType } = useSettingsStore()

  return (
    <Box
      sx={{
        position: 'absolute',
        top: 10,
        right: 10,
        zIndex: 1000,
        bgcolor: 'background.paper',
        borderRadius: 1,
        boxShadow: 2,
      }}
    >
      <ToggleButtonGroup
        value={mapType}
        exclusive
        onChange={(_, value) => value && setMapType(value)}
        size="small"
      >
        <ToggleButton value="satellite">
          <Satellite fontSize="small" />
        </ToggleButton>
        <ToggleButton value="street">
          <MapIcon fontSize="small" />
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
  )
}

function MapReadyHandler({ onMapReady }: { onMapReady?: (map: L.Map) => void }) {
  const map = useMap()
  const hasCalledRef = useRef(false)

  useEffect(() => {
    if (onMapReady && !hasCalledRef.current) {
      hasCalledRef.current = true
      onMapReady(map)
    }
  }, [map, onMapReady])

  return null
}

export default function MapContainerComponent({
  children,
  center = [48.5, 25.0], // Default: Western Ukraine
  zoom = 7,
  style,
  onMapReady,
}: MapContainerProps) {
  const { mapType } = useSettingsStore()

  const tileUrl = mapType === 'satellite' ? ESRI_SATELLITE : OSM_TILES
  const attribution = mapType === 'satellite' ? ESRI_ATTRIBUTION : OSM_ATTRIBUTION

  return (
    <Box sx={{ position: 'relative', height: '100%', width: '100%', ...style }}>
      <LeafletMapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%', borderRadius: 8 }}
      >
        <TileLayer
          key={mapType}
          url={tileUrl}
          attribution={attribution}
          maxZoom={19}
        />
        <MapTypeControl />
        <MapReadyHandler onMapReady={onMapReady} />
        {children}
      </LeafletMapContainer>
    </Box>
  )
}
