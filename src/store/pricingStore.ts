import { create } from 'zustand'
import { buildCatalog, PriceCatalog } from '@/utils/pricing'
import { pricingService, PriceListDoc, seedPriceListDoc } from '@/api/pricingService'

interface PricingState {
  // Каталог всегда заполнен: из Firestore, либо стартовый сид как локальный fallback
  catalog: PriceListDoc
  // Производный индекс по id — для быстрого расчёта смет
  indexed: PriceCatalog
  persisted: boolean // существует ли документ прайса в базе
  isLoading: boolean
  isSynced: boolean
  error: string | null

  loadFromServer: () => Promise<void>
  savePriceList: (data: Omit<PriceListDoc, 'updatedAt' | 'updatedBy'>) => Promise<boolean>
}

const toIndex = (doc: PriceListDoc): PriceCatalog =>
  buildCatalog({
    categories: doc.categories,
    works: doc.works,
    kits: doc.kits,
    materials: doc.materials,
    addons: doc.addons,
  })

const seedDoc = seedPriceListDoc()

export const usePricingStore = create<PricingState>()((set) => ({
  catalog: seedDoc,
  indexed: toIndex(seedDoc),
  persisted: false,
  isLoading: false,
  isSynced: false,
  error: null,

  loadFromServer: async () => {
    set({ isLoading: true, error: null })
    try {
      let doc = await pricingService.loadPriceList()
      // Если каталога в базе ещё нет — попытаться инициализировать из сида (только админ)
      if (!doc) doc = await pricingService.seedIfMissing()

      if (doc) {
        set({ catalog: doc, indexed: toIndex(doc), persisted: true, isSynced: true })
      } else {
        // Не админ и документа нет — работаем на локальном сиде
        const fallback = seedPriceListDoc()
        set({ catalog: fallback, indexed: toIndex(fallback), persisted: false, isSynced: true })
      }
    } catch (error) {
      console.error('Error loading price list:', error)
      set({ error: 'Не удалось загрузить прайс-лист', isSynced: true })
    } finally {
      set({ isLoading: false })
    }
  },

  savePriceList: async (data) => {
    const ok = await pricingService.savePriceList(data)
    if (ok) {
      const doc: PriceListDoc = { ...data, updatedAt: new Date().toISOString(), updatedBy: null }
      set({ catalog: doc, indexed: toIndex(doc), persisted: true })
    }
    return ok
  },
}))
