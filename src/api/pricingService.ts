import { db, auth } from './firebase'
import { doc, getDoc, setDoc, collection, query, where, getDocs, limit, orderBy, runTransaction } from 'firebase/firestore'
import type { Estimate, EstimateVersion, EstimateOffer, WorkCategory, Work, Kit, Material, Addon, PricingSettings } from '@/types/pricing'
import type { ServiceRequest } from '@/types/serviceRequest'
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

// Итог сохранения прайса. conflict — в базе уже другая версия (кто и когда сохранил её).
export type SavePriceListResult =
  | { ok: true; updatedAt: string; updatedBy: string | null }
  | { ok: false; conflict?: { updatedAt: string; updatedBy: string | null } }

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

// Документ кошторису для запису: при ЗМІНЕНОМУ змісті попередній стан іде в history (видно майстру і
// клієнту, що змінювалося); backend-поля оплати/чека переносимо з наявного (setDoc замінює документ цілком,
// тож інакше затерли б чек/оплату). Спільне для saveEstimate і транзакційного збереження факту.
const buildEstimatePayload = (estimate: Estimate, existing: Estimate | null, id: string, email: string | null, now: string): Estimate => {
  // Сигнатура содержания (позиции + сумма) — чтобы фиксировать версию только при реальном изменении.
  const sig = (e: Pick<Estimate, 'lines' | 'total'>) =>
    `${(e.lines || []).map((l) => `${l.refId}:${l.qty}:${l.lineTotal}`).sort().join('|')}#${e.total}`
  let history: EstimateVersion[] = existing?.history || []
  if (existing && sig(existing) !== sig(estimate)) {
    history = [
      ...history,
      {
        at: existing.updatedAt || existing.createdAt || now,
        total: existing.total,
        lines: existing.lines || [],
        ...(existing.sections ? { sections: existing.sections } : {}),
        editedBy: existing.createdBy || null,
      },
    ].slice(-20) // ограничиваем историю последними 20 версиями
  }
  return {
    ...estimate,
    id,
    createdAt: estimate.createdAt || existing?.createdAt || now,
    createdBy: estimate.createdBy || existing?.createdBy || email,
    updatedAt: now,
    history,
    // backend-поля оплаты/чека — переносим из существующего, если новый payload их не задаёт.
    paymentId: estimate.paymentId ?? existing?.paymentId ?? null,
    paidAt: estimate.paidAt ?? existing?.paidAt ?? null,
    taxUrl: estimate.taxUrl ?? existing?.taxUrl ?? null,
    fiscalCode: estimate.fiscalCode ?? existing?.fiscalCode ?? null,
    payInitiatedAt: estimate.payInitiatedAt ?? existing?.payInitiatedAt ?? null,
  }
}

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

  // Сохранить каталог целиком (доступно только администратору — см. firestore.rules).
  // expectedUpdatedAt — updatedAt прайса, который открыт на странице: если в базе другой (правка из
  // другой вкладки или инструментом агента server/scripts/site-catalog.mjs), не перезаписываем — иначе
  // документ целиком затёр бы чужие позиции. Без него проверки нет (как раньше).
  savePriceList: async (
    data: Omit<PriceListDoc, 'updatedAt' | 'updatedBy'>,
    expectedUpdatedAt?: string,
  ): Promise<SavePriceListResult> => {
    if (!db || !auth?.currentUser) {
      console.error('Firestore not configured or user not authenticated')
      return { ok: false }
    }
    try {
      // Архив: перед перезаписью снимаем снимок текущей версии (история цен).
      // Ошибка архивирования не должна срывать основное сохранение — изолируем.
      try {
        const prev = await getDoc(doc(db, PRICE_COLLECTION, PRICE_DOC))
        if (prev.exists() && expectedUpdatedAt !== undefined) {
          const cur = prev.data() as PriceListDoc
          if (cur.updatedAt !== expectedUpdatedAt) {
            return { ok: false, conflict: { updatedAt: cur.updatedAt, updatedBy: cur.updatedBy ?? null } }
          }
        }
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
      return { ok: true, updatedAt: payload.updatedAt, updatedBy: payload.updatedBy }
    } catch (error) {
      console.error('Error saving price list:', error)
      return { ok: false }
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

  // Сохранить смету. При повторном сохранении с ИЗМЕНЁННЫМ содержанием кладём прежнее состояние в
  // history (видно мастеру и клиенту — что менялось). Сохраняем backend-поля оплаты (setDoc заменяет
  // документ целиком, поэтому переносим их из существующего, чтобы не затереть чек/оплату).
  saveEstimate: async (estimate: Estimate): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = estimate.id || generateId()
      const ref = doc(db, ESTIMATES_COLLECTION, id)
      const existingSnap = await getDoc(ref)
      const existing = existingSnap.exists() ? (existingSnap.data() as Estimate) : null
      await setDoc(ref, buildEstimatePayload(estimate, existing, id, auth.currentUser.email, new Date().toISOString()))
      return { id }
    } catch (error) {
      console.error('Error saving estimate:', error)
      return null
    }
  },

  // Зберегти ФАКТ і пов'язану заявку ОДНІЄЮ транзакцією (редактор факту). check виконується на даних,
  // прочитаних У транзакції (SDK повторить його, якщо документи змінилися до коміту — бот/застосунок
  // дописали витрату): повертає abort — нічого не пишемо; інакше пишемо кошторис (історія і поля оплати —
  // як saveEstimate) і merge-патч заявки. Так кошторис і журнал витрат не можуть розійтися на півдорозі.
  saveEstimateWithRequest: async <A>(p: {
    estimate: Estimate
    requestId: string | null
    check: (ctx: { id: string; freshEst: Estimate | null; freshReq: ServiceRequest | null }) =>
      { abort: A } | { requestPatch: Partial<ServiceRequest> | null }
  }): Promise<{ ok: true; id: string; requestPatch: Partial<ServiceRequest> | null } | { ok: false; abort?: A; error?: string }> => {
    if (!db || !auth?.currentUser) return { ok: false, error: 'Немає підключення до бази або входу' }
    const database = db
    const email = auth.currentUser.email
    const id = p.estimate.id || generateId()
    const estRef = doc(database, ESTIMATES_COLLECTION, id)
    const reqRef = p.requestId ? doc(database, 'serviceRequests', p.requestId) : null
    try {
      const r = await runTransaction(database, async (tx) => {
        const es = await tx.get(estRef)
        const rs = reqRef ? await tx.get(reqRef) : null
        const existing = es.exists() ? (es.data() as Estimate) : null
        const freshReq = rs && rs.exists() ? (rs.data() as ServiceRequest) : null
        const c = p.check({ id, freshEst: existing, freshReq })
        if ('abort' in c) return { abort: c.abort }
        const now = new Date().toISOString()
        tx.set(estRef, buildEstimatePayload(p.estimate, existing, id, email, now))
        if (reqRef && c.requestPatch) {
          const patch: Record<string, unknown> = { ...c.requestPatch, id: p.requestId, updatedAt: now }
          // Як serviceRequestService.save: час справжньої зміни статусу (doneAt — при «Виконано»).
          if (c.requestPatch.status && c.requestPatch.status !== freshReq?.status) {
            patch.statusChangedAt = now
            if (c.requestPatch.status === 'done') patch.doneAt = now
          }
          if (!freshReq) { patch.createdAt = now; patch.createdBy = email }
          tx.set(reqRef, patch, { merge: true })
        }
        return { requestPatch: c.requestPatch }
      })
      if ('abort' in r) return { ok: false, abort: r.abort as A }
      return { ok: true, id, requestPatch: r.requestPatch }
    } catch (error) {
      console.error('Error saving estimate with request:', error)
      return { ok: false, error: error instanceof Error ? error.message : 'Не вдалося зберегти кошторис' }
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

  // Upsert предложения (набор вариантов) — только администратор (см. rules). ПИШЕМ ЧЕРЕЗ MERGE и
  // принимаем ЧАСТИЧНЫЙ объект: редактор мастера обновляет только свои поля (title/variantIds),
  // не затирая проставленные backend-ом selectedVariantId/status/chosenAt (выбор клиента).
  saveOffer: async (offer: Partial<EstimateOffer> & { id: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      await setDoc(doc(db, OFFERS_COLLECTION, offer.id), { ...offer, updatedAt: new Date().toISOString() }, { merge: true })
      return { id: offer.id }
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
