import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Container,
  Paper,
  Box,
  Tabs,
  Tab,
} from '@mui/material'
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
    // After login/register, navigate to home - ProtectedRoute will handle
    // waiting for data to load and redirecting to /connect-boat if needed
    navigate('/')
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
        background: 'linear-gradient(135deg, #F8FAFC 0%, #EEF2FF 50%, #FFF7ED 100%)',
        position: 'relative',
        overflow: 'hidden',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: '-50%',
          right: '-20%',
          width: '60%',
          height: '100%',
          background: 'radial-gradient(circle, rgba(33,150,243,0.1) 0%, transparent 70%)',
          pointerEvents: 'none',
        },
        '&::after': {
          content: '""',
          position: 'absolute',
          bottom: '-30%',
          left: '-10%',
          width: '50%',
          height: '80%',
          background: 'radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 70%)',
          pointerEvents: 'none',
        },
      }}
    >
      {/* Header with language selector */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-end',
          p: 2,
          position: 'relative',
          zIndex: 1,
        }}
      >
        <LanguageSelector />
      </Box>

      <Container maxWidth="sm" sx={{ flex: 1, display: 'flex', alignItems: 'center', position: 'relative', zIndex: 1 }}>
        <Paper
          elevation={0}
          sx={{
            p: { xs: 3, sm: 5 },
            width: '100%',
            borderRadius: 4,
            border: '1px solid rgba(255,255,255,0.8)',
            background: 'rgba(255,255,255,0.9)',
            backdropFilter: 'blur(20px)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.1)',
          }}
        >
          {/* Logo */}
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <img src="/logo.svg" alt="Logo" style={{ height: 140 }} />
          </Box>

          {showBoatConnection ? (
            <BoatConnection onSuccess={handleBoatConnected} />
          ) : (
            <>
              <Tabs
                value={tab}
                onChange={(_, newValue) => setTab(newValue)}
                centered
                sx={{
                  mb: 4,
                  '& .MuiTabs-indicator': {
                    background: 'linear-gradient(90deg, #2196F3 0%, #FF6B35 100%)',
                  },
                }}
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
