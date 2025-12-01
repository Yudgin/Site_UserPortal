import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  FormControl,
  Select,
  MenuItem,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  Typography,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Chip,
  Tooltip,
  Divider,
} from '@mui/material'
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  DirectionsBoat as BoatIcon,
} from '@mui/icons-material'
import { useBoatStore, ConnectedBoat } from '@/store/boatStore'
import BoatConnection from '@/components/auth/BoatConnection'

export default function BoatSelector() {
  const { t } = useTranslation()
  const { boats, selectedBoatId, selectBoat, removeBoat } = useBoatStore()
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [manageDialogOpen, setManageDialogOpen] = useState(false)

  if (boats.length === 0) {
    return (
      <>
        <Tooltip title={t('boat.connect')}>
          <IconButton color="primary" onClick={() => setAddDialogOpen(true)}>
            <AddIcon />
          </IconButton>
        </Tooltip>

        <Dialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} maxWidth="xs" fullWidth>
          <DialogTitle>{t('boat.connect')}</DialogTitle>
          <DialogContent>
            <BoatConnection onSuccess={() => setAddDialogOpen(false)} />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <BoatIcon color="primary" fontSize="small" />
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <Select
            value={selectedBoatId || ''}
            onChange={(e) => selectBoat(e.target.value)}
            displayEmpty
          >
            {boats.map((boat) => (
              <MenuItem key={boat.credentials.boatId} value={boat.credentials.boatId}>
                {boat.info.name || boat.credentials.boatId}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Tooltip title={t('boat.connect')}>
          <IconButton size="small" onClick={() => setAddDialogOpen(true)}>
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        {boats.length > 0 && (
          <Tooltip title={t('settings.title')}>
            <IconButton size="small" onClick={() => setManageDialogOpen(true)}>
              <BoatIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Add Boat Dialog */}
      <Dialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('boat.connect')}</DialogTitle>
        <DialogContent>
          <BoatConnection onSuccess={() => setAddDialogOpen(false)} />
        </DialogContent>
      </Dialog>

      {/* Manage Boats Dialog */}
      <Dialog open={manageDialogOpen} onClose={() => setManageDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <BoatIcon />
            {t('boat.connected')}
          </Box>
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {boats.length} {t('boat.connected').toLowerCase()}
          </Typography>

          <List>
            {boats.map((boat: ConnectedBoat, index: number) => (
              <Box key={boat.credentials.boatId}>
                {index > 0 && <Divider />}
                <ListItem
                  sx={{
                    bgcolor: boat.credentials.boatId === selectedBoatId ? 'action.selected' : 'transparent',
                    borderRadius: 1,
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    selectBoat(boat.credentials.boatId)
                    setManageDialogOpen(false)
                  }}
                >
                  <ListItemText
                    primary={boat.info.name}
                    secondary={
                      <>
                        ID: {boat.credentials.boatId}
                        <br />
                        Firmware: {boat.info.firmware}
                      </>
                    }
                  />
                  <ListItemSecondaryAction>
                    {boat.credentials.boatId === selectedBoatId && (
                      <Chip label={t('common.edit')} size="small" color="primary" sx={{ mr: 1 }} />
                    )}
                    <IconButton
                      edge="end"
                      color="error"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeBoat(boat.credentials.boatId)
                      }}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </ListItemSecondaryAction>
                </ListItem>
              </Box>
            ))}
          </List>
        </DialogContent>
      </Dialog>
    </>
  )
}
