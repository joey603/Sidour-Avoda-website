#!/usr/bin/env node
/**
 * Simulation légère « 1000 travailleurs » pour estimer ordre de grandeur avant démo / prod.
 *
 * Mesure :
 * - taille JSON (comme réponse API)
 * - coût CPU d’un mapping type front (sans React)
 *
 * Usage :
 *   node scripts/bench-planning-scale.mjs
 *   node scripts/bench-planning-scale.mjs 2000
 *
 * Pour la vraie latence réseau + API : backend `bash load/run-local.sh` avec
 * LOAD_TEST_EMAIL, LOAD_TEST_PASSWORD, LOAD_TEST_SITE_ID (voir locustfile.py).
 */

const N = Math.max(1, parseInt(process.argv[2] || "1000", 10) || 1000);

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SHIFTS = ["בוקר", "ערב", "לילה"];

function mockWorker(i) {
  const availability = {};
  for (const d of DAYS) {
    availability[d] = i % 3 === 0 ? [SHIFTS[i % SHIFTS.length]] : [];
  }
  return {
    id: i + 1,
    site_id: 1,
    name: `Worker ${i + 1}`,
    max_shifts: 5,
    roles: ["סוהר"],
    availability,
    answers: {},
    phone: null,
    linked_site_ids: i % 17 === 0 ? [1, 2] : [1],
    linked_site_names: i % 17 === 0 ? ["Site A", "Site B"] : ["Site A"],
    pending_approval: false,
  };
}

function bench(label, fn) {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  console.log(`${label}: ${ms.toFixed(2)} ms`);
  return out;
}

const rows = bench(`Génération ${N} objets travailleur (mock)`, () => {
  const arr = [];
  for (let i = 0; i < N; i++) arr.push(mockWorker(i));
  return arr;
});

let json;
const jsonBytes = bench(`JSON.stringify(${N} travailleurs)`, () => {
  json = JSON.stringify(rows);
  return json.length;
});

console.log(`Taille payload JSON ≈ ${(json.length / 1024).toFixed(1)} KiB (${json.length} octets)`);

bench(`Mapping client (simulé: id, nom, roles)`, () => {
  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    maxShifts: w.max_shifts,
    roles: w.roles,
    availability: w.availability,
    linkedSiteIds: w.linked_site_ids,
  }));
});

console.log(`
Interprétation rapide :
- ~${(json.length / 1024 / 1024).toFixed(2)} Mo brut sur le fil : ok en LAN/4G récent si < few s;
- le navigateur doit encore parser JSON + rendre ${N} lignes de tableau (voir onglet Performance Chrome);
- la génération auto (יצירת תכנון) est souvent plus coûteuse côté serveur que cette liste.
`);
