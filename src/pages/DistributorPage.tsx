import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  ListItemIcon,
  Chip,
  Alert,
  CircularProgress,
  Divider,
  Card,
  CardContent,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Grid,
  Snackbar,
} from '@mui/material'
import {
  DirectionsBoat as BoatIcon,
  Visibility as ViewIcon,
  Edit as EditIcon,
  Map as MapIcon,
  ExpandMore as ExpandMoreIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material'
import { DistributorBoat, BoatSettingGroup, BoatSettingParameter } from '@/types/models'
import { boatsApi } from '@/api/endpoints/boats'
import { settingsApi } from '@/api/endpoints/settings'

// Reusable setting select component
interface SettingSelectProps {
  parameter: BoatSettingParameter
  value: number | undefined
  onChange: (id: number, value: number) => void
  disabled?: boolean
}

function SettingSelect({ parameter, value, onChange, disabled }: SettingSelectProps) {
  const options = Object.entries(parameter.Value)
    .map(([key, label]) => ({ value: parseInt(key), label }))
    .sort((a, b) => a.value - b.value)

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

  const currentValue = value !== undefined ? value : options[0]?.value

  return (
    <FormControl fullWidth size="small" sx={{ mb: 2 }} disabled={disabled}>
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

// Language mapping
const languageToLocalization: Record<string, string> = {
  en: 'en_US',
  uk: 'uk_UA',
  ru: 'ru_RU',
  de: 'de_DE',
  ro: 'ro_RO',
  pl: 'pl_PL',
}

export default function DistributorPage() {
  const { t, i18n } = useTranslation()

  const [boats, setBoats] = useState<DistributorBoat[]>([])
  const [selectedBoat, setSelectedBoat] = useState<DistributorBoat | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Settings state
  const [settingsSchema, setSettingsSchema] = useState<BoatSettingGroup[]>([])
  const [settingsValues, setSettingsValues] = useState<Record<number, number>>({})
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [expandedGroup, setExpandedGroup] = useState<string | false>(false)
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  })

  useEffect(() => {
    loadDistributorBoats()
  }, [])

  useEffect(() => {
    if (selectedBoat?.permissions.viewSettings) {
      loadBoatSettings()
    }
  }, [selectedBoat, i18n.language])

  const loadDistributorBoats = async () => {
    setLoading(true)
    setError(null)

    // For demo, use dist-1 as the distributor ID
    // In production, this would come from the authenticated user
    const distributorId = 'dist-1'

    const result = await boatsApi.getDistributorBoats(distributorId)

    if (result.success && result.data) {
      setBoats(result.data)
      if (result.data.length > 0) {
        setSelectedBoat(result.data[0])
      }
    } else {
      setError(result.error?.message || 'Failed to load boats')
    }

    setLoading(false)
  }

  const loadBoatSettings = async () => {
    if (!selectedBoat) return

    setSettingsLoading(true)

    try {
      const currentLang = i18n.language.split('-')[0]
      const localization = languageToLocalization[currentLang] || 'en_US'

      const schemaResult = await settingsApi.getSettingsSchema({
        chipId: selectedBoat.boatId,
        localization,
      })

      if (schemaResult.success && schemaResult.data) {
        setSettingsSchema(schemaResult.data)
      }

      const valuesResult = await settingsApi.getSettingsValues(selectedBoat.boatId)
      if (valuesResult.success && valuesResult.data) {
        setSettingsValues(valuesResult.data)
      }
    } catch (err) {
      console.error('Failed to load settings:', err)
    } finally {
      setSettingsLoading(false)
    }
  }

  const handleSettingChange = async (settingId: number, value: number) => {
    if (!selectedBoat || !selectedBoat.permissions.editSettings) return

    setSettingsValues((prev) => ({ ...prev, [settingId]: value }))

    const result = await settingsApi.updateSetting(selectedBoat.boatId, settingId, value)

    if (result.success) {
      setSnackbar({ open: true, message: t('common.success'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: t('common.error'), severity: 'error' })
    }
  }

  const handleAccordionChange = (panel: string) => (_: React.SyntheticEvent, isExpanded: boolean) => {
    setExpandedGroup(isExpanded ? panel : false)
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
      <Alert severity="error" sx={{ mb: 2 }}>
        {error}
      </Alert>
    )
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        {t('distributor.title') || 'Distributor Panel'}
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {t('distributor.description') || 'Manage boats that have granted you access'}
      </Typography>

      {boats.length === 0 ? (
        <Alert severity="info">
          {t('distributor.noBoats') || 'No boats have granted you access yet'}
        </Alert>
      ) : (
        <Box sx={{ display: 'flex', gap: 3, flexDirection: { xs: 'column', md: 'row' } }}>
          {/* Boats List */}
          <Paper sx={{ flex: 1, maxWidth: { md: 350 } }}>
            <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
              <Typography variant="h6">
                {t('distributor.boats') || 'Available Boats'} ({boats.length})
              </Typography>
            </Box>
            <List>
              {boats.map((boat, index) => (
                <Box key={boat.id}>
                  {index > 0 && <Divider />}
                  <ListItem disablePadding>
                    <ListItemButton
                      selected={selectedBoat?.id === boat.id}
                      onClick={() => setSelectedBoat(boat)}
                    >
                      <ListItemIcon>
                        <BoatIcon color={selectedBoat?.id === boat.id ? 'primary' : 'inherit'} />
                      </ListItemIcon>
                      <ListItemText
                        primary={boat.boatName}
                        secondary={
                          <>
                            ID: {boat.boatId}
                            <br />
                            {boat.ownerEmail}
                          </>
                        }
                      />
                    </ListItemButton>
                  </ListItem>
                </Box>
              ))}
            </List>
          </Paper>

          {/* Selected Boat Details */}
          {selectedBoat && (
            <Box sx={{ flex: 2 }}>
              <Card sx={{ mb: 3 }}>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                    <BoatIcon color="primary" fontSize="large" />
                    <Box>
                      <Typography variant="h5">{selectedBoat.boatName}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        ID: {selectedBoat.boatId}
                      </Typography>
                    </Box>
                  </Box>

                  <Typography variant="subtitle2" gutterBottom>
                    {t('distributor.permissions') || 'Your Permissions'}:
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Chip
                      icon={<ViewIcon />}
                      label={t('settings.viewSettings') || 'View Settings'}
                      color={selectedBoat.permissions.viewSettings ? 'success' : 'default'}
                      variant={selectedBoat.permissions.viewSettings ? 'filled' : 'outlined'}
                      size="small"
                    />
                    <Chip
                      icon={<EditIcon />}
                      label={t('settings.editSettings') || 'Edit Settings'}
                      color={selectedBoat.permissions.editSettings ? 'success' : 'default'}
                      variant={selectedBoat.permissions.editSettings ? 'filled' : 'outlined'}
                      size="small"
                    />
                    <Chip
                      icon={<MapIcon />}
                      label={t('settings.viewReservoirs') || 'View Reservoirs'}
                      color={selectedBoat.permissions.viewReservoirs ? 'success' : 'default'}
                      variant={selectedBoat.permissions.viewReservoirs ? 'filled' : 'outlined'}
                      size="small"
                    />
                  </Box>
                </CardContent>
              </Card>

              {/* Settings Section */}
              {selectedBoat.permissions.viewSettings && (
                <Paper sx={{ p: 3 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                    <SettingsIcon color="primary" />
                    <Typography variant="h6">
                      {t('settings.boatSettings') || 'Boat Settings'}
                    </Typography>
                    {!selectedBoat.permissions.editSettings && (
                      <Chip label={t('common.readOnly') || 'Read Only'} size="small" color="warning" />
                    )}
                  </Box>

                  {settingsLoading ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                      <CircularProgress />
                    </Box>
                  ) : settingsSchema.length === 0 ? (
                    <Alert severity="info">
                      {t('settings.noSettings') || 'No settings available'}
                    </Alert>
                  ) : (
                    <>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        {settingsSchema.reduce((acc, g) => acc + g.parameters.length, 0)} {t('settings.parameters') || 'parameters'}
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
                                    disabled={!selectedBoat.permissions.editSettings}
                                  />
                                </Grid>
                              ))}
                            </Grid>
                          </AccordionDetails>
                        </Accordion>
                      ))}
                    </>
                  )}
                </Paper>
              )}

              {!selectedBoat.permissions.viewSettings && (
                <Alert severity="warning">
                  {t('distributor.noSettingsAccess') || 'You do not have permission to view settings for this boat'}
                </Alert>
              )}
            </Box>
          )}
        </Box>
      )}

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
