import { writeFile } from "node:fs/promises";
import { USER_AGENT } from "../ingestion/politeClient.js";
import { parseElectedSheet, type LocalElectedFile } from "../places/localElected.js";
import { readFirstSheet, unzip } from "../elections/xlsx.js";

/*
 * Builds data/autarquicas-2025-eleitos.json, the names of everyone elected in the autárquicas
 * of 12 October 2025, from the spreadsheets of the CNE's official results map (Mapa Oficial
 * n.º 2-B/2025, with its rectifications). Run it once, and again when the CNE publishes a new
 * rectification (update AS_OF); commit the file and the seed loads it on deploy.
 *
 *   npm run local-elected:fetch
 */

const ZIP_URL = "https://www.cne.pt/sites/default/files/dl/eleicoes/2025_al/docs_geral/2025al-mapa-oficial_retificado.zip";
const SHEET = /mapa_3_eleitos[^/]*\.xlsx$/;
/** The latest rectification included (Declaração de Retificação n.º 14/2026/1). */
const AS_OF = "2026-08-06";
const OUT = new URL("../../data/autarquicas-2025-eleitos.json", import.meta.url);

const response = await fetch(ZIP_URL, { headers: { "User-Agent": USER_AGENT } });
if (!response.ok) throw new Error(`CNE answered ${response.status} for ${ZIP_URL}`);
const files = unzip(Buffer.from(await response.arrayBuffer()));
const name = [...files.keys()].find((f) => SHEET.test(f));
if (!name) throw new Error(`No "eleitos" sheet in the zip: ${[...files.keys()].join(", ")}`);

const bodies = parseElectedSheet(readFirstSheet(files.get(name)!));
const file: LocalElectedFile = {
  election: "autarquicas-2025",
  source: { name: "CNE, Mapa Oficial n.º 2-B/2025", url: "https://www.cne.pt/content/eleicoes-autarquicas-2025", asOf: AS_OF },
  bodies,
};
// One body per line: readable diffs when a rectification changes a few names.
const json = `{\n"election": ${JSON.stringify(file.election)},\n"source": ${JSON.stringify(file.source)},\n"bodies": [\n${bodies.map((b) => JSON.stringify(b)).join(",\n")}\n]\n}\n`;
await writeFile(OUT, json);
const count = (organ: string) => bodies.filter((b) => b.organ === organ).length;
console.log(JSON.stringify({ sheet: name, CM: count("CM"), AM: count("AM"), AF: count("AF") }));
