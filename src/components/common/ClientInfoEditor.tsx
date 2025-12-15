import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  TextField,
  Button,
  CircularProgress,
  Autocomplete,
  Typography,
  Alert,
} from '@mui/material'
import { Save as SaveIcon } from '@mui/icons-material'
import { searchCities, getWarehouses, NPCity, NPWarehouse } from '@/api/endpoints/novaposhta'
import { serviceApi, ClientInfo } from '@/api/endpoints/service'

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

interface ClientInfoEditorProps {
  requestId: string
  clientInfo: ClientInfo | null
  onSave: (updatedInfo: ClientInfo) => void
}

export default function ClientInfoEditor({ requestId, clientInfo, onSave }: ClientInfoEditorProps) {
  const { t } = useTranslation()

  // Form state
  const [lastName, setLastName] = useState(clientInfo?.lastName || '')
  const [firstName, setFirstName] = useState(clientInfo?.firstName || '')
  const [middleName, setMiddleName] = useState(clientInfo?.middleName || '')

  // City autocomplete
  const [cityInputValue, setCityInputValue] = useState(clientInfo?.city || '')
  const [cityOptions, setCityOptions] = useState<NPCity[]>([])
  const [selectedCity, setSelectedCity] = useState<NPCity | null>(null)
  const [loadingCities, setLoadingCities] = useState(false)

  // Warehouse autocomplete
  const [warehouseInputValue, setWarehouseInputValue] = useState(clientInfo?.warehouse || '')
  const [warehouseOptions, setWarehouseOptions] = useState<NPWarehouse[]>([])
  const [selectedWarehouse, setSelectedWarehouse] = useState<NPWarehouse | null>(null)
  const [loadingWarehouses, setLoadingWarehouses] = useState(false)

  // Save state
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

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

  const handleSave = async () => {
    if (!selectedCity || !selectedWarehouse) {
      setError(t('service.selectCityAndWarehouse', 'Оберіть місто та відділення'))
      return
    }

    setSaving(true)
    setError(null)
    setSuccess(false)

    const result = await serviceApi.updateClientInfo(requestId, {
      LastName: lastName,
      FirstName: firstName,
      MiddleName: middleName,
      City: selectedCity.Ref,
      tWarehouse: selectedWarehouse.Ref,
    })

    if (result.success) {
      setSuccess(true)
      onSave({
        lastName,
        firstName,
        middleName,
        city: selectedCity.Description,
        cityRef: selectedCity.Ref,
        warehouse: selectedWarehouse.Description,
        warehouseRef: selectedWarehouse.Ref,
      })
      setTimeout(() => setSuccess(false), 3000)
    } else {
      setError(result.error?.message || t('common.error'))
    }

    setSaving(false)
  }

  const isFormValid = lastName.trim() && firstName.trim() && selectedCity && selectedWarehouse

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="subtitle2" color="text.secondary">
        {t('service.editClientInfo', 'Редагувати дані отримувача')}
      </Typography>

      {/* Name fields */}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <TextField
          label={t('service.lastName', 'Прізвище')}
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          size="small"
          sx={{ flex: 1, minWidth: 150 }}
        />
        <TextField
          label={t('service.firstName', "Ім'я")}
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          size="small"
          sx={{ flex: 1, minWidth: 150 }}
        />
        <TextField
          label={t('service.middleName', 'По батькові')}
          value={middleName}
          onChange={(e) => setMiddleName(e.target.value)}
          size="small"
          sx={{ flex: 1, minWidth: 150 }}
        />
      </Box>

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
        noOptionsText={t('service.typeToSearch', 'Почніть вводити назву міста')}
        loadingText={t('common.loading')}
        renderInput={(params) => (
          <TextField
            {...params}
            label={t('service.clientCity', 'Місто')}
            size="small"
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
        noOptionsText={selectedCity ? t('service.noWarehouses', 'Відділення не знайдено') : t('service.selectCityFirst', 'Спочатку оберіть місто')}
        loadingText={t('common.loading')}
        renderInput={(params) => (
          <TextField
            {...params}
            label={t('service.clientWarehouse', 'Відділення НП')}
            size="small"
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

      {error && <Alert severity="error">{error}</Alert>}
      {success && <Alert severity="success">{t('service.clientInfoSaved', 'Дані збережено')}</Alert>}

      <Button
        variant="contained"
        onClick={handleSave}
        disabled={!isFormValid || saving}
        startIcon={saving ? <CircularProgress size={20} /> : <SaveIcon />}
        sx={{ alignSelf: 'flex-start' }}
      >
        {t('common.save')}
      </Button>
    </Box>
  )
}
