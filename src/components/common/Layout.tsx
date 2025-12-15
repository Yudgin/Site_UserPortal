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

  const menuItems = [
    { text: t('reservoirs.title'), icon: <MapIcon />, path: '/' },
    { text: t('repairs.title'), icon: <RepairsIcon />, path: '/repairs' },
    { text: t('settings.title'), icon: <SettingsIcon />, path: '/settings' },
  ]

  // Add distributor menu for distributors and developers
  if (user?.role === 'developer' || user?.role === 'distributor') {
    menuItems.push({ text: t('distributor.title') || 'Distributor', icon: <DistributorIcon />, path: '/distributor' })
  }

  // Add admin menu for developers only
  if (user?.role === 'developer') {
    menuItems.push({ text: 'Admin', icon: <AdminIcon />, path: '/admin' })
  }

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

      {/* Navigation */}
      <List sx={{ flex: 1, pt: 2 }}>
        {menuItems.map((item) => (
          <ListItem key={item.path} disablePadding>
            <ListItemButton
              selected={location.pathname === item.path}
              onClick={() => {
                navigate(item.path)
                if (isMobile) setMobileOpen(false)
              }}
              sx={{
                '&.Mui-selected': {
                  '& .MuiListItemIcon-root': {
                    color: 'primary.main',
                  },
                },
              }}
            >
              <ListItemIcon>{item.icon}</ListItemIcon>
              <ListItemText primary={item.text} />
            </ListItemButton>
          </ListItem>
        ))}
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
