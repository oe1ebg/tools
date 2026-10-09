// Links to the datasets the tool ships with (footer attribution) and "show
// on Google Maps / OpenStreetMap" links for a location. These are plain
// <a href> targets for the user to click when online — nothing here is ever
// fetched; all data is built into data/ at build time. This is the only module
// of the offline tools allowed to contain external URLs (tests/confirm-offline.test.mjs).

import { el } from './dom.js';

export const DATA_SOURCES = {
  callsigns: {
    label: 'Rufzeichenliste (Fernmeldebüro)',
    url: 'https://www.fb.gv.at/Funk/amateurfunkdienst.html',
  },
  repeaters: {
    label: 'ÖVSV Repeater-Datenbank',
    url: 'https://repeater.oevsv.at/',
  },
  addresses: {
    label: 'Stadt Wien – Adressen Standorte Wien',
    url: 'https://www.data.gv.at/katalog/dataset/1d5c2411-9719-4c8f-b99d-57a5f4a4ae41',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.de',
  },
  gipNames: {
    label: 'Stadt Wien – GIP.at Namen (Punkt) Wien',
    url: 'https://www.data.gv.at/katalog/dataset/ee97fa6e-e96c-4f37-ae3f-26b2ed3ada0d',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.de',
  },
  stops: {
    label: 'Stadt Wien – Wiener Linien Haltestellen',
    url: 'https://www.data.gv.at/katalog/dataset/f1f6f15d-2faa-4b62-b78b-80599dd1c66e',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.de',
  },
  districts: {
    label: 'Stadt Wien – Bezirksgrenzen',
    url: 'https://www.data.gv.at/katalog/dataset/2ee6b8bf-6292-413c-bb8b-bd22dbb2ad4b',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.de',
  },
  adressregister: {
    label: '© Österreichisches Adressregister (BEV)',
    url: 'https://www.bev.gv.at/Services/Produkte/Adressregister/Oesterreichisches-Adressregister.html',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.de',
  },
  bezirke: {
    label: 'Statistik Austria – Politische Bezirke',
    url: 'https://www.statistik.at/services/tools/regionale-internationale-daten/regionale-daten-und-gliederungen/regionale-gliederungen',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.de',
  },
  leaflet: {
    label: 'Leaflet',
    url: 'https://leafletjs.com/',
    license: 'BSD-2',
    licenseUrl: 'https://github.com/Leaflet/Leaflet/blob/main/LICENSE',
  },
  osm: {
    label: '© OpenStreetMap-Mitwirkende',
    url: 'https://www.openstreetmap.org/copyright',
    license: 'ODbL',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/',
  },
};

// Source repository of the tools, for the commit link in the footer.
export const REPO_URL = 'https://github.com/oe1ebg/tools';

// Link target for a build's commit, or null for "dev"/unknown builds.
export function commitUrl(sha) {
  const s = String(sha || '');
  return /^[0-9a-f]{7,40}$/.test(s) ? `${REPO_URL}/commit/${s}` : null;
}

// Footer version: "commit abc1234 · data 1a2b3c4d5e6f" (commit linked when
// it is a real SHA). build = { commit, version } (build-info.js); version =
// the active service worker's content hash, which wins over build.version.
export function versionItems(build, version) {
  const b = build || {};
  const commit = b.commit || 'dev';
  const data = version || b.version || 'dev';
  const url = commitUrl(commit);
  return ['commit ', url ? extLink(url, commit) : commit, ` · data ${data}`];
}

// "2026-10-04..." -> "04.10.2026"
export function standDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '?');
}

function extLink(url, text) {
  return el('a', { href: url, target: '_blank', rel: 'noopener' }, text);
}

// "<label> (CC BY 4.0) – <detail>" with links to dataset and licence.
export function sourceItem(key, detail) {
  const s = DATA_SOURCES[key];
  return el('span', { class: 'source' },
    extLink(s.url, s.label),
    s.license ? [' (', extLink(s.licenseUrl, s.license), ')'] : null,
    detail ? ` – ${detail}` : null);
}

// Zoom level for a map link, by result/location type; a locator by its
// precision (4 chars ≈ 1°×2°, 6 ≈ 5 km, 8 ≈ 500 m), a UTMREF by its digits.
const MAP_ZOOM = { address: 18, poi: 17, street: 16, coordinate: 16, district: 14, postcode: 12, bezirk: 11 };
const LOCATOR_ZOOM = { 2: 5, 4: 9, 6: 13, 8: 16, 10: 18 };
const UTM_ZOOM = { 0: 9, 2: 12, 4: 15, 6: 17, 8: 18, 10: 18 };

export function mapLinkZoom(r) {
  if (r?.type === 'maidenhead') return LOCATOR_ZOOM[String(r.maidenhead || '').length] || 13;
  if (r?.type === 'utm') return UTM_ZOOM[String(r.utm || '').replace(/^\d+[A-Z] [A-Z]{2}/, '').replace(/\D/g, '').length] ?? 16;
  return MAP_ZOOM[r?.type] || 15;
}

// { google, osm } URLs for a point (5 decimals, "." as separator), or null
// without valid coordinates.
export function mapLinkUrls(lat, lon, zoom = 15) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const la = lat.toFixed(5), lo = lon.toFixed(5);
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${la},${lo}`,
    osm: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=${zoom}/${la}/${lo}`,
  };
}

// "Google Maps" / "OpenStreetMap" links for a lookup result or a stored
// `loc`. Marked .online-only: hidden while the browser is offline (see
// trackOnline()), since they would only lead to an error page.
export function mapLinks(r) {
  const u = mapLinkUrls(r?.lat, r?.lon, mapLinkZoom(r));
  if (!u) return null;
  return el('span', { class: 'map-links online-only' },
    extLink(u.google, 'Google Maps'), ' ', extLink(u.osm, 'OpenStreetMap'));
}

// Keeps `offline` on <html> in sync with navigator.onLine, so CSS hides
// .online-only elements while offline. Call once at startup.
export function trackOnline() {
  const root = document.documentElement;
  const sync = () => root.classList.toggle('offline', navigator.onLine === false);
  sync();
  globalThis.addEventListener('online', sync);
  globalThis.addEventListener('offline', sync);
}
