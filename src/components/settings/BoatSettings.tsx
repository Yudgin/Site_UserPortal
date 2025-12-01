import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Chip,
  Grid,
  Snackbar,
} from '@mui/material'
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material'
import { BoatSettingGroup, BoatSettingParameter } from '@/types/models'
import { settingsApi } from '@/api/endpoints/settings'
import { useBoatStore } from '@/store/boatStore'

interface SettingSelectProps {
  parameter: BoatSettingParameter
  value: number | undefined
  onChange: (id: number, value: number) => void
}

function SettingSelect({ parameter, value, onChange }: SettingSelectProps) {
  const options = Object.entries(parameter.Value)
    .map(([key, label]) => ({ value: parseInt(key), label }))
    .sort((a, b) => a.value - b.value)

  // Если нет вариантов значений, не показываем селект
  if (options.length === 0) {
    return (
      <Box sx={{ mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {parameter.Name}
        </Typography>
        <Chip label="N/A" size="small" variant="outlined" />
      </Box>
    )
  }

  // Определяем текущее значение (если не задано - первое из списка)
  const currentValue = value !== undefined ? value : options[0]?.value

  return (
    <FormControl fullWidth size="small" sx={{ mb: 2 }}>
      <InputLabel id={`setting-${parameter.ID}-label`}>
        {parameter.Name}
      </InputLabel>
      <Select
        labelId={`setting-${parameter.ID}-label`}
        value={currentValue ?? ''}
        label={parameter.Name}
        onChange={(e) => onChange(parameter.ID, Number(e.target.value))}
      >
        {options.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  )
}

// Маппинг языков интерфейса на локализацию API
const languageToLocalization: Record<string, string> = {
  en: 'en_US',
  uk: 'uk_UA',
  ru: 'ru_RU',
  de: 'de_DE',
  ro: 'ro_RO',
  pl: 'pl_PL',
}

export default function BoatSettings() {
  const { t, i18n } = useTranslation()
  const { getSelectedBoat } = useBoatStore()
  const selectedBoat = getSelectedBoat()

  const [settingsSchema, setSettingsSchema] = useState<BoatSettingGroup[]>([])
  const [settingsValues, setSettingsValues] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedGroup, setExpandedGroup] = useState<string | false>(false)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  })

  useEffect(() => {
    loadSettings()
  }, [selectedBoat, i18n.language])

  const loadSettings = async () => {
    if (!selectedBoat) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Получаем локализацию на основе текущего языка интерфейса
      const currentLang = i18n.language.split('-')[0] // 'en-US' -> 'en'
      const localization = languageToLocalization[currentLang] || 'en_US'

      // Загружаем схему настроек
      const schemaResult = await settingsApi.getSettingsSchema({
        chipId: selectedBoat.credentials.boatId,
        localization,
      })

      if (schemaResult.success && schemaResult.data) {
        setSettingsSchema(schemaResult.data)
      } else {
        setError(schemaResult.error?.message || 'Failed to load settings')
      }

      // Загружаем текущие значения
      const valuesResult = await settingsApi.getSettingsValues(selectedBoat.credentials.boatId)
      if (valuesResult.success && valuesResult.data) {
        setSettingsValues(valuesResult.data)
      }
    } catch (err) {
      setError('Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  const handleSettingChange = async (settingId: number, value: number) => {
    if (!selectedBoat) return

    // Оптимистичное обновление
    setSettingsValues((prev) => ({ ...prev, [settingId]: value }))

    // Отправляем на сервер
    const result = await settingsApi.updateSetting(selectedBoat.credentials.boatId, settingId, value)

    if (result.success) {
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' })
    } else {
      // Откатываем при ошибке
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' })
    }
  }

  const handleAccordionChange = (panel: string) => (_: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedGroup(isExpanded ? panel : false)
  }

  if (!selectedBoat) {
    return (
      <Alert severity="warning">
        {t('boat.notConnected')}
      </Alert>
    )
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error) {
    return (
      <Alert severity="error">
        {error}
      </Alert>
    )
  }

  if (settingsSchema.length === 0) {
    return (
      <Alert severity="info">
        {t('settings.noSettings') || 'No settings available'}
      </Alert>
    )
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {selectedBoat.info.name || selectedBoat.credentials.boatId} - {settingsSchema.reduce((acc, g) => acc + g.parameters.length, 0)} {t('settings.parameters') || 'parameters'}
      </Typography>

      {settingsSchema.map((group) => (
        <Accordion
          key={group.group_name}
          expanded={expandedGroup === group.group_name}
          onChange={handleAccordionChange(group.group_name)}
          sx={{ mb: 1 }}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography>{group.group_name}</Typography>
              <Chip label={group.parameters.length} size="small" color="primary" variant="outlined" />
            </Box>
          </AccordionSummary>
          <AccordionDetails>
            <Grid container spacing={2}>
              {group.parameters.map((param) => (
                <Grid item xs={12} sm={6} md={4} key={param.ID}>
                  <SettingSelect
                    parameter={param}
                    value={settingsValues[param.ID]}
                    onChange={handleSettingChange}
                  />
                </Grid>
              ))}
            </Grid>
          </AccordionDetails>
        </Accordion>
      ))}

      <Snackbar
        open={snackbar.open}
        autoHideDuration={2000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
      >
        <Alert severity={snackbar.severity}>{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  )
}
