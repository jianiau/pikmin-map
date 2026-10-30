// 手機版搜尋引擎,對應 server.py 的 search()。
// 不碰 DOM、不直接讀檔:資料由 store 提供,所以可以在 Node 裡測試。
//
// store 需要提供:
//   store.sources              [{ id, name, tileDeg, tiles: Set<string> }]
//   await store.loadTile(src, key)   → [[osm_id, lat, lon, name, tags], ...]
//   await store.area(id)             → { geometry } 或 null(GeoJSON Polygon/MultiPolygon)

export const EARTH_R = 6371008.8; // 公尺
export const MAX_ITEMS = 50000;
export const POPUP_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'natural', 'landuse', 'railway',
  'aeroway', 'cuisine', 'highway', 'bridge', 'brand', 'opening_hours', 'website', 'phone'];

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ---------------------------------------------------------------- 距離 */
export function haversine(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180;
  const p1 = lat1 * rad, p2 = lat2 * rad;
  const a = Math.sin((p2 - p1) / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ---------------------------------------------------------------- 條件語法(同 server.py)
   一行 = 一組條件(逗號 = 而且);多行 = 任一行符合。
   key=a|b  key!=a  key  !key  key~正規式  key!~正規式   # 後面是註解 */
const OP_RE = /^([^=!~]+?)\s*(!=|!~|=|~)\s*(.+)$/;

export function parseCond(text) {
  const s = text.trim();
  const m = OP_RE.exec(s);
  if (m) {
    const key = m[1].trim(), op = m[2], val = m[3].trim();
    if (op === '=' || op === '!=') {
      return [op, key, new Set(val.split('|').map(v => v.trim()).filter(Boolean))];
    }
    try {
      return [op, key, new RegExp(val, 'i')];
    } catch (e) {
      throw new Error(`正規表示式有誤:${s}(${e.message})`);
    }
  }
  if (s.startsWith('!')) {
    const key = s.slice(1).trim();
    if (key && !/[=~!]/.test(key)) return ['nex', key, null];
  } else if (s && !/[=~!]/.test(s)) {
    return ['ex', s, null];
  }
  throw new Error('無法解析的條件:' + s);
}

export function compileRules(text) {
  const groups = [];
  for (const raw of String(text || '').split(/\r\n|\r|\n/)) {
    const line = raw.split('#', 1)[0].trim();
    const conds = line.split(',').filter(c => c.trim()).map(parseCond);
    if (conds.length) groups.push(conds);
  }
  return groups;
}

function evalCond(tags, [op, key, p]) {
  const v = hasOwn(tags, key) ? tags[key] : undefined;
  if (op === 'ex') return v !== undefined;
  if (op === 'nex') return v === undefined;
  if (op === '=' || op === '!=') {
    const hit = v !== undefined && v.split(';').some(x => p.has(x.trim()));
    return op === '=' ? hit : !hit;
  }
  const hit = v !== undefined && p.test(v);
  return op === '~' ? hit : !hit;
}

export const match = (tags, groups) => groups.some(g => g.every(c => evalCond(tags, c)));

/* ---------------------------------------------------------------- 幾何 */
function ringBox(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 準備 Polygon / MultiPolygon:算外框,並提供 contains(x, y)(挖洞的部分不算在內)。 */
export function prepareGeometry(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates : null;
  if (!polys) throw new Error('不支援的幾何類型:' + geom.type);
  const parts = polys.map(rings => ({ box: ringBox(rings[0]), rings }));
  const bbox = parts.reduce((b, p) => [Math.min(b[0], p.box[0]), Math.min(b[1], p.box[1]),
    Math.max(b[2], p.box[2]), Math.max(b[3], p.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  return {
    bbox,
    contains(x, y) {
      for (const p of parts) {
        if (x < p.box[0] || x > p.box[2] || y < p.box[1] || y > p.box[3]) continue;
        if (!inRing(x, y, p.rings[0])) continue;
        let hole = false;
        for (let k = 1; k < p.rings.length; k++) {
          if (inRing(x, y, p.rings[k])) { hole = true; break; }
        }
        if (!hole) return true;
      }
      return false;
    },
  };
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

/** 回傳 { bbox, inside, origin }:bbox = [西,南,東,北] 或 null;inside(lon,lat) 精確判斷或 null;origin = 圓心 */
export async function resolveRegion(store, region) {
  const t = (region && region.type) || 'all';
  if (t === 'all') return { bbox: null, inside: null, origin: null };
  if (t === 'bbox') {
    const [w, s, e, n] = region.bbox.map(Number);
    return { bbox: [Math.min(w, e), Math.min(s, n), Math.max(w, e), Math.max(s, n)], inside: null, origin: null };
  }
  if (t === 'circle') {
    const [lon0, lat0] = region.center.map(Number);
    const r = Number(region.radius);
    if (!(Math.abs(lat0) <= 90 && Math.abs(lon0) <= 180)) throw new Error('圓心座標超出範圍');
    if (!(r > 0 && r <= 50000)) throw new Error('半徑要在 1 到 50000 公尺之間');
    const deg = 180 / Math.PI;
    const dlat = (r / EARTH_R) * deg;
    const dlon = (r / (EARTH_R * Math.max(Math.cos((lat0 * Math.PI) / 180), 0.01))) * deg;
    return {
      bbox: [lon0 - dlon, lat0 - dlat, lon0 + dlon, lat0 + dlat],
      inside: (x, y) => haversine(lon0, lat0, x, y) <= r,
      origin: [lon0, lat0],
    };
  }
  if (t === 'polygon') {
    const ring = region.ring.map(([x, y]) => [Number(x), Number(y)]);
    if (ring.length < 3) throw new Error('多邊形至少要 3 個點');
    if (ringArea(ring) === 0) throw new Error('多邊形無效');
    const pg = prepareGeometry({ type: 'Polygon', coordinates: [ring] });
    return { bbox: pg.bbox, inside: (x, y) => pg.contains(x, y), origin: null };
  }
  if (t === 'area') {
    const a = await store.area(Number(region.id));
    if (!a) throw new Error('找不到這個行政區');
    const pg = prepareGeometry(a.geometry);
    return { bbox: pg.bbox, inside: (x, y) => pg.contains(x, y), origin: null };
  }
  throw new Error('未知的區域類型');
}

/** 範圍外框涵蓋哪些格子(只回傳這個來源實際有資料的)。 */
export function tileKeys(src, bbox) {
  if (!bbox) return [...src.tiles];
  const d = src.tileDeg;
  const x0 = Math.floor(bbox[0] / d), x1 = Math.floor(bbox[2] / d);
  const y0 = Math.floor(bbox[1] / d), y1 = Math.floor(bbox[3] / d);
  const out = [];
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > src.tiles.size) {      // 範圍比資料還大:改成掃現有的格子
    for (const k of src.tiles) {
      const [ix, iy] = k.split('_').map(Number);
      if (ix >= x0 && ix <= x1 && iy >= y0 && iy <= y1) out.push(k);
    }
  } else {
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const k = `${ix}_${iy}`;
        if (src.tiles.has(k)) out.push(k);
      }
    }
  }
  return out;
}

const addrOf = t => t['addr:full'] || ['addr:city', 'addr:district', 'addr:street', 'addr:housenumber']
  .map(k => t[k] || '').join('');

/* ---------------------------------------------------------------- 搜尋 */
export function createEngine({ decors, store, maxItems = MAX_ITEMS }) {
  const byId = new Map(decors.map(d => [d.id, d]));
  const rules = new Map(decors.map(d => [d.id, compileRules(d.rules.join('\n'))]));

  /** body 與 server.py 的 /api/search 相同;onProgress(已讀格數, 總格數) 可省略。 */
  async function search(body, onProgress) {
    const decorIds = (body.decors || []).filter(id => rules.has(id));
    const custom = compileRules(body.custom || '');
    const combineAnd = body.combine === 'and';
    if (!decorIds.length && !custom.length) throw new Error('請先選擇至少一種裝飾,或輸入自訂條件');
    const { bbox, inside, origin } = await resolveRegion(store, body.region);
    const sel = decorIds.map(id => [byId.get(id).name, rules.get(id)]);

    const plan = [];
    for (const src of store.sources) {
      if (body.source && src.name !== body.source) continue;
      for (const key of tileKeys(src, bbox)) plan.push([src, key]);
    }

    const items = [], counts = Object.create(null);
    let total = 0, done = 0;
    for (const [src, key] of plan) {
      const feats = await store.loadTile(src, key);
      for (const [id, lat, lon, name, tags] of feats) {
        if (bbox && !(bbox[0] <= lon && lon <= bbox[2] && bbox[1] <= lat && lat <= bbox[3])) continue;
        const hits = [];
        for (const [nm, g] of sel) if (match(tags, g)) hits.push(nm);
        const cm = custom.length > 0 && match(tags, custom);
        let ok;
        if (sel.length && custom.length) ok = combineAnd ? (hits.length > 0 && cm) : (hits.length > 0 || cm);
        else ok = sel.length ? hits.length > 0 : cm;
        if (!ok) continue;
        if (inside && !inside(lon, lat)) continue;
        const labels = hits.length ? hits : ['自訂條件'];
        total++;
        for (const l of labels) counts[l] = (counts[l] || 0) + 1;
        if (items.length < maxItems) {
          const item = {
            id, lat, lon, name: name || '', decor: labels, addr: addrOf(tags),
            tag: POPUP_KEYS.filter(k => hasOwn(tags, k)).map(k => `${k}=${tags[k]}`).join('; '),
          };
          if (origin) item.dist = Math.round(haversine(origin[0], origin[1], lon, lat) * 10) / 10;
          items.push(item);
        }
      }
      if (onProgress) onProgress(++done, plan.length);
    }
    if (origin) items.sort((a, b) => a.dist - b.dist);
    return { total, shown: items.length, truncated: total > items.length, counts: { ...counts }, items };
  }

  return { search };
}
