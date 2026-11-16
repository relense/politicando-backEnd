import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadDatabaseConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { parseMarkdownPost, saveMarkdownPosts } from "../editorial/markdownFiles.js";

/*
 * Publishes editorial posts written as Markdown files (see src/editorial/markdownFiles.ts).
 * Re-running it updates the posts with the same slug.
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
    posts.push(parseMarkdownPost(await readFile(file, "utf8")));
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const { db, pool } = createDb(loadDatabaseConfig().DATABASE_URL);
try {
  for (const post of await saveMarkdownPosts(db, posts, { authorName, publish: !draft })) {
    console.log(JSON.stringify({ ...post, status: draft ? "draft" : "published" }));
  }
} catch (error) {
  console.error("Editorial import failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
