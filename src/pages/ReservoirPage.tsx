import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMapEvents, Marker } from 'react-leaflet'
import L from 'leaflet'
import {
  Box,
  Typography,
  Button,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Snackbar,
  Alert,
  Fab,
  Tooltip,
} from '@mui/material'
import {
  ArrowBack,
  Add as AddIcon,
  Delete as DeleteIcon,
  History as HistoryIcon,
  Share as ShareIcon,
  Home as HomeIcon,
  ContentCopy as CopyIcon,
  Edit as EditIcon,
} from '@mui/icons-material'
import MapContainer from '@/components/map/MapContainer'
import PointMarker from '@/components/map/PointMarker'
import HomeMarker from '@/components/map/HomeMarker'
import DeliveryHistory from '@/components/map/DeliveryHistory'
import LoadingSpinner from '@/components/common/LoadingSpinner'
import ConfirmDialog from '@/components/common/ConfirmDialog'
import { useBoatStore } from '@/store/boatStore'
import { useReservoirStore } from '@/store/reservoirStore'
import { pointsApi } from '@/api/endpoints/points'
import { reservoirsApi } from '@/api/endpoints/reservoirs'
import { Point } from '@/types/models'

function MapClickHandler({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click: (e) => {
      onMapClick(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

export default function ReservoirPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { getSelectedBoat, selectedBoatId } = useBoatStore()
  const selectedBoat = getSelectedBoat()
  const {
    selectedReservoir,
    setSelectedReservoir,
    updateReservoir,
    points,
    setPoints,
    selectedPoint,
    setSelectedPoint,
    isLoading,
    setLoading,
  } = useReservoirStore()

  const [addPointDialog, setAddPointDialog] = useState(false)
  const [newPointData, setNewPointData] = useState({ name: '', lat: 0, lng: 0, depth: '' })
  const [historyPoint, setHistoryPoint] = useState<Point | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Point | null>(null)
  const [shareDialog, setShareDialog] = useState<{ open: boolean; link: string; shareKey: string }>({ open: false, link: '', shareKey: '' })
  const [renameDialog, setRenameDialog] = useState(false)
  const [newName, setNewName] = useState('')
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  })

  useEffect(() => {
    if (id) {
      loadReservoirData()
    }
  }, [id])

  // Navigate back to dashboard if boat changes
  useEffect(() => {
    if (selectedReservoir && selectedBoatId) {
      // If the reservoir doesn't belong to the current boat, go back
      navigate('/')
    }
  }, [selectedBoatId])

  const loadReservoirData = async () => {
    if (!id || !selectedBoat) return

    setLoading(true)

    // If no selected reservoir, load it
    if (!selectedReservoir) {
      const reservoirsResult = await reservoirsApi.getAll(selectedBoat.credentials.boatId)
      if (reservoirsResult.success && reservoirsResult.data) {
        const reservoir = reservoirsResult.data.reservoirs.find((r) => r.id === id)
        if (reservoir) {
          setSelectedReservoir(reservoir)
        }
      }
    }

    // Load points
    const pointsResult = await pointsApi.getByReservoir(id)
    if (pointsResult.success && pointsResult.data) {
      setPoints(pointsResult.data.points)
    }

    setLoading(false)
  }

  const handleMapClick = useCallback((lat: number, lng: number) => {
    setNewPointData({ name: '', lat, lng, depth: '' })
    setAddPointDialog(true)
  }, [])

  const handleAddPoint = async () => {
    if (!id || !selectedBoat || !newPointData.name) return

    const result = await pointsApi.create({
      boatId: selectedBoat.credentials.boatId,
      boatPassword: selectedBoat.credentials.boatPassword,
      reservoirId: id,
      name: newPointData.name,
      coordinates: { lat: newPointData.lat, lng: newPointData.lng },
      depth: newPointData.depth ? parseFloat(newPointData.depth) : undefined,
    })

    if (result.success) {
      // Reload points from API
      const pointsResult = await pointsApi.getByReservoir(id)
      if (pointsResult.success && pointsResult.data) {
        setPoints(pointsResult.data.points)
      }
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' })
    }

    setAddPointDialog(false)
    setNewPointData({ name: '', lat: 0, lng: 0, depth: '' })
  }

  const handleDeletePoint = async () => {
    if (!deleteConfirm || !id) return

    const result = await pointsApi.delete(deleteConfirm.id)

    if (result.success) {
      // Reload points from API
      const pointsResult = await pointsApi.getByReservoir(id)
      if (pointsResult.success && pointsResult.data) {
        setPoints(pointsResult.data.points)
      }
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' })
    }

    setDeleteConfirm(null)
  }

  const handleShare = async () => {
    if (!selectedReservoir) return

    const result = await reservoirsApi.share(selectedReservoir.id)

    if (result.success && result.data) {
      const link = `${window.location.origin}/share/${result.data.shareKey}`
      setShareDialog({ open: true, link, shareKey: result.data.shareKey })
    } else {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' })
    }
  }

  const copyShareLink = () => {
    navigator.clipboard.writeText(shareDialog.link)
    setSnackbar({ open: true, message: t('share.linkCopied'), severity: 'success' })
  }

  const copyShareKey = () => {
    navigator.clipboard.writeText(shareDialog.shareKey)
    setSnackbar({ open: true, message: t('share.keyCopied'), severity: 'success' })
  }

  const handleOpenRename = () => {
    if (selectedReservoir) {
      setNewName(selectedReservoir.name)
      setRenameDialog(true)
    }
  }

  const handleRename = async () => {
    if (!selectedReservoir || !selectedBoat || !newName.trim()) return

    const result = await reservoirsApi.rename({
      boatId: selectedBoat.credentials.boatId,
      boatPassword: selectedBoat.credentials.boatPassword,
      reservoirNumber: selectedReservoir.number,
      newName: newName.trim(),
    })

    if (result.success) {
      updateReservoir(selectedReservoir.id, { name: newName.trim() })
      setSelectedReservoir({ ...selectedReservoir, name: newName.trim() })
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' })
    }

    setRenameDialog(false)
  }

  if (isLoading) {
    return <LoadingSpinner />
  }

  const mapCenter: [number, number] = selectedReservoir
    ? [selectedReservoir.basePoint.lat, selectedReservoir.basePoint.lng]
    : [48.5, 25.0]

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <IconButton onClick={() => navigate('/')}>
          <ArrowBack />
        </IconButton>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
          <Typography variant="h5">
            {selectedReservoir?.name || t('points.title')}
          </Typography>
          <Tooltip title={t('reservoirs.rename')}>
            <IconButton size="small" onClick={handleOpenRename}>
              <EditIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <Button
          variant="outlined"
          startIcon={<ShareIcon />}
          onClick={handleShare}
          size="small"
        >
          {t('reservoirs.share')}
        </Button>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' } }}>
        {/* Map */}
        <Box sx={{ flex: 2, height: { xs: 350, md: 500 }, position: 'relative' }}>
          <MapContainer center={mapCenter} zoom={14}>
            <MapClickHandler onMapClick={handleMapClick} />
            {/* Home marker (base point) */}
            {selectedReservoir && (
              <HomeMarker
                position={selectedReservoir.basePoint}
                name={selectedReservoir.name}
              />
            )}
            {/* Regular points */}
            {points.map((point) => (
              <PointMarker
                key={point.id}
                point={point}
                isSelected={selectedPoint?.id === point.id}
                onShowHistory={setHistoryPoint}
                onDelete={setDeleteConfirm}
              />
            ))}
          </MapContainer>

          <Tooltip title={t('points.add')}>
            <Fab
              color="primary"
              sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 1000 }}
              onClick={() => {
                const lat = mapCenter[0] + (Math.random() - 0.5) * 0.01
                const lng = mapCenter[1] + (Math.random() - 0.5) * 0.01
                handleMapClick(lat, lng)
              }}
            >
              <AddIcon />
            </Fab>
          </Tooltip>
        </Box>

        {/* Points List */}
        <Paper sx={{ flex: 1, p: 2, maxHeight: { md: 500 }, overflow: 'auto' }}>
          <Typography variant="h6" gutterBottom>
            {t('points.title')} ({points.length})
          </Typography>

          <List dense>
            {/* Home point (base point) */}
            {selectedReservoir && (
              <ListItem
                sx={{
                  bgcolor: 'primary.light',
                  color: 'white',
                  borderRadius: 1,
                  mb: 1,
                }}
              >
                <HomeIcon sx={{ mr: 1 }} />
                <ListItemText
                  primary={t('reservoirs.basePoint')}
                  secondary={
                    <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.8)' }}>
                      {selectedReservoir.basePoint.lat.toFixed(5)}, {selectedReservoir.basePoint.lng.toFixed(5)}
                    </Typography>
                  }
                />
              </ListItem>
            )}
            {/* Regular points */}
            {points.map((point) => (
              <ListItem
                key={point.id}
                disablePadding
                secondaryAction={
                  <>
                    <IconButton size="small" onClick={() => setHistoryPoint(point)}>
                      <HistoryIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" onClick={() => setDeleteConfirm(point)} color="error">
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </>
                }
              >
                <ListItemButton
                  selected={selectedPoint?.id === point.id}
                  onClick={() => setSelectedPoint(point)}
                  sx={{ borderRadius: 1 }}
                >
                  <ListItemText
                    primary={`#${point.number} ${point.name}`}
                    secondary={
                      <>
                        {point.depth && `${point.depth}${t('common.meters')} | `}
                        {point.coordinates.lat.toFixed(5)}, {point.coordinates.lng.toFixed(5)}
                      </>
                    }
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Paper>
      </Box>

      {/* Add Point Dialog */}
      <Dialog open={addPointDialog} onClose={() => setAddPointDialog(false)} maxWidth="lg" fullWidth>
        <DialogTitle>{t('points.add')}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' } }}>
            {/* Map for selecting location */}
            <Box sx={{ flex: 2, height: 450 }}>
              <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                {t('points.clickToSelect')}
              </Typography>
              <Box sx={{ height: 420 }}>
                <MapContainer
                  center={selectedReservoir ? [selectedReservoir.basePoint.lat, selectedReservoir.basePoint.lng] : mapCenter}
                  zoom={18}
                >
                  <MapClickHandler onMapClick={(lat, lng) => setNewPointData((prev) => ({ ...prev, lat, lng }))} />
                  {/* Show existing points */}
                  {selectedReservoir && (
                    <HomeMarker position={selectedReservoir.basePoint} name={selectedReservoir.name} />
                  )}
                  {points.map((point) => (
                    <PointMarker key={point.id} point={point} />
                  ))}
                  {/* Show new point marker */}
                  {newPointData.lat !== 0 && (
                    <Marker
                      position={[newPointData.lat, newPointData.lng]}
                      icon={L.divIcon({
                        className: 'new-point-marker',
                        html: `<div style="
                          background-color: #f44336;
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
                          font-size: 14px;
                        ">+</div>`,
                        iconSize: [32, 32],
                        iconAnchor: [16, 32],
                      })}
                    />
                  )}
                </MapContainer>
              </Box>
            </Box>

            {/* Form fields */}
            <Box sx={{ flex: 1 }}>
              <TextField
                autoFocus
                margin="dense"
                label={t('points.name')}
                fullWidth
                value={newPointData.name}
                onChange={(e) => setNewPointData((prev) => ({ ...prev, name: e.target.value }))}
              />
              <TextField
                margin="dense"
                label={t('points.depth')}
                type="number"
                fullWidth
                value={newPointData.depth}
                onChange={(e) => setNewPointData((prev) => ({ ...prev, depth: e.target.value }))}
              />

              {/* Manual coordinate entry */}
              <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                {t('points.coordinates')}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <TextField
                  margin="dense"
                  label={t('points.latitude')}
                  type="number"
                  size="small"
                  value={newPointData.lat || ''}
                  onChange={(e) => setNewPointData((prev) => ({ ...prev, lat: parseFloat(e.target.value) || 0 }))}
                  inputProps={{ step: 0.00001 }}
                  sx={{ flex: 1 }}
                />
                <TextField
                  margin="dense"
                  label={t('points.longitude')}
                  type="number"
                  size="small"
                  value={newPointData.lng || ''}
                  onChange={(e) => setNewPointData((prev) => ({ ...prev, lng: parseFloat(e.target.value) || 0 }))}
                  inputProps={{ step: 0.00001 }}
                  sx={{ flex: 1 }}
                />
              </Box>

              {newPointData.lat === 0 && newPointData.lng === 0 && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  {t('points.selectLocation')}
                </Alert>
              )}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddPointDialog(false)}>{t('common.cancel')}</Button>
          <Button
            onClick={handleAddPoint}
            variant="contained"
            disabled={!newPointData.name || (newPointData.lat === 0 && newPointData.lng === 0)}
          >
            {t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delivery History Dialog */}
      <DeliveryHistory
        point={historyPoint}
        open={!!historyPoint}
        onClose={() => setHistoryPoint(null)}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title={t('common.delete')}
        message={`${t('common.confirm')} "${deleteConfirm?.name}"?`}
        confirmColor="error"
        onConfirm={handleDeletePoint}
        onCancel={() => setDeleteConfirm(null)}
      />

      {/* Share Dialog */}
      <Dialog open={shareDialog.open} onClose={() => setShareDialog({ open: false, link: '', shareKey: '' })} maxWidth="sm" fullWidth>
        <DialogTitle>{t('share.title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            {t('share.description')}
          </Typography>

          {/* Share Key */}
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            {t('share.importKey')}:
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
            <TextField
              fullWidth
              size="small"
              value={shareDialog.shareKey}
              InputProps={{ readOnly: true }}
            />
            <Button
              variant="outlined"
              onClick={copyShareKey}
              startIcon={<CopyIcon />}
              sx={{ minWidth: 'auto', px: 2 }}
            >
              {t('share.copy')}
            </Button>
          </Box>

          {/* Share Link */}
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            {t('share.link')}:
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              fullWidth
              size="small"
              value={shareDialog.link}
              InputProps={{ readOnly: true }}
            />
            <Button
              variant="outlined"
              onClick={copyShareLink}
              startIcon={<CopyIcon />}
              sx={{ minWidth: 'auto', px: 2 }}
            >
              {t('share.copy')}
            </Button>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShareDialog({ open: false, link: '', shareKey: '' })}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialog} onClose={() => setRenameDialog(false)}>
        <DialogTitle>{t('reservoirs.rename')}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label={t('reservoirs.newName')}
            fullWidth
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) {
                handleRename()
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameDialog(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleRename} variant="contained" disabled={!newName.trim()}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
      >
        <Alert severity={snackbar.severity}>{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  )
}
