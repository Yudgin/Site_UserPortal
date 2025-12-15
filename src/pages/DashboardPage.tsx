import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  CardActionArea,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Snackbar,
  Alert,
  Paper,
  List,
  ListItem,
  ListItemText,
  Divider,
  CircularProgress,
} from '@mui/material'
import {
  Water,
  Share as ShareIcon,
  Download as ImportIcon,
  ContentCopy as CopyIcon,
  Build as ServiceIcon,
  Visibility as ViewIcon,
  Add as AddIcon,
} from '@mui/icons-material'
import MapContainer from '@/components/map/MapContainer'
import ReservoirMarker from '@/components/map/ReservoirMarker'
import LoadingSpinner from '@/components/common/LoadingSpinner'
import { useBoatStore } from '@/store/boatStore'
import { useReservoirStore } from '@/store/reservoirStore'
import { useSettingsStore } from '@/store/settingsStore'
import { reservoirsApi } from '@/api/endpoints/reservoirs'
import { serviceApi } from '@/api/endpoints/service'
import { Reservoir } from '@/types/models'

interface RepairItem {
  id: string
  Number: string
  Date: string
}

export default function DashboardPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { getSelectedBoat, selectedBoatId } = useBoatStore()
  const selectedBoat = getSelectedBoat()
  const { reservoirs, setReservoirs, setSelectedReservoir, updateReservoir, isLoading, setLoading } = useReservoirStore()
  const { phoneNumber } = useSettingsStore()

  // Repair requests from API
  const [repairRequests, setRepairRequests] = useState<RepairItem[]>([])
  const [loadingRepairs, setLoadingRepairs] = useState(false)

  const [renameDialog, setRenameDialog] = useState<{ open: boolean; reservoir: Reservoir | null }>({
    open: false,
    reservoir: null,
  })
  const [newName, setNewName] = useState('')
  const [shareDialog, setShareDialog] = useState<{ open: boolean; reservoir: Reservoir | null; link: string; shareKey: string }>({
    open: false,
    reservoir: null,
    link: '',
    shareKey: '',
  })
  const [importDialog, setImportDialog] = useState(false)
  const [importKey, setImportKey] = useState('')
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  })
  useEffect(() => {
    // Clear reservoirs when boat changes and reload
    setReservoirs([])
    loadReservoirs()
  }, [selectedBoatId])

  // Load repair requests when phone number is available
  useEffect(() => {
    if (phoneNumber) {
      loadRepairRequests()
    } else {
      setRepairRequests([])
    }
  }, [phoneNumber])

  const loadRepairRequests = async () => {
    if (!phoneNumber) return
    setLoadingRepairs(true)
    try {
      const result = await serviceApi.getRepairList(phoneNumber)
      if (result.success && result.data) {
        setRepairRequests(result.data)
      }
    } catch (error) {
      console.error('Failed to load repair requests:', error)
    } finally {
      setLoadingRepairs(false)
    }
  }

  const loadReservoirs = async () => {
    if (!selectedBoat) return

    setLoading(true)
    const result = await reservoirsApi.getAll(selectedBoat.credentials.boatId)

    if (result.success && result.data) {
      setReservoirs(result.data.reservoirs)
    }

    setLoading(false)
  }

  const handleReservoirClick = (reservoir: Reservoir) => {
    setSelectedReservoir(reservoir)
    navigate(`/reservoir/${reservoir.id}`)
  }

  const handleRenameClick = (reservoir: Reservoir) => {
    setNewName(reservoir.name)
    setRenameDialog({ open: true, reservoir })
  }

  const handleRenameSubmit = async () => {
    if (!renameDialog.reservoir || !selectedBoat) return

    const result = await reservoirsApi.rename({
      boatId: selectedBoat.credentials.boatId,
      boatPassword: selectedBoat.credentials.boatPassword,
      reservoirNumber: renameDialog.reservoir.number,
      newName,
    })

    if (result.success) {
      updateReservoir(renameDialog.reservoir.id, { name: newName })
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' })
    }

    setRenameDialog({ open: false, reservoir: null })
  }

  const handleShareClick = async (reservoir: Reservoir) => {
    const result = await reservoirsApi.share(reservoir.id)

    if (result.success && result.data) {
      const link = `${window.location.origin}/share/${result.data.shareKey}`
      setShareDialog({ open: true, reservoir, link, shareKey: result.data.shareKey })
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

  const handleImport = () => {
    if (!importKey.trim()) return
    navigate(`/share/${importKey.trim()}`)
    setImportDialog(false)
    setImportKey('')
  }

  if (isLoading) {
    return <LoadingSpinner />
  }

  // Calculate map center from reservoirs
  const mapCenter: [number, number] = reservoirs.length > 0
    ? [
        reservoirs.reduce((sum, r) => sum + r.basePoint.lat, 0) / reservoirs.length,
        reservoirs.reduce((sum, r) => sum + r.basePoint.lng, 0) / reservoirs.length,
      ]
    : [48.5, 25.0]

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4">
          {t('reservoirs.title')}
        </Typography>
        <Button
          variant="outlined"
          startIcon={<ImportIcon />}
          onClick={() => setImportDialog(true)}
        >
          {t('points.importByKey')}
        </Button>
      </Box>

      {/* Map */}
      <Box sx={{ height: 400, mb: 3 }}>
        <MapContainer center={mapCenter} zoom={reservoirs.length > 0 ? 8 : 6}>
          {reservoirs.map((reservoir) => (
            <ReservoirMarker
              key={reservoir.id}
              reservoir={reservoir}
              onClick={handleReservoirClick}
              onRename={handleRenameClick}
              onShare={handleShareClick}
            />
          ))}
        </MapContainer>
      </Box>

      {/* Reservoir Cards */}
      {reservoirs.length === 0 ? (
        <Typography color="text.secondary" textAlign="center" py={4}>
          {t('reservoirs.noReservoirs')}
        </Typography>
      ) : (
        <Grid container spacing={2}>
          {reservoirs.map((reservoir) => (
            <Grid item xs={12} sm={6} md={4} key={reservoir.id}>
              <Card>
                <CardActionArea onClick={() => handleReservoirClick(reservoir)}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                      <Water color="primary" />
                      <Typography variant="h6">{reservoir.name}</Typography>
                    </Box>
                    <Typography variant="body2" color="text.secondary">
                      {t('reservoirs.pointsCount')}: {reservoir.pointsCount}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {reservoir.basePoint.lat.toFixed(4)}, {reservoir.basePoint.lng.toFixed(4)}
                    </Typography>
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      {/* Service Requests Section */}
      <Paper sx={{ p: 3, mt: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap', gap: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ServiceIcon color="primary" />
            <Typography variant="h6">{t('service.myServiceRequests')}</Typography>
          </Box>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate('/repair/new')}
          >
            {t('repair.title')}
          </Button>
        </Box>

        {!phoneNumber ? (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t('service.addPhoneToSeeRequests')}
          </Alert>
        ) : loadingRepairs ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : repairRequests.length > 0 ? (
          <List>
            {repairRequests.map((request, index) => (
              <Box key={request.id}>
                {index > 0 && <Divider />}
                <ListItem
                  sx={{
                    flexDirection: { xs: 'column', sm: 'row' },
                    alignItems: { xs: 'flex-start', sm: 'center' },
                    gap: { xs: 1, sm: 2 },
                    py: { xs: 1.5, sm: 1 },
                  }}
                >
                  <ListItemText
                    primary={`${t('service.requestTitle')} #${request.Number}`}
                    secondary={request.Date}
                    sx={{ m: 0 }}
                  />
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<ViewIcon />}
                    onClick={() => navigate(`/serviceshare/${request.id}`)}
                    sx={{ flexShrink: 0 }}
                  >
                    {t('service.viewRequest')}
                  </Button>
                </ListItem>
              </Box>
            ))}
          </List>
        ) : (
          <Typography color="text.secondary" textAlign="center" py={2}>
            {t('service.noServiceRequests')}
          </Typography>
        )}
      </Paper>

      {/* Rename Dialog */}
      <Dialog open={renameDialog.open} onClose={() => setRenameDialog({ open: false, reservoir: null })}>
        <DialogTitle>{t('reservoirs.rename')}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label={t('reservoirs.newName')}
            fullWidth
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameDialog({ open: false, reservoir: null })}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleRenameSubmit} variant="contained">
            {t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Share Dialog */}
      <Dialog open={shareDialog.open} onClose={() => setShareDialog({ open: false, reservoir: null, link: '', shareKey: '' })} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ShareIcon />
            {t('share.title')}
          </Box>
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            {shareDialog.reservoir?.name}
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
          <Button onClick={() => setShareDialog({ open: false, reservoir: null, link: '', shareKey: '' })}>
            {t('common.close')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={importDialog} onClose={() => setImportDialog(false)}>
        <DialogTitle>{t('points.importByKey')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            {t('share.enterKey')}
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label={t('share.importKey')}
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
            placeholder="abc123xyz"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportDialog(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleImport} variant="contained" disabled={!importKey.trim()}>
            {t('share.import')}
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
