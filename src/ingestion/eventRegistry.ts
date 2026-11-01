import { z } from "zod";
import type { NewsPage, NewsSource, SourceArticle } from "./newsSource.js";

export const NEWS_SOURCES = [
  "publico.pt",
  "rtp.pt",
  "sicnoticias.sapo.pt",
  "expresso.sapo.pt",
  "dn.pt",
  "observador.pt",
  "eco.pt",
  "sabado.pt",
  "noticiasaominuto.com",
  "jornaldenegocios.pt",
  "tsf.pt",
];

const ENDPOINT = "https://eventregistry.org/api/v1/article/getArticles";
const ARTICLES_PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

const responseSchema = z.object({
  articles: z.object({
    results: z.array(z.unknown()),
    pages: z.number().int().nonnegative(),
  }),
});

const articleSchema = z
  .object({
    uri: z.coerce.string().min(1),
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    url: z.string().url(),
    dateTime: z.iso.datetime({ offset: true }),
    source: z.object({ uri: z.string().min(1) }),
    image: z.string().url().nullish(),
  })
  .transform(
    (article): SourceArticle => ({
      sourceUri: article.uri,
      title: article.title,
      content: article.body,
      url: article.url,
      source: article.source.uri,
      imageUrl: article.image ?? null,
      publishedAt: new Date(article.dateTime),
    }),
  );

class RetryableError extends Error {}

export interface EventRegistryOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  retryDelayMs?: number;
}

export const createEventRegistrySource = ({
  apiKey,
  fetch: fetchImpl = globalThis.fetch,
  retryDelayMs = 1_000,
}: EventRegistryOptions): NewsSource => {
  const request = async (body: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new RetryableError(`Event Registry request failed: ${String(error)}`);
    }
    // The body and URL are left out of errors so the API key can't reach the logs.
    const message = `Event Registry responded with HTTP ${response.status}`;
    if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
    if (!response.ok) throw new Error(message);
    return response.json();
  };

  const requestWithRetry = async (body: unknown): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request(body);
      } catch (error) {
        if (!(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
      }
    }
  };

  return {
    async fetchPage({ dateStart, dateEnd, page }): Promise<NewsPage> {
      const json = await requestWithRetry({
        apiKey,
        resultType: "articles",
        dataType: ["news"],
        articlesPage: page,
        articlesCount: ARTICLES_PER_PAGE,
        articlesSortBy: "date",
        articleBodyLen: -1,
        includeArticleImage: true,
        query: {
          $query: {
            $and: [
              { $or: NEWS_SOURCES.map((sourceUri) => ({ sourceUri })) },
              { dateStart, dateEnd, lang: "por" },
            ],
          },
        },
      });

      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error("Event Registry returned an unexpected response format");
      }

      const articles: SourceArticle[] = [];
      let malformed = 0;
      for (const result of parsed.data.articles.results) {
        const article = articleSchema.safeParse(result);
        if (article.success) articles.push(article.data);
        else malformed++;
      }
      return { articles, malformed, totalPages: parsed.data.articles.pages };
    },
  };
};
