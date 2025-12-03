import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Alert,
} from '@mui/material'
import {
  Search as SearchIcon,
  ArrowBack as BackIcon,
} from '@mui/icons-material'
import { decodeConfiguration } from './BoatConfiguratorPage'

export default function BoatConfiguratorLookupPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedCode = code.trim().toUpperCase()

    if (!trimmedCode) {
      setError(true)
      return
    }

    // Validate the code
    const config = decodeConfiguration(trimmedCode)
    if (!config) {
      setError(true)
      return
    }

    // Navigate to results page
    navigate(`/configurator/result/${trimmedCode}`)
  }

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCode(e.target.value.toUpperCase())
    setError(false)
  }

  return (
    <Box sx={{ p: 2, maxWidth: 600, mx: 'auto', mt: 4 }}>
      <Typography variant="h5" gutterBottom textAlign="center">
        {t('configurator.lookupTitle', 'Поиск конфигурации')}
      </Typography>

      <Typography variant="body1" color="textSecondary" textAlign="center" sx={{ mb: 4 }}>
        {t('configurator.lookupDescription', 'Введите 9-значный код конфигурации, чтобы увидеть внешний вид лодки')}
      </Typography>

      <Paper sx={{ p: 4 }}>
        <form onSubmit={handleSubmit}>
          <TextField
            label={t('configurator.enterCode', 'Введите код')}
            value={code}
            onChange={handleCodeChange}
            fullWidth
            error={error}
            helperText={error ? t('configurator.invalidCodeError', 'Недействительный код. Код должен содержать 9 символов.') : ''}
            InputProps={{
              sx: {
                fontFamily: 'monospace',
                fontSize: '1.5rem',
                textAlign: 'center',
                letterSpacing: '0.2em',
              },
            }}
            inputProps={{
              maxLength: 9,
              style: { textAlign: 'center' },
            }}
            sx={{ mb: 3 }}
          />

          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {t('configurator.invalidCodeMessage', 'Код не найден или недействителен. Убедитесь, что вы ввели правильный 9-значный код.')}
            </Alert>
          )}

          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
            <Button
              variant="outlined"
              startIcon={<BackIcon />}
              onClick={() => navigate('/configurator')}
            >
              {t('configurator.backToConfigurator', 'К конфигуратору')}
            </Button>
            <Button
              type="submit"
              variant="contained"
              startIcon={<SearchIcon />}
              disabled={code.length !== 9}
            >
              {t('configurator.search', 'Найти')}
            </Button>
          </Box>
        </form>
      </Paper>

      <Box sx={{ mt: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="textSecondary">
          {t('configurator.codeExample', 'Пример кода')}: <strong>0A1B2C3D4</strong>
        </Typography>
      </Box>
    </Box>
  )
}
