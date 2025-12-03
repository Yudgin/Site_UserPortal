import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Paper,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Button,
  Divider,
  Alert,
  Snackbar,
  Card,
  CardContent,
  Chip,
  Collapse,
} from '@mui/material'
import {
  Language as LanguageIcon,
  Security as SecurityIcon,
  DirectionsBoat as BoatIcon,
  Settings as SettingsIcon,
  Phone as PhoneIcon,
  CheckCircle as VerifiedIcon,
  Edit as EditIcon,
} from '@mui/icons-material'
import { languages } from '@/i18n'
import { useSettingsStore } from '@/store/settingsStore'
import { useBoatStore } from '@/store/boatStore'
import apiClient from '@/api/client'
import { Distributor } from '@/types/models'
import BoatSettings from '@/components/settings/BoatSettings'
import PhoneVerification from '@/components/common/PhoneVerification'
import { smsApi } from '@/api/endpoints/sms'

export default function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { language, setLanguage, userAccess, setUserAccess, updatePermissions, phoneNumber, setPhoneNumber } = useSettingsStore()
  const { getSelectedBoat } = useBoatStore()
  const selectedBoat = getSelectedBoat()

  const [distributors, setDistributors] = useState<Distributor[]>([])
  const [selectedDistributor, setSelectedDistributor] = useState<string>(userAccess?.distributorId || '')
  const [permissions, setPermissions] = useState({
    viewSettings: userAccess?.permissions.viewSettings || false,
    editSettings: userAccess?.permissions.editSettings || false,
    viewReservoirs: userAccess?.permissions.viewReservoirs || false,
  })
  const [showPhoneVerification, setShowPhoneVerification] = useState(false)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  })

  useEffect(() => {
    loadDistributors()
  }, [])

  const loadDistributors = async () => {
    try {
      const response = await apiClient.get('/distributors')
      setDistributors(response.data || [])
    } catch (error) {
      console.error('Failed to load distributors:', error)
    }
  }

  const handleLanguageChange = (code: string) => {
    setLanguage(code)
    i18n.changeLanguage(code)
  }

  const handlePhoneVerified = (verifiedPhone: string) => {
    setPhoneNumber(verifiedPhone)
    setShowPhoneVerification(false)
    setSnackbar({ open: true, message: t('phone.phoneVerified'), severity: 'success' })
  }

  const handleRemovePhone = () => {
    setPhoneNumber(null)
    setSnackbar({ open: true, message: t('common.success'), severity: 'success' })
  }

  const handlePermissionChange = (key: keyof typeof permissions) => {
    const newPermissions = { ...permissions, [key]: !permissions[key] }
    setPermissions(newPermissions)
    updatePermissions(newPermissions)
  }

  const handleSaveAccess = async () => {
    if (!selectedBoat) return

    const useMock = import.meta.env.VITE_USE_MOCK_API === 'true'

    try {
      if (!useMock) {
        // Send to real API when available
        await apiClient.put('/users/access', {
          boatId: selectedBoat.credentials.boatId,
          boatPassword: selectedBoat.credentials.boatPassword,
          distributorId: selectedDistributor,
          permissions,
        })
      }

      // Save locally (works for both mock and real API)
      setUserAccess({
        distributorId: selectedDistributor,
        permissions,
      })

      setSnackbar({ open: true, message: t('common.success'), severity: 'success' })
    } catch (error) {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' })
    }
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        {t('settings.title')}
      </Typography>

      {/* Boat Info */}
      {selectedBoat && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <BoatIcon color="primary" />
              <Typography variant="h6">{t('boat.connected')}</Typography>
            </Box>
            <Typography variant="body1">{selectedBoat.info.name}</Typography>
            <Typography variant="body2" color="text.secondary">
              ID: {selectedBoat.credentials.boatId}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Firmware: {selectedBoat.info.firmware}
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Language Settings */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <LanguageIcon color="primary" />
          <Typography variant="h6">{t('settings.language')}</Typography>
        </Box>

        <FormControl fullWidth>
          <InputLabel>{t('settings.language')}</InputLabel>
          <Select
            value={language}
            label={t('settings.language')}
            onChange={(e) => handleLanguageChange(e.target.value)}
          >
            {languages.map((lang) => (
              <MenuItem key={lang.code} value={lang.code}>
                {lang.flag} {lang.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Paper>

      {/* Phone Number Settings */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <PhoneIcon color="primary" />
          <Typography variant="h6">{t('service.phone')}</Typography>
        </Box>

        <Alert severity="info" sx={{ mb: 3 }}>
          {t('service.myServiceRequests')}
        </Alert>

        {/* Show verified phone or verification form */}
        {phoneNumber && !showPhoneVerification ? (
          <Box>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                p: 2,
                borderRadius: 2,
                bgcolor: 'success.light',
                color: 'success.contrastText',
                mb: 2,
              }}
            >
              <VerifiedIcon />
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" sx={{ opacity: 0.9 }}>
                  {t('phone.phoneVerified')}
                </Typography>
                <Typography variant="h6">
                  {smsApi.formatForDisplay(phoneNumber)}
                </Typography>
              </Box>
              <Chip
                label={t('phone.changeVerifiedPhone')}
                icon={<EditIcon />}
                onClick={() => setShowPhoneVerification(true)}
                sx={{ bgcolor: 'white', color: 'success.dark' }}
              />
            </Box>
            <Button
              variant="outlined"
              color="error"
              size="small"
              onClick={handleRemovePhone}
            >
              {t('common.delete')}
            </Button>
          </Box>
        ) : (
          <Collapse in={!phoneNumber || showPhoneVerification}>
            <PhoneVerification
              initialPhone={phoneNumber || ''}
              onVerified={handlePhoneVerified}
              onCancel={phoneNumber ? () => setShowPhoneVerification(false) : undefined}
            />
          </Collapse>
        )}
      </Paper>

      {/* Access Settings */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <SecurityIcon color="primary" />
          <Typography variant="h6">{t('settings.access')}</Typography>
        </Box>

        <FormControl fullWidth sx={{ mb: 3 }}>
          <InputLabel>{t('settings.distributor')}</InputLabel>
          <Select
            value={selectedDistributor}
            label={t('settings.distributor')}
            onChange={(e) => setSelectedDistributor(e.target.value)}
          >
            <MenuItem value="">
              <em>None</em>
            </MenuItem>
            {distributors.map((dist) => (
              <MenuItem key={dist.id} value={dist.id}>
                {dist.name} ({dist.region})
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle1" gutterBottom>
          {t('settings.permissions')}
        </Typography>

        <Alert severity="info" sx={{ mb: 2 }}>
          These permissions control what your distributor can see and modify.
        </Alert>

        <FormGroup>
          <FormControlLabel
            control={
              <Checkbox
                checked={permissions.viewSettings}
                onChange={() => handlePermissionChange('viewSettings')}
              />
            }
            label={t('settings.viewSettings')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={permissions.editSettings}
                onChange={() => handlePermissionChange('editSettings')}
              />
            }
            label={t('settings.editSettings')}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={permissions.viewReservoirs}
                onChange={() => handlePermissionChange('viewReservoirs')}
              />
            }
            label={t('settings.viewReservoirs')}
          />
        </FormGroup>

        <Button variant="contained" onClick={handleSaveAccess} sx={{ mt: 2 }}>
          {t('common.save')}
        </Button>
      </Paper>

      {/* Boat Settings */}
      <Paper sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <SettingsIcon color="primary" />
          <Typography variant="h6">{t('settings.boatSettings') || t('settings.autopilot')}</Typography>
        </Box>

        <BoatSettings />
      </Paper>

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
