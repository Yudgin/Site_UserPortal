// Роботи по заявці та калькуляції майстрів — ЛИШЕ читання (живі підписки onSnapshot). Пише тільки сервер
// (/api/master-estimates, /api/service-requests/:id/works), складають їх у застосунку «RunFerry Сервіс».
// Правила: works — будь-який персонал; masterEstimates — власник/директор/бухгалтер усі, майстер лише свої
// (тому для майстра запит ОБОВʼЯЗКОВО з where('performerUid','==',uid), інакше Firestore відхилить список).
// Без orderBy — сортуємо в JS (інакше потрібен складений індекс).
import { db } from './firebase'
import { collection, onSnapshot, query, where, type QueryConstraint } from 'firebase/firestore'
import type { MasterEstimate, ServiceWork } from '@/types/masterEstimate'

type Unsubscribe = () => void
const byCreatedAt = (a: { createdAt?: string }, b: { createdAt?: string }) => (a.createdAt || '').localeCompare(b.createdAt || '')

export const masterEstimateService = {
  // Роботи заявки: serviceRequests/{id}/works.
  subscribeWorks: (
    serviceRequestId: string,
    onData: (works: ServiceWork[]) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe => {
    if (!db || !serviceRequestId) { onData([]); return () => {} }
    return onSnapshot(
      collection(db, 'serviceRequests', serviceRequestId, 'works'),
      (snap) => onData(snap.docs.map((d) => ({ ...d.data(), id: d.id }) as ServiceWork).sort(byCreatedAt)),
      (error) => { console.error('Error subscribing to works:', error); onError?.(error) },
    )
  },

  // Калькуляції майстрів заявки. performerUid — лише свої (майстер); null — усі (власник/директор/бухгалтер).
  subscribeByRequest: (
    serviceRequestId: string,
    performerUid: string | null,
    onData: (estimates: MasterEstimate[]) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe => {
    if (!db || !serviceRequestId) { onData([]); return () => {} }
    const constraints: QueryConstraint[] = [where('serviceRequestId', '==', serviceRequestId)]
    if (performerUid) constraints.push(where('performerUid', '==', performerUid))
    return onSnapshot(
      query(collection(db, 'masterEstimates'), ...constraints),
      (snap) => onData(snap.docs.map((d) => ({ ...d.data(), id: d.id }) as MasterEstimate).sort(byCreatedAt)),
      (error) => { console.error('Error subscribing to master estimates:', error); onError?.(error) },
    )
  },
}

export default masterEstimateService
