// Керування доступом (тільки власник): сервісні центри (зони) + співробітники з ролями та
// правами по центрах. Мастери самі реєструються при вході (identity), тут власник призначає роль
// і, для майстра, права по кожному центру (перегляд / попередні / фактичні / виставлення на оплату).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Container, Box, Paper, Typography, Button, Alert, CircularProgress, Chip, Stack, Divider,
  TextField, MenuItem, Dialog, DialogTitle, DialogContent, DialogActions, Switch, FormControlLabel,
  Checkbox, Table, TableBody, TableRow, TableCell, Snackbar, IconButton,
} from '@mui/material'
import {
  Home as HomeIcon, Add as AddIcon, Edit as EditIcon, Business as CenterIcon, People as PeopleIcon,
} from '@mui/icons-material'
import { useAccess, useAccessStore } from '@/store/accessStore'
import { serviceCenterService } from '@/api/serviceCenterService'
import { userProfileService } from '@/api/userProfileService'
import {
  CENTER_PERMISSIONS, CENTER_PERMISSION_LABELS, ROLE_LABELS,
  type ServiceCenter, type UserProfile, type Role, type CenterPermission, type CenterAccess,
} from '@/types/access'

// Назначаемые роли. 'owner' пока не назначается: делегированный владелец заработает на уровне
// данных лише у фазі 1b (правила/сервер почнуть читати роль); власник — акаунт за email.
const ROLES: Role[] = ['director', 'accountant', 'master']

export default function AccessAdminPage() {
  const navigate = useNavigate()
  const { isOwner } = useAccess()
  const reloadCenters = useAccessStore((s) => s.reloadCenters)

  const [loading, setLoading] = useState(true)
  const [centers, setCenters] = useState<ServiceCenter[]>([])
  const [users, setUsers] = useState<UserProfile[]>([])
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: 'success' | 'error' }>({ open: false, msg: '', sev: 'success' })
  const notify = (msg: string, sev: 'success' | 'error' = 'success') => setSnack({ open: true, msg, sev })

  // редактор центра
  const [centerEdit, setCenterEdit] = useState<Partial<ServiceCenter> | null>(null)
  // редактор доступа пользователя
  const [userEdit, setUserEdit] = useState<UserProfile | null>(null)
  const [uRole, setURole] = useState<Role>('master')
  const [uActive, setUActive] = useState(false)
  const [uCenters, setUCenters] = useState<Record<string, CenterPermission[]>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const [c, u] = await Promise.all([serviceCenterService.list(), userProfileService.list()])
    setCenters(c); setUsers(u); setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const centerName = useMemo(() => new Map(centers.map((c) => [c.id, c.name])), [centers])

  if (!isOwner) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert severity="error">Доступ лише для власника.</Alert>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
      </Container>
    )
  }

  const saveCenter = async () => {
    if (!centerEdit || !centerEdit.name?.trim()) { notify('Вкажіть назву центру', 'error'); return }
    const ok = await serviceCenterService.save({
      id: centerEdit.id,
      name: centerEdit.name.trim(),
      zone: centerEdit.zone?.trim() || '',
      externalId: centerEdit.externalId?.trim() || null,
      active: centerEdit.active !== false,
    })
    if (ok) { notify('Центр збережено'); setCenterEdit(null); await load(); await reloadCenters() }
    else notify('Не вдалося зберегти', 'error')
  }

  const openUser = (u: UserProfile) => {
    setUserEdit(u)
    setURole(u.role || 'master')
    setUActive(!!u.active)
    const map: Record<string, CenterPermission[]> = {}
    ;(u.centers || []).forEach((c) => { map[c.centerId] = [...c.perms] })
    setUCenters(map)
  }

  const togglePerm = (centerId: string, perm: CenterPermission) => {
    setUCenters((prev) => {
      const cur = new Set(prev[centerId] || [])
      cur.has(perm) ? cur.delete(perm) : cur.add(perm)
      return { ...prev, [centerId]: Array.from(cur) }
    })
  }

  // Директору назначаем ЦЕНТРЫ (полный доступ внутри), мастеру — набор прав по центрам.
  const toggleDirectorCenter = (centerId: string) => {
    setUCenters((prev) => {
      const has = (prev[centerId] || []).length > 0
      return { ...prev, [centerId]: has ? [] : [...CENTER_PERMISSIONS] }
    })
  }

  const saveUser = async () => {
    if (!userEdit) return
    // master — по флагам; director — назначенные центры с полным набором прав; иначе — без центров.
    const centersArr: CenterAccess[] = uRole === 'master'
      ? Object.entries(uCenters).filter(([, perms]) => perms.length).map(([centerId, perms]) => ({ centerId, perms }))
      : uRole === 'director'
        ? Object.entries(uCenters).filter(([, perms]) => perms.length).map(([centerId]) => ({ centerId, perms: [...CENTER_PERMISSIONS] }))
        : []
    const ok = await userProfileService.setAccess(userEdit.uid, { role: uRole, active: uActive, centers: centersArr })
    if (ok) { notify('Доступ збережено'); setUserEdit(null); await load() }
    else notify('Не вдалося зберегти', 'error')
  }

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4">Доступ та центри</Typography>
        <Button startIcon={<HomeIcon />} onClick={() => navigate('/')}>На головну</Button>
      </Box>

      {/* Сервісні центри */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center"><CenterIcon color="primary" /><Typography variant="subtitle1">Сервісні центри (зони)</Typography></Stack>
          <Button size="small" startIcon={<AddIcon />} onClick={() => setCenterEdit({ active: true })}>Додати центр</Button>
        </Stack>
        {centers.length === 0 ? (
          <Typography variant="body2" color="text.secondary">Ще немає центрів. Додайте перший.</Typography>
        ) : (
          <Stack divider={<Divider flexItem />} spacing={1}>
            {centers.map((c) => (
              <Stack key={c.id} direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 160 }}>{c.name}</Typography>
                {c.zone && <Chip size="small" variant="outlined" label={c.zone} />}
                {c.externalId && <Typography variant="caption" color="text.secondary">1С: {c.externalId}</Typography>}
                {!c.active && <Chip size="small" color="default" label="неактивний" />}
                <IconButton size="small" sx={{ ml: 'auto' }} onClick={() => setCenterEdit(c)}><EditIcon fontSize="small" /></IconButton>
              </Stack>
            ))}
          </Stack>
        )}
      </Paper>

      {/* Співробітники */}
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}><PeopleIcon color="primary" /><Typography variant="subtitle1">Співробітники</Typography></Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Співробітник зʼявляється тут після першого входу. Призначте роль і, для майстра, права по центрах.
        </Typography>
        {users.length === 0 ? (
          <Typography variant="body2" color="text.secondary">Ще ніхто не входив.</Typography>
        ) : (
          <Stack divider={<Divider flexItem />} spacing={1}>
            {users.map((u) => (
              <Stack key={u.uid} direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ minWidth: 200 }}>{u.email || u.uid}</Typography>
                <Chip size="small" color={u.role === 'owner' ? 'secondary' : u.role === 'accountant' ? 'info' : 'default'} label={ROLE_LABELS[u.role] || u.role} />
                <Chip size="small" color={u.active ? 'success' : 'default'} label={u.active ? 'активний' : 'без доступу'} />
                {u.role === 'master' && <Typography variant="caption" color="text.secondary">центрів: {(u.centers || []).length}</Typography>}
                <Button size="small" sx={{ ml: 'auto' }} onClick={() => openUser(u)}>Налаштувати</Button>
              </Stack>
            ))}
          </Stack>
        )}
      </Paper>

      {/* Діалог центру */}
      <Dialog open={!!centerEdit} onClose={() => setCenterEdit(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{centerEdit?.id ? 'Центр' : 'Новий центр'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField label="Назва" value={centerEdit?.name || ''} onChange={(e) => setCenterEdit((c) => ({ ...c, name: e.target.value }))} fullWidth autoFocus />
            <TextField label="Зона / регіон (опц.)" value={centerEdit?.zone || ''} onChange={(e) => setCenterEdit((c) => ({ ...c, zone: e.target.value }))} fullWidth />
            <TextField label="ID у 1С (опц.)" value={centerEdit?.externalId || ''} onChange={(e) => setCenterEdit((c) => ({ ...c, externalId: e.target.value }))} fullWidth helperText="Для звʼязку з довідником сервісних центрів 1С" />
            <FormControlLabel control={<Switch checked={centerEdit?.active !== false} onChange={(e) => setCenterEdit((c) => ({ ...c, active: e.target.checked }))} />} label="Активний" />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCenterEdit(null)}>Скасувати</Button>
          <Button variant="contained" onClick={saveCenter}>Зберегти</Button>
        </DialogActions>
      </Dialog>

      {/* Діалог доступу співробітника */}
      <Dialog open={!!userEdit} onClose={() => setUserEdit(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Доступ: {userEdit?.email}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField select label="Роль" value={uRole} onChange={(e) => setURole(e.target.value as Role)} fullWidth
              disabled={uRole === 'owner'} helperText={uRole === 'owner' ? 'Власник — обліковий запис за email, роль не змінюється' : undefined}>
              {[...(ROLES.includes(uRole) ? [] : [uRole]), ...ROLES].map((r) => (
                <MenuItem key={r} value={r} disabled={r === 'owner'}>{ROLE_LABELS[r]}</MenuItem>
              ))}
            </TextField>
            <FormControlLabel control={<Switch checked={uActive} onChange={(e) => setUActive(e.target.checked)} />} label="Доступ активний" />
            {uRole === 'accountant' && <Alert severity="info">Бухгалтер: перегляд + виставлення на оплату по всіх центрах.</Alert>}
            {uRole === 'owner' && <Alert severity="warning">Власник: повний доступ до всього.</Alert>}
            {uRole === 'director' && (
              <Box>
                <Alert severity="info" sx={{ mb: 1 }}>Директор: повний доступ (усі права + економіка центру) у межах призначених центрів.</Alert>
                {centers.length === 0 ? (
                  <Alert severity="warning">Спочатку додайте сервісні центри.</Alert>
                ) : (
                  <Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>Центри під керуванням:</Typography>
                    {centers.filter((c) => c.active).map((c) => (
                      <FormControlLabel key={c.id}
                        control={<Checkbox size="small" checked={(uCenters[c.id] || []).length > 0} onChange={() => toggleDirectorCenter(c.id)} />}
                        label={centerName.get(c.id)} />
                    ))}
                  </Stack>
                )}
              </Box>
            )}
            {uRole === 'master' && (
              <Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Права по центрах:</Typography>
                {centers.length === 0 ? (
                  <Alert severity="warning">Спочатку додайте сервісні центри.</Alert>
                ) : (
                  <Box sx={{ overflowX: 'auto' }}>
                    <Table size="small">
                      <TableBody>
                        <TableRow>
                          <TableCell />
                          {CENTER_PERMISSIONS.map((p) => (
                            <TableCell key={p} align="center" sx={{ fontSize: 11, whiteSpace: 'nowrap' }}>{CENTER_PERMISSION_LABELS[p]}</TableCell>
                          ))}
                        </TableRow>
                        {centers.filter((c) => c.active).map((c) => (
                          <TableRow key={c.id}>
                            <TableCell sx={{ fontWeight: 600 }}>{centerName.get(c.id)}</TableCell>
                            {CENTER_PERMISSIONS.map((p) => (
                              <TableCell key={p} align="center" padding="none">
                                <Checkbox size="small" checked={(uCenters[c.id] || []).includes(p)} onChange={() => togglePerm(c.id, p)} />
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                )}
              </Box>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUserEdit(null)}>Скасувати</Button>
          <Button variant="contained" onClick={saveUser}>Зберегти</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>{snack.msg}</Alert>
      </Snackbar>
    </Container>
  )
}
