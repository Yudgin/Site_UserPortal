import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Box, CircularProgress } from '@mui/material'
import { useAuthStore } from '@/store/authStore'
import { useBoatStore } from '@/store/boatStore'
import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'
import DashboardPage from '@/pages/DashboardPage'
import ReservoirPage from '@/pages/ReservoirPage'
import SettingsPage from '@/pages/SettingsPage'
import SharePage from '@/pages/SharePage'
import ServiceSharePage from '@/pages/ServiceSharePage'
import AdminPage from '@/pages/AdminPage'
import DistributorPage from '@/pages/DistributorPage'
import BoatConfiguratorPage from '@/pages/BoatConfiguratorPage'
import BoatConfiguratorResultPage from '@/pages/BoatConfiguratorResultPage'
import BoatConfiguratorLookupPage from '@/pages/BoatConfiguratorLookupPage'
import Layout from '@/components/common/Layout'

interface ProtectedRouteProps {
  children: React.ReactNode
}

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { user, isLoading: authLoading } = useAuthStore()
  const { boats, isLoading: boatsLoading, isSynced, loadFromServer } = useBoatStore()

  // Trigger loading if user is authenticated but boats not synced
  React.useEffect(() => {
    if (user && !isSynced && !boatsLoading) {
      loadFromServer()
    }
  }, [user, isSynced, boatsLoading, loadFromServer])

  // Wait for auth to complete
  if (authLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  // Wait for boats to load from server
  if (boatsLoading || (!isSynced && boats.length === 0)) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    )
  }

  // Only redirect to connect-boat if boats are synced but empty
  if (isSynced && boats.length === 0) {
    return <Navigate to="/connect-boat" replace />
  }

  return <>{children}</>
}

const AuthRoute = ({ children }: ProtectedRouteProps) => {
  const { user } = useAuthStore()
  const { boats, isSynced } = useBoatStore()

  // Only redirect if fully loaded and has boats
  if (user && isSynced && boats.length > 0) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}

// Route that requires auth but not boat connection
const AuthenticatedRoute = ({ children }: ProtectedRouteProps) => {
  const { user } = useAuthStore()

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

export const AppRoutes = () => {
  return (
    <Routes>
      {/* Public routes */}
      <Route
        path="/login"
        element={
          <AuthRoute>
            <LoginPage />
          </AuthRoute>
        }
      />
      <Route
        path="/register"
        element={
          <AuthRoute>
            <RegisterPage />
          </AuthRoute>
        }
      />

      {/* Share route - semi-public */}
      <Route path="/share/:shareKey" element={<SharePage />} />

      {/* Service repair share - public */}
      <Route path="/serviceshare/:requestId" element={<ServiceSharePage />} />

      {/* Boat configurator - public */}
      <Route path="/configurator" element={<BoatConfiguratorPage />} />
      <Route path="/configurator/result/:code" element={<BoatConfiguratorResultPage />} />
      <Route path="/configurator/lookup" element={<BoatConfiguratorLookupPage />} />

      {/* Protected routes with Layout */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="reservoir/:id" element={<ReservoirPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="distributor" element={<DistributorPage />} />
      </Route>

      {/* Connect boat page (needs auth but not boat) */}
      <Route
        path="/connect-boat"
        element={
          <AuthenticatedRoute>
            <LoginPage connectBoat />
          </AuthenticatedRoute>
        }
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default AppRoutes
