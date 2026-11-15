/**
 * Presidents of the Republic, kept by hand: it changes every five or ten years and the
 * official site (presidencia.pt) doesn't publish the name or term in a structured way.
 * The sync reads the current President's biography and photo from the site and warns if
 * the biography stops matching the name here. Add the new President when one takes office.
 */
export interface President {
  id: string;
  name: string;
  fullName: string;
  /** Inauguration day (9 March after the election). */
  termStart: string;
  termEnd: string | null;
}

export const PRESIDENTS: readonly President[] = [
  {
    id: "marcelo-rebelo-de-sousa",
    name: "Marcelo Rebelo de Sousa",
    fullName: "Marcelo Nuno Duarte Rebelo de Sousa",
    termStart: "2016-03-09",
    termEnd: "2026-03-09",
  },
  {
    id: "antonio-jose-seguro",
    name: "António José Seguro",
    fullName: "António José Martins Seguro",
    termStart: "2026-03-09",
    termEnd: null,
  },
];

export const currentPresident = () => PRESIDENTS.find((p) => p.termEnd === null)!;

/** Who was President on a date (YYYY-MM-DD). */
export const presidentOn = (date: string) =>
  PRESIDENTS.find((p) => p.termStart <= date && (p.termEnd === null || date < p.termEnd)) ?? null;

/** Short names the press uses, which count only in an article about the presidency. */
export const PRESIDENT_ALIASES: Readonly<Record<string, { withContext: string[]; context: RegExp; exclude?: RegExp }>> = {
  "antonio-jose-seguro": {
    withContext: ["Seguro", "José Seguro"],
    context: /Presidente da República|Belém|chefe de Estado|Presidência da República|promulg|vet[ao]/i,
    // "Seguro" opening a sentence about insurance.
    exclude: /Seguro(?=\s+(?:de|do|da|automóvel|social|obrigatório|escolar)(?![\p{L}]))/gu,
  },
};

export const PRESIDENCY_SITE = "https://www.presidencia.pt";
export const BIOGRAPHY_URL = `${PRESIDENCY_SITE}/presidente-da-republica/o-presidente/biografia/`;
