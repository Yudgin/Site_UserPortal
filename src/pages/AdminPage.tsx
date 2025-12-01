import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Typography,
  Paper,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Alert,
  Chip,
} from '@mui/material'
import { AdminPanelSettings, People, DirectionsBoat } from '@mui/icons-material'
import { useAuthStore } from '@/store/authStore'

interface TabPanelProps {
  children?: React.ReactNode
  index: number
  value: number
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`admin-tabpanel-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ pt: 3 }}>{children}</Box>}
    </div>
  )
}

// Mock data for admin panel
const mockUsers = [
  { id: '1', email: 'user1@example.com', boatId: 'BOAT001', lastLogin: '2024-11-28', role: 'user' },
  { id: '2', email: 'user2@example.com', boatId: 'BOAT002', lastLogin: '2024-11-27', role: 'user' },
  { id: '3', email: 'distributor@example.com', boatId: null, lastLogin: '2024-11-28', role: 'distributor' },
]

const mockBoats = [
  { id: 'BOAT001', name: 'My Bait Boat', firmware: 'v2.5.1', owner: 'user1@example.com', lastActive: '2024-11-28' },
  { id: 'BOAT002', name: 'Demo Boat', firmware: 'v2.4.0', owner: 'user2@example.com', lastActive: '2024-11-25' },
]

export default function AdminPage() {
  useTranslation()
  const { user } = useAuthStore()
  const [tab, setTab] = useState(0)

  // Check access
  if (!user || (user.role !== 'developer' && user.role !== 'distributor')) {
    return (
      <Box>
        <Typography variant="h4" gutterBottom>
          Admin Panel
        </Typography>
        <Alert severity="error">
          You do not have permission to access this page.
        </Alert>
      </Box>
    )
  }

  const isDeveloper = user.role === 'developer'

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <AdminPanelSettings sx={{ fontSize: 32, color: 'primary.main' }} />
        <Typography variant="h4">Admin Panel</Typography>
        <Chip
          label={isDeveloper ? 'Developer' : 'Distributor'}
          color={isDeveloper ? 'error' : 'primary'}
          size="small"
        />
      </Box>

      <Paper sx={{ width: '100%' }}>
        <Tabs value={tab} onChange={(_, newValue) => setTab(newValue)}>
          <Tab icon={<People />} label="Users" iconPosition="start" />
          {isDeveloper && <Tab icon={<DirectionsBoat />} label="Boats" iconPosition="start" />}
        </Tabs>

        {/* Users Tab */}
        <TabPanel value={tab} index={0}>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Email</TableCell>
                  <TableCell>Boat ID</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Last Login</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {mockUsers.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.email}</TableCell>
                    <TableCell>{row.boatId || '-'}</TableCell>
                    <TableCell>
                      <Chip
                        label={row.role}
                        size="small"
                        color={row.role === 'distributor' ? 'primary' : 'default'}
                      />
                    </TableCell>
                    <TableCell>{row.lastLogin}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </TabPanel>

        {/* Boats Tab (Developer only) */}
        {isDeveloper && (
          <TabPanel value={tab} index={1}>
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Boat ID</TableCell>
                    <TableCell>Name</TableCell>
                    <TableCell>Firmware</TableCell>
                    <TableCell>Owner</TableCell>
                    <TableCell>Last Active</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {mockBoats.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Typography variant="body2" fontFamily="monospace">
                          {row.id}
                        </Typography>
                      </TableCell>
                      <TableCell>{row.name}</TableCell>
                      <TableCell>
                        <Chip label={row.firmware} size="small" variant="outlined" />
                      </TableCell>
                      <TableCell>{row.owner}</TableCell>
                      <TableCell>{row.lastActive}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </TabPanel>
        )}
      </Paper>

      <Alert severity="info" sx={{ mt: 3 }}>
        Note: This is a mock admin panel. In production, data will be loaded from the API.
        User synchronization runs every hour and on new registrations.
      </Alert>
    </Box>
  )
}
