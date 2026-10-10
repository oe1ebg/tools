// The tests of the generated data (callsign and repeater lists, location
// gold set, basemap, …) and of the build's Python skip themselves when that
// isn't there, so `just test` works on a fresh checkout. Where the data has
// just been built (ci.yml `bundle`, release.yml, data.yml) they run with
// DATA_TESTS=require: then missing data is a failure, never a skip (like
// ADIF_CROSSCHECK=require for the ADIF cross-checks).
export const DATA_REQUIRED = process.env.DATA_TESTS === 'require';

// The `skip` option of a test that needs `present`: the hint while it is
// missing, false (run, and fail on the missing file) when it is present or
// required.
export function skipWithout(present, hint) {
  return !present && !DATA_REQUIRED ? hint : false;
}
