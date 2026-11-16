import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type FlatRing, inverseTm, type Point, PROJECTIONS, simplifyRing, type TmProjection } from "../places/geo.js";
import { MUNICIPALITY_SHAPES_FILE, type ShapeFile } from "../places/locate.js";

/*
 * Builds data/municipalities.json, the simplified municipality outlines that GET /places/locate
 * uses, from DGT's official boundaries (CAOP 2024, open data). The frontend's maps use the same
 * source. Run it once, again only when CAOP changes:
 *
 *   1. Download and unzip into one folder:
 *        https://geo2.dgterritorio.gov.pt/caop/CAOP_Continente_2024-gpkg.zip
 *        https://geo2.dgterritorio.gov.pt/caop/CAOP_RAA_2024-gpkg.zip
 *        https://geo2.dgterritorio.gov.pt/caop/CAOP_RAM_2024-gpkg.zip
 *   2. npm run places:shapes -- <that folder>
 */

/** Simplification tolerance in metres, applied before converting to degrees. */
const TOLERANCE_M = 30;
/** Decimal places kept: 4 is about 10 metres. */
const DECIMALS = 4;

const folder = process.argv[2];
if (!folder) throw new Error("Usage: npm run places:shapes -- <folder with the CAOP .gpkg files>");

// A GeoPackage geometry is a GPKG header, then standard WKB (multi)polygons.
const readWkb = (buffer: Buffer, offset: number): { polygons: Point[][][]; end: number } => {
  const little = buffer[offset] === 1;
  const u32 = (at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const f64 = (at: number) => (little ? buffer.readDoubleLE(at) : buffer.readDoubleBE(at));
  const raw = u32(offset + 1);
  const type = raw % 1000;
  const dims = raw >= 3000 ? 4 : raw >= 1000 ? 3 : 2;
  let at = offset + 5;
  const ring = () => {
    const n = u32(at);
    at += 4;
    const points: Point[] = [];
    for (let i = 0; i < n; i++, at += 8 * dims) points.push([f64(at), f64(at + 8)]);
    return points;
  };
  const polygon = () => {
    const n = u32(at);
    at += 4;
    return Array.from({ length: n }, ring);
  };
  if (type === 3) return { polygons: [polygon()], end: at };
  if (type === 6) {
    const n = u32(at);
    at += 4;
    const polygons: Point[][][] = [];
    for (let i = 0; i < n; i++) {
      const part = readWkb(buffer, at);
      polygons.push(...part.polygons);
      at = part.end;
    }
    return { polygons, end: at };
  }
  throw new Error(`Unexpected geometry type ${raw}`);
};

const readGeometry = (blob: Uint8Array) => {
  const buffer = Buffer.from(blob);
  if (buffer.toString("ascii", 0, 2) !== "GP") throw new Error("Not a GeoPackage geometry");
  const envelope = [0, 32, 48, 48, 64][(buffer[3]! >> 1) & 7]!;
  return readWkb(buffer, 8 + envelope).polygons;
};

const files = readdirSync(folder).filter((name) => name.endsWith(".gpkg"));
const SOURCES: [RegExp, TmProjection][] = [
  [/^Continente/, PROJECTIONS.mainland],
  [/Acores_GCentral/, PROJECTIONS.utm26],
  [/Acores_GOcidental/, PROJECTIONS.utm25],
  [/Madeira/, PROJECTIONS.utm28],
];

const round = (value: number) => Number(value.toFixed(DECIMALS));
const out: ShapeFile = { source: "CAOP 2024, Direção-Geral do Território", municipalities: {} };
let points = 0;

for (const [pattern, projection] of SOURCES) {
  const file = files.find((name) => pattern.test(name));
  if (!file) throw new Error(`Missing ${pattern} in ${folder}`);
  const db = new DatabaseSync(join(folder, file), { readOnly: true });
  const { table_name: table } = db
    .prepare("select table_name from gpkg_geometry_columns where table_name like '%municipios'")
    .get() as { table_name: string };
  const rows = db.prepare(`select dtmn, municipio, geom from "${table}"`).all() as { dtmn: string; municipio: string; geom: Uint8Array }[];
  db.close();
  for (const row of rows) {
    const rings: FlatRing[] = [];
    for (const polygon of readGeometry(row.geom)) {
      for (const ring of polygon) {
        // Simplify in metres, where the tolerance means the same everywhere, then convert.
        const simple = simplifyRing(ring, TOLERANCE_M);
        rings.push(simple.flatMap(([x, y]) => inverseTm(projection, x, y).map(round)));
        points += simple.length;
      }
    }
    const lons = rings.flatMap((r) => r.filter((_, i) => i % 2 === 0));
    const lats = rings.flatMap((r) => r.filter((_, i) => i % 2 === 1));
    out.municipalities[row.dtmn] = {
      name: row.municipio,
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      rings,
    };
  }
}

writeFileSync(MUNICIPALITY_SHAPES_FILE, JSON.stringify(out));
console.log({ municipalities: Object.keys(out.municipalities).length, points, file: MUNICIPALITY_SHAPES_FILE.pathname });
