// Small per-browser settings (CSV separator, time mode, …) in localStorage.
// Reading or writing throws when storage is blocked (Safari private mode,
// some file:// setups); then the default applies and a change lasts for
// this page only, instead of the tool failing to start.

export function prefGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function prefSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: keep the value for this page only */
  }
}
