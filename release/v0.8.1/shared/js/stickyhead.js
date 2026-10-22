// The height of the sticky page header (#site-header) as the CSS variable
// --site-header-h on :root, kept current (it wraps on narrow screens and
// when chips appear or change): table headers stick right below it
// (`top: var(--site-header-h)`) instead of under it. Window resizes and
// changes inside the header trigger a new measurement, in the next frame
// (no ResizeObserver: WebKit reports loops for it here).

export function trackSiteHeaderHeight() {
  const hdr = document.getElementById('site-header');
  if (!hdr) return;
  let queued = false;
  const set = () => {
    queued = false;
    document.documentElement.style.setProperty('--site-header-h', `${hdr.offsetHeight}px`);
  };
  const queue = () => {
    if (!queued) { queued = true; requestAnimationFrame(set); }
  };
  set();
  window.addEventListener('resize', queue);
  new MutationObserver(queue).observe(hdr, { subtree: true, childList: true, characterData: true, attributes: true });
}
