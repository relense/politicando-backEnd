import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { editorialPosts } from "../db/schema.js";
import { editorialInputSchema } from "../modules/editorial/routes.js";

/*
 * Editorial posts written as Markdown files with a front matter block, e.g. from the research
 * folder:
 *
 *   ---
 *   slug: metodo-de-hondt-explicado
 *   kind: article
 *   title: "Método de Hondt: ..."
 *   subtitle: "..."
 *   tags: [eleições, explicador]
 *   featured: true        # optional: a front-page pick (false takes it off; absent leaves it as is)
 *   ---
 *   Body in Markdown.
 *
 * Only files with a `slug` are blog posts: anything else in the folder (internal write-ups,
 * posts for other sites) is skipped. Unknown keys (publish dates, notes) are ignored. Before storing, the body loses what is meant
 * for us, not readers: a leading "# Title" repeating the title, "> **Nota de edição:**" blocks,
 * and sections still waiting to be written ("*[A preencher ...]*").
 */

export interface MarkdownPost {
  slug: string;
  kind: "article" | "opinion" | "podcast" | "interview" | "video";
  title: string;
  subtitle: string | null;
  body: string;
  tags: string[];
  coverImageUrl: string | null;
  mediaUrl: string | null;
  /** Null when the file doesn't say, so a choice made in the admin stays. */
  featured: boolean | null;
}

const unquote = (value: string) => {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1).replace(/\\"/g, '"');
  return v.replace(/\s+#.*$/, "").trim();
};

/** The flat key: value subset of YAML that front matter uses here (strings and [a, b] lists). */
export const parseFrontMatter = (text: string): { meta: Record<string, string | string[]>; body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2]!.trim();
    meta[kv[1]!] = raw.startsWith("[") && raw.endsWith("]")
      ? raw.slice(1, -1).split(",").map(unquote).filter(Boolean)
      : unquote(raw);
  }
  return { meta, body: text.slice(match[0].length) };
};

/** Removes the parts of a draft meant for the editors. */
export const cleanBody = (body: string, title: string) => {
  let text = body.replace(/^\s*#\s+(.+)\n/, (line, heading: string) => (heading.trim() === title.trim() ? "" : line));
  // "> **Nota de edição:** ..." blocks, however many lines they run to.
  text = text.replace(/^>\s*\*\*Nota de edi[çc][ãa]o[^\n]*(\n>[^\n]*)*\n*/gim, "");
  // Sections not written yet: a "## " heading whose section holds an "[A preencher ...]" marker.
  const sections = text.split(/(?=^## )/m);
  text = sections.filter((s) => !/^## /.test(s) || !/\[A preencher\b/i.test(s)).join("");
  return text.replace(/\n{3,}/g, "\n\n").trim() + "\n";
};

const str = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : null);

/** Reads one file's text into a post; null if it isn't one (no slug). Throws saying what's wrong otherwise. */
export const parseMarkdownPost = (text: string): MarkdownPost | null => {
  const { meta, body } = parseFrontMatter(text);
  const slug = str(meta.slug);
  if (!slug) return null;
  const title = str(meta.title);
  if (!title) throw new Error("no title in the front matter");
  const tags = Array.isArray(meta.tags) ? meta.tags : str(meta.tags)?.split(",") ?? [];
  const input = editorialInputSchema.parse({
    title,
    subtitle: str(meta.subtitle),
    slug,
    kind: str(meta.kind) ?? "article",
    body: cleanBody(body, title),
    authorName: null,
    coverImageUrl: str(meta.cover_image_url) ?? str(meta.cover),
    mediaUrl: str(meta.media_url),
    tags: tags.map((t) => t.trim()).filter(Boolean),
  });
  const featured = str(meta.featured)?.toLowerCase();
  if (featured !== undefined && featured !== "true" && featured !== "false") throw new Error(`featured must be true or false, not "${featured}"`);
  const { authorName: _byline, ...fields } = input;
  return { ...fields, slug: input.slug!, tags: [...new Set(input.tags)], featured: featured === undefined ? null : featured === "true" };
};

/**
 * Stores posts by slug: new ones are created, existing ones get the new text. Publishing keeps
 * the first publication date. Featured changes only when the file says so; drafts are never featured.
 *
 * A draft never touches a live post (its text would go live at once): unpublish first. With
 * `fromRepo` (the deploy's import of content/editorial), a post someone took down stays down and
 * keeps its byline; the file only updates posts that are live.
 */
export const saveMarkdownPosts = async (
  db: Db,
  posts: MarkdownPost[],
  { authorName, publish, fromRepo = false, now = new Date() }: { authorName: string; publish: boolean; fromRepo?: boolean; now?: Date },
) => {
  const saved: { slug: string; created: boolean; changed: boolean }[] = [];
  for (const post of posts) {
    const [row] = await db
      .insert(editorialPosts)
      .values({
        ...post, featured: publish && post.featured === true, authorName,
        status: publish ? "published" : "draft", publishedAt: publish ? now : null, createdAt: now, updatedAt: now,
      })
      .onConflictDoUpdate({
        target: editorialPosts.slug,
        set: {
          kind: post.kind, title: post.title, subtitle: post.subtitle, body: post.body, tags: post.tags,
          coverImageUrl: post.coverImageUrl, mediaUrl: post.mediaUrl, ...(!fromRepo && { authorName }), updatedAt: now,
          ...(publish && { status: "published" as const, publishedAt: sql`coalesce(${editorialPosts.publishedAt}, ${now.toISOString()}::timestamptz)` }),
          ...(post.featured !== null && { featured: publish && post.featured }),
        },
        // Unchanged posts keep their dates, so re-importing (each deploy) doesn't look like an edit.
        setWhere: sql`${
          fromRepo ? sql`${editorialPosts.status} = 'published'` : publish ? sql`true` : sql`${editorialPosts.status} <> 'published'`
        } and (
          (${editorialPosts.kind}, ${editorialPosts.title}, ${editorialPosts.subtitle}, ${editorialPosts.body}, ${editorialPosts.tags},
            ${editorialPosts.coverImageUrl}, ${editorialPosts.mediaUrl}${fromRepo ? sql`` : sql`, ${editorialPosts.authorName}`})
          is distinct from (excluded.kind, excluded.title, excluded.subtitle, excluded.body, excluded.tags,
            excluded.cover_image_url, excluded.media_url${fromRepo ? sql`` : sql`, excluded.author_name`})
          ${publish && !fromRepo ? sql`or ${editorialPosts.status} <> 'published'` : sql``}
          ${post.featured !== null ? sql`or ${editorialPosts.featured} is distinct from ${publish && post.featured}` : sql``})`,
      })
      .returning({ slug: editorialPosts.slug, created: sql<boolean>`${editorialPosts.createdAt} = ${now.toISOString()}::timestamptz` });
    saved.push(row ? { ...row, changed: true } : { slug: post.slug, created: false, changed: false });
  }
  return saved;
};

/** Blog posts kept in this repo: published on every deploy (the seed), until the admin screen takes over. */
export const CONTENT_DIR = "content/editorial";

export const importContentPosts = async (db: Db, dir = CONTENT_DIR) => {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const posts: MarkdownPost[] = [];
  for (const name of names) {
    try {
      const post = parseMarkdownPost(await readFile(join(dir, name), "utf8"));
      if (post) posts.push(post);
    } catch (error) {
      throw new Error(`${join(dir, name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return saveMarkdownPosts(db, posts, { authorName: "Redação Politicando", publish: true, fromRepo: true });
};
