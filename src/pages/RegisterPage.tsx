import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Container,
  Paper,
  Box,
  Typography,
} from '@mui/material'
import { DirectionsBoat } from '@mui/icons-material'
import RegisterForm from '@/components/auth/RegisterForm'
import LanguageSelector from '@/components/common/LanguageSelector'

export default function RegisterPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const handleSuccess = () => {
    navigate('/connect-boat')
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
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <DirectionsBoat sx={{ fontSize: 56, color: 'primary.main' }} />
            <Typography variant="h4" fontWeight="bold" sx={{ mt: 1 }}>
              {t('auth.register')}
            </Typography>
          </Box>

          <RegisterForm
            onSuccess={handleSuccess}
            onLoginClick={() => navigate('/login')}
          />
        </Paper>
      </Container>
    </Box>
  )
}
