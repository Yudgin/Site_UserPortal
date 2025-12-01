import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  List,
  ListItem,
  ListItemText,
  Typography,
  Chip,
  Box,
  Divider,
} from '@mui/material'
import { Point, Delivery } from '@/types/models'
import { deliveriesApi } from '@/api/endpoints/deliveries'
import LoadingSpinner from '@/components/common/LoadingSpinner'

interface DeliveryHistoryProps {
  point: Point | null
  open: boolean
  onClose: () => void
}

export default function DeliveryHistory({ point, open, onClose }: DeliveryHistoryProps) {
  const { t } = useTranslation()
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open && point) {
      loadDeliveries()
    }
  }, [open, point])

  const loadDeliveries = async () => {
    if (!point) return

    setLoading(true)
    const result = await deliveriesApi.getByPoint(point.id)

    if (result.success && result.data) {
      setDeliveries(result.data.deliveries)
    }

    setLoading(false)
  }

  const getStatusColor = (status: Delivery['status']) => {
    switch (status) {
      case 'completed':
        return 'success'
      case 'aborted':
        return 'warning'
      case 'failed':
        return 'error'
      default:
        return 'default'
    }
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {t('deliveries.title')}
        {point && (
          <Typography variant="subtitle2" color="text.secondary">
            #{point.number} {point.name}
          </Typography>
        )}
      </DialogTitle>

      <DialogContent dividers>
        {loading ? (
          <LoadingSpinner />
        ) : deliveries.length === 0 ? (
          <Typography color="text.secondary" textAlign="center" py={4}>
            {t('deliveries.noDeliveries')}
          </Typography>
        ) : (
          <List disablePadding>
            {deliveries.map((delivery, index) => (
              <Box key={delivery.id}>
                {index > 0 && <Divider />}
                <ListItem>
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="body1">
                          {new Date(delivery.timestamp).toLocaleString()}
                        </Typography>
                        <Chip
                          label={t(`deliveries.${delivery.status}`)}
                          size="small"
                          color={getStatusColor(delivery.status)}
                        />
                      </Box>
                    }
                    secondary={
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="body2" component="span">
                          {t('deliveries.duration')}: {formatDuration(delivery.duration)}
                        </Typography>
                        <Typography variant="body2" component="span" sx={{ ml: 2 }}>
                          {t('deliveries.distance')}: {delivery.distance} {t('common.meters')}
                        </Typography>
                      </Box>
                    }
                  />
                </ListItem>
              </Box>
            ))}
          </List>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
      </DialogActions>
    </Dialog>
  )
}
