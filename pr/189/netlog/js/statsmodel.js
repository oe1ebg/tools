// The series statistics (#83) as the view shows them: seriesStatistics() numbers turned into
// texts and plain rows (no DOM, no storage). Estimated stays estimated, an unknown quantity is
// a dash and counts as left out (tools/netlog/AGENTS.md: never invent precision).
//
//   smDuration(ms)  -> "hh:mm" (hours unbounded, minutes floored like the roster report)
//   smQty(q)        -> { text, note, level }  text: "01:23" exact, "≈ 01:23" estimated,
//                      "≥ 01:23" when items were left out, "–" unknown; note: "(+2 ohne Zeit)" or "";
//                      level: 'exact' | 'estimated' | 'unknown'
//   smSummary(stats), smLeaderboard(stats), smMatrix(stats), smSessions(stats), smRotation(stats)

import { t } from './i18n.js';
import { hm, hmz } from './clock.js';

const SM_DASH = '–';
const smPad = n => String(n).padStart(2, '0');

export function smDuration(ms) {
  if (ms == null || !(ms >= 0)) return SM_DASH;
  const min = Math.floor(ms / 60000);
  return `${smPad(Math.floor(min / 60))}:${smPad(min % 60)}`;
}

export function smQty(q) {
  if (!q || q.ms == null) {
    return { text: SM_DASH, note: q && q.leftOut > 0 ? t('stats.leftOut', { n: q.leftOut }) : '', level: 'unknown' };
  }
  const left = q.leftOut > 0;
  const mark = left ? '≥ ' : q.quality === 'estimated' ? '≈ ' : '';
  return {
    text: mark + smDuration(q.ms),
    note: left ? t('stats.leftOut', { n: q.leftOut }) : '',
    level: left || q.quality === 'estimated' ? 'estimated' : 'exact',
  };
}

// "3/4 (75 %)"
export function smShare(attended, total) {
  return `${attended}/${total} (${total > 0 ? Math.round(attended / total * 100) : 0} %)`;
}

const smNumber = n => (n == null || n === '' ? '' : `#${n}`);
const smWho = h => h.call || '?';

// the summary line items: sessions counted, sessions without known times, stations, excluded calls
export function smSummary(stats) {
  const unknownTimes = stats.sessions.filter(s => s.length.ms == null).length;
  return {
    sessions: stats.sessionCount,
    unknownTimes,
    stations: stats.leaderboard.length,
    excluded: stats.excluded.participants,
    excludedSessions: stats.excluded.sessions,
    withoutStart: stats.gaps.withoutStart,
    withoutEnd: stats.gaps.withoutEnd,
  };
}

export function smLeaderboard(stats) {
  return stats.leaderboard.map(r => ({
    key: r.key, rank: r.rank, call: r.call, name: r.name || '',
    attended: r.sessionsAttended, attendedText: smShare(r.sessionsAttended, stats.sessionCount),
    timePresent: smQty(r.timePresent), speaking: smQty(r.speaking),
    ncsSessions: r.ncsSessions, lastSeen: r.lastSeen || SM_DASH,
  }));
}

// stations x sessions; a cell: { attended, text, note, ncs }: "✓ 01:23" (the time present, or
// "✓" alone when it is unknown), absent "–"
export function smMatrix(stats) {
  return {
    sessions: stats.matrix.sessions.map(s => ({ id: s.sessionId, date: s.date, number: smNumber(s.number) })),
    rows: stats.matrix.rows.map(r => ({
      key: r.key, call: r.call, name: r.name || '',
      cells: r.cells.map(c => {
        if (!c) return { attended: false, text: SM_DASH, note: '', ncs: false };
        const q = smQty(c.timePresent);
        return { attended: true, text: q.level === 'unknown' ? '✓' : `✓ ${q.text}`, note: q.note, ncs: Boolean(c.ncs) };
      }),
    })),
  };
}

// "18:00–19:10 UTC" with what is estimated marked; '' when the start is unknown
function smSpan(s) {
  if (!s.start.iso) return '';
  const a = (s.start.quality === 'estimated' ? '≈ ' : '') + hm(s.start.iso);
  if (!s.end.iso) return `${a}–? ${hmz(s.start.iso).split(' ').pop()}`;
  const b = (s.end.quality === 'estimated' ? '≈ ' : '') + hm(s.end.iso);
  return `${a}–${b} ${hmz(s.end.iso).split(' ').pop()}`;
}

export function smSessions(stats) {
  return stats.sessions.map(s => ({
    id: s.sessionId, date: s.date, number: smNumber(s.number), name: s.name || '',
    span: smSpan(s), length: smQty(s.length),
    rounds: s.rounds.map(r => ({ number: r.number, topic: r.topic, duration: smQty(r.duration) })),
    present: s.present,
    ncs: [...new Set(s.ncs.map(smWho))],
  }));
}

export function smRotation(stats) {
  return stats.rotation.map(r => ({
    id: r.sessionId, date: r.date, number: smNumber(r.number),
    holders: r.holders.map(h => ({
      call: smWho(h), name: h.name || '',
      from: h.from ? hm(h.from) : '', to: h.to ? hm(h.to) : '',
      zone: (h.from || h.to) ? hmz(h.from || h.to).split(' ').pop() : '',
      duration: smQty(h.ms),
    })),
  }));
}
