import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadDatabaseConfig } from "../config.js";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { editorialPosts } from "../db/schema.js";
import { parseMarkdownPost, saveMarkdownPosts } from "../editorial/markdownFiles.js";

/*
 * Publishes editorial posts written as Markdown files (see src/editorial/markdownFiles.ts).
 * Re-running it updates the posts with the same slug. Files without a slug are skipped.
 *
 *   npm run editorial:import -- ../politicando-research/articles      every .md in the folder
 *   npm run editorial:import -- a.md b.md                              just these
 *   npm run editorial:import -- <...> --draft                          store as drafts
 *   npm run editorial:import -- <...> --author="Nome"                  byline (default: Redação Politicando)
 */
const args = process.argv.slice(2);
const paths = args.filter((a) => !a.startsWith("--"));
const draft = args.includes("--draft");
const authorName = args.find((a) => a.startsWith("--author="))?.slice("--author=".length) || "Redação Politicando";
if (paths.length === 0) {
  console.error("Give a folder or .md files to import.");
  process.exit(1);
}

const files: string[] = [];
for (const path of paths) {
  if ((await stat(path)).isDirectory()) {
    files.push(...(await readdir(path)).filter((f) => f.endsWith(".md")).sort().map((f) => join(path, f)));
  } else files.push(path);
}

const posts = [];
for (const file of files) {
  try {
    const post = parseMarkdownPost(await readFile(file, "utf8"));
    if (post) posts.push(post);
    else console.log(JSON.stringify({ skipped: file, reason: "no slug: not a blog post" }));
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  const live = draft
    ? new Set((await db.select({ slug: editorialPosts.slug }).from(editorialPosts).where(eq(editorialPosts.status, "published"))).map((r) => r.slug))
    : new Set<string>();
  for (const post of await saveMarkdownPosts(db, posts, { authorName, publish: !draft })) {
    if (live.has(post.slug)) {
      // A draft never replaces a live post.
      console.error(`${post.slug} is live: not changed. Unpublish it first, or publish the change.`);
      process.exitCode = 1;
      continue;
    }
    console.log(JSON.stringify({ ...post, status: draft ? "draft" : "published" }));
  }
} catch (error) {
  console.error("Editorial import failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
