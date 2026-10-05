// Great-circle (haversine) distance between two WGS84 points, on the IUGG
// mean Earth radius. Shared by the location lookup, the repeater search and
// the SOTA alerts map.

const EARTH_RADIUS_M = 6371008.8;
const toRad = d => (d * Math.PI) / 180;

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
