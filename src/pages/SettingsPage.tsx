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
  TextField,
  Autocomplete,
  CircularProgress,
  Chip,
  Collapse,
} from '@mui/material'
import {
  Language as LanguageIcon,
  Security as SecurityIcon,
  DirectionsBoat as BoatIcon,
  Settings as SettingsIcon,
  Person as PersonIcon,
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
import { searchCities as npSearchCities, getWarehouses as npGetWarehouses, NPCity, NPWarehouse } from '@/api/endpoints/novaposhta'

// Helper to format phone for display
const formatPhoneForDisplay = (phone: string): string => {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('380')) {
    return `+${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10)}`
  }
  return phone
}

export default function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { language, setLanguage, userAccess, setUserAccess, updatePermissions, phoneNumber, setPhoneNumber, profile, setProfile } = useSettingsStore()
  const { getSelectedBoat } = useBoatStore()
  const selectedBoat = getSelectedBoat()

  const [distributors, setDistributors] = useState<Distributor[]>([])
  const [selectedDistributor, setSelectedDistributor] = useState<string>(userAccess?.distributorId || '')
  const [permissions, setPermissions] = useState({
    viewSettings: userAccess?.permissions.viewSettings || false,
    editSettings: userAccess?.permissions.editSettings || false,
    viewReservoirs: userAccess?.permissions.viewReservoirs || false,
  })
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  })

  // Profile form state
  const [lastName, setLastName] = useState(profile?.lastName || '')
  const [firstName, setFirstName] = useState(profile?.firstName || '')
  const [middleName, setMiddleName] = useState(profile?.middleName || '')
  const [showPhoneVerification, setShowPhoneVerification] = useState(false)

  // Nova Poshta state
  const [cities, setCities] = useState<NPCity[]>([])
  const [selectedCity, setSelectedCity] = useState<NPCity | null>(
    profile?.cityRef ? { Ref: profile.cityRef, Description: profile.city } as NPCity : null
  )
  const [cityInput, setCityInput] = useState(profile?.city || '')
  const [loadingCities, setLoadingCities] = useState(false)

  const [warehouses, setWarehouses] = useState<NPWarehouse[]>([])
  const [selectedWarehouse, setSelectedWarehouse] = useState<NPWarehouse | null>(
    profile?.warehouseRef ? { Ref: profile.warehouseRef, Description: profile.warehouse } as NPWarehouse : null
  )
  const [loadingWarehouses, setLoadingWarehouses] = useState(false)

  useEffect(() => {
    loadDistributors()
  }, [])

  // Update form state when profile changes
  useEffect(() => {
    if (profile) {
      setLastName(profile.lastName || '')
      setFirstName(profile.firstName || '')
      setMiddleName(profile.middleName || '')
      if (profile.cityRef) {
        setSelectedCity({ Ref: profile.cityRef, Description: profile.city } as NPCity)
        setCityInput(profile.city)
      }
      if (profile.warehouseRef) {
        setSelectedWarehouse({ Ref: profile.warehouseRef, Description: profile.warehouse } as NPWarehouse)
      }
    }
  }, [profile])


  // Load warehouses when city changes
  useEffect(() => {
    if (selectedCity?.Ref) {
      loadWarehouses(selectedCity.Ref)
    } else {
      setWarehouses([])
      setSelectedWarehouse(null)
    }
  }, [selectedCity])

  const loadDistributors = async () => {
    try {
      const response = await apiClient.get('/distributors')
      setDistributors(response.data || [])
    } catch (error) {
      console.error('Failed to load distributors:', error)
    }
  }

  const searchCities = async (query: string) => {
    if (query.length < 2) {
      setCities([])
      return
    }
    setLoadingCities(true)
    try {
      const result = await npSearchCities(query)
      setCities(result)
    } catch (error) {
      console.error('Error searching cities:', error)
    } finally {
      setLoadingCities(false)
    }
  }

  const loadWarehouses = async (cityRef: string) => {
    setLoadingWarehouses(true)
    try {
      const result = await npGetWarehouses(cityRef)
      setWarehouses(result)
    } catch (error) {
      console.error('Error loading warehouses:', error)
    } finally {
      setLoadingWarehouses(false)
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

  const handleSaveProfile = async () => {
    // Save profile (phone is saved via verification)
    await setProfile({
      lastName,
      firstName,
      middleName,
      city: selectedCity?.Description || '',
      cityRef: selectedCity?.Ref || null,
      warehouse: selectedWarehouse?.Description || '',
      warehouseRef: selectedWarehouse?.Ref || null,
    })

    setSnackbar({ open: true, message: t('service.clientInfoSaved'), severity: 'success' })
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

      {/* User Profile Settings */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <PersonIcon color="primary" />
          <Typography variant="h6">{t('service.clientInfo')}</Typography>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* Phone Number with Verification */}
          {phoneNumber && !showPhoneVerification ? (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                {t('service.phone')}
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  p: 2,
                  borderRadius: 2,
                  bgcolor: 'success.light',
                  color: 'success.contrastText',
                  mb: 1,
                }}
              >
                <VerifiedIcon />
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2" sx={{ opacity: 0.9 }}>
                    {t('phone.phoneVerified')}
                  </Typography>
                  <Typography variant="h6">
                    {formatPhoneForDisplay(phoneNumber)}
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
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                {t('phone.verifyPhone')}
              </Typography>
              <PhoneVerification
                initialPhone={phoneNumber || ''}
                onVerified={handlePhoneVerified}
                onCancel={phoneNumber ? () => setShowPhoneVerification(false) : undefined}
              />
            </Collapse>
          )}

          <Divider sx={{ my: 1 }} />

          {/* Name Fields */}
          <TextField
            label={t('service.lastName')}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            fullWidth
          />
          <TextField
            label={t('service.firstName')}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            fullWidth
          />
          <TextField
            label={t('service.middleName')}
            value={middleName}
            onChange={(e) => setMiddleName(e.target.value)}
            fullWidth
          />

          {/* City Autocomplete */}
          <Autocomplete
            options={cities}
            getOptionLabel={(option) => option.Description || ''}
            value={selectedCity}
            onChange={(_, newValue) => {
              setSelectedCity(newValue)
              setSelectedWarehouse(null)
            }}
            inputValue={cityInput}
            onInputChange={(_, newInputValue) => {
              setCityInput(newInputValue)
              searchCities(newInputValue)
            }}
            loading={loadingCities}
            noOptionsText={t('service.typeToSearch')}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('service.clientCity')}
                placeholder={t('service.typeToSearch')}
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {loadingCities ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />

          {/* Warehouse Autocomplete */}
          <Autocomplete
            options={warehouses}
            getOptionLabel={(option) => option.Description || ''}
            value={selectedWarehouse}
            onChange={(_, newValue) => setSelectedWarehouse(newValue)}
            loading={loadingWarehouses}
            disabled={!selectedCity}
            noOptionsText={selectedCity ? t('service.noWarehouses') : t('service.selectCityFirst')}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('service.clientWarehouse')}
                placeholder={selectedCity ? '' : t('service.selectCityFirst')}
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {loadingWarehouses ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />

          <Button variant="contained" onClick={handleSaveProfile} sx={{ mt: 1 }}>
            {t('common.save')}
          </Button>
        </Box>
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
