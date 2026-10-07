// DOM for the popups, the alert and pinned-summit lists, the search
// results, the band/mode checkboxes and the status bar. Built with el()
// (../shared/js/dom.js), never HTML strings: names, comments and
// frequencies come from the SOTA API and OSM. The actions come in as
// callbacks from app.js.

import { el, fill } from '../../shared/js/dom.js';
import { alertSummitKey, isOwnAlert, sortByOrder } from './alerts.js';
import { timeDisplayPair, formatAlertsBrief } from './format.js';
import { summitMetaLine, referenceDiff, referenceDiffText, haversineKm, splitSummitKey, summitLinks } from './summits.js';

const refButton = (isRef, { setRef, clearRef }) => isRef
  ? el('button', { type: 'button', class: 'btn-ref', onclick: clearRef }, 'clear reference')
  : el('button', { type: 'button', class: 'btn-ref', onclick: setRef }, 'set as reference');

const pinButton = (pinned, { pin, unpin }) => pinned
  ? el('button', { type: 'button', class: 'btn-ref danger', onclick: unpin }, 'remove pin')
  : el('button', { type: 'button', class: 'btn-ref', onclick: pin }, 'pin this summit');

const diffLine = diff => diff ? el('div', { class: 'ref-diff' }, referenceDiffText(diff)) : null;

function popupHead(name, key, meta, assoc, code){
  const links = summitLinks(assoc, code);
  return [
    el('div', { class: 'popup-title' }, name, ' ', el('span', { class: 'code' }, key)),
    el('div', { class: 'popup-meta' }, meta ? meta + ' · ' : '',
      el('a', { href: links.sotadata, target: '_blank', rel: 'noopener' }, 'sotadata ↗'), ' · ',
      el('a', { href: links.sotlas, target: '_blank', rel: 'noopener' }, 'sotl.as ↗')),
  ];
}

// Popup of an alerted, pinned or reference summit.
// ctx: { ownSet, referenceKey, summitMap, isCandidate, timeDisplay }
// on: { setRef, clearRef, pin, unpin }
export function alertPopup(group, summit, ctx, on){
  const rows = group.alerts.slice()
    .sort((a, b) => a.dateActivated.localeCompare(b.dateActivated))
    .map(a => {
      const { primary, secondary } = timeDisplayPair(a.dateActivated, false, ctx.timeDisplay);
      return el('div', { class: isOwnAlert(a, ctx.ownSet) ? 'alert-row own' : 'alert-row' },
        el('b', null, a.activatingCallsign), ' — ', primary, secondary ? ` (${secondary})` : '', el('br'),
        el('span', { class: 'freq' }, a.frequency),
        a.comments ? el('div', { class: 'comment' }, a.comments) : null);
    });
  const isRef = group.key === ctx.referenceKey;
  return el('div', { class: 'sota-popup' },
    popupHead(summit.name, group.key, summitMetaLine(summit), group.associationCode, group.summitCode),
    // Popups open on hover (see map.js), so this is the one place
    // distance/elevation-vs-reference needs to live — the connecting line
    // is purely the visual/spatial aid, not a second copy of this text.
    diffLine(referenceDiff(summit, isRef ? null : ctx.referenceKey, ctx.summitMap)),
    el('div', { class: 'popup-ref' }, refButton(isRef, on), ' ', pinButton(ctx.isCandidate, on)),
    rows.length ? rows : el('div', { class: 'popup-empty' }, 'no alerts in the current date range'));
}

// Popup of a dot in the "all summits" overlay.
export function allSummitPopup(entry, { pinned, isRef }, on){
  const { assoc, code } = splitSummitKey(entry.key);
  return el('div', { class: 'sota-popup' },
    popupHead(entry.name, entry.key, summitMetaLine(entry), assoc, code),
    el('div', { class: 'popup-ref' }, refButton(isRef, on), ' ', pinButton(pinned, on)));
}

// Hovering a list row previews the same reference distance/elevation line
// as hovering its marker on the map would. Per item, since mouseenter/
// mouseleave don't bubble; cheap, the lists are rebuilt on every render.
function hoverable(item, key, hover){
  item.addEventListener('mouseenter', () => hover(key, true));
  item.addEventListener('mouseleave', () => hover(key, false));
  return item;
}

function distanceToRefForAlert(a, refSummit, summitMap){
  const summit = summitMap.get(alertSummitKey(a));
  if (!summit) return null;
  return haversineKm(summit.lat, summit.lon, refSummit.lat, refSummit.lon);
}

// ctx: { ownSet, summitMap, referenceKey, timeDisplay }; hover(key, on)
export function renderAlertList(container, alerts, ctx, hover){
  if (!alerts.length){
    fill(container, el('div', { class: 'list-empty' }, 'no alerts in range'));
    return;
  }
  const { ownSet, summitMap, referenceKey } = ctx;
  // Own alerts always come first regardless of sort mode; within each
  // group, sort by distance to the reference (closest first) once one
  // is set — that's the actual question this tool exists to answer —
  // falling back to chronological order otherwise or where a summit's
  // own coordinates aren't resolvable.
  const refSummit = referenceKey ? summitMap.get(referenceKey) : null;
  const sorted = alerts.slice().sort((a, b) => {
    const aOwn = isOwnAlert(a, ownSet), bOwn = isOwnAlert(b, ownSet);
    if (aOwn !== bOwn) return aOwn ? -1 : 1;
    if (refSummit){
      const da = distanceToRefForAlert(a, refSummit, summitMap);
      const db = distanceToRefForAlert(b, refSummit, summitMap);
      if (da != null && db != null && da !== db) return da - db;
    }
    return a.dateActivated.localeCompare(b.dateActivated);
  });
  fill(container,
    refSummit ? el('div', { class: 'list-section-title' }, `sorted by distance to ${refSummit.name}`) : null,
    sorted.map(a => {
      const key = alertSummitKey(a);
      const isRef = key === referenceKey;
      const summit = summitMap.get(key);
      const diff = summit ? referenceDiff(summit, isRef ? null : referenceKey, summitMap) : null;
      const cls = ['list-item', isOwnAlert(a, ownSet) ? 'own' : '', isRef ? 'is-ref' : ''].filter(Boolean).join(' ');
      // role=button + tabindex: the whole row is the (keyboard-reachable)
      // set/clear-reference toggle, see app.js (click + keydown, delegated).
      return hoverable(el('div', { class: cls, 'data-summit-key': key, 'data-alert-id': String(a.id ?? ''),
        role: 'button', tabindex: '0', 'aria-pressed': String(isRef), title: 'click to set/clear as reference summit' },
        el('div', { class: 'li-top' }, el('b', null, a.activatingCallsign), el('span', { class: 'li-summit' }, isRef ? '★ ' : '', key)),
        el('div', { class: 'li-meta' }, `${timeDisplayPair(a.dateActivated, true, ctx.timeDisplay).primary} · ${a.frequency}`),
        diffLine(diff)), key, hover);
    }));
}

// Pinned candidate summits (from the search box), shown regardless of
// whether they currently have an alert — this is what makes "is this a
// good summit to activate?" answerable even with no alerts of your own.
// ctx: { summitMap, referenceKey, timeDisplay, groups }; on: { hover, unpin }
export function renderCandidatesList(container, candidates, ctx, on){
  if (!candidates.size){ fill(container); return; }
  fill(container, el('div', { class: 'list-section-title' }, 'pinned summits'), [...candidates.values()].map(c => {
    const isRef = c.key === ctx.referenceKey;
    const meta = summitMetaLine(c);
    // Same alert set the map/popup would show for this summit right now
    // (ctx.groups is band/mode-filtered, unlike alertsForSummitInRange).
    const alertBrief = formatAlertsBrief((ctx.groups.get(c.key) || {}).alerts || [], ctx.timeDisplay);
    // The row holds its own "remove pin" button, so it can't be a
    // role=button itself (no nested interactive content); a visually
    // hidden real button does the row's click action (set/clear
    // reference, via the delegated click handler in app.js) for keyboard
    // and screen-reader users instead. It can't show a focus ring itself,
    // so its row does (keyboard focus only, like :focus-visible on the
    // alert rows).
    const row = el('div', { class: isRef ? 'list-item candidate is-ref' : 'list-item candidate', 'data-summit-key': c.key, title: 'click to set/clear as reference summit' });
    const toggle = el('button', { type: 'button', class: 'sr-only', 'data-toggle-ref': '', 'aria-pressed': String(isRef),
      onfocus: () => row.classList.toggle('kbd-focus', toggle.matches(':focus-visible')),
      onblur: () => row.classList.remove('kbd-focus') },
    `reference summit: ${c.name} (${c.key})`);
    fill(row,
      toggle,
      el('div', { class: 'li-top' }, el('b', null, c.name), el('span', { class: 'li-summit' }, isRef ? '★ ' : '', c.key)),
      meta ? el('div', { class: 'li-meta' }, meta) : null,
      alertBrief ? el('div', { class: 'search-result-alert' }, `alert: ${alertBrief}`) : null,
      diffLine(referenceDiff(c, isRef ? null : ctx.referenceKey, ctx.summitMap)),
      el('button', { type: 'button', class: 'btn-ref danger', 'data-remove-candidate': c.key,
        onclick: e => { e.stopPropagation(); on.unpin(c.key); } }, 'remove pin'));
    return hoverable(row, c.key, on.hover);
  }));
}

/* ---------- summit search / pin panel ---------- */

// The panel's hint line (searching…, failed, nothing found), also told
// to screen readers through the #search-status live region.
export function setSearchHint(panel, status, text){
  fill(panel, el('div', { class: 'search-hint' }, text));
  status.textContent = text;
}

// Results of a SOTA name/code search or an OSM area search — both produce
// the same {key, assoc, code, name, altM, points, lat, lon} candidate shape.
// ctx: { isPinned(key), referenceKey(), alertBrief(key) }; on: { pin, setRef }
export function renderSearchResults(panel, status, cands, emptyMsg, ctx, on){
  panel.classList.add('show');
  if (!cands.length){ setSearchHint(panel, status, emptyMsg); return; }
  const shown = Math.min(cands.length, 30);
  status.textContent = `${shown} summit${shown === 1 ? '' : 's'} found`;
  const refButtons = [];
  const pinButtons = new Map();
  const markPinned = b => { b.textContent = 'pinned ✓'; b.disabled = true; };
  // Refresh every reference button in this panel, not just the one
  // clicked — setting a new reference un-sets whichever summit was
  // previously the reference, which might also be listed here.
  const syncRefButtons = () => refButtons.forEach(b => {
    const isNowRef = b.dataset.setrefCandKey === ctx.referenceKey();
    b.disabled = isNowRef;
    b.textContent = isNowRef ? 'reference ✓' : 'set as reference';
  });
  fill(panel, cands.slice(0, 30).map(cand => {
    const pinned = ctx.isPinned(cand.key);
    const isRef = cand.key === ctx.referenceKey();
    const meta = summitMetaLine(cand);
    const alertBrief = ctx.alertBrief(cand.key);
    const refBtn = el('button', { type: 'button', class: 'btn-ref', 'data-setref-cand-key': cand.key, disabled: isRef,
      onclick: () => {
        on.setRef(cand);
        syncRefButtons();
        const pinBtn = pinButtons.get(cand.key);
        if (pinBtn) markPinned(pinBtn);
      } }, isRef ? 'reference ✓' : 'set as reference');
    const pinBtn = el('button', { type: 'button', class: 'btn-ref', 'data-pin-cand-key': cand.key, disabled: pinned,
      onclick: () => { on.pin(cand); markPinned(pinBtn); } }, pinned ? 'pinned ✓' : '+ pin');
    refButtons.push(refBtn);
    if (!pinButtons.has(cand.key)) pinButtons.set(cand.key, pinBtn);
    return el('div', { class: 'search-result' },
      el('div', { class: 'search-result-top' },
        el('span', null, cand.name, ' ', el('span', { class: 'li-summit' }, cand.key), meta ? ` · ${meta}` : ''),
        el('span', { class: 'search-result-actions' }, refBtn, pinBtn)),
      alertBrief ? el('div', { class: 'search-result-alert' }, `alert: ${alertBrief}`) : null);
  }));
}

/* ---------- band/mode facets, status bar ---------- */

export function renderFacetGroup(container, presentValues, sortOrder, selectedSet){
  const ordered = sortByOrder(presentValues, sortOrder);
  if (!ordered.length){ fill(container, el('span', { class: 'search-hint' }, 'none in current range')); return; }
  fill(container, ordered.map(v => {
    const id = `${container.id}-${v.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return el('label', { class: 'chk', for: id }, el('input', { type: 'checkbox', id, value: v, checked: selectedSet.has(v) }), v);
  }));
}

export function renderStats(statsEl, { alerts, onMap, mine }){
  fill(statsEl, el('b', null, alerts), ' alerts · ', el('b', null, onMap), ' summits on map · ', el('b', null, mine), ' yours');
}

// ref: { name, key } or null
export function renderRefIndicator(refEl, ref, clearRef){
  if (!ref){ refEl.textContent = ''; return; }
  fill(refEl, 'reference: ', el('b', null, ref.name), ` (${ref.key}) `,
    el('button', { type: 'button', id: 'btn-clear-ref-toolbar', 'aria-label': 'clear reference', onclick: clearRef }, '✕'));
}
