import { useEffect } from 'react'
import { Snackbar, Alert, Box, CircularProgress } from '@mui/material'
import AppRoutes from './routes'
import { useAuthStore } from '@/store/authStore'
import { firebaseAuth } from '@/api/firebase'

function App() {
  const { setUser, setLoading, isLoading } = useAuthStore()

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
          role: 'user',
          createdAt: firebaseUser.metadata.creationTime || new Date().toISOString(),
          lastLogin: new Date().toISOString(),
        })
        // Boats are persisted in localStorage, no need to verify on startup
      } else {
        setUser(null)
      }

      setLoading(false)
    })

    return () => unsubscribe()
  }, [setUser, setLoading])

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
