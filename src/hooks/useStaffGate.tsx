// Гейт служебных страниц по РОЛИ (RBAC 1b) вместо проверки email владельца.
// Использование: const gate = useStaffGate((a) => a.can('actual')); ... if (gate) return gate
// Возвращает null, когда доступ разрешён; иначе — готовый экран (спиннер пока профиль не
// загружен, или «доступ заборонено»). Владелец по email не ждёт загрузки профиля.
import { Container, Alert, Button, Box, CircularProgress } from '@mui/material'
import { Home as HomeIcon } from '@mui/icons-material'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useAccess } from '@/store/accessStore'

export type AccessInfo = ReturnType<typeof useAccess>

export function useStaffGate(
  allow: (a: AccessInfo) => boolean,
  deniedText = 'Доступ лише для співробітників сервісу з відповідними правами.',
): JSX.Element | null {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const access = useAccess()

  const denied = (text: string) => (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Alert severity="error">{text}</Alert>
      <Button startIcon={<HomeIcon />} onClick={() => navigate('/')} sx={{ mt: 2 }}>На головну</Button>
    </Container>
  )

  if (!user) return denied('Потрібно увійти в систему.')
  if (!access.loaded && !access.isOwner) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>
  }
  if (!allow(access)) return denied(deniedText)
  return null
}

// Видна ли заявка/калькуляция этого центра текущему сотруднику (владелец/бухгалтер — все;
// директор/мастер — только свои центры; заявки БЕЗ центра им не показываем).
export const centerVisible = (a: AccessInfo, centerId?: string | null): boolean => {
  const v = a.visibleCenterIds()
  if (v === 'all') return true
  return !!centerId && v.includes(centerId)
}
