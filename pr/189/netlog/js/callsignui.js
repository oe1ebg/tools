// Netlog's side of the callsign lists: the lookup is the shared callsign
// service (shared/js/callsign-service.js, app.calls), the lists and their
// dialog are the shared ones (callsignlists.js, one store for all tools).
// Here only the section in "Backup and data" (summary + button) and the
// hooks that re-render what shows lookups.

import { $ } from '../../shared/js/dom.js';
import { t, lang } from './i18n.js';
import { createCallsignService } from '../../shared/js/callsign-service.js';
import { createCallsignLists } from '../../shared/js/callsignlists.js';
import { setText } from './keyed.js';

export function initCallsigns(app) {
  const calls = createCallsignService({
    getLang: lang,
    onChange: () => {
      renderListsSummary(app);
      if (app.onCallbook) app.onCallbook();
    },
  });
  app.calls = calls;
  const lists = createCallsignLists({ service: calls, getLang: lang });
  $('#btn-lists-open').addEventListener('click', ev => lists.open(ev.currentTarget));
  app.onLang(() => { calls.relabel(); });
  calls.watchFocus();
  return calls.init();
}

export function renderListsSummary(app) {
  const s = app.calls ? app.calls.summary() : null;
  setText($('#lists-summary'), !s ? '' : !s.available ? t('lists.unavailable') : t('lists.summary', { active: s.active, total: s.total }));
}
