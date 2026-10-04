// Loads the build-time data files in data/ (callsign list, later the Vienna
// location data). Same-origin only, and precached by the service worker, so
// this works offline. In confirm-offline.html the files are inlined by
// scripts/build_confirm.py as globalThis.CONFIRM_DATA[name] instead.

export async function loadDataFile(name) {
  const inline = globalThis.CONFIRM_DATA;
  if (inline && Object.prototype.hasOwnProperty.call(inline, name)) return inline[name];
  if (globalThis.location && location.protocol === 'file:') return null;
  try {
    const res = await fetch(`data/${name}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
