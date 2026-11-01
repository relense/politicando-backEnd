export interface SourceArticle {
  sourceUri: string;
  title: string;
  content: string;
  url: string;
  source: string;
  imageUrl: string | null;
  publishedAt: Date;
}

export interface NewsPage {
  articles: SourceArticle[];
  /** Results on this page that were dropped because they failed validation. */
  malformed: number;
  totalPages: number;
}

export interface NewsSource {
  /** Dates are inclusive, in YYYY-MM-DD form. Throws if the page can't be fetched. */
  fetchPage(request: { dateStart: string; dateEnd: string; page: number }): Promise<NewsPage>;
}
