/*
 * The next election of each kind, by the dates the law sets. None has an official date yet:
 * the President (legislativas, europeias, presidenciais) or the Government (autárquicas)
 * sets it by decree a few months before. Set `date` and `confirmed` when that decree comes
 * out, and move an election out of here once it's imported.
 */

export interface UpcomingElection {
  type: "legislativas" | "autarquicas" | "europeias" | "presidenciais" | "regionais";
  name: string;
  year: number;
  /** Official date, once set by decree. */
  date: string | null;
  confirmed: boolean;
  /** When the law says it must happen. */
  window: string;
  basis: string;
}

export const UPCOMING_ELECTIONS: readonly UpcomingElection[] = [
  {
    type: "regionais",
    name: "Regionais dos Açores 2028",
    year: 2028,
    date: null,
    confirmed: false,
    window: "Até ao fim de 2028, quatro anos depois das de fevereiro de 2024, salvo dissolução",
    basis: "Estatuto Político-Administrativo da Região Autónoma dos Açores",
  },
  {
    type: "europeias",
    name: "Europeias 2029",
    year: 2029,
    date: null,
    confirmed: false,
    window: "Na semana eleitoral fixada pelo Conselho da União Europeia, normalmente em maio ou junho",
    basis: "Ato relativo à eleição dos deputados ao Parlamento Europeu",
  },
  {
    type: "legislativas",
    name: "Legislativas 2029",
    year: 2029,
    date: null,
    confirmed: false,
    window: "Entre 14 de setembro e 14 de outubro de 2029, no fim da legislatura, salvo dissolução",
    basis: "Lei Eleitoral da Assembleia da República, artigo 19.º",
  },
  {
    type: "autarquicas",
    name: "Autárquicas 2029",
    year: 2029,
    date: null,
    confirmed: false,
    window: "Entre 22 de setembro e 14 de outubro de 2029",
    basis: "Lei Eleitoral dos Órgãos das Autarquias Locais, artigo 15.º",
  },
  {
    type: "regionais",
    name: "Regionais da Madeira 2029",
    year: 2029,
    date: null,
    confirmed: false,
    window: "Em 2029, quatro anos depois das de março de 2025, salvo dissolução",
    basis: "Estatuto Político-Administrativo da Região Autónoma da Madeira",
  },
  {
    type: "presidenciais",
    name: "Presidenciais 2031",
    year: 2031,
    date: null,
    confirmed: false,
    window: "Nos 60 dias antes de 9 de março de 2031, quando acaba o mandato",
    basis: "Constituição, artigo 125.º",
  },
];
