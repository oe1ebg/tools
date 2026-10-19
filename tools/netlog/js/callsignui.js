// Netlog's side of the callsign lists: the lists and their dialog are the
// shared ones (shared/js/callsignlists.js, one store for all tools). Here
// only the section in "Backup and data" (summary + button) and the merged
// view that check-in suggestions and the info line read (app.data.directory).

import { $ } from '../../shared/js/dom.js';
import { t, lang } from './i18n.js';
import { createCallsignLists } from '../../shared/js/callsignlists.js';
import { setText } from './keyed.js';

export function initCallsigns(app) {
  const lists = createCallsignLists({
    getLang: lang,
    getCallbook: () => app.data.callbook,
    onChange: () => {
      app.data.directory = lists.directory();
      renderListsSummary(app);
      if (app.onCallbook) app.onCallbook();
    },
  });
  app.callsignLists = lists;
  $('#btn-lists-open').addEventListener('click', ev => lists.open(ev.currentTarget));
  app.onLang(() => { lists.relabel(); renderListsSummary(app); });
  return lists.init();
}

// A change of the bundled list (loaded after the store): rebuild the view.
export function rebuildCallsignDirectory(app) {
  if (app.callsignLists) app.callsignLists.relabel();
}

export function renderListsSummary(app) {
  const s = app.callsignLists ? app.callsignLists.summary() : null;
  setText($('#lists-summary'), !s ? '' : !s.available ? t('lists.unavailable') : t('lists.summary', { active: s.active, total: s.total }));
}
