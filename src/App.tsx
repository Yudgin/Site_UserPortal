import { useEffect } from 'react'
import { Snackbar, Alert, Box, CircularProgress } from '@mui/material'
import AppRoutes from './routes'
import { useAuthStore } from '@/store/authStore'
import { useBoatStore } from '@/store/boatStore'
import { useSettingsStore } from '@/store/settingsStore'
import { firebaseAuth } from '@/api/firebase'
import { isAdminEmail } from '@/config/access'
import { useAccessStore } from '@/store/accessStore'
import { userProfileService } from '@/api/userProfileService'

function App() {
  const { setUser, setLoading, isLoading } = useAuthStore()
  const loadBoatsFromServer = useBoatStore((state) => state.loadFromServer)
  const loadSettingsFromServer = useSettingsStore((state) => state.loadFromServer)

  useEffect(() => {
    setLoading(true)

    // Listen to Firebase auth state changes
    const unsubscribe = firebaseAuth.onAuthStateChanged(async (firebaseUser) => {
      if (firebaseUser) {
        setUser({
          id: firebaseUser.uid,
          email: firebaseUser.email || '',
          displayName: firebaseUser.displayName,
          photoURL: firebaseUser.photoURL,
          phoneNumber: firebaseUser.phoneNumber,
          // Роль администратора прайс-листа выдаётся по email (см. config/access.ts)
          role: isAdminEmail(firebaseUser.email) ? 'developer' : 'user',
          createdAt: firebaseUser.metadata.creationTime || new Date().toISOString(),
          lastLogin: new Date().toISOString(),
        })

        // Саморегистрация identity (для реестра сотрудников) + загрузка роли/центров (RBAC).
        // Роль НЕ выдаём с клиента — только владелец назначает; здесь лишь читаем свой профиль.
        userProfileService.registerSelf().finally(() => {
          useAccessStore.getState().load(firebaseUser.uid)
        })

        // Load user data from Firestore
        await Promise.all([
          loadBoatsFromServer(),
          loadSettingsFromServer(),
        ])
      } else {
        setUser(null)
        useAccessStore.getState().clear()
        // Clear local stores on logout
        useBoatStore.setState({ boats: [], selectedBoatId: null, isSynced: false })
        useSettingsStore.setState({
          phoneNumber: null,
          serviceRequests: [],
          isSynced: false,
        })
      }

      setLoading(false)
    })

    return () => unsubscribe()
  }, [setUser, setLoading, loadBoatsFromServer, loadSettingsFromServer])

  const { error, setError } = useAuthStore()

  // Show loading while Firebase checks auth state
  if (isLoading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress />
      </Box>
    )
  }

  return (
    <>
      <AppRoutes />

      {/* Global error notification */}
      <Snackbar
        open={!!error}
        autoHideDuration={6000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setError(null)}
          severity="error"
          variant="filled"
          sx={{ width: '100%' }}
        >
          {error}
        </Alert>
      </Snackbar>
    </>
  )
}

export default App
