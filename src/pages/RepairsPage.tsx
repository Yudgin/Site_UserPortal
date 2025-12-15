import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemText,
  Divider,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material'
import {
  Build as ServiceIcon,
  Visibility as ViewIcon,
  Add as AddIcon,
  History as HistoryIcon,
} from '@mui/icons-material'
import { useSettingsStore } from '@/store/settingsStore'
import { serviceApi } from '@/api/endpoints/service'

interface RepairItem {
  id: string
  Number: string
  Date: string
}

interface HistoryItem {
  Desc: string
  Date: string
}

export default function RepairsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { phoneNumber } = useSettingsStore()

  const [repairRequests, setRepairRequests] = useState<RepairItem[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)

  useEffect(() => {
    if (phoneNumber) {
      loadRepairRequests()
      loadHistory()
    } else {
      setRepairRequests([])
      setHistory([])
    }
  }, [phoneNumber])

  const loadRepairRequests = async () => {
    if (!phoneNumber) return
    setLoading(true)
    try {
      const result = await serviceApi.getRepairList(phoneNumber)
      if (result.success && result.data) {
        setRepairRequests(result.data)
      }
    } catch (error) {
      console.error('Failed to load repair requests:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadHistory = async () => {
    if (!phoneNumber) return
    setHistoryLoading(true)
    try {
      const result = await serviceApi.getRepairHistory(phoneNumber)
      if (result.success && result.data) {
        setHistory(result.data)
      }
    } catch (error) {
      console.error('Failed to load history:', error)
    } finally {
      setHistoryLoading(false)
    }
  }

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr)
      return date.toLocaleString()
    } catch {
      return dateStr
    }
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ServiceIcon color="primary" sx={{ fontSize: 32 }} />
          <Typography variant="h4">{t('repairs.title')}</Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => navigate('/repair/new')}
          size="large"
        >
          {t('repair.title')}
        </Button>
      </Box>

      <Paper sx={{ p: 3 }}>
        {!phoneNumber ? (
          <Alert severity="info">
            {t('service.addPhoneToSeeRequests')}
            <Button
              size="small"
              onClick={() => navigate('/settings')}
              sx={{ ml: 2 }}
            >
              {t('settings.title')}
            </Button>
          </Alert>
        ) : loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
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
                    py: 2,
                  }}
                >
                  <ListItemText
                    primary={
                      <Typography variant="h6">
                        {t('service.requestTitle')} #{request.Number}
                      </Typography>
                    }
                    secondary={request.Date}
                    sx={{ m: 0 }}
                  />
                  <Button
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
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <ServiceIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography color="text.secondary" variant="h6">
              {t('service.noServiceRequests')}
            </Typography>
            <Typography color="text.secondary" variant="body2" sx={{ mb: 3 }}>
              {t('repairs.createFirstRequest')}
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => navigate('/repair/new')}
            >
              {t('repair.title')}
            </Button>
          </Box>
        )}
      </Paper>

      {/* Communication History Section */}
      {phoneNumber && (
        <Paper sx={{ p: 3, mt: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <HistoryIcon color="primary" />
            <Typography variant="h6">{t('service.communicationHistory')}</Typography>
          </Box>

          {historyLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : history.length > 0 ? (
            <List>
              {history.map((item, index) => (
                <Box key={index}>
                  {index > 0 && <Divider />}
                  <ListItem sx={{ py: 1.5 }}>
                    <ListItemText
                      primary={item.Desc}
                      secondary={formatDate(item.Date)}
                    />
                  </ListItem>
                </Box>
              ))}
            </List>
          ) : (
            <Typography color="text.secondary" textAlign="center" py={2}>
              {t('service.noHistory')}
            </Typography>
          )}
        </Paper>
      )}
    </Box>
  )
}
