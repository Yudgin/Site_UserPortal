import { createTheme, alpha } from '@mui/material/styles'

// Brand colors
const brandBlue = '#2196F3'
const brandOrange = '#FF6B35'

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: brandBlue,
      light: '#64B5F6',
      dark: '#1976D2',
      contrastText: '#ffffff',
    },
    secondary: {
      main: brandOrange,
      light: '#FF8A5B',
      dark: '#E55A2B',
      contrastText: '#ffffff',
    },
    background: {
      default: '#F8FAFC',
      paper: '#ffffff',
    },
    text: {
      primary: '#1E293B',
      secondary: '#64748B',
    },
    divider: '#E2E8F0',
    error: {
      main: '#EF4444',
      light: '#FCA5A5',
    },
    success: {
      main: '#10B981',
      light: '#6EE7B7',
    },
    warning: {
      main: '#F59E0B',
      light: '#FCD34D',
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h1: {
      fontWeight: 700,
      letterSpacing: '-0.02em',
    },
    h2: {
      fontWeight: 700,
      letterSpacing: '-0.01em',
    },
    h3: {
      fontWeight: 600,
      letterSpacing: '-0.01em',
    },
    h4: {
      fontWeight: 600,
    },
    h5: {
      fontWeight: 600,
    },
    h6: {
      fontWeight: 600,
    },
    button: {
      fontWeight: 600,
    },
  },
  shape: {
    borderRadius: 12,
  },
  shadows: [
    'none',
    '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
    '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  ],
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          scrollbarWidth: 'thin',
          '&::-webkit-scrollbar': {
            width: '8px',
            height: '8px',
          },
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: '#CBD5E1',
            borderRadius: '4px',
          },
          '&::-webkit-scrollbar-track': {
            backgroundColor: '#F1F5F9',
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          borderRadius: 10,
          fontWeight: 600,
          padding: '10px 20px',
          boxShadow: 'none',
          '&:hover': {
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          },
        },
        contained: {
          background: `linear-gradient(135deg, ${brandBlue} 0%, ${alpha(brandBlue, 0.85)} 100%)`,
          '&:hover': {
            background: `linear-gradient(135deg, ${brandBlue} 0%, #1976D2 100%)`,
          },
        },
        containedSecondary: {
          background: `linear-gradient(135deg, ${brandOrange} 0%, ${alpha(brandOrange, 0.85)} 100%)`,
          '&:hover': {
            background: `linear-gradient(135deg, ${brandOrange} 0%, #E55A2B 100%)`,
          },
        },
        outlined: {
          borderWidth: 2,
          '&:hover': {
            borderWidth: 2,
          },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 16,
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          border: '1px solid #E2E8F0',
          transition: 'transform 0.2s ease, box-shadow 0.2s ease',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: 16,
        },
        elevation1: {
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
        },
        elevation3: {
          boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 10,
            transition: 'box-shadow 0.2s ease',
            '&:hover': {
              boxShadow: '0 2px 8px rgba(33,150,243,0.15)',
            },
            '&.Mui-focused': {
              boxShadow: '0 4px 12px rgba(33,150,243,0.2)',
            },
          },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: `linear-gradient(135deg, ${brandBlue} 0%, #1565C0 100%)`,
          boxShadow: '0 4px 20px rgba(33,150,243,0.3)',
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          borderRight: 'none',
          boxShadow: '4px 0 20px rgba(0,0,0,0.08)',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          margin: '4px 8px',
          '&.Mui-selected': {
            background: `linear-gradient(135deg, ${alpha(brandBlue, 0.15)} 0%, ${alpha(brandBlue, 0.08)} 100%)`,
            '&:hover': {
              background: `linear-gradient(135deg, ${alpha(brandBlue, 0.2)} 0%, ${alpha(brandBlue, 0.12)} 100%)`,
            },
          },
          '&:hover': {
            background: alpha(brandBlue, 0.08),
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          fontWeight: 500,
        },
        colorPrimary: {
          background: `linear-gradient(135deg, ${brandBlue} 0%, #1976D2 100%)`,
        },
        colorSecondary: {
          background: `linear-gradient(135deg, ${brandOrange} 0%, #E55A2B 100%)`,
        },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          borderRadius: '12px !important',
          marginBottom: 8,
          border: '1px solid #E2E8F0',
          boxShadow: 'none',
          '&:before': {
            display: 'none',
          },
          '&.Mui-expanded': {
            margin: '0 0 8px 0',
          },
        },
      },
    },
    MuiAccordionSummary: {
      styleOverrides: {
        root: {
          borderRadius: 12,
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 12,
        },
        standardSuccess: {
          background: alpha('#10B981', 0.1),
          border: `1px solid ${alpha('#10B981', 0.3)}`,
        },
        standardError: {
          background: alpha('#EF4444', 0.1),
          border: `1px solid ${alpha('#EF4444', 0.3)}`,
        },
        standardWarning: {
          background: alpha('#F59E0B', 0.1),
          border: `1px solid ${alpha('#F59E0B', 0.3)}`,
        },
        standardInfo: {
          background: alpha(brandBlue, 0.1),
          border: `1px solid ${alpha(brandBlue, 0.3)}`,
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: {
          height: 3,
          borderRadius: '3px 3px 0 0',
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          fontSize: '0.95rem',
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 20,
        },
      },
    },
    MuiAvatar: {
      styleOverrides: {
        root: {
          background: `linear-gradient(135deg, ${brandOrange} 0%, #E55A2B 100%)`,
        },
      },
    },
  },
})

// Export brand colors for use in components
export const brandColors = {
  blue: brandBlue,
  orange: brandOrange,
  gradient: {
    blue: `linear-gradient(135deg, ${brandBlue} 0%, #1565C0 100%)`,
    orange: `linear-gradient(135deg, ${brandOrange} 0%, #E55A2B 100%)`,
    blueLight: `linear-gradient(135deg, ${alpha(brandBlue, 0.1)} 0%, ${alpha(brandBlue, 0.05)} 100%)`,
  },
}
