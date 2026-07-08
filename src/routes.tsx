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
import NewRepairPage from '@/pages/NewRepairPage'
import RepairsPage from '@/pages/RepairsPage'
import PixelEditorPage from '@/pages/PixelEditorPage'
import DesignPage from '@/pages/DesignPage'
import PriceListAdminPage from '@/pages/PriceListAdminPage'
import ServiceContentAdminPage from '@/pages/ServiceContentAdminPage'
import KnowledgeAdminPage from '@/pages/KnowledgeAdminPage'
import ClientChatPage from '@/pages/ClientChatPage'
import ManagerInboxPage from '@/pages/ManagerInboxPage'
import FeedbackAdminPage from '@/pages/FeedbackAdminPage'
import ServicePresentationPage from '@/pages/ServicePresentationPage'
import QuestionnairePage from '@/pages/QuestionnairePage'
import PublicPriceListPage from '@/pages/PublicPriceListPage'
import KnowledgeArticlePage from '@/pages/KnowledgeArticlePage'
import ClientsAdminPage from '@/pages/ClientsAdminPage'
import ClientProfilesAdminPage from '@/pages/ClientProfilesAdminPage'
import ComplaintsAdminPage from '@/pages/ComplaintsAdminPage'
import TasksAdminPage from '@/pages/TasksAdminPage'
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

  // Only redirect to connect-boat if boats are synced but empty.
  // Администратор (developer) видит панель (и меню) даже без привязанной лодки.
  if (isSynced && boats.length === 0) {
    if (user.role === 'developer') return <>{children}</>
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

      {/* Service repair - public */}
      <Route path="/serviceshare/:requestId" element={<ServiceSharePage />} />
      <Route path="/service/:requestId" element={<ServiceSharePage />} />
      <Route path="/repair/new" element={<NewRepairPage />} />

      {/* Service presentation - public marketing page */}
      <Route path="/presentation" element={<ServicePresentationPage />} />

      {/* Intake questionnaire - public */}
      <Route path="/questionnaire" element={<QuestionnairePage />} />

      {/* Public price list - public */}
      <Route path="/price" element={<PublicPriceListPage />} />

      {/* Public knowledge article view - public */}
      <Route path="/help/:id" element={<KnowledgeArticlePage />} />

      {/* Client AI chat - public (session protected by unguessable id) */}
      <Route path="/chat" element={<ClientChatPage />} />
      <Route path="/chat/:sessionId" element={<ClientChatPage />} />

      {/* Manager inbox (escalated chats) - requires auth (email-gated inside) */}
      <Route
        path="/manager-inbox"
        element={
          <AuthenticatedRoute>
            <ManagerInboxPage />
          </AuthenticatedRoute>
        }
      />

      {/* Feedback + AI behavior corrections admin - requires auth (email-gated inside) */}
      <Route
        path="/feedback-admin"
        element={
          <AuthenticatedRoute>
            <FeedbackAdminPage />
          </AuthenticatedRoute>
        }
      />

      {/* Clients & boats database - requires auth (email-gated inside) */}
      <Route
        path="/clients-admin"
        element={
          <AuthenticatedRoute>
            <ClientsAdminPage />
          </AuthenticatedRoute>
        }
      />

      {/* Client profiles (merged by phone) - requires auth (email-gated inside) */}
      <Route
        path="/client-profiles"
        element={
          <AuthenticatedRoute>
            <ClientProfilesAdminPage />
          </AuthenticatedRoute>
        }
      />

      {/* Complaint templates (symptom → works) - requires auth (email-gated inside) */}
      <Route
        path="/complaints-admin"
        element={
          <AuthenticatedRoute>
            <ComplaintsAdminPage />
          </AuthenticatedRoute>
        }
      />

      {/* Service tasks (parts shipment, extra work…) - requires auth (email-gated inside) */}
      <Route
        path="/tasks-admin"
        element={
          <AuthenticatedRoute>
            <TasksAdminPage />
          </AuthenticatedRoute>
        }
      />

      {/* Price list admin - requires auth (email-gated inside), no boat needed */}
      <Route
        path="/pricelist-admin"
        element={
          <AuthenticatedRoute>
            <PriceListAdminPage />
          </AuthenticatedRoute>
        }
      />

      {/* Service content admin (agreement text) - requires auth (email-gated inside) */}
      <Route
        path="/service-content-admin"
        element={
          <AuthenticatedRoute>
            <ServiceContentAdminPage />
          </AuthenticatedRoute>
        }
      />

      {/* Knowledge base admin - requires auth (email-gated inside) */}
      <Route
        path="/knowledge-admin"
        element={
          <AuthenticatedRoute>
            <KnowledgeAdminPage />
          </AuthenticatedRoute>
        }
      />

      {/* Boat configurator - public */}
      <Route path="/configurator" element={<BoatConfiguratorPage />} />
      <Route path="/configurator/:code" element={<BoatConfiguratorPage />} />
      <Route path="/configurator/result/:code" element={<BoatConfiguratorResultPage />} />
      <Route path="/configurator/lookup" element={<BoatConfiguratorLookupPage />} />

      {/* Pixel editor - view is public, create requires auth */}
      <Route path="/pixel-editor/:designId" element={<PixelEditorPage />} />
      <Route
        path="/pixel-editor"
        element={
          <AuthenticatedRoute>
            <PixelEditorPage />
          </AuthenticatedRoute>
        }
      />

      {/* Pixel editor admin - with export buttons */}
      <Route path="/pixel-editor-admin/:designId" element={<PixelEditorPage isAdmin />} />
      <Route
        path="/pixel-editor-admin"
        element={
          <AuthenticatedRoute>
            <PixelEditorPage isAdmin />
          </AuthenticatedRoute>
        }
      />

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
        <Route path="repairs" element={<RepairsPage />} />
        <Route path="design" element={<DesignPage />} />
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
