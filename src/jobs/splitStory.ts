import { sql } from "drizzle-orm";
import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { splitStory } from "../stories/split.js";

/*
 * Moves articles that don't belong out of a story, into a new one kept apart from it for good
 * (the hourly job does this by itself for the cases it catches; see src/stories/split.ts):
 *
 *   npm run story:split -- <storyId> <articleId> [articleId…] [--apply]
 *   npm run story:split -- <storyId> --merge <oldStoryId> [--apply]
 *
 * `--merge` takes the articles a wrong join brought in (from story_merges). Without --apply it
 * only shows what would happen. On Render: node dist/jobs/splitStory.js <same arguments>.
 */
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const mergeAt = args.indexOf("--merge");
const mergeArg = mergeAt >= 0 ? args[mergeAt + 1] : undefined;
const [storyArg, ...articleArgs] = args.filter((a, i) => !a.startsWith("--") && (mergeAt < 0 || i !== mergeAt + 1));
const isId = (a: string | undefined) => a !== undefined && /^[1-9]\d{0,9}$/.test(a) && Number(a) <= 2_147_483_647;
if (!isId(storyArg) || (mergeAt >= 0 ? !isId(mergeArg) || articleArgs.length > 0 : articleArgs.length === 0 || !articleArgs.every(isId))) {
  console.error("Usage: npm run story:split -- <storyId> <articleId> [articleId…] [--apply]\n       npm run story:split -- <storyId> --merge <oldStoryId> [--apply]");
  process.exit(1);
}
const storyId = Number(storyArg);

class DryRun extends Error {}

const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('assign_stories'))`);
    let articleIds = articleArgs.map(Number);
    if (mergeArg) {
      const [merge] = (
        await tx.execute<{ into_id: number; article_ids: number[] | null }>(
          sql`select into_id, article_ids from story_merges where from_id = ${Number(mergeArg)}`,
        )
      ).rows;
      if (!merge) throw new Error(`Story ${mergeArg} was never joined into another`);
      if (merge.into_id !== storyId) throw new Error(`Story ${mergeArg} was joined into ${merge.into_id}, not ${storyId}`);
      if (!merge.article_ids?.length) throw new Error(`The join of ${mergeArg} predates keeping its articles: list them by hand`);
      // Some may have left the story since (the hourly check, an earlier split): split the rest.
      const still = await tx.execute<{ id: number }>(
        sql`select id from articles where story_id = ${storyId} and id = any(${`{${merge.article_ids.join(",")}}`}::integer[])`,
      );
      articleIds = still.rows.map((r) => r.id);
      const gone = merge.article_ids.filter((id) => !articleIds.includes(id));
      if (gone.length) console.log(`No longer in story ${storyId}, left out: ${gone.join(", ")}`);
      if (articleIds.length === 0) throw new Error(`None of the articles of that join are in story ${storyId} any more`);
    }
    const result = await splitStory(tx, storyId, articleIds, "manual");
    console.log(
      JSON.stringify({
        story: storyId,
        // The id is only known once saved: a dry run uses one up that the real run won't get.
        newStory: apply ? result.id : "(given on --apply)",
        moved: result.moved,
        leftVisible: result.left,
        redirected: result.redirected,
      }),
    );
    if (!apply) throw new DryRun();
  });
  console.log("Applied.");
} catch (error) {
  if (error instanceof DryRun) console.log("Dry run: nothing was saved. Add --apply to save.");
  else {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
