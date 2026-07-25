import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AppBar,
  Box,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Collapse,
  Toolbar,
  Typography,
  Avatar,
  Menu,
  MenuItem,
  Divider,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import {
  Menu as MenuIcon,
  Map as MapIcon,
  Settings as SettingsIcon,
  AdminPanelSettings as AdminIcon,
  Logout as LogoutIcon,
  Store as DistributorIcon,
  Build as RepairsIcon,
  Palette as DesignIcon,
  Calculate as PriceListIcon,
  Description as TermsIcon,
  MenuBook as KnowledgeIcon,
  SupportAgent as InboxIcon,
  Feedback as FeedbackIcon,
  Web as PresentationIcon,
  Assignment as QuestionnaireIcon,
  RequestQuote as PublicPriceIcon,
  Groups as ClientsIcon,
  ReportProblem as ComplaintIcon,
  Assignment as TaskIcon,
  Person as ProfileIcon,
  ReceiptLong as EstimateIcon,
  Payments as PaymentsIcon,
  AssignmentTurnedIn as RequestIcon,
  Insights as OwnerDashIcon,
  ManageAccounts as AccessIcon,
  Memory as FirmwareMenuIcon,
  LocalShipping as ShippingIcon,
  Sailing as BoatSalesIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'
import { useBoatStore } from '@/store/boatStore'
import { firebaseAuth } from '@/api/firebase'
import LanguageSelector from './LanguageSelector'
import BoatSelector from './BoatSelector'

const DRAWER_WIDTH = 240

export default function Layout() {
  const { t } = useTranslation()
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down('md'))
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuthStore()
  const { getSelectedBoat } = useBoatStore()
  const selectedBoat = getSelectedBoat()

  const [mobileOpen, setMobileOpen] = useState(false)
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen)
  }

  const handleUserMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget)
  }

  const handleUserMenuClose = () => {
    setAnchorEl(null)
  }

  const handleLogout = async () => {
    handleUserMenuClose()
    await firebaseAuth.signOut()
    logout()
    navigate('/login')
  }

  // Навигация: плоские пункты + сворачиваемые группы (дерево). NavGroup имеет поле items.
  type NavItem = { text: string; icon: JSX.Element; path: string }
  type NavGroup = { group: string; icon: JSX.Element; items: NavItem[] }
  type NavEntry = NavItem | NavGroup
  const isGroup = (e: NavEntry): e is NavGroup => 'items' in e

  const nav: NavEntry[] = [
    { text: t('reservoirs.title'), icon: <MapIcon />, path: '/' },
    { text: t('repairs.title'), icon: <RepairsIcon />, path: '/repairs' },
    { text: t('master.title', 'Прошивки пульта'), icon: <FirmwareMenuIcon />, path: '/master' },
    { text: t('design.title'), icon: <DesignIcon />, path: '/design' },
    { text: t('settings.title'), icon: <SettingsIcon />, path: '/settings' },
  ]

  if (user?.role === 'developer' || user?.role === 'distributor') {
    nav.push({ text: t('distributor.title') || 'Distributor', icon: <DistributorIcon />, path: '/distributor' })
  }

  // Разделы для владельца — сгруппированы, чтобы меню не было длинной простынёй.
  if (user?.role === 'developer') {
    nav.push({ text: 'Панель власника', icon: <OwnerDashIcon />, path: '/owner' })
    nav.push({ group: 'Заявки та сервіс', icon: <InboxIcon />, items: [
      { text: 'Обращения', icon: <InboxIcon />, path: '/manager-inbox' },
      { text: 'Заявки', icon: <RequestIcon />, path: '/service-requests' },
      { text: 'Дзвінки', icon: <InboxIcon />, path: '/calls' },
      { text: 'Задачи', icon: <TaskIcon />, path: '/tasks-admin' },
      // Та же страница, что в «Продажі корабликів»: импорт и продаж, и ремонтов из 1С6.
      { text: 'Імпорт з 1С6', icon: <RequestIcon />, path: '/boats-import' },
    ] })
    nav.push({ group: 'Калькуляції та оплати', icon: <PaymentsIcon />, items: [
      { text: 'Пропозиція клієнту', icon: <EstimateIcon />, path: '/offer-editor' },
      { text: 'Фактична калькуляція', icon: <EstimateIcon />, path: '/actual-estimate' },
      { text: 'Оплати та чеки', icon: <PaymentsIcon />, path: '/payments-admin' },
    ] })
    nav.push({ group: 'Прайс і контент', icon: <PriceListIcon />, items: [
      { text: 'Прайс-лист', icon: <PriceListIcon />, path: '/pricelist-admin' },
      { text: 'Публічний прайс', icon: <PublicPriceIcon />, path: '/price' },
      { text: 'Жалобы→работы', icon: <ComplaintIcon />, path: '/complaints-admin' },
      { text: 'Соглашение', icon: <TermsIcon />, path: '/service-content-admin' },
      { text: 'База знаний', icon: <KnowledgeIcon />, path: '/knowledge-admin' },
      { text: 'Презентація', icon: <PresentationIcon />, path: '/presentation' },
      { text: 'Опросник', icon: <QuestionnaireIcon />, path: '/questionnaire' },
    ] })
    nav.push({ group: 'Доставка (Нова Пошта)', icon: <ShippingIcon />, items: [
      { text: 'Шаблони посилок', icon: <ShippingIcon />, path: '/np-templates' },
    ] })
    nav.push({ group: 'Продажі корабликів', icon: <BoatSalesIcon />, items: [
      { text: 'Замовлення', icon: <BoatSalesIcon />, path: '/boat-orders' },
      { text: 'Каталог корабликів', icon: <BoatSalesIcon />, path: '/boats-catalog' },
      { text: 'Імпорт з 1С6', icon: <BoatSalesIcon />, path: '/boats-import' },
    ] })
    nav.push({ group: 'Клієнти', icon: <ClientsIcon />, items: [
      { text: 'Клиенты', icon: <ClientsIcon />, path: '/clients-admin' },
      { text: 'Профили', icon: <ProfileIcon />, path: '/client-profiles' },
      { text: 'Отзывы ИИ', icon: <FeedbackIcon />, path: '/feedback-admin' },
    ] })
    nav.push({ group: 'Доступ і система', icon: <AccessIcon />, items: [
      { text: 'Доступ та центри', icon: <AccessIcon />, path: '/access' },
      { text: 'Доступ до прошивок', icon: <FirmwareMenuIcon />, path: '/firmware-access' },
      { text: 'ФОПи та ключі', icon: <PaymentsIcon />, path: '/fops' },
      { text: 'Admin', icon: <AdminIcon />, path: '/admin' },
    ] })
  }

  // Группа открыта, если пользователь её раскрыл, либо (по умолчанию) в ней активный маршрут.
  const groupHasActive = (g: NavGroup) => g.items.some((it) => it.path === location.pathname)
  const isGroupOpen = (g: NavGroup) => openGroups[g.group] ?? groupHasActive(g)
  const toggleGroup = (title: string, g: NavGroup) =>
    setOpenGroups((prev) => ({ ...prev, [title]: !(prev[title] ?? groupHasActive(g)) }))

  const go = (path: string) => { navigate(path); if (isMobile) setMobileOpen(false) }

  const drawer = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Logo Area with gradient */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          py: 3,
          background: 'linear-gradient(180deg, rgba(33,150,243,0.08) 0%, rgba(255,255,255,0) 100%)',
        }}
      >
        <img src="/logo.svg" alt="Logo" style={{ height: 120 }} />
      </Box>

      {/* Selected Boat Info */}
      {selectedBoat && (
        <Box
          sx={{
            mx: 2,
            p: 2,
            borderRadius: 3,
            background: 'linear-gradient(135deg, #2196F3 0%, #1565C0 100%)',
            color: 'white',
            boxShadow: '0 4px 15px rgba(33,150,243,0.4)',
          }}
        >
          <Typography variant="subtitle2" fontWeight={600}>{selectedBoat.info.name}</Typography>
          <Typography variant="caption" sx={{ opacity: 0.85 }}>ID: {selectedBoat.credentials.boatId}</Typography>
        </Box>
      )}

      {/* Navigation (дерево: плоские пункты + сворачиваемые группы) */}
      <List sx={{ flex: 1, pt: 1, overflowY: 'auto' }}>
        {nav.map((entry) =>
          isGroup(entry) ? (
            <Box key={entry.group}>
              <ListItemButton onClick={() => toggleGroup(entry.group, entry)}>
                <ListItemIcon>{entry.icon}</ListItemIcon>
                <ListItemText primary={entry.group} primaryTypographyProps={{ fontWeight: 600 }} />
                {isGroupOpen(entry) ? <ExpandLessIcon color="action" /> : <ExpandMoreIcon color="action" />}
              </ListItemButton>
              <Collapse in={isGroupOpen(entry)} timeout="auto" unmountOnExit>
                <List disablePadding>
                  {entry.items.map((item) => (
                    <ListItemButton
                      key={item.path}
                      selected={location.pathname === item.path}
                      onClick={() => go(item.path)}
                      sx={{ pl: 4, '&.Mui-selected': { '& .MuiListItemIcon-root': { color: 'primary.main' } } }}
                    >
                      <ListItemIcon sx={{ minWidth: 38 }}>{item.icon}</ListItemIcon>
                      <ListItemText primary={item.text} primaryTypographyProps={{ variant: 'body2' }} />
                    </ListItemButton>
                  ))}
                </List>
              </Collapse>
            </Box>
          ) : (
            <ListItem key={entry.path} disablePadding>
              <ListItemButton
                selected={location.pathname === entry.path}
                onClick={() => go(entry.path)}
                sx={{ '&.Mui-selected': { '& .MuiListItemIcon-root': { color: 'primary.main' } } }}
              >
                <ListItemIcon>{entry.icon}</ListItemIcon>
                <ListItemText primary={entry.text} />
              </ListItemButton>
            </ListItem>
          )
        )}
      </List>
    </Box>
  )

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar
        position="fixed"
        sx={{
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          ml: { md: `${DRAWER_WIDTH}px` },
        }}
      >
        <Toolbar>
          <IconButton
            color="inherit"
            edge="start"
            onClick={handleDrawerToggle}
            sx={{ mr: 2, display: { md: 'none' } }}
          >
            <MenuIcon />
          </IconButton>

          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
            {t('app.title')}
          </Typography>

          <BoatSelector />

          <LanguageSelector />

          <IconButton onClick={handleUserMenuOpen} sx={{ ml: 1 }}>
            <Avatar
              src={user?.photoURL || undefined}
              alt={user?.displayName || user?.email}
              sx={{ width: 32, height: 32 }}
            >
              {user?.email?.charAt(0).toUpperCase()}
            </Avatar>
          </IconButton>

          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleUserMenuClose}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            <MenuItem disabled>
              <Typography variant="body2">{user?.email}</Typography>
            </MenuItem>
            <Divider />
            <MenuItem onClick={handleLogout}>
              <ListItemIcon>
                <LogoutIcon fontSize="small" />
              </ListItemIcon>
              {t('auth.logout')}
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box
        component="nav"
        sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}
      >
        {/* Mobile drawer */}
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={handleDrawerToggle}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': { boxSizing: 'border-box', width: DRAWER_WIDTH },
          }}
        >
          {drawer}
        </Drawer>

        {/* Desktop drawer */}
        <Drawer
          variant="permanent"
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': { boxSizing: 'border-box', width: DRAWER_WIDTH },
          }}
          open
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 3,
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          minHeight: '100vh',
          bgcolor: 'background.default',
        }}
      >
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  )
}
