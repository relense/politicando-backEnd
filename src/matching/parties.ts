/**
 * Party list: Tribunal Constitucional register, checked 2026-11-01
 * (https://www.tribunalconstitucional.pt/tc/partidos.html).
 * Seats: "Current composition" table of the English Wikipedia page for the
 * 17th Legislature, as edited 2026-10-08. Check against parlamento.pt.
 * Websites: requested and checked by page title on 2026-11-01, except where a
 * comment says otherwise. Null means no site could be confirmed.
 */
export const SEATS_AS_OF = "2026-10-08";

export interface PartyDefinition {
  slug: string;
  acronym: string;
  name: string;
  website: string | null;
  assemblySeats: number;
  /** Case-sensitive literal text that counts as a mention of this party. */
  terms: string[];
}

/** Words that show a capitalised common word is being used as a party name. */
const PARTY_PREFIXES = [
  "o", "O", "do", "Do", "no", "No", "ao", "Ao", "pelo", "Pelo",
  "com o", "Com o", "partido", "Partido",
];

/** For names that are also ordinary words: count them only after a party prefix. */
const inContext = (word: string, prefixes = PARTY_PREFIXES) =>
  prefixes.map((prefix) => `${prefix} ${word}`);

export const PARTY_DEFINITIONS: PartyDefinition[] = [
  {
    slug: "pcp", acronym: "PCP", name: "Partido Comunista Português",
    website: "http://www.pcp.pt/", assemblySeats: 3,
    terms: ["PCP", "Partido Comunista Português"],
  },
  {
    slug: "cds-pp", acronym: "CDS-PP", name: "CDS - Partido Popular",
    website: "http://www.cds.pt/", assemblySeats: 2,
    terms: ["CDS-PP", "CDS", "CDS – Partido Popular", "CDS - Partido Popular", "CDS-Partido Popular"],
  },
  {
    slug: "psd", acronym: "PSD", name: "Partido Social Democrata",
    website: "https://www.psd.pt/", assemblySeats: 89,
    terms: ["PPD/PSD", "PSD", "Partido Social Democrata"],
  },
  {
    slug: "ps", acronym: "PS", name: "Partido Socialista",
    website: "https://ps.pt/", assemblySeats: 58,
    terms: ["PS", "Partido Socialista"],
  },
  {
    slug: "pctp-mrpp", acronym: "PCTP/MRPP", name: "Partido Comunista dos Trabalhadores Portugueses",
    website: "http://lutapopularonline.org/index.php/editorial", assemblySeats: 0,
    terms: ["PCTP/MRPP", "PCTP", "MRPP", "Partido Comunista dos Trabalhadores Portugueses"],
  },
  {
    slug: "ppm", acronym: "PPM", name: "Partido Popular Monárquico",
    website: "https://partidopopularmonarquico.pt/", assemblySeats: 0,
    terms: ["PPM", "Partido Popular Monárquico"],
  },
  {
    slug: "pev", acronym: "PEV", name: "Partido Ecologista \"Os Verdes\"",
    website: "http://www.osverdes.pt/", assemblySeats: 0,
    terms: ["PEV", "Os Verdes", "Partido Ecologista Os Verdes"],
  },
  {
    slug: "mpt", acronym: "MPT", name: "Partido da Terra",
    website: "http://mpt.pt/", assemblySeats: 0,
    terms: ["MPT", "Partido da Terra"],
  },
  {
    slug: "be", acronym: "B.E.", name: "Bloco de Esquerda",
    website: "https://www.bloco.org/", assemblySeats: 1,
    terms: ["B.E.", "BE", "Bloco de Esquerda"],
  },
  {
    slug: "ptp", acronym: "PTP", name: "Partido Trabalhista Português",
    website: null, assemblySeats: 0,
    terms: ["PTP", "Partido Trabalhista Português"],
  },
  {
    slug: "pan", acronym: "PAN", name: "Pessoas-Animais-Natureza",
    website: "https://www.pan.com.pt/", assemblySeats: 1,
    terms: ["PAN", "Pessoas-Animais-Natureza", "Pessoas, Animais, Natureza"],
  },
  {
    slug: "mas", acronym: "MAS", name: "Movimento Alternativa Socialista",
    // Site blocks automated requests (HTTP 406); address not re-confirmed.
    website: "http://www.mas.org.pt/", assemblySeats: 0,
    // "MAS" alone is "BUT" in an all-caps headline.
    terms: ["Movimento Alternativa Socialista", ...inContext("MAS")],
  },
  {
    slug: "livre", acronym: "L", name: "LIVRE",
    website: "https://partidolivre.pt/", assemblySeats: 6,
    // "Livre" alone is common: "Mercado Livre", "Entrada Livre".
    terms: ["LIVRE", ...inContext("Livre")],
  },
  {
    slug: "jpp", acronym: "JPP", name: "Juntos pelo Povo",
    website: "http://juntospelopovo.pt/", assemblySeats: 1,
    terms: ["JPP", "Juntos pelo Povo"],
  },
  {
    slug: "adn", acronym: "ADN", name: "Alternativa Democrática Nacional",
    website: "https://adn.com.pt/", assemblySeats: 0,
    // "ADN" also means DNA in Portuguese, and "o ADN do clube" is common usage.
    terms: ["Alternativa Democrática Nacional", ...inContext("ADN", ["partido", "Partido"])],
  },
  {
    slug: "nc", acronym: "NC", name: "Nós, Cidadãos!",
    website: "http://noscidadaos.pt/", assemblySeats: 0,
    terms: ["Nós, Cidadãos!", "Nós Cidadãos", "Nós, Cidadãos"],
  },
  {
    slug: "atua", acronym: "A)T", name: "(A)TUA",
    website: null, assemblySeats: 0,
    terms: ["(A)TUA"],
  },
  {
    slug: "il", acronym: "IL", name: "Iniciativa Liberal",
    website: "https://iniciativaliberal.pt/", assemblySeats: 9,
    terms: ["IL", "Iniciativa Liberal"],
  },
  {
    slug: "chega", acronym: "CH", name: "CHEGA",
    // Site blocks automated requests; address taken from Wikipedia.
    website: "https://partidochega.pt/", assemblySeats: 60,
    // "Chega" alone is also a verb: "Chega a Lisboa".
    terms: ["CHEGA", ...inContext("Chega")],
  },
  {
    slug: "rir", acronym: "R.I.R.", name: "Reagir Incluir Reciclar",
    website: null, assemblySeats: 0,
    terms: ["R.I.R.", "Reagir Incluir Reciclar", ...inContext("RIR")],
  },
  {
    slug: "volt", acronym: "VP", name: "Volt Portugal",
    website: "https://voltportugal.org/", assemblySeats: 0,
    terms: ["Volt Portugal", ...inContext("Volt")],
  },
  {
    slug: "nova-direita", acronym: "ND", name: "Nova Direita",
    website: "https://novadireita.pt/", assemblySeats: 0,
    terms: ["Nova Direita"],
  },
  {
    slug: "pls", acronym: "PLS", name: "Partido Liberal Social",
    website: "https://partidoliberalsocial.pt/", assemblySeats: 0,
    terms: ["PLS", "Partido Liberal Social"],
  },
  {
    slug: "tu", acronym: "TU", name: "Trabalhadores Unidos",
    website: null, assemblySeats: 0,
    // "TU" alone is "YOU" in an all-caps headline.
    terms: ["Trabalhadores Unidos", ...inContext("TU", ["partido", "Partido"])],
  },
];
