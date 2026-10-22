// The ADIF editor's shared state: the log and what the table shows of it.
//
// View contract (app.js owns the writes; filter code and others read it and
// change the view only through setView()):
// - records: Array<{FIELD: value}>, the source of truth. Exports always
//   write all of it, in this order. The array is never replaced (mutated
//   in place: push, splice, reorder on sort).
// - recordFile: string[], parallel to records: the name of the file each
//   record was loaded from ('' for rows added in the editor). app.js keeps
//   it in sync on load, add, delete and sort. Read-only for everyone else.
// - view: number[] | null, record indices in display order; null = all
//   records in order. setView(v) stores it (a copy) and re-renders only the
//   table's visible window. After add/delete/sort app.js remaps the indices
//   in an active view itself (a deleted record leaves it, an added one is
//   appended, sorting reorders it).
// - issuesByIndex: Map<number, { worst, issues, byField }>, record index ->
//   its validation issues from the current validation result: worst is
//   'error' | 'warning' | 'info', issues the issue objects of
//   validateAdif(), byField a Map(field name -> issues), field-less issues
//   under ''. Records without an issue have no entry. Rebuilt (same Map
//   object) after every validation and every reorder.
// - The table's DOM: every body row carries data-ri (the record index),
//   every value cell data-col (the field name); never rely on positions.
// - scrollToRecord(ri) scrolls the table to a record shown in the view.
//
// Top-level names are unique across the editor's modules (one scope in the
// single-file bundle).

export const records = [];
export const recordFile = [];
export const issuesByIndex = new Map();
export let view = null;

const viewHooks = { render: () => {}, scrollTo: () => {} };

export function setView(v){
  view = v ? Array.from(v) : null;
  viewHooks.render();
}

export function scrollToRecord(ri){
  viewHooks.scrollTo(ri);
}

// app.js: what setView()/scrollToRecord() do.
export function bindViewHooks(render, scrollTo){
  viewHooks.render = render;
  viewHooks.scrollTo = scrollTo;
}

// For app.js's own remapping after add/delete/sort (no re-render).
export function replaceView(v){
  view = v;
}

// Number of rows shown, and the record index at display position pos.
export function viewLength(){
  return view ? view.length : records.length;
}

export function viewIndexAt(pos){
  return view ? view[pos] : pos;
}
