import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Box, Container, Paper, Typography, Button, CircularProgress, Alert, Divider, Stack, Link } from '@mui/material'
import { ArrowBack as BackIcon, PlayCircleOutline as VideoIcon, ChatBubbleOutline as ChatIcon } from '@mui/icons-material'
import { knowledgeService } from '@/api/knowledgeService'
import { tName } from '@/utils/pricing'
import type { KnowledgeArticle } from '@/types/knowledge'

// Публичный просмотр статьи базы знаний (инструкция, самопомощь, «как избежать наценки»).
export default function KnowledgeArticlePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [article, setArticle] = useState<KnowledgeArticle | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      setArticle(id ? await knowledgeService.load(id) : null)
      setLoading(false)
    })()
  }, [id])

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', py: { xs: 3, md: 5 } }}>
      <Container maxWidth="sm">
        <Button startIcon={<BackIcon />} onClick={() => navigate(-1)} sx={{ mb: 2 }}>Назад</Button>
        {!article || !article.active || article.forMasters ? (
          <Alert severity="info">
            Стаття ще готується. Ви можете описати проблему — і помічник підкаже, що можна зробити.
            <Box sx={{ mt: 1 }}>
              <Button size="small" variant="contained" startIcon={<ChatIcon />} onClick={() => navigate('/chat')}>
                Запитати помічника
              </Button>
            </Box>
          </Alert>
        ) : (
          <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 2, textWrap: 'balance' }}>{tName(article.title, 'uk')}</Typography>
            <Typography variant="body1" sx={{ whiteSpace: 'pre-line', lineHeight: 1.7 }}>{tName(article.body, 'uk')}</Typography>

            {article.images && article.images.length > 0 && (
              <Stack spacing={2} sx={{ mt: 3 }}>
                {article.images.map((img, i) => (
                  <Box key={i}>
                    <Box component="img" src={img.url} alt={img.caption || ''}
                      sx={{ width: '100%', borderRadius: 2, display: 'block', border: '1px solid', borderColor: 'divider' }} />
                    {img.caption && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, textAlign: 'center' }}>
                        {img.caption}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            )}

            {article.videos.length > 0 && (
              <>
                <Divider sx={{ my: 2.5 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Відео</Typography>
                <Stack spacing={1}>
                  {article.videos.map((v, i) => (
                    <Button key={i} startIcon={<VideoIcon />} href={v.url} target="_blank" rel="noopener"
                      sx={{ justifyContent: 'flex-start' }}>{v.title || v.url}</Button>
                  ))}
                </Stack>
              </>
            )}
            {article.links.length > 0 && (
              <>
                <Divider sx={{ my: 2.5 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Посилання</Typography>
                <Stack spacing={0.5}>
                  {article.links.map((l, i) => (
                    <Link key={i} href={l} target="_blank" rel="noopener" variant="body2">{l}</Link>
                  ))}
                </Stack>
              </>
            )}

            <Alert severity="info" icon={false} sx={{ mt: 3, fontSize: 13 }}>
              Не впевнені? Опишіть проблему — помічник підкаже, як діяти саме у вашому випадку.
              <Box sx={{ mt: 1 }}>
                <Button size="small" variant="outlined" startIcon={<ChatIcon />} onClick={() => navigate('/chat')}>
                  Запитати помічника
                </Button>
              </Box>
            </Alert>
          </Paper>
        )}
      </Container>
    </Box>
  )
}
