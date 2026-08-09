// Раздел «Мастеру» — скачивание прошивок пульта (FlySky I6/I6X и др.) + утилиты (прошивальщик,
// USB-драйвер). Список прошивок отдаёт 1С через Firebase Functions (/api/firmware/*); 1С сама
// фильтрует по email и логирует скачивания. Доступ по брендам/веткам: публичные — всем, остальные —
// по персональному доступу (firmwareUserAccess). Владелец (isAdminEmail) видит все.
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box, Typography, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  IconButton, Chip, CircularProgress, Alert, Tooltip, TextField, InputAdornment, FormControl,
  InputLabel, Select, MenuItem, Stack,
} from '@mui/material'
import {
  Download as DownloadIcon, Search as SearchIcon, Memory as FirmwareIcon,
  BuildCircle as FlasherIcon, UsbRounded as DriverIcon, Window as WindowsIcon, Apple as AppleIcon,
} from '@mui/icons-material'
import { firmwareService, Firmware } from '@/api/firmwareService'
import { firmwareCatalogService, FirmwareBrand, FirmwareBranch } from '@/api/firmwareCatalogService'
import { isAdminEmail } from '@/config/access'
import { useAuthStore } from '@/store/authStore'

export default function MasterPage() {
  const { t } = useTranslation()
  const { user } = useAuthStore()
  const [allFirmwares, setAllFirmwares] = useState<Firmware[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<{ id: string; type: 'bin' | 'win' | 'mac' } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterBranch, setFilterBranch] = useState<string>('')
  const [filterLang, setFilterLang] = useState<string>('')
  const [filterBrand, setFilterBrand] = useState<string>('')
  const [filterDevice, setFilterDevice] = useState<string>('')
  const [filterFeature, setFilterFeature] = useState<string>('') // '' = усі; 'none' = без feature; інакше — значення

  // Access control state
  const [brands, setBrands] = useState<FirmwareBrand[]>([])
  const [branches, setBranches] = useState<FirmwareBranch[]>([])
  const [userAccess, setUserAccess] = useState<{ brands: string[]; branches: string[] }>({ brands: [], branches: [] })

  // Владелец видит все прошивки (email-админ)
  const isAdmin = !!user && isAdminEmail(user.email)

  useEffect(() => {
    loadFirmwares()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const loadFirmwares = async () => {
    if (!user?.email) {
      setError(t('master.noEmail', 'Email is required to load firmwares'))
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const list = await firmwareService.getFirmwareList(user.email)

      if (list.length === 0) {
        setError(t('master.noFirmwares', 'No firmwares available for your account'))
        setAllFirmwares([])
        setLoading(false)
        return
      }

      setAllFirmwares(list)

      const uniqueBrands = [...new Set(list.map((fw) => fw.brand))].filter(Boolean)
      const uniqueBranches = [...new Set(list.map((fw) => fw.branch))].filter(Boolean)

      // Синхронизируем каталог брендов/веток из ответа API (только владелец пишет каталог).
      if (isAdmin) {
        await Promise.all([
          firmwareCatalogService.syncBrands(uniqueBrands),
          firmwareCatalogService.syncBranches(uniqueBranches),
        ])
      }

      const [brandsData, branchesData, accessData] = await Promise.all([
        firmwareCatalogService.getAllBrands(),
        firmwareCatalogService.getAllBranches(),
        firmwareCatalogService.getUserFirmwareAccess(user.email),
      ])

      setBrands(brandsData)
      setBranches(branchesData)
      setUserAccess(accessData)
    } catch (err) {
      console.error('Error loading firmwares:', err)
      setError(t('master.loadError', 'Failed to load firmwares'))
    }

    setLoading(false)
  }

  const handleDownload = async (firmware: Firmware, type: 'bin' | 'win' | 'mac' = 'bin') => {
    if (!user?.email) return

    const firmwareId = type === 'win' ? firmware.win : type === 'mac' ? firmware.mac : firmware.id
    if (!firmwareId) return

    setDownloading({ id: firmware.id, type })

    let success = false
    if (type === 'win') {
      success = await firmwareService.downloadFirmwareWin(user.email, firmwareId, firmware.Name)
    } else if (type === 'mac') {
      success = await firmwareService.downloadFirmwareMac(user.email, firmwareId, firmware.Name)
    } else {
      success = await firmwareService.downloadFirmware(user.email, firmwareId, firmware.Name)
    }

    if (!success) setError(t('master.downloadError', 'Failed to download firmware'))
    setDownloading(null)
  }

  // Firmwares the user may see: admin — all; otherwise public brands/branches + personal grants.
  const accessibleFirmwares = useMemo(() => {
    if (isAdmin) return allFirmwares
    const publicBrands = new Set(brands.filter((b) => b.publicAccess).map((b) => b.name))
    const publicBranches = new Set(branches.filter((b) => b.publicAccess).map((b) => b.name))
    const allowedBrands = new Set([...publicBrands, ...userAccess.brands])
    const allowedBranches = new Set([...publicBranches, ...userAccess.branches])
    return allFirmwares.filter((fw) => allowedBrands.has(fw.brand) && allowedBranches.has(fw.branch))
  }, [allFirmwares, brands, branches, userAccess, isAdmin])

  const filterOptions = useMemo(() => {
    const branchList = [...new Set(accessibleFirmwares.map((fw) => fw.branch))].sort()
    const langs = [...new Set(accessibleFirmwares.map((fw) => fw.lang))].sort()
    const brandList = [...new Set(accessibleFirmwares.map((fw) => fw.brand))].sort()
    const devices = [...new Set(accessibleFirmwares.map((fw) => fw.device).filter(Boolean))].sort()
    const features = [...new Set(accessibleFirmwares.map((fw) => fw.feature || '').filter(Boolean))].sort()
    return { branches: branchList, langs, brands: brandList, devices, features }
  }, [accessibleFirmwares])

  const filteredFirmwares = useMemo(() => {
    return accessibleFirmwares.filter((fw) => {
      const query = searchQuery.toLowerCase()
      const matchesSearch =
        fw.Name.toLowerCase().includes(query) ||
        fw.lang.toLowerCase().includes(query) ||
        fw.branch.toLowerCase().includes(query) ||
        fw.brand.toLowerCase().includes(query) ||
        (fw.device && fw.device.toLowerCase().includes(query)) ||
        (fw.feature && fw.feature.toLowerCase().includes(query))
      const matchesBranch = !filterBranch || fw.branch === filterBranch
      const matchesLang = !filterLang || fw.lang === filterLang
      const matchesBrand = !filterBrand || fw.brand === filterBrand
      const matchesDevice = !filterDevice || fw.device === filterDevice
      const matchesFeature = !filterFeature
        || (filterFeature === 'none' ? !(fw.feature || '') : fw.feature === filterFeature)
      return matchesSearch && matchesBranch && matchesLang && matchesBrand && matchesDevice && matchesFeature
    })
  }, [accessibleFirmwares, searchQuery, filterBranch, filterLang, filterBrand, filterDevice, filterFeature])

  const groupedByBrand = useMemo(() => {
    return filteredFirmwares.reduce((acc, fw) => {
      if (!acc[fw.brand]) acc[fw.brand] = []
      acc[fw.brand].push(fw)
      return acc
    }, {} as Record<string, Firmware[]>)
  }, [filteredFirmwares])

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 1 }}>{t('master.title', 'Прошивки пульта')}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {t('master.description', 'Завантаження прошивок пульта')}
      </Typography>

      {/* Утилиты */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>{t('master.utilities', 'Утиліти для прошивки')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('master.utilitiesDesc', 'Завантажте потрібне ПЗ перед прошивкою пульта')}
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Paper variant="outlined" sx={{ p: 2, flex: 1, display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
            component="a" href="/flash/flysky-updater-win64.exe" download>
            <FlasherIcon color="primary" sx={{ fontSize: 40 }} />
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle1">{t('master.flasher', 'Програма для прошивки')}</Typography>
              <Typography variant="body2" color="text.secondary">{t('master.flasherDesc', 'FlySky Updater для Windows 64-bit')}</Typography>
            </Box>
            <DownloadIcon color="action" />
          </Paper>
          <Paper variant="outlined" sx={{ p: 2, flex: 1, display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
            component="a" href="/flash/CP210x_Windows_Drivers.zip" download>
            <DriverIcon color="primary" sx={{ fontSize: 40 }} />
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle1">{t('master.driver', 'USB-драйвер')}</Typography>
              <Typography variant="body2" color="text.secondary">{t('master.driverDesc', 'Драйвер CP210x для Windows')}</Typography>
            </Box>
            <DownloadIcon color="action" />
          </Paper>
        </Stack>
      </Paper>

      {error && <Alert severity="warning" sx={{ mb: 3 }} onClose={() => setError(null)}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
      ) : accessibleFirmwares.length > 0 ? (
        <>
          {/* Поиск и фильтры */}
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 3 }}>
            <TextField size="small" placeholder={t('master.search', 'Пошук прошивок...')} value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)} sx={{ flex: 2 }}
              InputProps={{ startAdornment: (<InputAdornment position="start"><SearchIcon /></InputAdornment>) }} />

            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>{t('master.brand', 'Бренд')}</InputLabel>
              <Select value={filterBrand} label={t('master.brand', 'Бренд')} onChange={(e) => setFilterBrand(e.target.value)}>
                <MenuItem value="">{t('common.all', 'Усі')}</MenuItem>
                {filterOptions.brands.map((brand) => <MenuItem key={brand} value={brand}>{brand}</MenuItem>)}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>{t('master.language', 'Мова')}</InputLabel>
              <Select value={filterLang} label={t('master.language', 'Мова')} onChange={(e) => setFilterLang(e.target.value)}>
                <MenuItem value="">{t('common.all', 'Усі')}</MenuItem>
                {filterOptions.langs.map((lang) => <MenuItem key={lang} value={lang}>{lang}</MenuItem>)}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>{t('master.branch', 'Гілка')}</InputLabel>
              <Select value={filterBranch} label={t('master.branch', 'Гілка')} onChange={(e) => setFilterBranch(e.target.value)}>
                <MenuItem value="">{t('common.all', 'Усі')}</MenuItem>
                {filterOptions.branches.map((branch) => <MenuItem key={branch} value={branch}>{branch}</MenuItem>)}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>{t('master.device', 'Пристрій')}</InputLabel>
              <Select value={filterDevice} label={t('master.device', 'Пристрій')} onChange={(e) => setFilterDevice(e.target.value)}>
                <MenuItem value="">{t('common.all', 'Усі')}</MenuItem>
                {filterOptions.devices.map((device) => <MenuItem key={device} value={device}>{device}</MenuItem>)}
              </Select>
            </FormControl>

            {filterOptions.features.length > 0 && (
              <FormControl size="small" sx={{ minWidth: 130 }}>
                <InputLabel>{t('master.feature', 'Feature')}</InputLabel>
                <Select value={filterFeature} label={t('master.feature', 'Feature')} onChange={(e) => setFilterFeature(e.target.value)}>
                  <MenuItem value="">{t('common.all', 'Усі')}</MenuItem>
                  <MenuItem value="none">{t('master.featureNone', 'Без feature')}</MenuItem>
                  {filterOptions.features.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
                </Select>
              </FormControl>
            )}
          </Stack>

          {/* Прошивки по брендам */}
          {Object.entries(groupedByBrand).map(([brand, brandFirmwares]) => (
            <Box key={brand} sx={{ mb: 4 }}>
              <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                <FirmwareIcon color="primary" />{brand}<Chip label={brandFirmwares.length} size="small" />
              </Typography>
              <TableContainer component={Paper}>
                <Table size="small" sx={{ tableLayout: 'fixed' }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: '35%' }}>{t('master.name', 'Назва')}</TableCell>
                      <TableCell sx={{ width: '15%' }}>{t('master.device', 'Пристрій')}</TableCell>
                      <TableCell sx={{ width: '10%' }}>{t('master.language', 'Мова')}</TableCell>
                      <TableCell sx={{ width: '15%' }}>{t('master.branch', 'Гілка')}</TableCell>
                      <TableCell sx={{ width: '25%' }} align="right">{t('master.actions', 'Дії')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {brandFirmwares.map((firmware) => {
                      const isBeta = firmware.Name.toLowerCase().includes('dev')
                      return (
                        <TableRow key={firmware.id} hover>
                          <TableCell>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography variant="body2">{firmware.Name}</Typography>
                              {isBeta && <Chip label="Beta" size="small" color="warning" sx={{ height: 20, fontSize: '0.7rem' }} />}
                              {firmware.feature && <Chip label={firmware.feature} size="small" color="info" variant="outlined" sx={{ height: 20, fontSize: '0.7rem' }} />}
                            </Box>
                          </TableCell>
                          <TableCell>{firmware.device || '-'}</TableCell>
                          <TableCell><Chip label={firmware.lang} size="small" color={firmware.lang === 'UA' ? 'primary' : 'default'} /></TableCell>
                          <TableCell><Chip label={firmware.branch} size="small" variant="outlined" /></TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                              <Tooltip title={t('master.downloadBin', 'Завантажити .bin')}>
                                <IconButton color="primary" size="small" onClick={() => handleDownload(firmware, 'bin')} disabled={downloading?.id === firmware.id}>
                                  {downloading?.id === firmware.id && downloading?.type === 'bin' ? <CircularProgress size={20} /> : <DownloadIcon />}
                                </IconButton>
                              </Tooltip>
                              {firmware.win && (
                                <Tooltip title={t('master.downloadWin', 'Завантажити для Windows')}>
                                  <IconButton color="info" size="small" onClick={() => handleDownload(firmware, 'win')} disabled={downloading?.id === firmware.id}>
                                    {downloading?.id === firmware.id && downloading?.type === 'win' ? <CircularProgress size={20} /> : <WindowsIcon />}
                                  </IconButton>
                                </Tooltip>
                              )}
                              {firmware.mac && (
                                <Tooltip title={t('master.downloadMac', 'Завантажити для Mac')}>
                                  <IconButton color="default" size="small" onClick={() => handleDownload(firmware, 'mac')} disabled={downloading?.id === firmware.id}>
                                    {downloading?.id === firmware.id && downloading?.type === 'mac' ? <CircularProgress size={20} /> : <AppleIcon />}
                                  </IconButton>
                                </Tooltip>
                              )}
                            </Stack>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          ))}
        </>
      ) : (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <FirmwareIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
          <Typography variant="h6" color="text.secondary">{t('master.noFirmwares', 'Прошивок немає')}</Typography>
          <Typography variant="body2" color="text.secondary">{t('master.contactSupport', "Зверніться до підтримки, щоб отримати доступ до прошивок")}</Typography>
        </Paper>
      )}
    </Box>
  )
}
