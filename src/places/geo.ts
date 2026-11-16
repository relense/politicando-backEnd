/*
 * Small geometry helpers for finding the municipality a point is in, with no GIS dependency.
 * CAOP is projected (Transverse Mercator on GRS 1980); the build script turns it into degrees
 * with `inverseTm`, and lookups are plain even-odd point-in-polygon tests on lon/lat.
 */

export interface TmProjection {
  /** Latitude of origin and central meridian, in degrees. */
  lat0: number;
  lon0: number;
  k0: number;
  falseEasting: number;
  falseNorthing: number;
}

// GRS 1980 (ETRS89 and PTRA08 use it; the datums differ by centimetres, which is nothing here).
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const EP2 = E2 / (1 - E2);
const E4 = E2 * E2;
const E6 = E4 * E2;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Meridian arc length from the equator to latitude phi (radians). */
const meridian = (phi: number) =>
  A *
  ((1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256) * phi -
    ((3 * E2) / 8 + (3 * E4) / 32 + (45 * E6) / 1024) * Math.sin(2 * phi) +
    ((15 * E4) / 256 + (45 * E6) / 1024) * Math.sin(4 * phi) -
    ((35 * E6) / 3072) * Math.sin(6 * phi));

/** Projected metres to [lon, lat] in degrees (Snyder, "Map Projections: A Working Manual", 8-5 to 8-12). */
export const inverseTm = (p: TmProjection, x: number, y: number): [number, number] => {
  const m = meridian(rad(p.lat0)) + (y - p.falseNorthing) / p.k0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const c1 = EP2 * cos1 * cos1;
  const t1 = Math.tan(phi1) ** 2;
  const n1 = A / Math.sqrt(1 - E2 * sin1 * sin1);
  const r1 = (A * (1 - E2)) / (1 - E2 * sin1 * sin1) ** 1.5;
  const d = (x - p.falseEasting) / (n1 * p.k0);
  const phi =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lambda =
    (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5) / 120) / cos1;
  return [p.lon0 + deg(lambda), deg(phi)];
};

/** CAOP 2024's projections. */
export const PROJECTIONS = {
  /** Mainland: ETRS89 / Portugal TM06 (EPSG:3763). */
  mainland: { lat0: 39.6682583333333, lon0: -8.13310833333333, k0: 1, falseEasting: 0, falseNorthing: 0 },
  /** PTRA08 / UTM 25N, 26N and 28N: western Azores, central and eastern Azores, Madeira. */
  utm25: { lat0: 0, lon0: -33, k0: 0.9996, falseEasting: 500_000, falseNorthing: 0 },
  utm26: { lat0: 0, lon0: -27, k0: 0.9996, falseEasting: 500_000, falseNorthing: 0 },
  utm28: { lat0: 0, lon0: -15, k0: 0.9996, falseEasting: 500_000, falseNorthing: 0 },
} satisfies Record<string, TmProjection>;

export type Point = [number, number];
/** A ring as [lon0, lat0, lon1, lat1, …]: compact to store. The last point joins back to the first. */
export type FlatRing = number[];

/** Douglas–Peucker on one closed ring. Keeps at least 4 points so the ring stays a polygon. */
export const simplifyRing = (ring: Point[], tolerance: number): Point[] => {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(ring[i]!, ring[first]!, ring[last]!);
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
};

/** Distance from p to the segment a–b, in the units of the coordinates. */
export const segmentDistance = ([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) => {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** Even-odd test over every ring of a shape, so holes (enclaves) count as outside. */
export const contains = (rings: FlatRing[], lon: number, lat: number) => {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[2 * i]!;
      const yi = ring[2 * i + 1]!;
      const xj = ring[2 * j]!;
      const yj = ring[2 * j + 1]!;
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
};

/** Distance in metres from a point to the nearest edge of a shape (flat-earth, fine for a few km). */
export const distanceToEdge = (rings: FlatRing[], lon: number, lat: number) => {
  const kx = 111_320 * Math.cos(rad(lat));
  const ky = 110_574;
  let best = Infinity;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const d = segmentDistance(
        [lon * kx, lat * ky],
        [ring[2 * j]! * kx, ring[2 * j + 1]! * ky],
        [ring[2 * i]! * kx, ring[2 * i + 1]! * ky],
      );
      if (d < best) best = d;
    }
  }
  return best;
};
