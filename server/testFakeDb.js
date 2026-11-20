// Підробка Firestore в памʼяті для node --test (лише те, що потрібно журналу посилок): doc get/set/update/delete,
// collection get/where(==, >=, in, array-contains), автоматичний id. set без merge — повна заміна, з merge — по верхніх полях.
export function fakeDb(seed = {}) {
  const data = Object.fromEntries(Object.entries(seed).map(([c, docs]) => [c, new Map(Object.entries(docs).map(([id, v]) => [id, structuredClone(v)]))]))
  const col = (name) => (data[name] ||= new Map())
  let auto = 0
  const stats = { reads: 0, writes: 0 }
  const docRef = (name, id) => ({
    id,
    get: async () => { stats.reads++; const v = col(name).get(id); return { id, exists: v !== undefined, data: () => (v === undefined ? undefined : structuredClone(v)), ref: docRef(name, id) } },
    set: async (v, opts) => { stats.writes++; col(name).set(id, opts && opts.merge ? { ...(col(name).get(id) || {}), ...structuredClone(v) } : structuredClone(v)) },
    update: async (v) => { stats.writes++; if (!col(name).has(id)) throw new Error(`no doc ${name}/${id}`); col(name).set(id, { ...col(name).get(id), ...structuredClone(v) }) },
    delete: async () => { stats.writes++; col(name).delete(id) },
  })
  const match = (v, f, op, want) => {
    const got = v[f]
    if (op === '==') return got === want
    if (op === '>=') return got != null && got >= want
    if (op === 'in') return want.includes(got)
    if (op === 'array-contains') return Array.isArray(got) && got.includes(want)
    throw new Error(`fakeDb: оператор ${op} не підтримано`)
  }
  const query = (name, filters) => ({
    where: (f, op, want) => query(name, [...filters, [f, op, want]]),
    get: async () => {
      const docs = [...col(name).entries()].filter(([, v]) => filters.every(([f, op, want]) => match(v, f, op, want)))
        .map(([id, v]) => ({ id, exists: true, data: () => structuredClone(v), ref: docRef(name, id) }))
      stats.reads += docs.length
      return { docs, empty: docs.length === 0, size: docs.length }
    },
  })
  return {
    collection: (name) => ({ doc: (id) => docRef(name, id || `auto${++auto}`), ...query(name, []) }),
    _data: data,
    _get: (name, id) => col(name).get(id),
    _stats: stats,
  }
}

export default fakeDb
