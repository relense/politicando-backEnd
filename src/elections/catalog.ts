/**
 * Elections we import from the electoral administration's results site
 * (www.eleicoes.mai.gov.pt, run by the Secretaria-Geral do MAI). Sites up to 2019 serve
 * files under static-data/ ("old"); 2021-2025 under assets/static/ ("new"); autárquicas 2025
 * and presidenciais 2026 use a newer platform with numeric place ids ("v3", see maiV3.ts).
 * The two rounds of a presidential election are separate sites and separate elections.
 */
export interface ElectionDef {
  id: string;
  type: "legislativas" | "autarquicas" | "europeias" | "presidenciais";
  name: string;
  date: string;
  /** Folder on the results site. */
  site: string;
  platform: "old" | "new" | "v3";
  /** Bodies elected, as the site codes them. The first is the main one. */
  organs: string[];
}

export const MAI_ORIGIN = "https://www.eleicoes.mai.gov.pt";

const e = (
  type: ElectionDef["type"],
  year: number,
  date: string,
  platform: ElectionDef["platform"],
  organs: string[],
  name: string,
): ElectionDef => ({ id: `${type}-${year}`, type, name, date, site: `${type}${year}`, platform, organs });

const AUTARQUICAS = ["CM", "AM", "AF"];

export const ELECTIONS: readonly ElectionDef[] = [
  e("legislativas", 2011, "2011-06-05", "old", ["AR"], "Legislativas 2011"),
  e("legislativas", 2015, "2015-10-04", "old", ["AR"], "Legislativas 2015"),
  e("legislativas", 2019, "2019-10-06", "old", ["AR"], "Legislativas 2019"),
  e("legislativas", 2022, "2022-01-30", "new", ["AR"], "Legislativas 2022"),
  e("legislativas", 2024, "2024-03-10", "new", ["AR"], "Legislativas 2024"),
  e("legislativas", 2025, "2025-05-18", "new", ["AR"], "Legislativas 2025"),
  e("europeias", 2014, "2014-05-25", "old", ["EUR"], "Europeias 2014"),
  e("europeias", 2019, "2019-05-26", "old", ["EUR"], "Europeias 2019"),
  e("europeias", 2024, "2024-06-09", "new", ["PE"], "Europeias 2024"),
  e("presidenciais", 2011, "2011-01-23", "old", ["PR"], "Presidenciais 2011"),
  e("presidenciais", 2016, "2016-01-24", "old", ["PR"], "Presidenciais 2016"),
  e("presidenciais", 2021, "2021-01-24", "new", ["PR"], "Presidenciais 2021"),
  e("autarquicas", 2013, "2013-09-29", "old", AUTARQUICAS, "Autárquicas 2013"),
  e("autarquicas", 2017, "2017-10-01", "old", AUTARQUICAS, "Autárquicas 2017"),
  e("autarquicas", 2021, "2021-09-26", "new", AUTARQUICAS, "Autárquicas 2021"),
  // After 2021: its places are matched by name to the ones earlier elections stored.
  e("autarquicas", 2025, "2025-10-12", "v3", AUTARQUICAS, "Autárquicas 2025"),
  { ...e("presidenciais", 2026, "2026-01-18", "v3", ["PR"], "Presidenciais 2026 (1.ª volta)"), site: "presidenciais2026_1S" },
  {
    ...e("presidenciais", 2026, "2026-02-08", "v3", ["PR"], "Presidenciais 2026 (2.ª volta)"),
    id: "presidenciais-2026-2a-volta",
    site: "presidenciais2026_2S",
  },
];

export const sourceUrl = (election: ElectionDef) => `${MAI_ORIGIN}/${election.site}/`;
