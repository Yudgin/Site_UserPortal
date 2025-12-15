import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Container,
  Paper,
  Box,
  Typography,
  Button,
  Alert,
  CircularProgress,
  Divider,
  List,
  ListItem,
  ListItemText,
  Card,
  CardContent,
  Radio,
  RadioGroup,
  FormControlLabel,
  TextField,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Snackbar,
} from '@mui/material'
import {
  ExpandMore as ExpandMoreIcon,
  CheckCircle as CheckCircleIcon,
  Phone as PhoneIcon,
  Comment as CommentIcon,
  QuestionAnswer as QuestionIcon,
  LocalShipping as ShippingIcon,
  Build as BuildIcon,
  Payment as PaymentIcon,
  Person as PersonIcon,
} from '@mui/icons-material'
import LanguageSelector from '@/components/common/LanguageSelector'
import LoadingSpinner from '@/components/common/LoadingSpinner'
import ClientInfoEditor from '@/components/common/ClientInfoEditor'
import { serviceApi, ServiceRequestData, ClientInfo } from '@/api/endpoints/service'
import { useSettingsStore } from '@/store/settingsStore'
import { useNavigate } from 'react-router-dom'
import { Home as HomeIcon } from '@mui/icons-material'

export default function ServiceSharePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { requestId } = useParams<{ requestId: string }>()
  const { addServiceRequest } = useSettingsStore()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ServiceRequestData | null>(null)

  // Action loading states
  const [acceptingTerms, setAcceptingTerms] = useState(false)
  const [confirmingRepair, setConfirmingRepair] = useState(false)
  const [addingComment, setAddingComment] = useState(false)
  const [addingQuestion, setAddingQuestion] = useState(false)
  const [requestingCall, setRequestingCall] = useState(false)

  // Form states
  const [selectedRepairOption, setSelectedRepairOption] = useState<string>('')
  const [newComment, setNewComment] = useState('')
  const [newQuestion, setNewQuestion] = useState('')
  const [callComment, setCallComment] = useState('')

  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  })

  useEffect(() => {
    if (requestId) {
      loadData()
    }
  }, [requestId])

  const loadData = async () => {
    if (!requestId) return

    setLoading(true)
    setError(null)

    const result = await serviceApi.getRequest(requestId)

    if (result.success && result.data) {
      setData(result.data)
      if (result.data.selectedRepairOptionId) {
        setSelectedRepairOption(result.data.selectedRepairOptionId)
      }
      // Add this request to user's saved list with its number
      addServiceRequest(requestId, result.data.requestId)
    } else {
      setError(result.error?.message || t('service.loadError'))
    }

    setLoading(false)
  }

  const handleAcceptTerms = async () => {
    if (!data) return

    setAcceptingTerms(true)
    const result = await serviceApi.acceptTerms(data.requestId)

    if (result.success) {
      setData({
        ...data,
        clientAcceptedTerms: {
          accepted: true,
          acceptedAt: new Date().toLocaleString(),
        },
      })
      setSnackbar({ open: true, message: t('service.termsAccepted'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: result.error?.message || t('common.error'), severity: 'error' })
    }

    setAcceptingTerms(false)
  }

  const handleConfirmRepair = async () => {
    if (!data || !selectedRepairOption) return

    setConfirmingRepair(true)
    const confirmedAt = new Date().toISOString()
    const result = await serviceApi.selectRepairOption(data.requestId, selectedRepairOption, confirmedAt)

    if (result.success) {
      setData({
        ...data,
        selectedRepairOptionId: selectedRepairOption,
        selectedRepairConfirmedAt: new Date().toLocaleString(),
      })
      setSnackbar({ open: true, message: t('service.repairConfirmed'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: result.error?.message || t('common.error'), severity: 'error' })
    }

    setConfirmingRepair(false)
  }

  const handleAddComment = async () => {
    if (!data || !newComment.trim()) return

    setAddingComment(true)
    const result = await serviceApi.addComment(data.requestId, newComment)

    if (result.success) {
      if (result.data?.comments) {
        setData({ ...data, comments: result.data.comments })
      } else {
        setData({
          ...data,
          comments: [...data.comments, { date: new Date().toLocaleString(), text: newComment }],
        })
      }
      setNewComment('')
      setSnackbar({ open: true, message: t('service.commentAdded'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: result.error?.message || t('common.error'), severity: 'error' })
    }

    setAddingComment(false)
  }

  const handleAddQuestion = async () => {
    if (!data || !newQuestion.trim()) return

    setAddingQuestion(true)
    const result = await serviceApi.addQuestion(data.requestId, newQuestion)

    if (result.success) {
      if (result.data?.questions) {
        setData({ ...data, questions: result.data.questions })
      } else {
        setData({
          ...data,
          questions: [
            ...data.questions,
            {
              question: newQuestion,
              questionDate: new Date().toLocaleString(),
              answer: null,
              answerDate: null,
            },
          ],
        })
      }
      setNewQuestion('')
      setSnackbar({ open: true, message: t('service.questionSent'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: result.error?.message || t('common.error'), severity: 'error' })
    }

    setAddingQuestion(false)
  }

  const handleRequestCall = async () => {
    if (!data) return

    setRequestingCall(true)
    const result = await serviceApi.requestCall(data.requestId, callComment)

    if (result.success) {
      if (result.data?.callRequests) {
        setData({ ...data, callRequests: result.data.callRequests })
      } else {
        setData({
          ...data,
          callRequests: [
            ...data.callRequests,
            { date: new Date().toLocaleString(), userComment: callComment },
          ],
        })
      }
      setCallComment('')
      setSnackbar({ open: true, message: t('service.callRequested'), severity: 'success' })
    } else {
      setSnackbar({ open: true, message: result.error?.message || t('common.error'), severity: 'error' })
    }

    setRequestingCall(false)
  }

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH' }).format(price)
  }

  if (loading) {
    return <LoadingSpinner fullScreen />
  }

  if (error || !data) {
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
        <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 400 }}>
          <Typography variant="h6" color="error" gutterBottom>
            {t('common.error')}
          </Typography>
          <Typography color="text.secondary">
            {error || t('service.invalidRequest')}
          </Typography>
        </Paper>
      </Box>
    )
  }

  const termsAccepted = data.clientAcceptedTerms?.accepted

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <img src="/logo.svg" alt="Logo" style={{ height: 160 }} />
          <Button
            variant="outlined"
            startIcon={<HomeIcon />}
            onClick={() => navigate('/')}
          >
            {t('common.home')}
          </Button>
        </Box>
        <LanguageSelector />
      </Box>

      <Container maxWidth="md" sx={{ flex: 1, pb: 4 }}>
        {/* Terms Acceptance */}
        {!termsAccepted && (
          <Paper sx={{ p: 3, mb: 3 }}>
            <Typography variant="h5" gutterBottom>
              {t('service.termsTitle')}
            </Typography>
            <Alert severity="info" sx={{ mb: 2 }}>
              {t('service.termsDescription')}
            </Alert>
            <Button
              variant="contained"
              onClick={handleAcceptTerms}
              disabled={acceptingTerms}
              startIcon={acceptingTerms ? <CircularProgress size={20} /> : <CheckCircleIcon />}
            >
              {t('service.acceptTerms')}
            </Button>
          </Paper>
        )}

        {/* Main Content (after terms accepted) */}
        {termsAccepted && (
          <Paper sx={{ p: 3 }}>
            <Typography variant="h5" gutterBottom>
              {t('service.requestTitle')} #{data.requestId}
            </Typography>

            {/* Accepted Info */}
            <Alert severity="success" sx={{ mb: 3 }}>
              {t('service.termsAcceptedAt')}: {data.clientAcceptedTerms.acceptedAt}
            </Alert>

            {/* Client Info */}
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <PersonIcon color="primary" />
                  <Typography variant="h6">{t('service.clientInfo', 'Інформація про отримувача')}</Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {data.clientInfo && (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 3 }}>
                    <Typography variant="body1">
                      <strong>{t('service.clientName', 'ПІБ')}:</strong>{' '}
                      {`${data.clientInfo.lastName} ${data.clientInfo.firstName} ${data.clientInfo.middleName}`.trim() || '—'}
                    </Typography>
                    <Typography variant="body1">
                      <strong>{t('service.clientCity', 'Місто')}:</strong> {data.clientInfo.city || '—'}
                    </Typography>
                    <Typography variant="body1">
                      <strong>{t('service.clientWarehouse', 'Відділення НП')}:</strong> {data.clientInfo.warehouse || '—'}
                    </Typography>
                  </Box>
                )}
                <Divider sx={{ my: 2 }} />
                <ClientInfoEditor
                  requestId={data.requestId}
                  clientInfo={data.clientInfo}
                  onSave={(updatedInfo: ClientInfo) => {
                    setData({ ...data, clientInfo: updatedInfo })
                    setSnackbar({ open: true, message: t('service.clientInfoSaved', 'Дані отримувача збережено'), severity: 'success' })
                  }}
                />
              </AccordionDetails>
            </Accordion>
            <Divider sx={{ my: 2 }} />

            {/* Shipment Info */}
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <ShippingIcon color="primary" />
                  <Typography variant="h6">{t('service.shipmentInfo')}</Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {data.shipment.ttn && (
                  <Typography variant="body1" sx={{ mb: 2 }}>
                    <strong>{t('service.ttn')}:</strong> {data.shipment.ttn}
                  </Typography>
                )}
                <Typography variant="body1" sx={{ mb: 2 }}>
                  <strong>{t('service.complaint')}:</strong> {data.complaint || '—'}
                </Typography>

                {data.shipment?.statusHistory?.length > 0 && (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>{t('service.date')}</TableCell>
                          <TableCell>{t('service.status')}</TableCell>
                          <TableCell>{t('service.comment')}</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {data.shipment.statusHistory.map((item, index) => (
                          <TableRow key={index}>
                            <TableCell>{item.date}</TableCell>
                            <TableCell>{item.status}</TableCell>
                            <TableCell>{item.comment || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </AccordionDetails>
            </Accordion>

            <Divider sx={{ my: 2 }} />

            {/* Repair Options */}
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <BuildIcon color="primary" />
                  <Typography variant="h6">{t('service.repairOptions')}</Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {data.selectedRepairOptionId ? (
                  <Alert severity="success" sx={{ mb: 2 }}>
                    {t('service.optionSelected')}: {data.repairOptions?.find(o => o.id === data.selectedRepairOptionId)?.description || data.selectedRepairOptionId}
                    <br />
                    {t('service.confirmedAt')}: {data.selectedRepairConfirmedAt}
                  </Alert>
                ) : (
                  <>
                    <RadioGroup
                      value={selectedRepairOption}
                      onChange={(e) => setSelectedRepairOption(e.target.value)}
                    >
                      {(data.repairOptions || []).map((option, idx) => (
                        <Card key={option.id || idx} variant="outlined" sx={{ mb: 1 }}>
                          <CardContent sx={{ py: 1, '&:last-child': { pb: 1 } }}>
                            <FormControlLabel
                              value={option.id || String(idx)}
                              control={<Radio />}
                              label={
                                <Box>
                                  <Typography variant="subtitle1">{option.description}</Typography>
                                  <Chip
                                    label={formatPrice(option.price)}
                                    color="primary"
                                    size="small"
                                    sx={{ mt: 0.5 }}
                                  />
                                </Box>
                              }
                            />
                          </CardContent>
                        </Card>
                      ))}
                    </RadioGroup>
                    <Button
                      variant="contained"
                      onClick={handleConfirmRepair}
                      disabled={!selectedRepairOption || confirmingRepair}
                      sx={{ mt: 2 }}
                    >
                      {confirmingRepair ? <CircularProgress size={20} /> : t('service.confirmRepair')}
                    </Button>
                  </>
                )}
              </AccordionDetails>
            </Accordion>

            <Divider sx={{ my: 2 }} />

            {/* Comments Section */}
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CommentIcon color="primary" />
                  <Typography variant="h6">{t('service.comments')}</Typography>
                  <Chip label={data.comments?.length || 0} size="small" />
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {data.comments?.length > 0 ? (
                  <List dense>
                    {data.comments.map((comment, index) => (
                      <ListItem key={index} divider>
                        <ListItemText
                          primary={comment.text}
                          secondary={`${comment.author || t('service.you')} • ${comment.date}`}
                        />
                      </ListItem>
                    ))}
                  </List>
                ) : (
                  <Typography color="text.secondary">{t('service.noComments')}</Typography>
                )}

                <Box sx={{ mt: 2 }}>
                  <TextField
                    fullWidth
                    multiline
                    rows={2}
                    label={t('service.addComment')}
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    sx={{ mb: 1 }}
                  />
                  <Button
                    variant="outlined"
                    onClick={handleAddComment}
                    disabled={!newComment.trim() || addingComment}
                  >
                    {addingComment ? <CircularProgress size={20} /> : t('service.send')}
                  </Button>
                </Box>
              </AccordionDetails>
            </Accordion>

            <Divider sx={{ my: 2 }} />

            {/* Questions Section */}
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <QuestionIcon color="primary" />
                  <Typography variant="h6">{t('service.questions')}</Typography>
                  <Chip label={data.questions?.length || 0} size="small" />
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {data.questions?.length > 0 ? (
                  <List>
                    {data.questions.map((q, index) => (
                      <ListItem key={index} divider sx={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                        <Typography variant="body1">
                          <strong>{t('service.question')}:</strong> {q.question}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {q.questionDate}
                        </Typography>
                        {q.answer && (
                          <Box sx={{ mt: 1, pl: 2, borderLeft: '2px solid', borderColor: 'primary.main' }}>
                            <Typography variant="body2">
                              <strong>{t('service.answer')}:</strong> {q.answer}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {q.answerDate}
                            </Typography>
                          </Box>
                        )}
                      </ListItem>
                    ))}
                  </List>
                ) : (
                  <Typography color="text.secondary">{t('service.noQuestions')}</Typography>
                )}

                <Box sx={{ mt: 2 }}>
                  <TextField
                    fullWidth
                    multiline
                    rows={2}
                    label={t('service.askQuestion')}
                    value={newQuestion}
                    onChange={(e) => setNewQuestion(e.target.value)}
                    sx={{ mb: 1 }}
                  />
                  <Button
                    variant="outlined"
                    onClick={handleAddQuestion}
                    disabled={!newQuestion.trim() || addingQuestion}
                  >
                    {addingQuestion ? <CircularProgress size={20} /> : t('service.send')}
                  </Button>
                </Box>
              </AccordionDetails>
            </Accordion>

            <Divider sx={{ my: 2 }} />

            {/* Call Request Section */}
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <PhoneIcon color="primary" />
                  <Typography variant="h6">{t('service.callRequest')}</Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                {data.callRequests?.length > 0 && (
                  <List dense sx={{ mb: 2 }}>
                    {data.callRequests.map((call, index) => (
                      <ListItem key={index} divider>
                        <ListItemText
                          primary={call.userComment || t('service.callbackRequested')}
                          secondary={call.date}
                        />
                        {call.managerComment && (
                          <Typography variant="body2" color="primary">
                            {t('service.managerResponse')}: {call.managerComment}
                          </Typography>
                        )}
                      </ListItem>
                    ))}
                  </List>
                )}

                <TextField
                  fullWidth
                  multiline
                  rows={2}
                  label={t('service.callComment')}
                  value={callComment}
                  onChange={(e) => setCallComment(e.target.value)}
                  sx={{ mb: 1 }}
                />
                <Button
                  variant="outlined"
                  onClick={handleRequestCall}
                  disabled={requestingCall}
                  startIcon={<PhoneIcon />}
                >
                  {requestingCall ? <CircularProgress size={20} /> : t('service.requestCall')}
                </Button>
              </AccordionDetails>
            </Accordion>

            <Divider sx={{ my: 2 }} />

            {/* Payment Section */}
            {(data.finalPrice || data.finalInvoice?.length > 0) && (
              <Accordion defaultExpanded>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <PaymentIcon color="primary" />
                    <Typography variant="h6">{t('service.payment')}</Typography>
                  </Box>
                </AccordionSummary>
                <AccordionDetails>
                  {data.finalInvoice?.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography variant="subtitle1" sx={{ mb: 1 }}>
                        <strong>{t('service.invoice')}:</strong>
                      </Typography>
                      <TableContainer>
                        <Table size="small">
                          <TableBody>
                            {data.finalInvoice.map((item, index) => (
                              <TableRow key={index}>
                                <TableCell>{item.description}</TableCell>
                                <TableCell align="right">{formatPrice(item.price)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </Box>
                  )}
                  {data.finalPrice != null && (
                    <Typography variant="h5" color="primary" sx={{ mb: 2 }}>
                      {t('service.totalPrice')}: {formatPrice(data.finalPrice)}
                    </Typography>
                  )}

                  <Chip
                    label={data.paymentStatus === true ? t('service.paid') : t('service.unpaid')}
                    color={data.paymentStatus === true ? 'success' : 'warning'}
                    sx={{ mb: 2 }}
                  />

                  {data.monopayUrl && data.paymentStatus !== true && (
                    <Box>
                      <Button
                        variant="contained"
                        color="success"
                        href={data.monopayUrl}
                        target="_blank"
                      >
                        {t('service.payNow')}
                      </Button>
                    </Box>
                  )}
                </AccordionDetails>
              </Accordion>
            )}

            {/* Return Delivery */}
            {data.returnTtn && (
              <>
                <Divider sx={{ my: 2 }} />
                <Accordion>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <ShippingIcon color="success" />
                      <Typography variant="h6">{t('service.returnDelivery')}</Typography>
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Typography variant="body1" sx={{ mb: 2 }}>
                      <strong>{t('service.returnTtn')}:</strong> {data.returnTtn}
                    </Typography>

                    {data.returnTtnHistory?.length > 0 && (
                      <TableContainer>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell>{t('service.date')}</TableCell>
                              <TableCell>{t('service.status')}</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {data.returnTtnHistory.map((item, index) => (
                              <TableRow key={index}>
                                <TableCell>{item.date}</TableCell>
                                <TableCell>{item.status}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    )}
                  </AccordionDetails>
                </Accordion>
              </>
            )}
          </Paper>
        )}
      </Container>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
      >
        <Alert severity={snackbar.severity}>{snackbar.message}</Alert>
      </Snackbar>
    </Box>
  )
}
