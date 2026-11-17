import { ApiError } from "../errors.js";

/*
 * Screens what readers write before it's saved. Like 4chan: people can be as rude as they
 * like, swear, insult politicians and each other. The only limit is what's a crime whoever
 * it's aimed at, so it's refused up front rather than waiting for reports:
 *
 * - other people's contact details (doxxing; data protection law)
 * - threats of violence (Código Penal, art. 153)
 * - attacks on a group for its origin, colour, religion, sexuality or disability: insulting
 *   or calling for violence against it (Código Penal, art. 240)
 *
 * Insults and accusations aimed at one person are left to reports (see reports.ts): whether
 * they're a crime depends on context a filter can't judge. Edit the lists below to tune it;
 * matching ignores case and accents.
 */

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Groups protected by art. 240, as the words people use for them (plural and singular). Folded. */
const ANY_GROUP = [
  "pretos", "preto", "pretas", "preta", "negros", "negro", "africanos", "africano", "ciganos", "cigano", "ciganas", "cigana",
  "brasileiros", "brasileiro", "brasileiras", "brasileira", "zucas", "zuca", "imigrantes", "imigrante", "estrangeiros", "estrangeiro",
  "indianos", "indiano", "monhes", "monhe", "chineses", "chines", "ucranianos", "ucraniano", "nepaleses", "nepales",
  "arabes", "arabe", "muculmanos", "muculmano", "islamicos", "judeus", "judeu", "cristaos", "catolicos",
  "gays", "gay", "homossexuais", "paneleiros", "paneleiro", "lesbicas", "lesbica", "trans", "transexuais", "deficientes", "deficiente",
];

/** "<group> de merda", "morte aos <group>"…: insulting a whole group, or calling for violence against it. */
const groupAttacks = ANY_GROUP.flatMap((g) => [
  `${g} de merda`,
  `${g} do caralho`,
  `morte aos ${g}`,
  `morte as ${g}`,
  `matar os ${g}`,
  `matar as ${g}`,
  `matem os ${g}`,
  `matem as ${g}`,
  `matar todos os ${g}`,
  `queimar os ${g}`,
  `exterminar os ${g}`,
  `exterminio dos ${g}`,
  `os ${g} sao uns animais`,
  `os ${g} sao animais`,
  `os ${g} sao macacos`,
  `os ${g} sao sub-humanos`,
  `os ${g} nao sao gente`,
  `os ${g} nao sao pessoas`,
]);

/** Threats of violence against someone. Folded; spaces or hyphens between words both match. */
const THREATS = [
  "vou te matar",
  "vou-te matar",
  "vamos te matar",
  "vamos-te matar",
  "te vou matar",
  "vou mata-lo",
  "vou mata-la",
  "vou-te partir todo",
  "vou te partir todo",
  "vou-te dar um tiro",
  "vou te dar um tiro",
  "vou-lhe dar um tiro",
  "vou lhe dar um tiro",
  "matem-no",
  "matem-na",
  "sei onde moras",
  "sei onde vives",
  "sei onde trabalhas",
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+");
const words = (list: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "u");
const HATE = words(groupAttacks);
const THREAT = words(THREATS);

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;
/**
 * Portuguese phone numbers. Mobiles (91, 92, 93, 96) also when grouped "912 345 678"; other
 * numbers only written together or with +351, so budget figures ("200 000 000") pass.
 */
const PHONE = /(?<!\d)(?:(?:\+|00)351[\s.-]?[29]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}|9[1236]\d[\s.-]?\d{3}[\s.-]?\d{3}|2\d{8})(?!\d)/;

export type ScreenResult = { code: "personal_data" | "hate" | "threat"; message: string } | null;

/** Why this text can't be published, or null. */
export const screenText = (...texts: (string | null | undefined)[]): ScreenResult => {
  const text = texts.filter(Boolean).join("\n");
  if (!text) return null;
  const folded = fold(text);
  if (EMAIL.test(text) || PHONE.test(text)) {
    return { code: "personal_data", message: "Não publiques contactos (email ou telefone), teus ou de outra pessoa: é ilegal divulgá-los." };
  }
  if (THREAT.test(folded)) return { code: "threat", message: "Ameaças são crime e não são publicadas." };
  if (HATE.test(folded)) {
    return { code: "hate", message: "Atacar um grupo pela origem, cor, religião ou orientação sexual é crime. Podes criticar pessoas e ideias." };
  }
  return null;
};

/** Throws a 400 the frontend can show as is (`message` is in Portuguese) when the text is refused. */
export const assertPublishable = (...texts: (string | null | undefined)[]) => {
  const refused = screenText(...texts);
  if (refused) throw new ApiError(400, refused.code, refused.message);
};
