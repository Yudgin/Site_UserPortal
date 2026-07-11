// Слой доступа сотрудников (RBAC): профиль-роль текущего пользователя + список центров.
// Загружается при входе (App). Хук useAccess даёт can(perm, centerId) / role / isOwner для гейтинга UI.
// ВНИМАНИЕ: клиентский гейтинг — только UX. Реальная защита — firestore.rules + backend (фаза 1b).
import { create } from 'zustand'
import { userProfileService } from '@/api/userProfileService'
import { serviceCenterService } from '@/api/serviceCenterService'
import { useAuthStore } from '@/store/authStore'
import { isAdminEmail } from '@/config/access'
import type { UserProfile, ServiceCenter, CenterPermission, Role } from '@/types/access'

interface AccessState {
  profile: UserProfile | null
  centers: ServiceCenter[]
  loaded: boolean
  load: (uid: string) => Promise<void>
  reloadCenters: () => Promise<void>
  clear: () => void
}

export const useAccessStore = create<AccessState>()((set) => ({
  profile: null,
  centers: [],
  loaded: false,
  load: async (uid) => {
    const [profile, centers] = await Promise.all([
      userProfileService.getOwn(uid),
      serviceCenterService.list(),
    ])
    set({ profile, centers, loaded: true })
  },
  reloadCenters: async () => set({ centers: await serviceCenterService.list() }),
  clear: () => set({ profile: null, centers: [], loaded: false }),
}))

// Итоговые права текущего пользователя. Владелец (по email ИЛИ role='owner') — всё.
// Бухгалтер — просмотр + оплата по всем центрам. Мастер — по своим центрам из профиля.
export const useAccess = () => {
  const user = useAuthStore((s) => s.user)
  const profile = useAccessStore((s) => s.profile)
  const centers = useAccessStore((s) => s.centers)
  const loaded = useAccessStore((s) => s.loaded)

  const isOwner = !!user && (isAdminEmail(user.email) || profile?.role === 'owner')
  const role: Role | null = isOwner ? 'owner' : profile?.active ? profile.role : null

  const can = (perm: CenterPermission, centerId?: string): boolean => {
    if (isOwner) return true
    if (!profile || !profile.active) return false
    if (profile.role === 'accountant') return perm === 'view' || perm === 'payment'
    if (profile.role === 'master') {
      if (!centerId) return (profile.centers || []).some((c) => c.perms.includes(perm))
      const c = (profile.centers || []).find((x) => x.centerId === centerId)
      return !!c && c.perms.includes(perm)
    }
    return false
  }

  // Центры, к которым у пользователя есть хотя бы просмотр (для фильтрации списков).
  const visibleCenterIds = (): string[] | 'all' => {
    if (isOwner || profile?.role === 'accountant') return 'all'
    if (profile?.role === 'master') return (profile.centers || []).filter((c) => c.perms.includes('view')).map((c) => c.centerId)
    return []
  }

  // Есть ли вообще доступ в служебную часть (не клиент).
  const isStaff = isOwner || (!!profile?.active && (profile.role === 'accountant' || profile.role === 'master'))

  return { isOwner, role, can, visibleCenterIds, isStaff, centers, loaded, profile }
}
