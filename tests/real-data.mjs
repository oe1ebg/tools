// The tests of the generated data (callsign and repeater lists, location
// gold set, basemap, …) and of the build's Python skip themselves when that
// isn't there, so `just test` works on a fresh checkout. Where the data has
// just been built (ci.yml `bundle`, release.yml, data.yml) they run with
// DATA_TESTS=require: then missing data is a failure, never a skip (like
// ADIF_CROSSCHECK=require for the ADIF cross-checks).
//
// Every test file that reads the generated data or the built site/ imports
// this module: ci.yml `bundle` runs exactly those files after the build
// (`test` has run all the others already, and without the data they check
// the same; issue #36). tests/real-data.test.mjs checks that no such file is
// missing.
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DATA_REQUIRED = process.env.DATA_TESTS === 'require';

// tools/shared/data/ has been built: the offline bundles then inline it.
export const SHARED_DATA = fileURLToPath(new URL('../tools/shared/data/', import.meta.url));
export const sharedDataBuilt = () => existsSync(SHARED_DATA) && readdirSync(SHARED_DATA).some(n => n.endsWith('.json'));

// The `skip` option of a test that needs `present`: the hint while it is
// missing, false (run, and fail on the missing file) when it is present or
// required.
export function skipWithout(present, hint) {
  return !present && !DATA_REQUIRED ? hint : false;
}
