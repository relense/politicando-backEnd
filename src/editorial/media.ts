/*
 * Media embeds for editorial posts, from an allow-list of providers. We return the provider's
 * own embed URL so the frontend never builds iframes from arbitrary input.
 */

export interface Media {
  provider: "youtube" | "vimeo" | "spotify" | "soundcloud" | "apple_podcasts";
  url: string;
  embedUrl: string;
}

export const parseMedia = (raw: string): Media | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^(www|m)\./, "");
  const path = url.pathname;

  if (host === "youtube.com" || host === "youtu.be") {
    const id =
      host === "youtu.be" ? path.slice(1) : url.searchParams.get("v") ?? /^\/(?:embed|shorts|live)\/([^/]+)/.exec(path)?.[1] ?? "";
    return /^[\w-]{11}$/.test(id) ? { provider: "youtube", url: raw, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` } : null;
  }
  if (host === "vimeo.com") {
    const id = /^\/(\d+)/.exec(path)?.[1];
    return id ? { provider: "vimeo", url: raw, embedUrl: `https://player.vimeo.com/video/${id}` } : null;
  }
  if (host === "open.spotify.com") {
    const match = /^\/(episode|show|track|album|playlist)\/([A-Za-z0-9]+)/.exec(path);
    return match ? { provider: "spotify", url: raw, embedUrl: `https://open.spotify.com/embed/${match[1]}/${match[2]}` } : null;
  }
  if (host === "soundcloud.com") {
    return /^\/[\w-]+\/[\w-]+/.test(path)
      ? { provider: "soundcloud", url: raw, embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com${path}`)}` }
      : null;
  }
  if (host === "podcasts.apple.com") {
    return /\/podcast\//.test(path) ? { provider: "apple_podcasts", url: raw, embedUrl: `https://embed.podcasts.apple.com${path}${url.search}` } : null;
  }
  return null;
};

/** "Orçamento do Estado: o que muda?" → "orcamento-do-estado-o-que-muda" */
export const slugify = (title: string) =>
  title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "") || "post";
