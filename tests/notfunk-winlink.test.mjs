// The Winlink form pack of the Notfunk-Meldebuch (tools/notfunk/winlink/,
// issue #179, contract: FORMAT.md there): template, input form and viewer
// fit together and survive the Winlink clients; the zip for operators is
// deterministic. Recorded Pat output: tests/fixtures/notfunk-winlink/pat/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const OE1EBG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(OE1EBG, 'tools', 'notfunk', 'winlink');
const FIX = join(OE1EBG, 'tests', 'fixtures', 'notfunk-winlink', 'pat');
const read = name => readFileSync(join(DIR, name), 'utf8');
const TEMPLATE = read('OE1_Notfunk_Meldung.txt');
const INITIAL = read('OE1_Notfunk_Meldung_Initial.html');
const VIEWER = read('OE1_Notfunk_Meldung_Viewer.html');

// Insertion tags Pat replaces in form HTML (internal/forms/builder.go,
// insertionTagReplacer; Winlink Express has the same set and more).
const TAGS = ['MsgSender', 'Callsign', 'ProgramVersion', 'DateTime', 'UDateTime', 'Date', 'UDate', 'UDTG', 'Time', 'UTime',
  'Day', 'UDay', 'GPS', 'GPSValid', 'GPS_DECIMAL', 'GPS_SIGNED_DECIMAL', 'GridSquare', 'Latitude', 'Longitude',
  'GPSLatitude', 'GPSLongitude', 'InternetAvailable', 'MsgIsReply', 'MsgIsForward', 'MsgIsAcknowledgement', 'SeqNum',
  'FormFolder', 'FormServer', 'FormPort', 'MsgTo', 'MsgCc', 'MsgSubject', 'MsgP2P', 'Sender'];
const tagsIn = html => [...html.matchAll(new RegExp(`\\{\\s*(${TAGS.join('|')})\\s*\\}`, 'gi'))].map(m => m[1]);
const scripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test('template: header lines, both forms, ASCII only', () => {
  const lines = TEMPLATE.split('\n');
  assert.equal(lines[0], 'Form: OE1_Notfunk_Meldung_Initial.html,OE1_Notfunk_Meldung_Viewer.html');
  assert.ok(lines.includes('To: <var msgto>'));
  assert.ok(lines.includes('Subject: <var kennung> <var prioritaet> <var nummer>: <var betreff>'));
  // exercise marker: the first body line; its own line, a blank line, the Inhalt, a blank line, the marker
  assert.equal(lines[lines.indexOf('Msg:') + 1], '<var uebung>');
  const i = lines.indexOf('<var inhalt>');
  assert.deepEqual(lines.slice(i - 2, i + 3), ['<var uebung>', '', '<var inhalt>', '', '<var uebung>']);
  assert.ok(lines.includes('Msg:'));
  for (const f of lines[0].slice(6).split(',')) assert.ok(read(f.trim()), f);
  assert.ok(/^[\n -~]*$/.test(TEMPLATE), 'template is ASCII');
});

test('every template variable is a named field of the input form', () => {
  const vars = new Set([...TEMPLATE.matchAll(/<var\s+([\w-]+)\s*>/gi)].map(m => m[1].toLowerCase()));
  const names = new Set([...INITIAL.matchAll(/\sname="([^"]+)"/g)].map(m => m[1]));
  for (const v of vars) assert.ok(names.has(v), `<var ${v}> has no field`);
  // FORMAT.md: the flat fields and the payload
  for (const n of ['meldung', 'msgto', 'nummer', 'prioritaet', 'art', 'von', 'an', 'betreff', 'inhalt', 'zeit', 'bezug', 'station', 'verlauf', 'format_version', 'templateversion', 'kennung', 'uebung']) {
    assert.ok(names.has(n), n);
  }
  for (const n of names) assert.equal(n, n.toLowerCase(), 'clients lower-case field names');
  // the file input, the paste box and the exercise checkbox are not posted
  assert.doesNotMatch(INITIAL, /<input[^>]*type="checkbox"[^>]*name=/);
  assert.doesNotMatch(INITIAL, /<input[^>]*type="file"[^>]*name=/);
  assert.doesNotMatch(INITIAL, /<textarea[^>]*id="paste"[^>]*name=/);
  assert.match(INITIAL, /<form [^>]*method="post" enctype="multipart\/form-data" action="http:\/\/\{FormServer\}:\{FormPort\}"/);
  assert.match(INITIAL, /name="station" id="station" value="\{MsgSender\}"/);
  assert.match(INITIAL, /name="format_version" value="1"/);
});

test('insertion tags only where intended', () => {
  assert.deepEqual(tagsIn(INITIAL).sort(), ['FormPort', 'FormServer', 'MsgSender']);
  assert.deepEqual(tagsIn(VIEWER), []);
  // the input form takes no received values; the viewer's var slots sit in hidden textareas only
  assert.doesNotMatch(INITIAL, /\{\s*var\s/i);
  const slots = [...VIEWER.matchAll(/\{\s*var\s+([\w-]+)\s*\}/gi)];
  assert.ok(slots.length >= 10);
  for (const m of slots) {
    const at = m.index;
    const line = VIEWER.slice(VIEWER.lastIndexOf('\n', at) + 1, VIEWER.indexOf('\n', at));
    assert.equal(line, `<textarea hidden id="d-${m[1]}">{var ${m[1]}}</textarea>`);
  }
  assert.match(VIEWER, /<textarea hidden id="d-meldung">\{var meldung\}<\/textarea>/);
  for (const s of scripts(VIEWER)) assert.doesNotMatch(s, /\{\s*var\s/i);
});

test('forms are standalone: no external URLs or resources, ASCII, small, scripts parse', () => {
  for (const [name, html] of [['Initial', INITIAL], ['Viewer', VIEWER]]) {
    assert.deepEqual([...html.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)].map(m => m[0]), [], name);
    assert.doesNotMatch(html, /<(script|img|link|iframe)[^>]+(src|href)=/i, name);
    assert.doesNotMatch(html, /@import|[^.A-Za-z]url\(/, name); // CSS resources (not URL.createObjectURL)
    assert.ok(/^[\n -~]*$/.test(html), `${name}: ASCII only (entities / \\u escapes)`);
    assert.ok(html.length < 25000, `${name}: ${html.length} bytes`);
    assert.doesNotMatch(html, /\sstyle="|\son[a-z]+="/i, `${name}: no inline styles or handlers`);
    assert.doesNotMatch(html, /toLocale|Intl\./, `${name}: no locale formatting`);
    const js = scripts(html);
    assert.equal(js.length, 1);
    new vm.Script(js[0]);
  }
});

test('exercise marker: a banner above the text in both forms, from the payload or the flat field', () => {
  // viewer: the banner directly above the text box, from `exercise` or the flat `uebung`
  assert.match(VIEWER, /<p class="ex" id="ex-a" hidden><span aria-hidden="true">&#9888;<\/span> ACHTUNG &Uuml;BUNG<\/p>\n<div class="text" id="text"/);
  assert.match(VIEWER, /<textarea hidden id="d-uebung">\{var uebung\}<\/textarea>/);
  assert.match(scripts(VIEWER)[0], /exercise\(o\.exercise !== false\)/);
  assert.match(scripts(VIEWER)[0], /exercise\(!!slot\('uebung'\)\)/);
  // input form: hidden kennung/uebung; manual entry checked by default, banner above the Inhalt box
  assert.match(INITIAL, /<input type="checkbox" id="ex-in" checked/);
  assert.match(INITIAL, /<label for="inhalt" class="req">Inhalt<\/label><p class="ex" id="ex-man">/);
  assert.match(scripts(INITIAL)[0], /EX_TAG = '\[\\u00dcBUNG\]', EX_LINE = '=== ACHTUNG \\u00dcBUNG ==='/);
  // print and forced colours keep the border
  assert.match(VIEWER, /@media \(forced-colors:active\)\{[^}]*\.ex\{/);
  assert.match(VIEWER, /@media print\{[\s\S]*\.ex\{border:2px solid #000/);
});

// The input form's serialiser, taken from the file, on the recorded payload.
function serialiser() {
  const src = scripts(INITIAL)[0];
  const body = /function ser\(o\) \{([\s\S]*?)\n  \}/.exec(src)[1];
  return new Function('o', body);
}

test('payload: ASCII, no < > &, no line breaks, and what Pat recorded', () => {
  const sample = JSON.parse(readFileSync(join(FIX, 'W1-007.winlink.json'), 'utf8'));
  const s = serialiser()(sample);
  assert.ok(/^[ -~]*$/.test(s));
  assert.doesNotMatch(s, /[<>&\n]|\{var/);
  assert.deepEqual(JSON.parse(s), sample);
  assert.equal(JSON.parse(serialiser()({ t: '😀 {var x}' })).t, '😀 {var x}');
  // Pat's XML attachment carries exactly this string, XML-escaped
  const xml = readFileSync(join(FIX, 'RMS_Express_Form_OE1_Notfunk_Meldung_Viewer.xml'), 'utf8');
  const raw = /<meldung>([^<]*)<\/meldung>/.exec(xml)[1].replace(/&#34;/g, '"').replace(/&#39;/g, "'");
  assert.equal(raw, s);
  assert.match(xml, /<display_form>OE1_Notfunk_Meldung_Viewer\.html<\/display_form>/);
  // the .b2f: ISO-8859-1 body, one attachment with that name and size
  const b2f = readFileSync(join(FIX, 'F7KZR3Z7S5VG.b2f')).toString('latin1');
  assert.match(b2f, /\r\nContent-Type: text\/plain; charset=ISO-8859-1\r\n/);
  assert.match(b2f, /\r\nFile: \d+ RMS_Express_Form_OE1_Notfunk_Meldung_Viewer\.xml\r\n/);
  assert.match(b2f, /\r\nSubject: =\?ISO-8859-1\?q\?\[=DCBUNG\]_Dringend_W1-007:_Nachschub_Notstrom_<dringend>_&_Treibstoff\?=\r\n/);
  // the marker framed, with a blank line on both sides of the Inhalt
  assert.ok(b2f.includes('\r\n\r\n=== ACHTUNG \xdcBUNG ===\r\nNOTFUNK-MELDUNG W1-007\r\n'), 'first body line');
  assert.ok(b2f.includes('Inhalt:\r\n=== ACHTUNG \xdcBUNG ===\r\n\r\nBen\xf6tigen'));
  assert.ok(b2f.includes('Tor 3\'.\r\nTest: <b>kein HTML</b>'));
  assert.match(b2f, /\r\n\r\n=== ACHTUNG \xdcBUNG ===\r\n\r\nVerlauf:/);
  assert.ok(b2f.includes('Von:           Einsatzleitung Übungsraum Nord / OE1XYZ\r\n'));
});

function python(args) {
  for (const [cmd, pre] of [['uv', ['run', '--no-project', 'python']], ['python3', []]]) {
    try {
      return execFileSync(cmd, [...pre, ...args], { cwd: OE1EBG, stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  throw new Error('no python');
}

test('operator download: deterministic zip with the folder "OE1 Notfunk"', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'winlink-zip-'));
  try {
    const a = join(tmp, 'a.zip'), b = join(tmp, 'b.zip');
    python([join(OE1EBG, 'scripts', 'winlink_pack.py'), a]);
    python([join(OE1EBG, 'scripts', 'winlink_pack.py'), b]);
    assert.ok(readFileSync(a).equals(readFileSync(b)), 'same bytes twice');
    const names = python(['-c', 'import sys, zipfile; print("\\n".join(i.filename + " " + str(i.date_time[0]) for i in zipfile.ZipFile(sys.argv[1]).infolist()))', a]).trim().split('\n');
    assert.deepEqual(names, [
      'OE1 Notfunk/ 1980', 'OE1 Notfunk/OE1_Notfunk_Meldung.txt 1980',
      'OE1 Notfunk/OE1_Notfunk_Meldung_Initial.html 1980', 'OE1 Notfunk/OE1_Notfunk_Meldung_Viewer.html 1980', 'README.txt 1980',
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
