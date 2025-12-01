import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Container,
  Paper,
  Box,
  Typography,
  Tabs,
  Tab,
} from '@mui/material'
import { DirectionsBoat } from '@mui/icons-material'
import LoginForm from '@/components/auth/LoginForm'
import RegisterForm from '@/components/auth/RegisterForm'
import BoatConnection from '@/components/auth/BoatConnection'
import LanguageSelector from '@/components/common/LanguageSelector'
import { useAuthStore } from '@/store/authStore'
import { useBoatStore } from '@/store/boatStore'

interface LoginPageProps {
  connectBoat?: boolean
}

export default function LoginPage({ connectBoat = false }: LoginPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const { boats } = useBoatStore()
  const [tab, setTab] = useState(0)

  // If user is logged in but needs to connect boat
  const showBoatConnection = connectBoat || (user && boats.length === 0)

  const handleAuthSuccess = () => {
    // After login/register, check if boat is connected
    const { boats } = useBoatStore.getState()
    if (boats.length > 0) {
      navigate('/')
    } else {
      navigate('/connect-boat')
    }
  }

  const handleBoatConnected = () => {
    navigate('/')
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      {/* Header with language selector */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          p: 2,
        }}
      >
        <LanguageSelector />
      </Box>

      <Container maxWidth="sm" sx={{ flex: 1, display: 'flex', alignItems: 'center' }}>
        <Paper
          elevation={3}
          sx={{
            p: 4,
            width: '100%',
            borderRadius: 3,
          }}
        >
          {/* Logo */}
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <DirectionsBoat sx={{ fontSize: 56, color: 'primary.main' }} />
            <Typography variant="h4" fontWeight="bold" sx={{ mt: 1 }}>
              {t('app.title')}
            </Typography>
          </Box>

          {showBoatConnection ? (
            <BoatConnection onSuccess={handleBoatConnected} />
          ) : (
            <>
              <Tabs
                value={tab}
                onChange={(_, newValue) => setTab(newValue)}
                centered
                sx={{ mb: 3 }}
              >
                <Tab label={t('auth.login')} />
                <Tab label={t('auth.register')} />
              </Tabs>

              {tab === 0 ? (
                <LoginForm
                  onSuccess={handleAuthSuccess}
                  onRegisterClick={() => setTab(1)}
                />
              ) : (
                <RegisterForm
                  onSuccess={handleAuthSuccess}
                  onLoginClick={() => setTab(0)}
                />
              )}
            </>
          )}
        </Paper>
      </Container>
    </Box>
  )
}
