import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { electionLists, electionResults, electionTurnout, elections, places } from "../db/schema.js";

/*
 * Legislativas before the results site existed (1975 Constituinte to 2009): national totals
 * only, copied by hand from the CNE's official maps (mapas oficiais, as published in the
 * Diário do Governo / Diário da República). The PDFs are at each election's sourceUrl;
 * 1976–1995 are scans. Lists use the acronyms printed on the map.
 *
 * Every figure is as published. In four maps the lists plus blank and null votes don't add
 * up exactly to the voters (1976: 3 short, 1999: 48 over, 2002: 804 short, 2005: 163 short);
 * those are the map's own figures, kept as they are.
 *
 * 1975 elected the Constituent Assembly (250 seats, plus Macau's). 1976 had 263 seats,
 * 1979–1987 250, and 230 since 1991. Before 1979 blank votes were counted with the null ones.
 */

export interface HistoricList {
  list: string;
  name: string;
  partySlugs: string[];
  coalition: boolean;
  votes: number;
  mandates: number;
}

export interface HistoricElection {
  id: string;
  name: string;
  date: string;
  sourceUrl: string;
  registered: number;
  voters: number;
  /** Null when the map counts blank votes with the null ones (1975, 1976). */
  blank: number | null;
  null: number;
  seats: number;
  lists: HistoricList[];
}

export const HISTORIC_LEGISLATIVAS: HistoricElection[] = [
  {
    id: "legislativas-1975",
    name: "Assembleia Constituinte 1975",
    date: "1975-04-25",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ac_1975.pdf",
    registered: 6231372,
    voters: 5711829,
    blank: null,
    null: 396675,
    seats: 250,
    lists: [
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 2162972, mandates: 116 },
      { list: "PPD", name: "Partido Popular Democrático", partySlugs: ["psd"], coalition: false, votes: 1507282, mandates: 81 },
      { list: "PCP", name: "Partido Comunista Português", partySlugs: ["pcp"], coalition: false, votes: 711935, mandates: 30 },
      { list: "CDS", name: "Centro Democrático Social", partySlugs: ["cds-pp"], coalition: false, votes: 434879, mandates: 16 },
      { list: "MDP/CDE", name: "Movimento Democrático Português", partySlugs: [], coalition: false, votes: 236318, mandates: 5 },
      { list: "FSP", name: "Frente Socialista Popular", partySlugs: [], coalition: false, votes: 66307, mandates: 0 },
      { list: "MES", name: "Movimento de Esquerda Socialista", partySlugs: [], coalition: false, votes: 58248, mandates: 0 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 44877, mandates: 1 },
      { list: "FEC(m-l)", name: "Frente Eleitoral de Comunistas (marxista-leninista)", partySlugs: [], coalition: false, votes: 33185, mandates: 0 },
      { list: "PPM", name: "Partido Popular Monárquico", partySlugs: ["ppm"], coalition: false, votes: 32526, mandates: 0 },
      { list: "PUP", name: "Partido de Unidade Popular", partySlugs: [], coalition: false, votes: 13138, mandates: 0 },
      { list: "LCI", name: "Liga Comunista Internacionalista", partySlugs: [], coalition: false, votes: 10835, mandates: 0 },
      { list: "ADIM", name: "Associação para a Defesa dos Interesses de Macau", partySlugs: [], coalition: false, votes: 1622, mandates: 1 },
      { list: "CDM", name: "Centro Democrático de Macau", partySlugs: [], coalition: false, votes: 1030, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1976",
    name: "Legislativas 1976",
    date: "1976-04-25",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1976.pdf",
    registered: 6402035,
    voters: 5482723,
    blank: null,
    null: 257612,
    seats: 263,
    lists: [
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 1911769, mandates: 107 },
      { list: "PPD", name: "Partido Popular Democrático", partySlugs: ["psd"], coalition: false, votes: 1336697, mandates: 73 },
      { list: "CDS", name: "Centro Democrático Social", partySlugs: ["cds-pp"], coalition: false, votes: 877494, mandates: 42 },
      { list: "PCP", name: "Partido Comunista Português", partySlugs: ["pcp"], coalition: false, votes: 786701, mandates: 40 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 91691, mandates: 1 },
      { list: "FSP", name: "Frente Socialista Popular", partySlugs: [], coalition: false, votes: 42124, mandates: 0 },
      { list: "MRPP", name: "Movimento Reorganizativo do Partido do Proletariado", partySlugs: ["pctp-mrpp"], coalition: false, votes: 36108, mandates: 0 },
      { list: "MES", name: "Movimento de Esquerda Socialista", partySlugs: [], coalition: false, votes: 31315, mandates: 0 },
      { list: "PDC", name: "Partido da Democracia Cristã", partySlugs: [], coalition: false, votes: 29873, mandates: 0 },
      { list: "PPM", name: "Partido Popular Monárquico", partySlugs: ["ppm"], coalition: false, votes: 28352, mandates: 0 },
      { list: "LCI", name: "Liga Comunista Internacionalista", partySlugs: [], coalition: false, votes: 16263, mandates: 0 },
      { list: "PCP(M-L)", name: "Partido Comunista de Portugal (marxista-leninista)", partySlugs: [], coalition: false, votes: 15795, mandates: 0 },
      { list: "AOC", name: "Aliança Operário-Camponesa", partySlugs: [], coalition: false, votes: 15756, mandates: 0 },
      { list: "PRT", name: "Partido Revolucionário dos Trabalhadores", partySlugs: [], coalition: false, votes: 5170, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1979",
    name: "Legislativas 1979",
    date: "1979-12-02",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1979.pdf",
    registered: 7249346,
    voters: 6007453,
    blank: 42863,
    null: 120851,
    seats: 250,
    lists: [
      { list: "AD", name: "Aliança Democrática (PPD/PSD, CDS e PPM)", partySlugs: ["psd", "cds-pp", "ppm"], coalition: true, votes: 2554458, mandates: 121 },
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 1642136, mandates: 74 },
      { list: "APU", name: "Aliança Povo Unido (PCP e MDP/CDE)", partySlugs: ["pcp"], coalition: true, votes: 1129322, mandates: 47 },
      { list: "PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 141227, mandates: 7 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 130842, mandates: 1 },
      { list: "PDC", name: "Partido da Democracia Cristã", partySlugs: [], coalition: false, votes: 72514, mandates: 0 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 53268, mandates: 0 },
      { list: "UEDS", name: "União de Esquerda para a Democracia Socialista", partySlugs: [], coalition: false, votes: 43325, mandates: 0 },
      { list: "PSR", name: "Partido Socialista Revolucionário", partySlugs: [], coalition: false, votes: 36978, mandates: 0 },
      { list: "CDS", name: "Centro Democrático Social", partySlugs: ["cds-pp"], coalition: false, votes: 23523, mandates: 0 },
      { list: "POUS", name: "Partido Operário de Unidade Socialista", partySlugs: [], coalition: false, votes: 12713, mandates: 0 },
      { list: "OCMLP", name: "Organização Comunista Marxista-Leninista Portuguesa", partySlugs: [], coalition: false, votes: 3433, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1980",
    name: "Legislativas 1980",
    date: "1980-10-05",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1980.pdf",
    registered: 7179023,
    voters: 6026395,
    blank: 34522,
    null: 103140,
    seats: 250,
    lists: [
      { list: "AD", name: "Aliança Democrática (PPD/PSD, CDS e PPM)", partySlugs: ["psd", "cds-pp", "ppm"], coalition: true, votes: 2706667, mandates: 126 },
      { list: "FRS", name: "Frente Republicana e Socialista (PS, UEDS e ASDI)", partySlugs: ["ps"], coalition: true, votes: 1606198, mandates: 71 },
      { list: "APU", name: "Aliança Povo Unido (PCP e MDP/CDE)", partySlugs: ["pcp"], coalition: true, votes: 1009505, mandates: 41 },
      { list: "PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 147644, mandates: 8 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 83204, mandates: 1 },
      { list: "POUS/PST", name: "Partido Operário de Unidade Socialista / Partido Socialista dos Trabalhadores", partySlugs: [], coalition: true, votes: 83095, mandates: 0 },
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 67081, mandates: 3 },
      { list: "PSR", name: "Partido Socialista Revolucionário", partySlugs: [], coalition: false, votes: 60496, mandates: 0 },
      { list: "PT", name: "Partido Trabalhista", partySlugs: [], coalition: false, votes: 39408, mandates: 0 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 35409, mandates: 0 },
      { list: "PDC-MIRN/PDP-FN", name: "Partido da Democracia Cristã, MIRN/Partido da Direita Portuguesa e Frente Nacional", partySlugs: [], coalition: true, votes: 23819, mandates: 0 },
      { list: "CDS", name: "Centro Democrático Social", partySlugs: ["cds-pp"], coalition: false, votes: 13765, mandates: 0 },
      { list: "UDA/PDA", name: "União Democrática dos Açores / Partido Democrático do Atlântico", partySlugs: [], coalition: true, votes: 8529, mandates: 0 },
      { list: "OCMLP", name: "Organização Comunista Marxista-Leninista Portuguesa", partySlugs: [], coalition: false, votes: 3913, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1983",
    name: "Legislativas 1983",
    date: "1983-04-25",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1983.pdf",
    registered: 7337064,
    voters: 5707695,
    blank: 42494,
    null: 104276,
    seats: 250,
    lists: [
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 2061309, mandates: 101 },
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 1554804, mandates: 75 },
      { list: "APU", name: "Aliança Povo Unido (PCP, MDP/CDE e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 1031609, mandates: 44 },
      { list: "CDS", name: "Centro Democrático Social", partySlugs: ["cds-pp"], coalition: false, votes: 716705, mandates: 30 },
      { list: "PDC", name: "Partido da Democracia Cristã", partySlugs: [], coalition: false, votes: 39180, mandates: 0 },
      { list: "PPM", name: "Partido Popular Monárquico", partySlugs: ["ppm"], coalition: false, votes: 27635, mandates: 0 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 27260, mandates: 0 },
      { list: "UDP/PSR", name: "União Democrática Popular / Partido Socialista Revolucionário", partySlugs: [], coalition: true, votes: 25222, mandates: 0 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 20995, mandates: 0 },
      { list: "POUS", name: "Partido Operário de Unidade Socialista", partySlugs: [], coalition: false, votes: 19657, mandates: 0 },
      { list: "PSR", name: "Partido Socialista Revolucionário", partySlugs: [], coalition: false, votes: 13327, mandates: 0 },
      { list: "LST", name: "Liga Socialista dos Trabalhadores", partySlugs: [], coalition: false, votes: 11500, mandates: 0 },
      { list: "OCMLP", name: "Organização Comunista Marxista-Leninista Portuguesa", partySlugs: [], coalition: false, votes: 6113, mandates: 0 },
      { list: "PDA", name: "Partido Democrático do Atlântico", partySlugs: [], coalition: false, votes: 5523, mandates: 0 },
      { list: "PC(R)", name: "Partido Comunista (Reconstruído)", partySlugs: [], coalition: false, votes: 86, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1985",
    name: "Legislativas 1985",
    date: "1985-10-06",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1985.pdf",
    registered: 8025166,
    voters: 5798929,
    blank: 48719,
    null: 96610,
    seats: 250,
    lists: [
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 1732288, mandates: 88 },
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 1204311, mandates: 57 },
      { list: "PRD", name: "Partido Renovador Democrático", partySlugs: [], coalition: false, votes: 1038893, mandates: 45 },
      { list: "APU", name: "Aliança Povo Unido (PCP, MDP/CDE e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 898281, mandates: 38 },
      { list: "CDS", name: "Centro Democrático Social", partySlugs: ["cds-pp"], coalition: false, votes: 577580, mandates: 22 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 73401, mandates: 0 },
      { list: "PDC", name: "Partido da Democracia Cristã", partySlugs: [], coalition: false, votes: 41831, mandates: 0 },
      { list: "PSR", name: "Partido Socialista Revolucionário", partySlugs: [], coalition: false, votes: 35238, mandates: 0 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 19943, mandates: 0 },
      { list: "POUS", name: "Partido Operário de Unidade Socialista", partySlugs: [], coalition: false, votes: 19085, mandates: 0 },
      { list: "PC(R)", name: "Partido Comunista (Reconstruído)", partySlugs: [], coalition: false, votes: 12749, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1987",
    name: "Legislativas 1987",
    date: "1987-07-19",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1987.pdf",
    registered: 7930668,
    voters: 5676358,
    blank: 50135,
    null: 73533,
    seats: 250,
    lists: [
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 2850784, mandates: 148 },
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 1262506, mandates: 60 },
      { list: "CDU", name: "Coligação Democrática Unitária (PCP e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 689137, mandates: 31 },
      { list: "PRD", name: "Partido Renovador Democrático", partySlugs: [], coalition: false, votes: 278561, mandates: 7 },
      { list: "CDS", name: "Centro Democrático Social", partySlugs: ["cds-pp"], coalition: false, votes: 251987, mandates: 4 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 50717, mandates: 0 },
      { list: "PSR", name: "Partido Socialista Revolucionário", partySlugs: [], coalition: false, votes: 32977, mandates: 0 },
      { list: "MDP/CDE", name: "Movimento Democrático Português", partySlugs: [], coalition: false, votes: 32607, mandates: 0 },
      { list: "PDC", name: "Partido da Democracia Cristã", partySlugs: [], coalition: false, votes: 31667, mandates: 0 },
      { list: "PPM", name: "Partido Popular Monárquico", partySlugs: ["ppm"], coalition: false, votes: 23218, mandates: 0 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 20800, mandates: 0 },
      { list: "PC(R)", name: "Partido Comunista (Reconstruído)", partySlugs: [], coalition: false, votes: 18544, mandates: 0 },
      { list: "POUS", name: "Partido Operário de Unidade Socialista", partySlugs: [], coalition: false, votes: 9185, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1991",
    name: "Legislativas 1991",
    date: "1991-10-06",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1991.pdf",
    registered: 8462357,
    voters: 5735431,
    blank: 47652,
    null: 63020,
    seats: 230,
    lists: [
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 2902351, mandates: 135 },
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 1670758, mandates: 72 },
      { list: "PCP-PEV", name: "Coligação Democrática Unitária (PCP e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 504583, mandates: 17 },
      { list: "CDS", name: "Centro Democrático Social", partySlugs: ["cds-pp"], coalition: false, votes: 254317, mandates: 5 },
      { list: "PSN", name: "Partido de Solidariedade Nacional", partySlugs: [], coalition: false, votes: 96096, mandates: 1 },
      { list: "PSR", name: "Partido Socialista Revolucionário", partySlugs: [], coalition: false, votes: 64159, mandates: 0 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 48542, mandates: 0 },
      { list: "PRD", name: "Partido Renovador Democrático", partySlugs: [], coalition: false, votes: 35077, mandates: 0 },
      { list: "PPM", name: "Partido Popular Monárquico", partySlugs: ["ppm"], coalition: false, votes: 25216, mandates: 0 },
      { list: "PDA", name: "Partido Democrático do Atlântico", partySlugs: [], coalition: false, votes: 10842, mandates: 0 },
      { list: "FER", name: "Frente da Esquerda Revolucionária", partySlugs: [], coalition: false, votes: 6661, mandates: 0 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 6157, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1995",
    name: "Legislativas 1995",
    date: "1995-10-01",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1995.pdf",
    registered: 8906608,
    voters: 5904854,
    blank: 45793,
    null: 67300,
    seats: 230,
    lists: [
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 2583755, mandates: 112 },
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 2014589, mandates: 88 },
      { list: "CDS/PP", name: "CDS – Partido Popular", partySlugs: ["cds-pp"], coalition: false, votes: 534470, mandates: 15 },
      { list: "PCP-PEV", name: "Coligação Democrática Unitária (PCP e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 506157, mandates: 15 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 41137, mandates: 0 },
      { list: "PSR", name: "Partido Socialista Revolucionário", partySlugs: [], coalition: false, votes: 37638, mandates: 0 },
      { list: "UDP", name: "União Democrática Popular", partySlugs: [], coalition: false, votes: 33876, mandates: 0 },
      { list: "PSN", name: "Partido de Solidariedade Nacional", partySlugs: [], coalition: false, votes: 12613, mandates: 0 },
      { list: "PG", name: "Partido da Gente", partySlugs: [], coalition: false, votes: 8279, mandates: 0 },
      { list: "MPT", name: "Movimento O Partido da Terra", partySlugs: ["mpt"], coalition: false, votes: 8235, mandates: 0 },
      { list: "PPM-MPT", name: "Coligação Ecologia e Futuro (PPM e MPT)", partySlugs: ["ppm", "mpt"], coalition: true, votes: 5932, mandates: 0 },
      { list: "MUT", name: "Movimento de Unidade dos Trabalhadores", partySlugs: [], coalition: false, votes: 2544, mandates: 0 },
      { list: "PDA", name: "Partido Democrático do Atlântico", partySlugs: [], coalition: false, votes: 2536, mandates: 0 },
    ],
  },
  {
    id: "legislativas-1999",
    name: "Legislativas 1999",
    date: "1999-10-10",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_1999.pdf",
    registered: 8864604,
    voters: 5415102,
    blank: 56964,
    null: 51230,
    seats: 230,
    lists: [
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 2385922, mandates: 115 },
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 1750158, mandates: 81 },
      { list: "PCP-PEV", name: "Coligação Democrática Unitária (PCP e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 487058, mandates: 17 },
      { list: "CDS-PP", name: "CDS – Partido Popular", partySlugs: ["cds-pp"], coalition: false, votes: 451643, mandates: 15 },
      { list: "B.E.", name: "Bloco de Esquerda", partySlugs: ["be"], coalition: false, votes: 132333, mandates: 2 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 40006, mandates: 0 },
      { list: "MPT", name: "Movimento O Partido da Terra", partySlugs: ["mpt"], coalition: false, votes: 19938, mandates: 0 },
      { list: "PPM", name: "Partido Popular Monárquico", partySlugs: ["ppm"], coalition: false, votes: 16522, mandates: 0 },
      { list: "PSN", name: "Partido de Solidariedade Nacional", partySlugs: [], coalition: false, votes: 11488, mandates: 0 },
      { list: "PH", name: "Partido Humanista", partySlugs: [], coalition: false, votes: 7346, mandates: 0 },
      { list: "POUS", name: "Partido Operário de Unidade Socialista", partySlugs: [], coalition: false, votes: 4104, mandates: 0 },
      { list: "PDA", name: "Partido Democrático do Atlântico", partySlugs: [], coalition: false, votes: 438, mandates: 0 },
    ],
  },
  {
    id: "legislativas-2002",
    name: "Legislativas 2002",
    date: "2002-03-17",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_2002.pdf",
    registered: 8902713,
    voters: 5473655,
    blank: 55121,
    null: 52653,
    seats: 230,
    lists: [
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 2200765, mandates: 105 },
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 2068584, mandates: 96 },
      { list: "CDS-PP", name: "CDS – Partido Popular", partySlugs: ["cds-pp"], coalition: false, votes: 477350, mandates: 14 },
      { list: "PCP-PEV", name: "Coligação Democrática Unitária (PCP e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 379870, mandates: 12 },
      { list: "B.E.", name: "Bloco de Esquerda", partySlugs: ["be"], coalition: false, votes: 149966, mandates: 3 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 36193, mandates: 0 },
      { list: "MPT", name: "Movimento O Partido da Terra", partySlugs: ["mpt"], coalition: false, votes: 15540, mandates: 0 },
      { list: "PPM", name: "Partido Popular Monárquico", partySlugs: ["ppm"], coalition: false, votes: 12398, mandates: 0 },
      { list: "PH", name: "Partido Humanista", partySlugs: [], coalition: false, votes: 11472, mandates: 0 },
      { list: "PNR", name: "Partido Nacional Renovador", partySlugs: [], coalition: false, votes: 4712, mandates: 0 },
      { list: "POUS", name: "Partido Operário de Unidade Socialista", partySlugs: [], coalition: false, votes: 4316, mandates: 0 },
      { list: "B.E.-UDP", name: "Coligação Bloco de Esquerda-UDP", partySlugs: ["be"], coalition: true, votes: 3911, mandates: 0 },
    ],
  },
  {
    id: "legislativas-2005",
    name: "Legislativas 2005",
    date: "2005-02-20",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_2005_rectificacao.pdf",
    registered: 8944508,
    voters: 5747834,
    blank: 103537,
    null: 65515,
    seats: 230,
    lists: [
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 2588312, mandates: 121 },
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 1653425, mandates: 75 },
      { list: "PCP-PEV", name: "Coligação Democrática Unitária (PCP e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 433369, mandates: 14 },
      { list: "CDS-PP", name: "CDS – Partido Popular", partySlugs: ["cds-pp"], coalition: false, votes: 416415, mandates: 12 },
      { list: "B.E.", name: "Bloco de Esquerda", partySlugs: ["be"], coalition: false, votes: 364971, mandates: 8 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 48186, mandates: 0 },
      { list: "PND", name: "Nova Democracia", partySlugs: [], coalition: false, votes: 40358, mandates: 0 },
      { list: "PH", name: "Partido Humanista", partySlugs: [], coalition: false, votes: 17056, mandates: 0 },
      { list: "PNR", name: "Partido Nacional Renovador", partySlugs: [], coalition: false, votes: 9374, mandates: 0 },
      { list: "POUS", name: "Partido Operário de Unidade Socialista", partySlugs: [], coalition: false, votes: 5535, mandates: 0 },
      { list: "PDA", name: "Partido Democrático do Atlântico", partySlugs: [], coalition: false, votes: 1618, mandates: 0 },
    ],
  },
  {
    id: "legislativas-2009",
    name: "Legislativas 2009",
    date: "2009-09-27",
    sourceUrl: "https://www.cne.pt/sites/default/files/dl/resultados_ar_2009.pdf",
    registered: 9519921,
    voters: 5681258,
    blank: 99086,
    null: 76894,
    seats: 230,
    lists: [
      { list: "PS", name: "Partido Socialista", partySlugs: ["ps"], coalition: false, votes: 2077238, mandates: 97 },
      { list: "PPD/PSD", name: "Partido Social Democrata", partySlugs: ["psd"], coalition: false, votes: 1653665, mandates: 81 },
      { list: "CDS-PP", name: "CDS – Partido Popular", partySlugs: ["cds-pp"], coalition: false, votes: 592778, mandates: 21 },
      { list: "B.E.", name: "Bloco de Esquerda", partySlugs: ["be"], coalition: false, votes: 557306, mandates: 16 },
      { list: "PCP-PEV", name: "Coligação Democrática Unitária (PCP e PEV)", partySlugs: ["pcp", "pev"], coalition: true, votes: 446279, mandates: 15 },
      { list: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses", partySlugs: ["pctp-mrpp"], coalition: false, votes: 52761, mandates: 0 },
      { list: "MEP", name: "Movimento Esperança Portugal", partySlugs: [], coalition: false, votes: 25949, mandates: 0 },
      { list: "PND", name: "Nova Democracia", partySlugs: [], coalition: false, votes: 21876, mandates: 0 },
      { list: "MMS", name: "Movimento Mérito e Sociedade", partySlugs: [], coalition: false, votes: 16924, mandates: 0 },
      { list: "PPM", name: "Partido Popular Monárquico", partySlugs: ["ppm"], coalition: false, votes: 15262, mandates: 0 },
      { list: "MPT-P.H.", name: "Frente Ecologia e Humanismo (MPT e PH)", partySlugs: ["mpt"], coalition: true, votes: 12405, mandates: 0 },
      { list: "PNR", name: "Partido Nacional Renovador", partySlugs: [], coalition: false, votes: 11503, mandates: 0 },
      { list: "PPV", name: "Partido Pró-Vida", partySlugs: [], coalition: false, votes: 8461, mandates: 0 },
      { list: "PTP", name: "Partido Trabalhista Português", partySlugs: ["ptp"], coalition: false, votes: 4974, mandates: 0 },
      { list: "POUS", name: "Partido Operário de Unidade Socialista", partySlugs: [], coalition: false, votes: 4632, mandates: 0 },
      { list: "MPT", name: "Movimento O Partido da Terra", partySlugs: ["mpt"], coalition: false, votes: 3265, mandates: 0 },
    ],
  },];

const TOP = "GLOBAL-990000";
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Stores the historic legislativas at the whole-country level. Safe to re-run. */
export const importHistoricLegislativas = async (db: Db, list: HistoricElection[] = HISTORIC_LEGISLATIVAS) => {
  await db.insert(places).values({ key: TOP, name: "Total", level: "global", parentKey: null, dicofre: null }).onConflictDoNothing();
  for (const e of list) {
    const valid = e.voters - (e.blank ?? 0) - e.null;
    await db.transaction(async (tx) => {
      await tx
        .insert(elections)
        .values({ id: e.id, type: "legislativas", name: e.name, date: e.date, organs: ["AR"], sourceUrl: e.sourceUrl, importedAt: new Date() })
        .onConflictDoUpdate({ target: elections.id, set: { name: e.name, date: e.date, sourceUrl: e.sourceUrl, importedAt: new Date() } });
      await tx.delete(electionResults).where(sql`${electionResults.electionId} = ${e.id}`);
      await tx.delete(electionTurnout).where(sql`${electionTurnout.electionId} = ${e.id}`);
      await tx.delete(electionLists).where(sql`${electionLists.electionId} = ${e.id}`);
      await tx.insert(electionLists).values(
        e.lists.map((l) => ({ electionId: e.id, list: l.list, name: l.name, coalition: l.coalition, citizens: false, partySlugs: l.partySlugs })),
      );
      await tx.insert(electionTurnout).values({
        electionId: e.id, organ: "AR", placeKey: TOP, registered: e.registered, voters: e.voters,
        turnoutPct: round2((e.voters / e.registered) * 100), blank: e.blank ?? 0, null: e.null, totalMandates: e.seats,
      });
      await tx.insert(electionResults).values(
        e.lists.map((l) => ({
          electionId: e.id, organ: "AR", placeKey: TOP, list: l.list, label: null, votes: l.votes,
          pct: round2((l.votes / e.voters) * 100), validPct: round2((l.votes / valid) * 100), mandates: l.mandates, presidents: null,
        })),
      );
    });
  }
  return { elections: list.length };
};
