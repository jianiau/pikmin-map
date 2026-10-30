// 離線版的資料存取層:讀 App 內附的資料包,提供和 server.py 相同介面的 api。
import { createEngine } from './engine.js';

const TILE_CACHE_MAX = 300;   // 最多同時留在記憶體的格子數(手機記憶體有限)

export async function createLocalApi({ base = 'data/' } = {}) {
  const getJson = async path => {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`讀取資料失敗:${path}(${r.status})`);
    return r.json();
  };

  const [index, decors] = await Promise.all([getJson(base + 'index.json'), getJson('decors.json')]);
  const sources = await Promise.all(index.sources.map(async s => {
    const meta = await getJson(`${base}${s.id}/meta.json`);
    return { id: s.id, name: s.name, count: meta.count, tileDeg: meta.tileDeg,
             tiles: new Set(meta.tiles), areas: meta.areas };
  }));

  const cache = new Map();   // Map 會記住插入順序,拿來當簡單的 LRU
  let areaList = null;
  const areaGeom = new Map();

  async function loadAreas() {
    if (areaList) return areaList;
    const list = [];
    for (const s of sources) {
      if (!s.areas) continue;
      for (const a of await getJson(`${base}${s.id}/areas.json`)) {
        areaGeom.set(a.id, a.g);
        list.push({ id: a.id, name: a.name, level: a.level, parent: a.parent, bbox: a.bbox, source: s.name });
      }
    }
    list.sort((a, b) => (a.source || '').localeCompare(b.source || '') || a.level - b.level
      || (a.parent || '').localeCompare(b.parent || '') || a.name.localeCompare(b.name));
    return (areaList = list);
  }

  const store = {
    sources,
    async loadTile(src, key) {
      const ck = `${src.id}/${key}`;
      if (cache.has(ck)) {
        const v = cache.get(ck);
        cache.delete(ck); cache.set(ck, v);
        return v;
      }
      const v = await getJson(`${base}${src.id}/t/${key}.json`);
      cache.set(ck, v);
      if (cache.size > TILE_CACHE_MAX) cache.delete(cache.keys().next().value);
      return v;
    },
    async area(id) {
      await loadAreas();
      const g = areaGeom.get(id);
      return g ? { geometry: g } : null;
    },
  };
  const engine = createEngine({ decors, store });

  return {
    decors: async () => decors,
    sources: async () => sources.map(s => ({ name: s.name, count: s.count })),
    areas: loadAreas,
    async areaOutline(id) {
      await loadAreas();
      return { type: 'Feature', properties: {}, geometry: areaGeom.get(id) };
    },
    search: (body, onProgress) => engine.search(body, onProgress),
  };
}
