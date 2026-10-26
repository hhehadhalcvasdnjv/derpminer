// Pure helpers for the restock bot: no network, no side effects, so they're
// testable against saved Apple responses.

/**
 * Pull the purchasable variants out of an Apple "buy" page. The page embeds its
 * product catalog as JSON; each variant object starts with "partNumber" and is
 * followed by its dimension fields, so we read each part's fields from the text
 * between it and the next part number.
 * @returns {{ part: string, capacityGb: number | null, color: string | null }[]}
 */
export function parseProducts(html) {
  const re = /"partNumber"\s*:\s*"([A-Z0-9]{4,10}\/[A-Z])"/g;
  const hits = [...html.matchAll(re)];
  const seen = new Map();
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : m.index + 2000;
    const seg = html.slice(m.index, Math.min(end, m.index + 2000));
    const cap = seg.match(/"dimensionCapacity"\s*:\s*"(\d+)\s*(gb|tb)"/i);
    const color = seg.match(/"dimensionColor"\s*:\s*"([^"]+)"/);
    const capacityGb = cap ? Number(cap[1]) * (cap[2].toLowerCase() === 'tb' ? 1024 : 1) : null;
    const prev = seen.get(m[1]);
    // The same part can appear several times; keep the occurrence with the most detail.
    if (!prev || (prev.capacityGb === null && capacityGb !== null)) {
      seen.set(m[1], { part: m[1], capacityGb, color: color ? color[1] : null });
    }
  });
  return [...seen.values()];
}

/** Keep only variants whose storage is in `capacitiesGb`. */
export function filterByCapacity(products, capacitiesGb) {
  return products.filter((p) => p.capacityGb !== null && capacitiesGb.includes(p.capacityGb));
}

/**
 * Store-pickup availability endpoint that Apple's own "check availability"
 * button calls. Locale comes from the product URL (…/de/shop/… → Germany).
 */
export function fulfillmentUrl(productUrl, parts, location) {
  const u = new URL(productUrl);
  const idx = u.pathname.indexOf('/shop/');
  const prefix = idx >= 0 ? u.pathname.slice(0, idx) : '';
  const q = new URLSearchParams({ fae: 'true', pl: 'true', 'mts.0': 'regular', 'mts.1': 'compact' });
  parts.forEach((p, i) => q.set(`parts.${i}`, p));
  q.set('searchNearby', 'true');
  q.set('location', location);
  return `${u.origin}${prefix}/shop/fulfillment-messages?${q}`;
}

/**
 * Flatten a fulfillment-messages response into one row per (store, part),
 * restricted to stores whose name or city contains `storeMatch`.
 */
export function parseAvailability(json, storeMatch) {
  const stores = json?.body?.content?.pickupMessage?.stores ?? [];
  const needle = storeMatch.toLowerCase();
  const rows = [];
  for (const s of stores) {
    const where = `${s.storeName ?? ''} ${s.city ?? ''}`.toLowerCase();
    if (needle && !where.includes(needle)) continue;
    for (const [part, a] of Object.entries(s.partsAvailability ?? {})) {
      rows.push({
        part,
        store: s.storeName ?? String(s.storeNumber),
        storeNumber: String(s.storeNumber ?? s.storeName),
        city: s.city ?? '',
        available: a?.pickupDisplay === 'available',
        title: a?.messageTypes?.regular?.storePickupProductTitle ?? a?.messageTypes?.compact?.storePickupProductTitle ?? part,
        quote: a?.pickupSearchQuote ?? a?.messageTypes?.regular?.storePickupQuote ?? '',
      });
    }
  }
  return rows;
}

/**
 * Compare against what was available last time. Only rows that just turned
 * available are returned, so one restock means one alert, not one per poll.
 */
export function newlyAvailable(prevKeys, rows) {
  const keys = new Set(rows.filter((r) => r.available).map((r) => `${r.storeNumber}|${r.part}`));
  const fresh = rows.filter((r) => r.available && !prevKeys.has(`${r.storeNumber}|${r.part}`));
  return { fresh, keys };
}

/** Split into chunks so a single request never carries too many parts. */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
