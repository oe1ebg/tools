// Spatial helpers: a uniform grid index over the address points (no O(n) scans for nearest / in-box queries).

import { distanceMeters } from '../geo.js';

// Cells of ~250 m at Vienna's latitude.
const CELL_LAT = 0.00225, CELL_LON = 0.0034;

export function buildGrid(lat, lon) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    if (lat[i] < minLat) minLat = lat[i];
    if (lat[i] > maxLat) maxLat = lat[i];
    if (lon[i] < minLon) minLon = lon[i];
    if (lon[i] > maxLon) maxLon = lon[i];
  }
  const rows = Math.floor((maxLat - minLat) / CELL_LAT) + 1;
  const cols = Math.floor((maxLon - minLon) / CELL_LON) + 1;
  const cellOf = new Int32Array(lat.length);
  const start = new Int32Array(rows * cols + 1);
  for (let i = 0; i < lat.length; i++) {
    const c = Math.floor((lat[i] - minLat) / CELL_LAT) * cols + Math.floor((lon[i] - minLon) / CELL_LON);
    cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < rows * cols; c++) start[c + 1] += start[c];
  const items = new Int32Array(lat.length);
  const fill = start.slice(0, rows * cols);
  for (let i = 0; i < lat.length; i++) items[fill[cellOf[i]]++] = i;
  return { lat, lon, minLat, minLon, maxLat, maxLon, rows, cols, start, items };
}

function forCells(grid, r0, r1, c0, c1, fn) {
  r0 = Math.max(0, r0); c0 = Math.max(0, c0);
  r1 = Math.min(grid.rows - 1, r1); c1 = Math.min(grid.cols - 1, c1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = r * grid.cols + c;
      for (let k = grid.start[cell]; k < grid.start[cell + 1]; k++) fn(grid.items[k]);
    }
  }
}

// The k nearest points within maxMeters: [{ i, d }] sorted by distance.
export function nearestPoints(grid, lat, lon, k = 12, maxMeters = 1500) {
  const r = Math.floor((lat - grid.minLat) / CELL_LAT);
  const c = Math.floor((lon - grid.minLon) / CELL_LON);
  const maxRing = Math.ceil(maxMeters / 250) + 1;
  const found = [];
  for (let ring = 0; ring <= maxRing; ring++) {
    const before = found.length;
    // Only the cells on this ring's border.
    for (let rr = r - ring; rr <= r + ring; rr++) {
      const edge = rr === r - ring || rr === r + ring;
      for (let cc = c - ring; cc <= c + ring; cc += edge ? 1 : 2 * ring || 1) {
        forCells(grid, rr, rr, cc, cc, i => {
          const d = distanceMeters(lat, lon, grid.lat[i], grid.lon[i]);
          if (d <= maxMeters) found.push({ i, d });
        });
      }
    }
    // A ring at distance ring*~250 m can't beat what we have once we have k
    // points closer than that.
    if (found.length >= k && found.length >= before) {
      found.sort((a, b) => a.d - b.d);
      if (found[k - 1].d < ring * 230) break;
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, k);
}

// Calls fn(i) for every point inside the box.
export function pointsInBox(grid, south, west, north, east, fn) {
  if (north < grid.minLat || south > grid.maxLat || east < grid.minLon || west > grid.maxLon) return;
  forCells(grid,
    Math.floor((south - grid.minLat) / CELL_LAT), Math.floor((north - grid.minLat) / CELL_LAT),
    Math.floor((west - grid.minLon) / CELL_LON), Math.floor((east - grid.minLon) / CELL_LON),
    i => {
      const la = grid.lat[i], lo = grid.lon[i];
      if (la >= south && la < north && lo >= west && lo < east) fn(i);
    });
}
