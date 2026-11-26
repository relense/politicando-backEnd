import { XMLParser } from "fast-xml-parser";
import { inflateRawSync } from "node:zlib";

/*
 * Just enough of zip and xlsx to read the CNE's official map spreadsheets: the files in a zip
 * (stored or deflated), and one worksheet as rows of text cells. No formulas, styles or dates.
 */

/** Every file in a zip archive, by its path inside it. */
export const unzip = (zip: Buffer): Map<string, Buffer> => {
  // The end of central directory record: 22 bytes plus a comment of up to 64 KiB, at the end.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip file");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("Broken zip central directory");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`Broken zip entry: ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`Unsupported zip compression ${method} for ${name}`);
  }
  return files;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => ["si", "r", "row", "c"].includes(name),
});

type Node = Record<string, unknown>;
const text = (node: unknown): string => {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const n = node as Node;
  if ("#text" in n) return String(n["#text"]);
  return "";
};

/** "C12" → 2 (columns from 0). */
const columnOf = (ref: string) => {
  let col = 0;
  for (const ch of ref.replace(/\d+$/, "")) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
};

/** The first worksheet of an xlsx file, as rows of cells (text, trimmed; null when empty). */
export const readFirstSheet = (xlsx: Buffer): (string | null)[][] => {
  const files = unzip(xlsx);
  const shared: string[] = [];
  const strings = files.get("xl/sharedStrings.xml");
  if (strings) {
    const sst = (parser.parse(strings.toString("utf8")) as Node).sst as Node | undefined;
    for (const si of (sst?.si as Node[] | undefined) ?? []) {
      // Plain (<t>) or rich text (<r><t>…</t></r>…).
      shared.push(si.t !== undefined ? text(si.t) : ((si.r as Node[] | undefined) ?? []).map((r) => text(r.t)).join(""));
    }
  }
  const sheet = files.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("No first worksheet in the xlsx file");
  const worksheet = (parser.parse(sheet.toString("utf8")) as Node).worksheet as Node;
  const rows = (((worksheet.sheetData as Node | undefined)?.row as Node[] | undefined) ?? []);
  const out: (string | null)[][] = [];
  for (const row of rows) {
    const index = Number(row.r) - 1;
    while (out.length < index) out.push([]);
    const cells: (string | null)[] = [];
    for (const c of (row.c as Node[] | undefined) ?? []) {
      const col = columnOf(String(c.r));
      const raw = c.t === "s" ? shared[Number(text(c.v))] : c.t === "inlineStr" ? text((c.is as Node | undefined)?.t) : text(c.v);
      const value = raw?.trim() ?? "";
      while (cells.length < col) cells.push(null);
      cells[col] = value === "" ? null : value;
    }
    out.push(cells);
  }
  return out;
};
