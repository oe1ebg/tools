// Writes the empty Notfunk form (the "Leeres Formular (PDF)" of the tool) so
// the manual can offer it as a plain download:
//   node scripts/notfunk_vordruck.mjs <out.pdf>
// Same drawing function as in the tool (tools/notfunk/js/paperpdf.js), no
// Einsatz name, the date of the build as print date.
import { writeFileSync } from 'node:fs';
import { blankFormPdf } from '../tools/notfunk/js/paperpdf.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/notfunk_vordruck.mjs <out.pdf>');
  process.exit(2);
}
writeFileSync(out, blankFormPdf(null, { now: new Date().toISOString() }));
