import { syncAgenda } from "../agenda/sync.js";
import { loadParliamentConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { createOpenDataClient } from "../parliament/openData.js";
import { openVoteRounds } from "../predictions/rounds.js";
import { createRevalidator } from "../revalidate.js";

/** Imports the political calendar: the parliament's, the President's and the European Parliament's. */
const config = loadParliamentConfig();
const { db, pool } = createDb(config.DATABASE_URL);

try {
  const results = await syncAgenda(db, { parliament: createOpenDataClient({ legislature: config.PARLIAMENT_LEGISLATURE, timeoutMs: 60_000 }) });
  console.log(JSON.stringify(results));
  // Votes on the plenary agenda within the week open for "Passa ou chumba?", with a megathread.
  console.log(JSON.stringify({ voteRounds: await openVoteRounds(db) }));
  const failed = Object.entries(results).filter(([, r]) => r && typeof r === "object" && "error" in r);
  await createRevalidator()(["agenda", "predictions"]);
  for (const [source, r] of failed) console.error(`Agenda source ${source} failed: ${(r as { error: string }).error}`);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
