import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useBoatStore } from '@/store/boatStore'
import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'
import DashboardPage from '@/pages/DashboardPage'
import ReservoirPage from '@/pages/ReservoirPage'
import SettingsPage from '@/pages/SettingsPage'
import SharePage from '@/pages/SharePage'
import AdminPage from '@/pages/AdminPage'
import DistributorPage from '@/pages/DistributorPage'
import Layout from '@/components/common/Layout'

interface ProtectedRouteProps {
  children: React.ReactNode
}

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { user } = useAuthStore()
  const { boats } = useBoatStore()

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (boats.length === 0) {
    return <Navigate to="/connect-boat" replace />
  }

  return <>{children}</>
}

const AuthRoute = ({ children }: ProtectedRouteProps) => {
  const { user } = useAuthStore()
  const { boats } = useBoatStore()

  if (user && boats.length > 0) {
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
