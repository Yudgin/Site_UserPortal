import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
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
  List,
  ListItemButton,
  ListItemText,
  Collapse,
  Chip,
  Switch,
  FormControlLabel,
  Checkbox,
  Divider,
  Stack,
  Link,
} from '@mui/material'
import {
  Phone as PhoneIcon,
  Send as SendIcon,
  Home as HomeIcon,
  CheckCircle as CheckIcon,
  ExpandMore as ExpandMoreIcon,
  ChevronRight as ChevronRightIcon,
} from '@mui/icons-material'
import LanguageSelector from '@/components/common/LanguageSelector'
import { serviceApi, ServiceCenter, ServiceTypeItem, NewRepairRequest } from '@/api/endpoints/service'
import { serviceRequestApi } from '@/api/endpoints/serviceRequest'
import { chatSessionService } from '@/api/chatSessionService'
import { clientProfileService } from '@/api/clientProfileService'
import { aiApi } from '@/api/endpoints/ai'
import { defaultAuthorization, NO_REAPPROVAL_DEVIATION_PCT } from '@/types/chat'
import { searchCities, getWarehouses, NPCity, NPWarehouse } from '@/api/endpoints/novaposhta'
import { useSettingsStore } from '@/store/settingsStore'

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
  const [searchParams] = useSearchParams()

  // Get user profile data from settings store
  const { phoneNumber: savedPhone, profile: savedProfile } = useSettingsStore()

  // Stepper
  const [activeStep, setActiveStep] = useState(0)
  const steps = [
    t('repair.stepContact', 'Контактні дані'),
    t('repair.stepServiceType', 'Тип сервісу'),
    t('repair.stepService', 'Сервіс'),
    t('repair.stepDelivery', 'Доставка'),
  ]
  // Из чата тип сервиса уже подразумевается (ремонт) — шаг «Тип сервісу» пропускаем,
  // тип подбираем автоматически. stepFlow — реальные индексы шагов в порядке показа.
  const fromChat = !!searchParams.get('chat')
  const stepFlow = fromChat ? [0, 2, 3] : [0, 1, 2, 3]
  const displayLabels = stepFlow.map((i) => steps[i])
  const displayIndex = Math.max(0, stepFlow.indexOf(activeStep))

  // Service types
  const [serviceTypes, setServiceTypes] = useState<ServiceTypeItem[]>([])
  const [loadingTypes, setLoadingTypes] = useState(true)
  const [selectedServiceType, setSelectedServiceType] = useState<{ id: string; name: string; path: string[] } | null>(null)
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())

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
  // Согласование объёма работ + принятие условий (на стадии заявки)
  const [authorization, setAuthorization] = useState(defaultAuthorization())
  const [acceptedTerms, setAcceptedTerms] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ id: string } | null>(null)

  // Load service centers and types on mount
  useEffect(() => {
    loadServiceCenters()
    loadServiceTypes()
  }, [])

  // Handle URL parameter for service type
  useEffect(() => {
    const typeParam = searchParams.get('type')
    if (typeParam && serviceTypes.length > 0) {
      const found = findServiceTypeById(serviceTypes, typeParam)
      if (found) {
        setSelectedServiceType(found)
        // Expand parent items
        const newExpanded = new Set<string>()
        found.path.forEach((id) => newExpanded.add(id))
        setExpandedItems(newExpanded)
      }
    }
  }, [searchParams, serviceTypes])

  // Prefill from chat session (arriving from estimate chat: /repair/new?chat=<id>).
  // Контакт переносим, а описание проблемы — ИИ-резюме диалога (неисправность + план),
  // а не сырой текст переписки.
  useEffect(() => {
    const chatId = searchParams.get('chat')
    if (!chatId) return
    ;(async () => {
      const s = await chatSessionService.load(chatId)
      if (!s) return
      if (s.contact?.phone) setPhone((p) => p || s.contact!.phone!)
      if (s.contact?.name) setFirstName((n) => n || s.contact!.name!)
      const firstClient = s.messages.find((m) => m.role === 'client' && !m.internal)
      const convo = s.messages
        .filter((m) => !m.internal && m.text)
        .map((m) => `${m.role === 'client' ? 'Клієнт' : m.role === 'manager' ? 'Менеджер' : 'Помічник'}: ${m.text}`)
        .join('\n')
      let summary = firstClient?.text || ''
      if (convo) {
        const res = await aiApi.improveText({
          currentText: convo,
          userPrompt: 'Підсумуй це звернення для заявки на ремонт: коротко (2–4 речення) опиши, яка несправність і що плануємо зробити (якщо це зрозуміло з діалогу). Без вступних фраз, лише суть.',
          context: 'diagnostics',
          lang: 'uk',
        })
        if (res.success && res.data?.text) summary = res.data.text
      }
      if (summary) setComplaint((c) => c || summary)
    })()
  }, [searchParams]) // eslint-disable-line react-hooks/exhaustive-deps

  // Из чата тип сервиса не спрашиваем — авто-выбираем первый доступный (лист дерева).
  useEffect(() => {
    if (!fromChat || selectedServiceType || serviceTypes.length === 0) return
    const firstLeaf = (items: ServiceTypeItem[]): { id: string; name: string; path: string[] } | null => {
      for (const it of items) {
        if (!it.List || it.List.length === 0) return { id: it.ID, name: it.Name, path: [] }
        const found = firstLeaf(it.List)
        if (found) return found
      }
      return null
    }
    const leaf = firstLeaf(serviceTypes)
    if (leaf) setSelectedServiceType(leaf)
  }, [fromChat, serviceTypes, selectedServiceType])

  // Auto-fill form from user profile
  useEffect(() => {
    // Fill phone number
    if (savedPhone && !phone) {
      setPhone(savedPhone)
    }

    // Fill name fields from profile
    if (savedProfile) {
      if (savedProfile.lastName && !lastName) {
        setLastName(savedProfile.lastName)
      }
      if (savedProfile.firstName && !firstName) {
        setFirstName(savedProfile.firstName)
      }
      if (savedProfile.middleName && !middleName) {
        setMiddleName(savedProfile.middleName)
      }

      // Fill city from profile
      if (savedProfile.city && savedProfile.cityRef && !selectedCity) {
        const cityFromProfile: NPCity = {
          Ref: savedProfile.cityRef,
          Description: savedProfile.city,
          DescriptionRu: savedProfile.city,
          Area: '',
          AreaDescription: '',
        }
        setSelectedCity(cityFromProfile)
        setCityInputValue(savedProfile.city)
      }
    }
  }, [savedPhone, savedProfile]) // Only run on initial load

  // Auto-fill warehouse when city is set from profile
  useEffect(() => {
    if (savedProfile?.warehouseRef && savedProfile?.warehouse && selectedCity && !selectedWarehouse) {
      // Check if the city matches the saved profile city
      if (selectedCity.Ref === savedProfile.cityRef) {
        const warehouseFromProfile: NPWarehouse = {
          Ref: savedProfile.warehouseRef,
          Description: savedProfile.warehouse,
          DescriptionRu: savedProfile.warehouse,
          Number: '',
          CityRef: selectedCity.Ref,
          CityDescription: savedProfile.city,
          TypeOfWarehouse: '',
        }
        setSelectedWarehouse(warehouseFromProfile)
        setWarehouseInputValue(savedProfile.warehouse)
      }
    }
  }, [selectedCity, savedProfile, warehouseOptions])

  // Find service type by ID recursively
  const findServiceTypeById = (
    items: ServiceTypeItem[],
    id: string,
    path: string[] = []
  ): { id: string; name: string; path: string[] } | null => {
    for (const item of items) {
      if (item.ID === id) {
        return { id: item.ID, name: item.Name, path }
      }
      if (item.List && item.List.length > 0) {
        const found = findServiceTypeById(item.List, id, [...path, item.ID])
        if (found) return found
      }
    }
    return null
  }

  const loadServiceTypes = async () => {
    setLoadingTypes(true)
    const result = await serviceApi.getServiceTypeList()
    if (result.success && result.data) {
      setServiceTypes(result.data)
    }
    setLoadingTypes(false)
  }

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
  const isStep2Valid = selectedServiceType !== null
  const isStep3Valid = selectedServiceCenter && complaint.trim() && acceptedTerms
  const isStep4Valid = selectedCity && selectedWarehouse

  // Toggle expand item
  const toggleExpand = (id: string) => {
    const newExpanded = new Set(expandedItems)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    setExpandedItems(newExpanded)
  }

  // Select service type (only leaf nodes - items without children)
  const handleSelectServiceType = (item: ServiceTypeItem, path: string[]) => {
    if (!item.List || item.List.length === 0) {
      setSelectedServiceType({ id: item.ID, name: item.Name, path })
    }
  }

  // Render service type tree recursively
  const renderServiceTypeTree = (items: ServiceTypeItem[], level: number = 0, path: string[] = []): React.ReactNode => {
    return items.map((item) => {
      const hasChildren = item.List && item.List.length > 0
      const isExpanded = expandedItems.has(item.ID)
      const isSelected = selectedServiceType?.id === item.ID
      const currentPath = [...path, item.ID]

      return (
        <Box key={item.ID}>
          <ListItemButton
            onClick={() => {
              if (hasChildren) {
                toggleExpand(item.ID)
              } else {
                handleSelectServiceType(item, path)
              }
            }}
            selected={isSelected}
            sx={{ pl: 2 + level * 2 }}
          >
            {hasChildren ? (
              isExpanded ? <ExpandMoreIcon /> : <ChevronRightIcon />
            ) : (
              <Box sx={{ width: 24 }} />
            )}
            <ListItemText primary={item.Name} />
          </ListItemButton>
          {hasChildren && (
            <Collapse in={isExpanded} timeout="auto" unmountOnExit>
              <List component="div" disablePadding>
                {renderServiceTypeTree(item.List!, level + 1, currentPath)}
              </List>
            </Collapse>
          )}
        </Box>
      )
    })
  }

  const handleNext = () => {
    const i = stepFlow.indexOf(activeStep)
    setActiveStep(stepFlow[Math.min(i + 1, stepFlow.length - 1)])
  }

  const handleBack = () => {
    const i = stepFlow.indexOf(activeStep)
    setActiveStep(stepFlow[Math.max(i - 1, 0)])
  }

  const handleSubmit = async () => {
    if (!selectedCity || !selectedWarehouse) return

    setSubmitting(true)
    setError(null)

    const request: NewRepairRequest = {
      phone_number: formatPhoneForApi(phone),
      Service: selectedServiceCenter,
      ServiceType: selectedServiceType?.id,
      Disc: complaint,
      LastName: lastName,
      FirstName: firstName,
      MiddleName: middleName,
      City: selectedCity.Ref,
      tWarehouse: selectedWarehouse.Ref,
    }

    const result = await serviceApi.createRepairRequest(request)

    if (result.success && result.data) {
      // 1С может вернуть success без номера — не строим по нему URL и не теряем локальную запись.
      const requestId = String(result.data.ID || '').trim()
      // Принятие условий → в 1С (окремий ендпоінт). Тільки за наявності номера. Best-effort.
      if (acceptedTerms && requestId) {
        await serviceApi.acceptTerms(requestId).catch(() => {})
      }
      // Сохраняем согласование в связанную чат-сессию (если заявка из чата) — менеджер увидит его.
      const chatId = searchParams.get('chat')
      if (chatId) {
        const s = await chatSessionService.load(chatId)
        if (s) await chatSessionService.save({ ...s, authorization, outcome: 'repair-request' })
      }
      // Профиль клиента по телефону (авто-слияние по номеру)
      if (phone.trim()) {
        await clientProfileService.upsertByPhone(phone, {
          name: `${lastName} ${firstName}`.trim(),
          sessionId: chatId || null,
        })
      }
      // Заявку храним И у себя: локальная serviceRequest, связанная с 1С через externalRequestId.
      await serviceRequestApi.createLocal({
        sessionId: chatId || null,
        externalRequestId: requestId || null,
        clientName: `${lastName} ${firstName}`.trim(),
        clientPhone: formatPhoneForApi(phone),
        // Адрес отправки клиента (НП) — чтобы потом подставился при создании ТТН.
        clientCityRef: selectedCity?.Ref,
        clientCityName: selectedCity?.Description,
        clientWarehouseRef: selectedWarehouse?.Ref,
        clientWarehouseName: selectedWarehouse?.Description,
        complaint,
      }).catch(() => {})
      setSuccess({ id: requestId })
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
          <Stepper activeStep={displayIndex} sx={{ mb: 4 }}>
            {displayLabels.map((label) => (
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

          {/* Step 2: Service Type */}
          {activeStep === 1 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Typography variant="body1" color="text.secondary">
                {t('repair.selectServiceType', 'Оберіть тип послуги')}
              </Typography>

              {selectedServiceType && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2">{t('repair.selected', 'Обрано')}:</Typography>
                  <Chip
                    label={selectedServiceType.name}
                    color="primary"
                    onDelete={() => setSelectedServiceType(null)}
                  />
                </Box>
              )}

              {loadingTypes ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                  <CircularProgress />
                </Box>
              ) : (
                <Paper variant="outlined" sx={{ maxHeight: 400, overflow: 'auto' }}>
                  <List component="nav">
                    {renderServiceTypeTree(serviceTypes)}
                  </List>
                </Paper>
              )}

              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Button onClick={handleBack}>{t('common.back')}</Button>
                <Button variant="contained" onClick={handleNext} disabled={!isStep2Valid}>
                  {t('common.next')}
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 3: Service & Complaint */}
          {activeStep === 2 && (
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

              {/* Согласование объёма работ (переключатели с интервалами) */}
              <Divider textAlign="left"><Typography variant="caption">Погодження робіт</Typography></Divider>
              <Alert severity="info" icon={false} sx={{ fontSize: 13, py: 0.5 }}>
                Якщо фактична смета відрізняється від попередньої не більше ніж на {NO_REAPPROVAL_DEVIATION_PCT}% —
                додаткове погодження не потрібне.
              </Alert>
              <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                <FormControlLabel sx={{ alignItems: 'flex-start', m: 0 }}
                  control={<Switch checked={authorization.fixOtherVisibleDefects} onChange={(e) => setAuthorization({ ...authorization, fixOtherVisibleDefects: e.target.checked })} />}
                  label="Усувати інші видимі дефекти, виявлені під час діагностики/ремонту" />
                <FormControlLabel sx={{ alignItems: 'flex-start', m: 0 }}
                  control={<Switch checked={authorization.autoApproveNewDefects} onChange={(e) => setAuthorization({ ...authorization, autoApproveNewDefects: e.target.checked })} />}
                  label={`Дозволяю роботи по нових дефектах без окремого погодження, якщо їх вартість ≤ ${authorization.newDefectsBoatPctThreshold}% вартості кораблика`} />
                <FormControlLabel sx={{ alignItems: 'flex-start', m: 0 }}
                  control={<Switch checked={authorization.autoApproveEstimateIncrease} onChange={(e) => setAuthorization({ ...authorization, autoApproveEstimateIncrease: e.target.checked })} />}
                  label={`Дозволяю ремонт без додаткового погодження, якщо смета зросла, але не більше ніж на ${authorization.estimateIncreasePctThreshold}%`} />
              </Stack>

              <FormControlLabel sx={{ alignItems: 'flex-start', m: 0 }}
                control={<Checkbox checked={acceptedTerms} onChange={(e) => setAcceptedTerms(e.target.checked)} />}
                label={<Typography variant="body2">Я приймаю <Link href="/service-content-admin" target="_blank" rel="noopener">умови обслуговування</Link> сервісу</Typography>} />

              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Button onClick={handleBack}>{t('common.back')}</Button>
                <Button variant="contained" onClick={handleNext} disabled={!isStep3Valid}>
                  {t('common.next')}
                </Button>
              </Box>
            </Box>
          )}

          {/* Step 4: Delivery Address */}
          {activeStep === 3 && (
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
                  disabled={!isStep4Valid || submitting}
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
