// Каталог продажів корабликів (Firestore): моделі, опції комплектації, дропшипери.
// Доступ — власник (див. firestore.rules). Один CRUD-шаблон на три колекції.
import { db, auth } from './firebase'
import { collection, doc, getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import type { BoatModel, BoatOption, Dropshipper } from '@/types/boats'
import { secureId } from '@/utils/id'

const makeCrud = <T extends { id: string; createdAt?: string; name: string }>(coll: string) => ({
  list: async (): Promise<T[]> => {
    if (!db) return []
    try {
      const snap = await getDocs(collection(db, coll))
      return snap.docs.map((d) => d.data() as T).sort((a, b) => a.name.localeCompare(b.name, 'uk'))
    } catch (e) {
      console.error(`${coll} list:`, e)
      return []
    }
  },
  save: async (t: Partial<T> & { id?: string }): Promise<{ id: string } | null> => {
    if (!db || !auth?.currentUser) return null
    try {
      const id = t.id || secureId(16)
      const now = new Date().toISOString()
      await setDoc(
        doc(db, coll, id),
        { ...t, id, updatedAt: now, ...(t.createdAt ? {} : { createdAt: now, createdBy: auth.currentUser.uid }) },
        { merge: true }
      )
      return { id }
    } catch (e) {
      console.error(`${coll} save:`, e)
      return null
    }
  },
  remove: async (id: string): Promise<boolean> => {
    if (!db) return false
    try {
      await deleteDoc(doc(db, coll, id))
      return true
    } catch (e) {
      console.error(`${coll} remove:`, e)
      return false
    }
  },
})

export const boatModelService = makeCrud<BoatModel>('boatModels')
export const boatOptionService = makeCrud<BoatOption>('boatOptions')
export const dropshipperService = makeCrud<Dropshipper>('dropshippers')
