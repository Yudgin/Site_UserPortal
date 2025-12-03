import { useEffect } from 'react'
import { Snackbar, Alert, Box, CircularProgress } from '@mui/material'
import AppRoutes from './routes'
import { useAuthStore } from '@/store/authStore'
import { useBoatStore } from '@/store/boatStore'
import { useSettingsStore } from '@/store/settingsStore'
import { firebaseAuth } from '@/api/firebase'

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
          role: 'user',
          createdAt: firebaseUser.metadata.creationTime || new Date().toISOString(),
          lastLogin: new Date().toISOString(),
        })

        // Load user data from Firestore
        await Promise.all([
          loadBoatsFromServer(),
          loadSettingsFromServer(),
        ])
      } else {
        setUser(null)
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
