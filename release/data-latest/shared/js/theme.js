// Light / dark theme for every tool page. A CLASSIC script (not a module),
// loaded in the page head as the first script, before the stylesheets
// (this file, then css/tools.css next to this folder), so the page never
// paints in the wrong theme. The single-file bundles inline it, so this
// comment names no tags or paths that a bundle check would take for an
// external reference.
//
// It always sets the resolved theme, data-theme="light|dark" on the root
// element ("auto" follows prefers-color-scheme, also when the OS switches
// while the page is open), so the CSS needs exactly one light and one dark
// token set (tools.css). Buttons with data-theme-choice="light|auto|dark"
// become the toggle (aria-pressed shows the active one). One choice for all
// tools, stored under oe1ebg-theme; the tools' old keys are still read.
//
// ES5 on purpose: it runs before anything else and must not be the reason a
// page breaks in an old browser.
(function () {
  var KEY = 'oe1ebg-theme';
  var OLD_KEYS = ['oe1ebg-confirm-theme', 'adif-editor-theme', 'sota-alerts-theme'];
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function stored() {
    var keys = [KEY].concat(OLD_KEYS);
    for (var i = 0; i < keys.length; i++) {
      var v = read(keys[i]);
      if (v === 'light' || v === 'dark' || v === 'auto') return v;
    }
    return 'auto';
  }

  var choice = stored();

  function apply() {
    var dark = choice === 'dark' || (choice === 'auto' && !!mq && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var buttons = document.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-theme-choice') === choice;
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      buttons[i].classList.toggle('active', on);
    }
  }

  function set(next) {
    choice = next;
    // Storage blocked (private mode, file:// in some browsers): the choice
    // just lasts for this page.
    try { window.localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
    apply();
  }

  apply();
  if (mq) {
    var onChange = function () { if (choice === 'auto') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange); // Safari < 14
  }

  function wire() {
    var buttons = document.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () { set(this.getAttribute('data-theme-choice')); });
    }
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.OE1EBG_THEME = { choice: function () { return choice; }, set: set };
})();
