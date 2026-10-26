import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProducts, filterByCapacity, fulfillmentUrl, parseAvailability, newlyAvailable } from './lib.mjs';

const html = `<script>window.PRODUCT_SELECTION_BOOTSTRAP = {"products":[
  {"partNumber":"MX001ZD/A","familyType":"iphoneduo","dimensionColor":"black","dimensionCapacity":"256gb","price":{"amount":2399}},
  {"partNumber":"MX002ZD/A","familyType":"iphoneduo","dimensionColor":"black","dimensionCapacity":"512gb"},
  {"partNumber":"MX003ZD/A","familyType":"iphoneduo","dimensionColor":"silver","dimensionCapacity":"1tb"},
  {"partNumber":"MA999ZM/A","name":"Duo Case"}
]};</script><a data-part="MX001ZD/A">"partNumber":"MX001ZD/A"</a>`;

test('parseProducts reads capacity and colour per part, deduplicated', () => {
  const p = parseProducts(html);
  assert.deepEqual(p, [
    { part: 'MX001ZD/A', capacityGb: 256, color: 'black' },
    { part: 'MX002ZD/A', capacityGb: 512, color: 'black' },
    { part: 'MX003ZD/A', capacityGb: 1024, color: 'silver' },
    { part: 'MA999ZM/A', capacityGb: null, color: null },
  ]);
  assert.deepEqual(filterByCapacity(p, [256, 512]).map((x) => x.part), ['MX001ZD/A', 'MX002ZD/A']);
});

test('fulfillmentUrl keeps the locale and numbers the parts', () => {
  const u = new URL(fulfillmentUrl('https://www.apple.com/de/shop/buy-iphone/iphone-duo', ['A/A', 'B/A'], '80331'));
  assert.equal(u.pathname, '/de/shop/fulfillment-messages');
  assert.equal(u.searchParams.get('parts.0'), 'A/A');
  assert.equal(u.searchParams.get('parts.1'), 'B/A');
  assert.equal(u.searchParams.get('location'), '80331');
});

const response = {
  body: { content: { pickupMessage: { stores: [
    { storeName: 'Rosenstraße', storeNumber: 'R045', city: 'München', partsAvailability: {
      'MX001ZD/A': { pickupDisplay: 'available', pickupSearchQuote: 'Heute verfügbar', messageTypes: { regular: { storePickupProductTitle: 'iPhone Duo 256 GB Schwarz' } } },
      'MX002ZD/A': { pickupDisplay: 'unavailable', messageTypes: { regular: { storePickupProductTitle: 'iPhone Duo 512 GB Schwarz' } } },
    } },
    { storeName: 'Augsburg', storeNumber: 'R999', city: 'Augsburg', partsAvailability: {
      'MX001ZD/A': { pickupDisplay: 'available' },
    } },
  ] } } },
};

test('parseAvailability keeps only matching stores', () => {
  const rows = parseAvailability(response, 'München');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.part, r.available]), [['MX001ZD/A', true], ['MX002ZD/A', false]]);
  assert.equal(rows[0].title, 'iPhone Duo 256 GB Schwarz');
  assert.equal(parseAvailability({}, 'München').length, 0);
});

test('newlyAvailable alerts once per restock', () => {
  const rows = parseAvailability(response, 'München');
  const first = newlyAvailable(new Set(), rows);
  assert.equal(first.fresh.length, 1);
  const second = newlyAvailable(first.keys, rows);
  assert.equal(second.fresh.length, 0);
  const gone = newlyAvailable(second.keys, rows.map((r) => ({ ...r, available: false })));
  assert.equal(newlyAvailable(gone.keys, rows).fresh.length, 1);
});
