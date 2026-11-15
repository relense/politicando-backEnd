import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { contractParties, contracts, places } from "../db/schema.js";
import { overwriteAll } from "../db/upsert.js";
import { USER_AGENT } from "../ingestion/politeClient.js";
import { streamJsonArray } from "../parliament/openData.js";
import { CONTRACTS_DATASET, parseContract, parseResources, placeMatcher, type ParsedContract } from "./base.js";

const BATCH = 500;

export interface ContractStats {
  read: number;
  imported: number;
  /** Records without an id, date, price, object or procedure. */
  invalid: number;
  /** Contracts with places in Portugal we could not match to a municipality or district. */
  unplaced: number;
}

/** Stores contracts from a stream of BASE records, replacing any already stored with the same id. */
export const importContracts = async (
  db: Db,
  records: AsyncIterable<unknown>,
  { onProgress }: { onProgress?: (stats: ContractStats) => void } = {},
): Promise<ContractStats> => {
  const match = placeMatcher(
    await db.select({ key: places.key, name: places.name, level: places.level, parentKey: places.parentKey }).from(places),
  );
  const stats: ContractStats = { read: 0, imported: 0, invalid: 0, unplaced: 0 };
  let batch = new Map<string, ParsedContract>();

  const flush = async () => {
    if (batch.size === 0) return;
    const rows = [...batch.values()];
    batch = new Map();
    await db.transaction(async (tx) => {
      await tx
        .insert(contracts)
        .values(
          rows.map(({ parties, ...c }) => {
            const placeKeys = [...new Set(c.places.flatMap(match))];
            if (placeKeys.length === 0 && c.places.some((p) => /^portugal,/i.test(p))) stats.unplaced++;
            return { ...c, placeKeys, importedAt: new Date() };
          }),
        )
        .onConflictDoUpdate({ target: contracts.id, set: overwriteAll(contracts) });
      const ids = rows.map((r) => r.id);
      await tx.delete(contractParties).where(inArray(contractParties.contractId, ids));
      const parties = rows.flatMap((r) => r.parties.map((p) => ({ ...p, contractId: r.id })));
      for (let i = 0; i < parties.length; i += 2_000) await tx.insert(contractParties).values(parties.slice(i, i + 2_000));
    });
    stats.imported += rows.length;
    onProgress?.(stats);
  };

  for await (const record of records) {
    stats.read++;
    const contract = parseContract(record);
    if (!contract) {
      stats.invalid++;
      continue;
    }
    // A file can list the same contract twice; the later record wins.
    batch.set(contract.id, contract);
    if (batch.size >= BATCH) await flush();
  }
  await flush();
  return stats;
};

/** The yearly files on dados.gov.pt, with when each was last regenerated. */
export const fetchContractFiles = async (fetchImpl: typeof fetch = fetch) => {
  const url = `https://dados.gov.pt/api/1/datasets/${CONTRACTS_DATASET}/`;
  const response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return parseResources(await response.json());
};

/**
 * Downloads one yearly zip and streams the JSON array inside it. Uses the system's `unzip`
 * (the files are hundreds of MB unpacked, so they are never held in memory).
 */
export async function* contractFileRecords(url: string): AsyncIterable<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "base-contracts-"));
  try {
    const zip = join(dir, "contracts.zip");
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30 * 60_000) });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
        await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(zip));
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 30_000));
      }
    }

    const unzip = spawn("unzip", ["-p", zip], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    unzip.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve, reject) => {
      unzip.on("error", reject);
      unzip.on("close", resolve);
    });
    yield* streamJsonArray(unzip.stdout);
    const code = await exited;
    if (code !== 0) throw new Error(`unzip exited with ${code}: ${stderr.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
