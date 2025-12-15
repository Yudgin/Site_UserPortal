import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Container,
  Paper,
  Box,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Autocomplete,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Stepper,
  Step,
  StepLabel,
  InputAdornment,
} from '@mui/material'
import {
  Phone as PhoneIcon,
  Send as SendIcon,
  Home as HomeIcon,
  CheckCircle as CheckIcon,
} from '@mui/icons-material'
import LanguageSelector from '@/components/common/LanguageSelector'
import { serviceApi, ServiceCenter, NewRepairRequest } from '@/api/endpoints/service'
import { searchCities, getWarehouses, NPCity, NPWarehouse } from '@/api/endpoints/novaposhta'

// Simple debounce helper
function useDebounce<T extends (...args: any[]) => any>(fn: T, delay: number): T {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const debouncedFn = useCallback((...args: Parameters<T>) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = setTimeout(() => {
      fn(...args)
    }, delay)
  }, [fn, delay]) as T

  return debouncedFn
}

export default function NewRepairPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  // Stepper
  const [activeStep, setActiveStep] = useState(0)
  const steps = [
    t('repair.stepContact', 'Контактні дані'),
    t('repair.stepService', 'Сервіс'),
    t('repair.stepDelivery', 'Доставка'),
  ]

  // Form state
  const [phone, setPhone] = useState('')
  const [lastName, setLastName] = useState('')
  const [firstName, setFirstName] = useState('')
  const [middleName, setMiddleName] = useState('')
  const [complaint, setComplaint] = useState('')
  const [selectedServiceCenter, setSelectedServiceCenter] = useState<string>('')

  // Service centers
  const [serviceCenters, setServiceCenters] = useState<ServiceCenter[]>([])
  const [loadingCenters, setLoadingCenters] = useState(true)

  // City autocomplete
  const [cityInputValue, setCityInputValue] = useState('')
  const [cityOptions, setCityOptions] = useState<NPCity[]>([])
  const [selectedCity, setSelectedCity] = useState<NPCity | null>(null)
  const [loadingCities, setLoadingCities] = useState(false)

  // Warehouse autocomplete
  const [warehouseInputValue, setWarehouseInputValue] = useState('')
  const [warehouseOptions, setWarehouseOptions] = useState<NPWarehouse[]>([])
  const [selectedWarehouse, setSelectedWarehouse] = useState<NPWarehouse | null>(null)
  const [loadingWarehouses, setLoadingWarehouses] = useState(false)

  // Submit state
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ id: string } | null>(null)

  // Load service centers on mount
  useEffect(() => {
    loadServiceCenters()
  }, [])

  const loadServiceCenters = async () => {
    setLoadingCenters(true)
    const result = await serviceApi.getServiceCenters()
    if (result.success && result.data) {
      setServiceCenters(result.data)
    }
    setLoadingCenters(false)
  }

  // Debounced city search
  const debouncedCitySearch = useDebounce(async (query: string) => {
    if (query.length < 2) {
      setCityOptions([])
      return
    }
    setLoadingCities(true)
    const cities = await searchCities(query)
    setCityOptions(cities)
    setLoadingCities(false)
  }, 300)

  // Load warehouses when city changes
  useEffect(() => {
    if (selectedCity?.Ref) {
      setLoadingWarehouses(true)
      getWarehouses(selectedCity.Ref).then((warehouses) => {
        setWarehouseOptions(warehouses)
        setLoadingWarehouses(false)
      })
    } else {
      setWarehouseOptions([])
    }
    setSelectedWarehouse(null)
    setWarehouseInputValue('')
  }, [selectedCity])

  // Filter warehouses by input
  const debouncedWarehouseSearch = useDebounce(async (query: string) => {
    if (!selectedCity?.Ref) return
    setLoadingWarehouses(true)
    const warehouses = await getWarehouses(selectedCity.Ref, query)
    setWarehouseOptions(warehouses)
    setLoadingWarehouses(false)
  }, 300)

  // Format phone input
  const handlePhoneChange = (value: string) => {
    const cleaned = value.replace(/[^\d+\s-]/g, '')
    setPhone(cleaned)
  }

  // Validate phone
  const isValidPhone = (phone: string): boolean => {
    const cleaned = phone.replace(/\D/g, '')
    if (cleaned.startsWith('380')) {
      return cleaned.length === 12
    }
    if (cleaned.startsWith('0')) {
      return cleaned.length === 10
    }
    return cleaned.length >= 9
  }

  // Format phone for API
  const formatPhoneForApi = (phone: string): string => {
    let cleaned = phone.replace(/\D/g, '')
    if (cleaned.startsWith('0')) {
      cleaned = '38' + cleaned
    } else if (!cleaned.startsWith('380') && cleaned.length === 9) {
      cleaned = '380' + cleaned
    }
    return '+' + cleaned
  }

  // Step validation
  const isStep1Valid = isValidPhone(phone) && lastName.trim() && firstName.trim()
  const isStep2Valid = selectedServiceCenter && complaint.trim()
  const isStep3Valid = selectedCity && selectedWarehouse

  const handleNext = () => {
    setActiveStep((prev) => prev + 1)
  }

  const handleBack = () => {
    setActiveStep((prev) => prev - 1)
  }

  const handleSubmit = async () => {
    if (!selectedCity || !selectedWarehouse) return

    setSubmitting(true)
    setError(null)

    const request: NewRepairRequest = {
      phone_number: formatPhoneForApi(phone),
      Service: selectedServiceCenter,
      Disc: complaint,
      LastName: lastName,
      FirstName: firstName,
      MiddleName: middleName,
      City: selectedCity.Ref,
      tWarehouse: selectedWarehouse.Ref,
    }

    const result = await serviceApi.createRepairRequest(request)

    if (result.success && result.data) {
      setSuccess({ id: result.data.ID })
    } else {
      setError(result.error?.message || t('common.error'))
    }

    setSubmitting(false)
  }

  // Success screen
  if (success) {
    return (
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <img src="/logo.svg" alt="Logo" style={{ height: 160 }} />
            <Button variant="outlined" startIcon={<HomeIcon />} onClick={() => navigate('/')}>
              {t('common.home')}
            </Button>
          </Box>
          <LanguageSelector />
        </Box>

        <Container maxWidth="sm" sx={{ py: 4 }}>
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <CheckIcon sx={{ fontSize: 80, color: 'success.main', mb: 2 }} />
            <Typography variant="h4" gutterBottom>
              {t('repair.success', 'Заявку створено!')}
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
              {t('repair.successMessage', 'Ваша заявка на ремонт успішно створена. Ми зв\'яжемося з вами найближчим часом.')}
            </Typography>
            <Alert severity="info" sx={{ mb: 3, textAlign: 'left' }}>
              <Typography variant="body2">
                {t('repair.requestId', 'Номер заявки')}: <strong>{success.id}</strong>
              </Typography>
            </Alert>
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
              <Button variant="contained" onClick={() => navigate(`/service/${success.id}`)}>
                {t('repair.viewRequest', 'Переглянути заявку')}
              </Button>
              <Button variant="outlined" onClick={() => navigate('/')}>
                {t('common.home')}
              </Button>
            </Box>
          </Paper>
        </Container>
      </Box>
    )
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <img src="/logo.svg" alt="Logo" style={{ height: 160 }} />
          <Button variant="outlined" startIcon={<HomeIcon />} onClick={() => navigate('/')}>
            {t('common.home')}
          </Button>
        </Box>
        <LanguageSelector />
      </Box>

      <Container maxWidth="md" sx={{ pb: 4 }}>
        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" gutterBottom>
            {t('repair.title', 'Нова заявка на ремонт')}
          </Typography>

          {/* Stepper */}
          <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
            {steps.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>

          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}

          {/* Step 1: Contact Info */}
          {activeStep === 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <TextField
                label={t('repair.phone', 'Номер телефону')}
                value={phone}
                onChange={(e) => handlePhoneChange(e.target.value)}
                placeholder="+380 XX XXX XX XX"
                fullWidth
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <PhoneIcon />
                    </InputAdornment>
                  ),
                }}
                helperText={t('phone.ukrainianOnly')}
              />

              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                <TextField
                  label={t('service.lastName')}
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  sx={{ flex: 1, minWidth: 200 }}
                  required
                />
                <TextField
                  label={t('service.firstName')}
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  sx={{ flex: 1, minWidth: 200 }}
                  required
                />
                <TextField
                  label={t('service.middleName')}
                  value={middleName}
                  onChange={(e) => setMiddleName(e.target.value)}
                  sx={{ flex: 1, minWidth: 200 }}
                />
              </Box>

              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="contained" onClick={handleNext} disabled={!isStep1Valid}>
                  {t('common.next')}
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 2: Service & Complaint */}
          {activeStep === 1 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <FormControl fullWidth>
                <InputLabel>{t('repair.serviceCenter', 'Сервісний центр')}</InputLabel>
                <Select
                  value={selectedServiceCenter}
                  onChange={(e) => setSelectedServiceCenter(e.target.value)}
                  label={t('repair.serviceCenter', 'Сервісний центр')}
                  disabled={loadingCenters}
                >
                  {serviceCenters.map((center) => (
                    <MenuItem key={center.ID} value={center.ID}>
                      {center.Name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                label={t('repair.complaint', 'Опис проблеми')}
                value={complaint}
                onChange={(e) => setComplaint(e.target.value)}
                multiline
                rows={4}
                fullWidth
                placeholder={t('repair.complaintPlaceholder', 'Опишіть проблему з вашим пристроєм...')}
              />

              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Button onClick={handleBack}>{t('common.back')}</Button>
                <Button variant="contained" onClick={handleNext} disabled={!isStep2Valid}>
                  {t('common.next')}
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 3: Delivery Address */}
          {activeStep === 2 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Typography variant="body1" color="text.secondary">
                {t('repair.deliveryInfo', 'Вкажіть адресу відділення Нової Пошти, з якого ви надішлете пристрій')}
              </Typography>

              {/* City autocomplete */}
              <Autocomplete
                options={cityOptions}
                getOptionLabel={(option) => option.Description}
                value={selectedCity}
                onChange={(_, newValue) => setSelectedCity(newValue)}
                inputValue={cityInputValue}
                onInputChange={(_, newInputValue) => {
                  setCityInputValue(newInputValue)
                  debouncedCitySearch(newInputValue)
                }}
                loading={loadingCities}
                noOptionsText={t('service.typeToSearch')}
                loadingText={t('common.loading')}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={t('service.clientCity')}
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
                isOptionEqualToValue={(option, value) => option.Ref === value.Ref}
              />

              {/* Warehouse autocomplete */}
              <Autocomplete
                options={warehouseOptions}
                getOptionLabel={(option) => option.Description}
                value={selectedWarehouse}
                onChange={(_, newValue) => setSelectedWarehouse(newValue)}
                inputValue={warehouseInputValue}
                onInputChange={(_, newInputValue) => {
                  setWarehouseInputValue(newInputValue)
                  if (selectedCity?.Ref && newInputValue.length >= 1) {
                    debouncedWarehouseSearch(newInputValue)
                  }
                }}
                loading={loadingWarehouses}
                disabled={!selectedCity}
                noOptionsText={selectedCity ? t('service.noWarehouses') : t('service.selectCityFirst')}
                loadingText={t('common.loading')}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={t('service.clientWarehouse')}
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
                isOptionEqualToValue={(option, value) => option.Ref === value.Ref}
              />

              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Button onClick={handleBack}>{t('common.back')}</Button>
                <Button
                  variant="contained"
                  onClick={handleSubmit}
                  disabled={!isStep3Valid || submitting}
                  startIcon={submitting ? <CircularProgress size={20} /> : <SendIcon />}
                >
                  {t('repair.submit', 'Створити заявку')}
                </Button>
              </Box>
            </Box>
          )}
        </Paper>
      </Container>
    </Box>
  )
}
