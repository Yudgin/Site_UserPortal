// Управление доступом к прошивкам пульта (владелец). Бренды/ветки: флаг «Публічний» — доступны
// всем вошедшим; иначе — только тем, кому выдан персональный доступ по email (firmwareUserAccess).
// Каталог брендов/веток синхронизируется из ответа 1С (кнопка «Синхронізувати»).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Stack, Divider, Switch,
  List, ListItem, ListItemText, TextField, Select, MenuItem, InputLabel, FormControl, OutlinedInput,
  Checkbox, ListItemButton, Chip, IconButton, Snackbar,
} from '@mui/material'
import {
  Home as HomeIcon, Sync as SyncIcon, Memory as FirmwareIcon, Delete as DeleteIcon, Edit as EditIcon,
  PersonAdd as GrantIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import { firmwareCatalogService, FirmwareBrand, FirmwareBranch } from '@/api/firmwareCatalogService'
import { firmwareService } from '@/api/firmwareService'

type Grant = { email: string; brands: string[]; branches: string[] }

export default function FirmwareAccessAdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [brands, setBrands] = useState<FirmwareBrand[]>([])
  const [branches, setBranches] = useState<FirmwareBranch[]>([])
  const [grants, setGrants] = useState<Grant[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' | 'info' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' | 'info' = 'success') => setSnack({ open: true, msg, sev })

  // Редактор персонального гранта
  const [email, setEmail] = useState('')
  const [selBrands, setSelBrands] = useState<string[]>([])
  const [selBranches, setSelBranches] = useState<string[]>([])
  const [savingGrant, setSavingGrant] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [b, br, g] = await Promise.all([
      firmwareCatalogService.getAllBrands(),
      firmwareCatalogService.getAllBranches(),
      firmwareCatalogService.listUserAccess(),
    ])
    setBrands(b.sort((x, y) => x.name.localeCompare(y.name)))
    setBranches(br.sort((x, y) => x.name.localeCompare(y.name)))
    setGrants(g.sort((x, y) => x.email.localeCompare(y.email)))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Синхронизировать каталог брендов/веток из ответа 1С (по email владельца).
  const sync = async () => {
    if (!user?.email) return
    setSyncing(true)
    try {
      const list = await firmwareService.getFirmwareList(user.email)
      const uniqueBrands = [...new Set(list.map((f) => f.brand))].filter(Boolean)
      const uniqueBranches = [...new Set(list.map((f) => f.branch))].filter(Boolean)
      await Promise.all([
        firmwareCatalogService.syncBrands(uniqueBrands),
        firmwareCatalogService.syncBranches(uniqueBranches),
      ])
      await load()
      notify(`Синхронізовано: ${uniqueBrands.length} брендів, ${uniqueBranches.length} гілок`)
    } catch {
      notify('Не вдалося синхронізувати', 'error')
    }
    setSyncing(false)
  }

  const toggleBrand = async (b: FirmwareBrand) => {
    const next = !b.publicAccess
    setBrands((prev) => prev.map((x) => (x.name === b.name ? { ...x, publicAccess: next } : x)))
    const ok = await firmwareCatalogService.updateBrandPublicAccess(b.name, next)
    if (!ok) { notify('Не вдалося зберегти', 'error'); load() }
  }
  const toggleBranch = async (b: FirmwareBranch) => {
    const next = !b.publicAccess
    setBranches((prev) => prev.map((x) => (x.name === b.name ? { ...x, publicAccess: next } : x)))
    const ok = await firmwareCatalogService.updateBranchPublicAccess(b.name, next)
    if (!ok) { notify('Не вдалося зберегти', 'error'); load() }
  }

  const editGrant = (g: Grant) => { setEmail(g.email); setSelBrands(g.brands); setSelBranches(g.branches) }
  const clearGrant = () => { setEmail(''); setSelBrands([]); setSelBranches([]) }

  const saveGrant = async () => {
    const em = email.trim().toLowerCase()
    if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { notify('Вкажіть коректний email', 'error'); return }
    setSavingGrant(true)
    const ok = await firmwareCatalogService.setUserFirmwareAccess(em, selBrands, selBranches)
    setSavingGrant(false)
    if (ok) { notify(`Доступ для ${em} збережено`); clearGrant(); load() }
    else notify('Не вдалося зберегти', 'error')
  }

  const removeGrant = async (g: Grant) => {
    const ok = await firmwareCatalogService.setUserFirmwareAccess(g.email, [], [])
    if (ok) { notify(`Доступ ${g.email} знято`); load() } else notify('Не вдалося', 'error')
  }

  // Только не-публичные бренды/ветки имеет смысл выдавать персонально (публичные и так всем).
  const privateBrands = useMemo(() => brands.filter((b) => !b.publicAccess).map((b) => b.name), [brands])
  const privateBranches = useMemo(() => branches.filter((b) => !b.publicAccess).map((b) => b.name), [branches])

  if (!user || !isAdminEmail(user.email)) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для власника.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Доступ до прошивок</Typography>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<FirmwareIcon />} onClick={() => navigate('/master')}>Прошивки</Button>
          <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
        </Stack>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Публічні бренди/гілки бачать усі авторизовані користувачі. Непублічні — лише ті, кому видано
        персональний доступ за email. Список брендів/гілок береться з 1С (кнопка «Синхронізувати»).
      </Typography>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
      ) : (
        <Stack spacing={3}>
          <Box>
            <Button variant="outlined" startIcon={syncing ? <CircularProgress size={16} /> : <SyncIcon />} disabled={syncing} onClick={sync}>
              Синхронізувати з 1С
            </Button>
          </Box>

          {/* Бренды */}
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle1" sx={{ mb: 1 }}>Бренди {brands.length > 0 && `(${brands.length})`}</Typography>
            {brands.length === 0 ? (
              <Alert severity="info">Каталог порожній — натисніть «Синхронізувати з 1С».</Alert>
            ) : (
              <List dense disablePadding>
                {brands.map((b) => (
                  <ListItem key={b.name} divider secondaryAction={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption" color={b.publicAccess ? 'success.main' : 'text.secondary'}>
                        {b.publicAccess ? 'публічний' : 'за доступом'}
                      </Typography>
                      <Switch edge="end" checked={!!b.publicAccess} onChange={() => toggleBrand(b)} />
                    </Stack>
                  }>
                    <ListItemText primary={b.name} />
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>

          {/* Ветки */}
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle1" sx={{ mb: 1 }}>Гілки {branches.length > 0 && `(${branches.length})`}</Typography>
            {branches.length === 0 ? (
              <Alert severity="info">Каталог порожній — натисніть «Синхронізувати з 1С».</Alert>
            ) : (
              <List dense disablePadding>
                {branches.map((b) => (
                  <ListItem key={b.name} divider secondaryAction={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="caption" color={b.publicAccess ? 'success.main' : 'text.secondary'}>
                        {b.publicAccess ? 'публічна' : 'за доступом'}
                      </Typography>
                      <Switch edge="end" checked={!!b.publicAccess} onChange={() => toggleBranch(b)} />
                    </Stack>
                  }>
                    <ListItemText primary={b.name} />
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>

          {/* Персональный доступ */}
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle1" sx={{ mb: 1 }}>Персональний доступ (за email)</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Видайте доступ до непублічних брендів/гілок конкретному користувачу. Публічні тут не потрібні — вони й так доступні всім.
            </Typography>
            <Stack spacing={2}>
              <TextField label="Email користувача" value={email} onChange={(e) => setEmail(e.target.value)} size="small" fullWidth />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <FormControl size="small" fullWidth>
                  <InputLabel>Бренди</InputLabel>
                  <Select multiple value={selBrands} onChange={(e) => setSelBrands(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}
                    input={<OutlinedInput label="Бренди" />} renderValue={(s) => (s as string[]).join(', ')}>
                    {privateBrands.length === 0 && <MenuItem disabled>Немає непублічних брендів</MenuItem>}
                    {privateBrands.map((name) => (
                      <MenuItem key={name} value={name}>
                        <Checkbox checked={selBrands.includes(name)} />
                        <ListItemText primary={name} />
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" fullWidth>
                  <InputLabel>Гілки</InputLabel>
                  <Select multiple value={selBranches} onChange={(e) => setSelBranches(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}
                    input={<OutlinedInput label="Гілки" />} renderValue={(s) => (s as string[]).join(', ')}>
                    {privateBranches.length === 0 && <MenuItem disabled>Немає непублічних гілок</MenuItem>}
                    {privateBranches.map((name) => (
                      <MenuItem key={name} value={name}>
                        <Checkbox checked={selBranches.includes(name)} />
                        <ListItemText primary={name} />
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
              <Stack direction="row" spacing={1}>
                <Button variant="contained" startIcon={<GrantIcon />} disabled={savingGrant || !email.trim()} onClick={saveGrant}>Зберегти доступ</Button>
                {(email || selBrands.length || selBranches.length) ? <Button onClick={clearGrant}>Очистити</Button> : null}
              </Stack>
            </Stack>

            {grants.length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Видані доступи</Typography>
                <List dense disablePadding>
                  {grants.map((g) => (
                    <ListItem key={g.email} divider secondaryAction={
                      <Stack direction="row" spacing={0.5}>
                        <IconButton size="small" onClick={() => editGrant(g)}><EditIcon fontSize="small" /></IconButton>
                        <IconButton size="small" color="error" onClick={() => removeGrant(g)}><DeleteIcon fontSize="small" /></IconButton>
                      </Stack>
                    }>
                      <ListItemButton onClick={() => editGrant(g)} sx={{ borderRadius: 1 }}>
                        <ListItemText primary={g.email}
                          secondary={
                            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', mt: 0.5 }}>
                              {g.brands.map((b) => <Chip key={`b${b}`} label={b} size="small" />)}
                              {g.branches.map((b) => <Chip key={`br${b}`} label={b} size="small" variant="outlined" />)}
                            </Stack>
                          }
                          secondaryTypographyProps={{ component: 'div' }} />
                      </ListItemButton>
                    </ListItem>
                  ))}
                </List>
              </>
            )}
          </Paper>
        </Stack>
      )}

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
