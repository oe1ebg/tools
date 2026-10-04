// Links to the datasets the tool ships with (footer attribution). These are
// plain <a href> targets for the user to click when online — nothing here is
// ever fetched; all data is built into data/ at build time. This is the only
// js/ module allowed to contain external URLs (tests/confirm-offline.test.mjs).

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
  districts: {
    label: 'Stadt Wien – Bezirksgrenzen',
    url: 'https://www.data.gv.at/katalog/dataset/2ee6b8bf-6292-413c-bb8b-bd22dbb2ad4b',
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
  return el('span', { class: 'src' },
    extLink(s.url, s.label),
    s.license ? [' (', extLink(s.licenseUrl, s.license), ')'] : null,
    detail ? ` – ${detail}` : null);
}
