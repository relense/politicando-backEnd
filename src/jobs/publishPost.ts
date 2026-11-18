import { readFile } from "node:fs/promises";

/*
 * Publishes an article.md to the live site through the API (POST /api/v2/publish):
 *
 *   npm run editorial:publish -- path/to/article.md            publish (or update, by slug)
 *   npm run editorial:publish -- path/to/article.md --draft    store without publishing
 *
 * Needs PUBLISH_API_KEY in .env (one of the keys in the API's PUBLISH_API_KEYS). Goes to
 * https://api.politicando.pt unless PUBLISH_API_URL says otherwise (e.g. http://localhost:4000).
 */

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const key = process.env.PUBLISH_API_KEY;
const api = (process.env.PUBLISH_API_URL || "https://api.politicando.pt").replace(/\/$/, "");
if (!file || !key) {
  console.error(!file ? "Usage: npm run editorial:publish -- <article.md> [--draft]" : "Set PUBLISH_API_KEY in .env");
  process.exit(1);
}

const response = await fetch(`${api}/api/v2/publish`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({ markdown: await readFile(file, "utf8"), draft: args.includes("--draft") }),
});
type Answer = { slug: string; status: string; created: boolean; changed: boolean; url: string; error?: { message: string } };
const body = (await response.json().catch(() => null)) as Answer | null;
if (!response.ok) {
  console.error(`Failed (${response.status}):`, body?.error?.message ?? body);
  process.exit(1);
}
if (!body) process.exit(1);
console.log(body.changed ? `${body.created ? "Published" : "Updated"} (${body.status}): ${body.url}` : `Already up to date: ${body.url}`);
