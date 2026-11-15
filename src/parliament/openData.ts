/**
 * Downloads files from the parliament's open data pages (parlamento.pt › Dados Abertos).
 * Download links carry tokens that change, so every run finds them from the pages:
 * dataset page → legislature folder → "<Name><Leg>_json.txt".
 */

const SITE = "https://www.parlamento.pt";
const USER_AGENT = "PoliticandoBot/1.0 (+https://github.com/relense/politicando-backEnd)";

export const DATASETS = {
  deputies: "DAInformacaoBase",
  biographies: "DARegistoBiografico",
  initiatives: "DAIniciativas",
} as const;

export type Dataset = keyof typeof DATASETS;

const decode = (href: string) => href.replace(/&amp;/g, "&");

export const findFolderLink = (html: string, legislature: string) => {
  const match = new RegExp(`title="Pasta ${legislature} Legislatura"[^>]*href="([^"]+)"`).exec(html);
  return match ? new URL(decode(match[1]!), SITE).href : null;
};

export const findJsonLink = (html: string) => {
  const match = /<a[^>]*href="([^"]+)"[^>]*>\s*[^<]*_json\.txt\s*<\/a>/.exec(html);
  return match ? new URL(decode(match[1]!), SITE).href : null;
};

export const createOpenDataClient = ({
  legislature,
  fetch: fetchImpl = fetch,
  timeoutMs = 120_000,
}: {
  legislature: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) => {
  const get = async (url: string) => {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.text();
  };

  return async (dataset: Dataset): Promise<unknown> => {
    const page = `${SITE}/Cidadania/Paginas/${DATASETS[dataset]}.aspx`;
    const folder = findFolderLink(await get(page), legislature);
    if (!folder) throw new Error(`No ${legislature} folder on ${page}`);
    const file = findJsonLink(await get(folder));
    if (!file) throw new Error(`No JSON file in the ${legislature} folder of ${page}`);
    return JSON.parse((await get(file)).replace(/^﻿/, ""));
  };
};
