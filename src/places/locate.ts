import { readFileSync } from "node:fs";
import { contains, distanceToEdge, type FlatRing } from "./geo.js";

/** Built by `npm run places:shapes`. Resolves to <repo>/data both from src/ and from dist/. */
export const MUNICIPALITY_SHAPES_FILE = new URL("../../data/municipalities.json", import.meta.url);

export interface ShapeFile {
  source: string;
  /** Keyed by DICOFRE code ("1106" is Lisboa). */
  municipalities: Record<string, { name: string; bbox: [number, number, number, number]; rings: FlatRing[] }>;
}

/**
 * Points this close to a municipality but in none (on a beach, or in a sliver the simplified
 * outlines leave between neighbours) count as in the nearest one.
 */
const NEAR_M = 1_500;
/** About 1.5 km in degrees, to widen bounding boxes for the near search. */
const NEAR_DEG = 0.02;

let shapes: ShapeFile | null = null;
const load = () => (shapes ??= JSON.parse(readFileSync(MUNICIPALITY_SHAPES_FILE, "utf8")) as ShapeFile);

/** The DICOFRE code of the municipality at a point, or null outside Portugal. */
export const municipalityAt = (lat: number, lon: number, file: ShapeFile = load()): string | null => {
  let nearest: { code: string; distance: number } | null = null;
  for (const [code, { bbox, rings }] of Object.entries(file.municipalities)) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    if (lon < minLon - NEAR_DEG || lon > maxLon + NEAR_DEG || lat < minLat - NEAR_DEG || lat > maxLat + NEAR_DEG) continue;
    const inBox = lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    if (inBox && contains(rings, lon, lat)) return code;
    const distance = distanceToEdge(rings, lon, lat);
    if (distance <= NEAR_M && (!nearest || distance < nearest.distance)) nearest = { code, distance };
  }
  return nearest?.code ?? null;
};
