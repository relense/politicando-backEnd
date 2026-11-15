import { eq } from "drizzle-orm";
import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { contractImports } from "../db/schema.js";
import { contractFileRecords, fetchContractFiles, importContracts } from "../contracts/import.js";

/*
 * Imports public contracts from BASE's open data (one file per year, regenerated weekly).
 * Run it weekly from the host's cron; it re-imports the current and previous year, since
 * contracts are often published months after they are signed.
 *
 *   npm run contracts:import                  this year and last year
 *   npm run contracts:import -- 2019 2020     those years
 *   npm run contracts:import -- --from=2012   every year since 2012 (about 2 million contracts)
 *   npm run contracts:import -- --refresh     re-import files even if they haven't changed
 *
 * Needs the `unzip` command on the host.
 */
const args = process.argv.slice(2);
const thisYear = new Date().getFullYear();
const from = Number(args.find((a) => a.startsWith("--from="))?.slice(7) ?? NaN);
const listed = args.filter((a) => /^\d{4}$/.test(a)).map(Number);
const years = new Set(
  listed.length > 0
    ? listed
    : Number.isInteger(from)
      ? Array.from({ length: thisYear - from + 1 }, (_, i) => from + i)
      : [thisYear - 1, thisYear],
);

const config = loadDatabaseConfig();
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const files = (await fetchContractFiles()).filter((f) => years.has(f.year)).sort((a, b) => a.year - b.year);
  const missing = [...years].filter((y) => !files.some((f) => f.year === y));
  if (missing.length > 0) console.warn(`No file for ${missing.join(", ")}`);

  for (const file of files) {
    const [previous] = await db.select().from(contractImports).where(eq(contractImports.year, file.year));
    if (previous?.sourceModified === file.modified && !args.includes("--refresh")) {
      console.log(`${file.year}: unchanged since ${file.modified}, skipped`);
      continue;
    }
    const started = Date.now();
    let stats;
    try {
      stats = await importContracts(db, contractFileRecords(file.url), {
        onProgress: (s) => s.imported % 50_000 === 0 && console.log(`${file.year}: ${s.imported} contracts`),
      });
    } catch (error) {
      // One year failing (the download, usually) shouldn't stop the others; next week retries it.
      console.error(`${file.year}: failed`, error);
      process.exitCode = 1;
      continue;
    }
    await db
      .insert(contractImports)
      .values({ year: file.year, sourceModified: file.modified, contracts: stats.imported })
      .onConflictDoUpdate({
        target: contractImports.year,
        set: { sourceModified: file.modified, contracts: stats.imported, importedAt: new Date() },
      });
    console.log(JSON.stringify({ year: file.year, ...stats, seconds: Math.round((Date.now() - started) / 1000) }));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
