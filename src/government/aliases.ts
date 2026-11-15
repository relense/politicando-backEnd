/**
 * Shorter names the press uses for members of the Government, keyed by their name on the
 * portal. The full name always counts; an alias counts only when the article also has
 * one of the `context` words or the full name, and never in an `exclude` phrase.
 *
 * "Montenegro" is also a country, written with an article ("o Montenegro", "no
 * Montenegro"); the Prime Minister is named without one ("Montenegro disse").
 */
export const GOVERNMENT_ALIASES: Readonly<
  Record<string, { withContext: string[]; context: RegExp; exclude?: RegExp }>
> = {
  "Luís Montenegro": {
    withContext: ["Montenegro"],
    context: /primeiro-ministro|Governo|PSD|executivo|São Bento/i,
    exclude: /(?<![\p{L}])(?:[Oo]|[DdNn]o|[Aa]o|[Pp]elo)\s+Montenegro(?![\p{L}])/gu,
  },
};
