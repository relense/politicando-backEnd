/*
 * Governments since the 25th of April, kept by hand. Dates follow the Government's own list
 * of heads of government ("Chefes do Governo desde 1821", HEADS_OF_GOVERNMENT_URL), which
 * stops at 2015; later ones follow the portal's pages for each government. Parties, support
 * and how each ended are historical record, summarised here. Add the new government when one
 * takes office (the daily sync warns when the portal's current code isn't listed).
 */

export const HEADS_OF_GOVERNMENT_URL =
  "https://www.portugal.gov.pt/pt/gc25/governo/governos-anteriores/chefes-do-governo-desde-1821";

export type EndReason =
  | "end_of_term" // The legislature ran its course; a new government followed the election.
  | "early_election" // Parliament was dissolved and early elections called.
  | "censure" // Parliament passed a motion of censure.
  | "confidence_rejected" // Parliament rejected a motion of confidence.
  | "programme_rejected" // Parliament rejected the government's programme.
  | "resignation" // The Prime Minister resigned and another government was formed without elections.
  | "dismissed" // The President dismissed the Prime Minister.
  | "death" // The Prime Minister died.
  | "provisional" // A provisional government, replaced by the next one (1974-76).
  | "in_office";

export interface HistoricGovernment {
  /** "gc01"-"gc25" for constitutional governments (the portal's codes), "gp1"-"gp6" for provisional ones. */
  code: string;
  kind: "constitutional" | "provisional";
  name: string;
  primeMinister: string;
  start: string;
  /** The day the next government took office; null while in office. */
  end: string | null;
  /** Our party slugs in government; empty for provisional and presidential-initiative governments. */
  parties: string[];
  /** How it governed, in a few words. */
  support: string;
  endReason: EndReason;
  /** What happened, in one sentence. */
  endNote: string | null;
}

const g = (
  code: string,
  name: string,
  primeMinister: string,
  start: string,
  end: string | null,
  parties: string[],
  support: string,
  endReason: EndReason,
  endNote: string | null,
): HistoricGovernment => ({
  code,
  kind: code.startsWith("gp") ? "provisional" : "constitutional",
  name,
  primeMinister,
  start,
  end,
  parties,
  support,
  endReason,
  endNote,
});

export const GOVERNMENTS: readonly HistoricGovernment[] = [
  g("gp1", "I Governo Provisório", "Adelino da Palma Carlos", "1974-05-16", "1974-07-18", [], "Governo provisório", "provisional", "O Primeiro-Ministro demitiu-se."),
  g("gp2", "II Governo Provisório", "Vasco Gonçalves", "1974-07-18", "1974-09-30", [], "Governo provisório", "provisional", null),
  g("gp3", "III Governo Provisório", "Vasco Gonçalves", "1974-09-30", "1975-03-26", [], "Governo provisório", "provisional", null),
  g("gp4", "IV Governo Provisório", "Vasco Gonçalves", "1975-03-26", "1975-08-08", [], "Governo provisório", "provisional", null),
  g("gp5", "V Governo Provisório", "Vasco Gonçalves", "1975-08-08", "1975-09-19", [], "Governo provisório", "provisional", null),
  g("gp6", "VI Governo Provisório", "José Pinheiro de Azevedo", "1975-09-19", "1976-07-23", [], "Governo provisório", "provisional", "Deu lugar ao primeiro governo constitucional, depois das eleições de 1976."),
  g("gc01", "I Governo Constitucional", "Mário Soares", "1976-07-23", "1978-01-23", ["ps"], "Minoria do PS", "confidence_rejected", "O Parlamento rejeitou uma moção de confiança, em dezembro de 1977."),
  g("gc02", "II Governo Constitucional", "Mário Soares", "1978-01-23", "1978-08-29", ["ps", "cds-pp"], "Coligação PS e CDS", "dismissed", "O CDS saiu do Governo e o Presidente Ramalho Eanes exonerou o Primeiro-Ministro."),
  g("gc03", "III Governo Constitucional", "Alfredo Nobre da Costa", "1978-08-29", "1978-11-22", [], "Iniciativa presidencial, sem partidos", "programme_rejected", "O Parlamento rejeitou o programa do Governo."),
  g("gc04", "IV Governo Constitucional", "Carlos Mota Pinto", "1978-11-22", "1979-07-07", [], "Iniciativa presidencial, sem partidos", "resignation", "O Primeiro-Ministro demitiu-se."),
  g("gc05", "V Governo Constitucional", "Maria de Lourdes Pintasilgo", "1979-07-07", "1980-01-03", [], "Iniciativa presidencial, sem partidos, até às eleições intercalares", "early_election", "Governo de gestão até às eleições antecipadas de dezembro de 1979."),
  g("gc06", "VI Governo Constitucional", "Francisco Sá Carneiro", "1980-01-03", "1981-01-09", ["psd", "cds-pp", "ppm"], "Aliança Democrática (PSD, CDS e PPM), maioria absoluta", "death", "O Primeiro-Ministro morreu no desastre de Camarate, a 4 de dezembro de 1980."),
  g("gc07", "VII Governo Constitucional", "Francisco Pinto Balsemão", "1981-01-09", "1981-09-04", ["psd", "cds-pp", "ppm"], "Aliança Democrática, maioria absoluta", "resignation", "O Primeiro-Ministro demitiu-se e formou novo governo."),
  g("gc08", "VIII Governo Constitucional", "Francisco Pinto Balsemão", "1981-09-04", "1983-06-09", ["psd", "cds-pp", "ppm"], "Aliança Democrática, maioria absoluta", "early_election", "O Primeiro-Ministro demitiu-se e o Presidente dissolveu o Parlamento; eleições em abril de 1983."),
  g("gc09", "IX Governo Constitucional", "Mário Soares", "1983-06-09", "1985-11-06", ["ps", "psd"], "Bloco Central (PS e PSD), maioria absoluta", "early_election", "O PSD saiu da coligação; eleições antecipadas em outubro de 1985."),
  g("gc10", "X Governo Constitucional", "Aníbal Cavaco Silva", "1985-11-06", "1987-08-17", ["psd"], "Minoria do PSD", "censure", "O Parlamento aprovou uma moção de censura, em abril de 1987; eleições antecipadas em julho."),
  g("gc11", "XI Governo Constitucional", "Aníbal Cavaco Silva", "1987-08-17", "1991-10-31", ["psd"], "Maioria absoluta do PSD", "end_of_term", null),
  g("gc12", "XII Governo Constitucional", "Aníbal Cavaco Silva", "1991-10-31", "1995-10-28", ["psd"], "Maioria absoluta do PSD", "end_of_term", null),
  g("gc13", "XIII Governo Constitucional", "António Guterres", "1995-10-28", "1999-10-25", ["ps"], "Minoria do PS", "end_of_term", null),
  g("gc14", "XIV Governo Constitucional", "António Guterres", "1999-10-25", "2002-04-06", ["ps"], "Minoria do PS", "early_election", "O Primeiro-Ministro demitiu-se depois das autárquicas de dezembro de 2001; eleições antecipadas em março de 2002."),
  g("gc15", "XV Governo Constitucional", "José Manuel Durão Barroso", "2002-04-06", "2004-07-17", ["psd", "cds-pp"], "Coligação PSD e CDS-PP, maioria absoluta", "resignation", "O Primeiro-Ministro saiu para presidir à Comissão Europeia."),
  g("gc16", "XVI Governo Constitucional", "Pedro Santana Lopes", "2004-07-17", "2005-03-12", ["psd", "cds-pp"], "Coligação PSD e CDS-PP, maioria absoluta", "early_election", "O Presidente Jorge Sampaio dissolveu o Parlamento; eleições antecipadas em fevereiro de 2005."),
  g("gc17", "XVII Governo Constitucional", "José Sócrates", "2005-03-12", "2009-10-26", ["ps"], "Maioria absoluta do PS", "end_of_term", null),
  g("gc18", "XVIII Governo Constitucional", "José Sócrates", "2009-10-26", "2011-06-21", ["ps"], "Minoria do PS", "early_election", "O Parlamento chumbou o PEC IV e o Primeiro-Ministro demitiu-se; eleições antecipadas em junho de 2011."),
  g("gc19", "XIX Governo Constitucional", "Pedro Passos Coelho", "2011-06-21", "2015-10-30", ["psd", "cds-pp"], "Coligação PSD e CDS-PP, maioria absoluta", "end_of_term", null),
  g("gc20", "XX Governo Constitucional", "Pedro Passos Coelho", "2015-10-30", "2015-11-26", ["psd", "cds-pp"], "Coligação PSD e CDS-PP, minoria", "programme_rejected", "O Parlamento rejeitou o programa do Governo, em novembro de 2015."),
  g("gc21", "XXI Governo Constitucional", "António Costa", "2015-11-26", "2019-10-26", ["ps"], "Minoria do PS, com acordos com BE, PCP e PEV", "end_of_term", null),
  g("gc22", "XXII Governo Constitucional", "António Costa", "2019-10-26", "2022-03-30", ["ps"], "Minoria do PS", "early_election", "O Parlamento chumbou o Orçamento do Estado para 2022; eleições antecipadas em janeiro de 2022."),
  g("gc23", "XXIII Governo Constitucional", "António Costa", "2022-03-30", "2024-04-02", ["ps"], "Maioria absoluta do PS", "early_election", "O Primeiro-Ministro demitiu-se em novembro de 2023; eleições antecipadas em março de 2024."),
  g("gc24", "XXIV Governo Constitucional", "Luís Montenegro", "2024-04-02", "2025-06-05", ["psd", "cds-pp"], "Coligação PSD e CDS-PP (AD), minoria", "confidence_rejected", "O Parlamento rejeitou uma moção de confiança, em março de 2025; eleições antecipadas em maio."),
  g("gc25", "XXV Governo Constitucional", "Luís Montenegro", "2025-06-05", null, ["psd", "cds-pp"], "Coligação PSD e CDS-PP (AD), minoria", "in_office", null),
];

/** Legislative elections since 1975, for the timeline. Results for 2011 on come from the elections data. */
export const LEGISLATIVE_ELECTION_DATES: readonly string[] = [
  "1975-04-25", "1976-04-25", "1979-12-02", "1980-10-05", "1983-04-25", "1985-10-06", "1987-07-19",
  "1991-10-06", "1995-10-01", "1999-10-10", "2002-03-17", "2005-02-20", "2009-09-27", "2011-06-05",
  "2015-10-04", "2019-10-06", "2022-01-30", "2024-03-10", "2025-05-18",
];

/** The portal has full pages from the XXI Government on. */
export const portalUrl = (code: string) => (/^gc(2[1-9]|[3-9]\d)$/.test(code) ? `https://www.portugal.gov.pt/pt/${code}` : null);
