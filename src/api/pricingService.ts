import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs, limit, orderBy } from 'firebase/firestore'
import type { Estimate, EstimateOffer, WorkCategory, Work, Kit, Material, Addon, PricingSettings } from '@/types/pricing'
import { priceListSeed, defaultPricingSettings } from '@/data/priceListSeed'
import { isAdminEmail } from '@/config/access'
import { secureId } from '@/utils/id'

// Весь каталог прайс-листа хранится одним документом priceList/current.
// Это упрощает загрузку/атомарное сохранение из редактора; лимит документа
// Firestore (1 МБ) с запасом покрывает сотни работ на 6 языках.
export interface PriceListDoc {
  categories: WorkCategory[]
  works: Work[]
  kits: Kit[]
  materials: Material[]
  addons: Addon[]
  settings: PricingSettings
  updatedAt: string
  updatedBy: string | null
}

const PRICE_DOC = 'current'
const PRICE_COLLECTION = 'priceList'
const PRICE_ARCHIVE_COLLECTION = 'priceArchive'
const ESTIMATES_COLLECTION = 'priceEstimates'
const OFFERS_COLLECTION = 'estimateOffers'

// Запись архива цен: снимок предыдущей версии каталога, сделанный перед перезаписью.
export interface PriceArchiveEntry extends PriceListDoc {
  archiveId: string
  archivedAt: string // когда версия была вытеснена новой
  supersededBy: string | null // кто сохранил новую версию поверх
}

// Собрать документ каталога из стартового сида
export const seedPriceListDoc = (): PriceListDoc => ({
  ...priceListSeed,
  settings: defaultPricingSettings,
  updatedAt: new Date().toISOString(),
  updatedBy: null,
})

// Криптостойкий уникальный id: смета открывается по прямой ссылке (get по id),
// поэтому id не должен угадываться перебором.
const generateId = (): string => secureId(16)

export const pricingService = {
  // Загрузить каталог. Возвращает null, если документа ещё нет в базе.
  loadPriceList: async (): Promise<PriceListDoc | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, PRICE_COLLECTION, PRICE_DOC))
      return snap.exists() ? (snap.data() as PriceListDoc) : null
    } catch (error) {
      console.error('Error loading price list:', error)
      return null
    }
  },

  // Сохранить каталог целиком (доступно только администратору — см. firestore.rules)
  savePriceList: async (data: Omit<PriceListDoc, 'updatedAt' | 'updatedBy'>): Promise<boolean> => {
    if (!db || !auth?.currentUser) {
      console.error('Firestore not configured or user not authenticated')
      return false
    }
    try {
      // Архив: перед перезаписью снимаем снимок текущей версии (история цен).
      // Ошибка архивирования не должна срывать основное сохранение — изолируем.
      try {
        const prev = await getDoc(doc(db, PRICE_COLLECTION, PRICE_DOC))
        if (prev.exists()) {
          const archiveId = generateId()
          const entry: PriceArchiveEntry = {
            ...(prev.data() as PriceListDoc),
            archiveId,
            archivedAt: new Date().toISOString(),
            supersededBy: auth.currentUser.email,
          }
          await setDoc(doc(db, PRICE_ARCHIVE_COLLECTION, archiveId), entry)
        }
      } catch (archiveErr) {
        console.error('Error archiving previous price list:', archiveErr)
      }
      const payload: PriceListDoc = {
        ...data,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.currentUser.email,
      }
      await setDoc(doc(db, PRICE_COLLECTION, PRICE_DOC), payload)
      return true
    } catch (error) {
      console.error('Error saving price list:', error)
      return false
    }
  },

  // История версий прайса (архив), новые сверху. Только для администратора (см. rules).
  listArchive: async (max = 100): Promise<PriceArchiveEntry[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, PRICE_ARCHIVE_COLLECTION), orderBy('archivedAt', 'desc'), limit(max))
      const snap = await getDocs(q)
      return snap.docs.map((d) => d.data() as PriceArchiveEntry)
    } catch (error) {
      console.error('Error listing price archive:', error)
      return []
    }
  },

  // Инициализировать каталог из сида, если его ещё нет и текущий пользователь — админ.
  // Возвращает записанный документ либо null, если инициализация не выполнена.
  seedIfMissing: async (): Promise<PriceListDoc | null> => {
    if (!db || !auth?.currentUser) return null
    if (!isAdminEmail(auth.currentUser.email)) return null
    try {
      const ref = doc(db, PRICE_COLLECTION, PRICE_DOC)
      const snap = await getDoc(ref)
      if (snap.exists()) return snap.data() as PriceListDoc
      const seeded = seedPriceListDoc()
      seeded.updatedBy = auth.currentUser.email
      await setDoc(ref, seeded)
      return seeded
    } catch (error) {
      console.error('Error seeding price list:', error)
      return null
    }
  },

  // Сохранить смету (история + обучающая база для AI-оценки)
  saveEstimate: async (estimate: Estimate): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = estimate.id || generateId()
      const payload: Estimate = {
        ...estimate,
        id,
        createdBy: estimate.createdBy || auth.currentUser.email,
      }
      await setDoc(doc(db, ESTIMATES_COLLECTION, id), payload)
      return { id }
    } catch (error) {
      console.error('Error saving estimate:', error)
      return null
    }
  },

  // Загрузить смету по id (открывается по ссылке клиентом)
  loadEstimate: async (id: string): Promise<Estimate | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, ESTIMATES_COLLECTION, id))
      return snap.exists() ? (snap.data() as Estimate) : null
    } catch (error) {
      console.error('Error loading estimate:', error)
      return null
    }
  },

  // Сметы, привязанные к заявке 1С
  getEstimatesByRequest: async (requestId: string): Promise<Estimate[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, ESTIMATES_COLLECTION), where('requestId', '==', requestId), limit(50))
      const snap = await getDocs(q)
      const items = snap.docs.map((d) => d.data() as Estimate)
      return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    } catch (error) {
      console.error('Error loading estimates by request:', error)
      return []
    }
  },

  // Сохранить предложение (набор вариантов) — только администратор (см. rules)
  saveOffer: async (offer: EstimateOffer): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = offer.id || generateId()
      const payload: EstimateOffer = { ...offer, id, createdBy: offer.createdBy || auth.currentUser.email }
      await setDoc(doc(db, OFFERS_COLLECTION, id), payload)
      return { id }
    } catch (error) {
      console.error('Error saving offer:', error)
      return null
    }
  },

  // Загрузить предложение по id (для админа; клиент — через backend /api/offers/:id/public)
  loadOffer: async (id: string): Promise<EstimateOffer | null> => {
    if (!db) return null
    try {
      const snap = await getDoc(doc(db, OFFERS_COLLECTION, id))
      return snap.exists() ? (snap.data() as EstimateOffer) : null
    } catch (error) {
      console.error('Error loading offer:', error)
      return null
    }
  },

  // Недавние сметы — источник обучающих примеров для AI-оценки
  getRecentEstimates: async (max = 50): Promise<Estimate[]> => {
    if (!db) return []
    try {
      const q = query(collection(db, ESTIMATES_COLLECTION), orderBy('createdAt', 'desc'), limit(max))
      const snap = await getDocs(q)
      return snap.docs.map((d) => d.data() as Estimate)
    } catch (error) {
      console.error('Error loading recent estimates:', error)
      return []
    }
  },
}

export default pricingService
