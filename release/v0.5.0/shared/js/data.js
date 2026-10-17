// Loads the build-time data files in tools/shared/data/ (callsign list,
// repeaters, Vienna locations, Austria areas, basemap), published at
// /shared/data/. Same-origin only, and precached by the offline tools'
// service workers, so this works offline. The URL is relative to the page,
// so it assumes the page sits one level below the site root (/<tool>/),
// like every tool. In the single-file bundles (confirm-offline.html) the
// files are inlined as globalThis.OE1EBG_DATA[name] instead.

export async function loadDataFile(name) {
  const inline = globalThis.OE1EBG_DATA;
  if (inline && Object.prototype.hasOwnProperty.call(inline, name)) return inline[name];
  if (globalThis.location && location.protocol === 'file:') return null;
  try {
    const res = await fetch(`../shared/data/${name}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
