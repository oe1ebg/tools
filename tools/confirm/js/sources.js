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

// Source repository of this site, for the commit link in the footer.
export const REPO_URL = 'https://github.com/ebirn/web_outdated_at';

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
  return el('span', { class: 'src' },
    extLink(s.url, s.label),
    s.license ? [' (', extLink(s.licenseUrl, s.license), ')'] : null,
    detail ? ` – ${detail}` : null);
}
