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
  IconButton,
  Menu,
  MenuItem,
} from '@mui/material'
import {
  Search as SearchIcon,
  ArrowBack as BackIcon,
  Language as LanguageIcon,
} from '@mui/icons-material'
import { decodeConfiguration } from './BoatConfiguratorPage'
import { languages } from '@/i18n'

export default function BoatConfiguratorLookupPage() {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation()
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)
  const [langMenuAnchor, setLangMenuAnchor] = useState<null | HTMLElement>(null)

  const handleLanguageChange = (langCode: string) => {
    i18n.changeLanguage(langCode)
    setLangMenuAnchor(null)
  }

  const currentLanguage = languages.find(l => l.code === i18n.language) || languages[0]

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
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h5">
          {t('configurator.lookupTitle', 'Пошук конфігурації')}
        </Typography>
        <IconButton
          onClick={(e) => setLangMenuAnchor(e.currentTarget)}
          size="small"
          sx={{ border: '1px solid #ccc' }}
        >
          <Box component="span" sx={{ fontSize: '1.2rem', mr: 0.5 }}>{currentLanguage.flag}</Box>
          <LanguageIcon fontSize="small" />
        </IconButton>
        <Menu
          anchorEl={langMenuAnchor}
          open={Boolean(langMenuAnchor)}
          onClose={() => setLangMenuAnchor(null)}
        >
          {languages.map((lang) => (
            <MenuItem
              key={lang.code}
              onClick={() => handleLanguageChange(lang.code)}
              selected={lang.code === i18n.language}
            >
              <Box component="span" sx={{ mr: 1 }}>{lang.flag}</Box>
              {lang.name}
            </MenuItem>
          ))}
        </Menu>
      </Box>

      <Typography variant="body1" color="textSecondary" textAlign="center" sx={{ mb: 4 }}>
        {t('configurator.lookupDescription', 'Введіть 9-значний код конфігурації, щоб побачити зовнішній вигляд човна')}
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
