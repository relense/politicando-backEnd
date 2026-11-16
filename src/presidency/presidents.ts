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
  /** Inauguration day (9 March after the election, since 1986). */
  termStart: string;
  termEnd: string | null;
}

export const PRESIDENTS: readonly President[] = [
  {
    id: "antonio-ramalho-eanes",
    name: "António Ramalho Eanes",
    fullName: "António dos Santos Ramalho Eanes",
    termStart: "1976-07-14",
    termEnd: "1986-03-09",
  },
  {
    id: "mario-soares",
    name: "Mário Soares",
    fullName: "Mário Alberto Nobre Lopes Soares",
    termStart: "1986-03-09",
    termEnd: "1996-03-09",
  },
  {
    id: "jorge-sampaio",
    name: "Jorge Sampaio",
    fullName: "Jorge Fernando Branco de Sampaio",
    termStart: "1996-03-09",
    termEnd: "2006-03-09",
  },
  {
    id: "anibal-cavaco-silva",
    name: "Aníbal Cavaco Silva",
    fullName: "Aníbal António Cavaco Silva",
    termStart: "2006-03-09",
    termEnd: "2016-03-09",
  },
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

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/**
 * Birth date and place and where they live, read from the official biography's wording
 * ("nasceu a 11 de março de 1962, em Penamacor", "reside nas Caldas da Rainha"). Null when
 * the biography doesn't say it that way.
 */
export const biographyFacts = (bio: string[]) => {
  const text = bio.join(" ");
  const born = /nasceu (?:a|em) (\d{1,2}) de (\p{L}+) de (\d{4}),? (?:em|n[oa]s?) ([\p{Lu}][\p{L}' -]*?)(?=[,.;(]| vila| cidade| concelho| freguesia| onde)/u.exec(text);
  const month = born ? MONTHS.indexOf(born[2]!.toLowerCase()) + 1 : 0;
  const lives = /\breside(?:m)? (?:em|n[oa]s?) ([\p{Lu}][\p{L}' -]*?)(?=[,.;(])/u.exec(text);
  return {
    birthDate: born && month ? `${born[3]}-${String(month).padStart(2, "0")}-${born[1]!.padStart(2, "0")}` : null,
    birthPlace: born?.[4]?.trim() ?? null,
    residence: lives?.[1]?.trim() ?? null,
  };
};
