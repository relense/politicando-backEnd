import { ApiError } from "../errors.js";

/*
 * Screens what readers write before it's saved. Deliberately narrow: swearing and rudeness
 * pass (it's just words); what's refused is what's illegal or harmful whoever reads it:
 * other people's contact details, slurs, threats, and link spam. Edit the lists below to
 * tune it; matching ignores case and accents.
 */

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Slurs against a group (origin, colour, religion, sexuality, disability). Whole words, folded. */
const SLURS = [
  "paneleiro",
  "paneleiros",
  "panasca",
  "panascas",
  "fufa",
  "fufas",
  "monhe",
  "monhes",
  "pretalhada",
  "pretalhame",
  "ciganada",
  "zucas",
  "atrasado mental",
  "atrasados mentais",
  "mongoloide",
  "mongoloides",
  "sub-humano",
  "sub-humanos",
  "subhumanos",
];

/** "<group> de merda" and the like: an insult aimed at a group, not a person's opinion. */
const GROUPS = ["preto", "pretos", "cigano", "ciganos", "brasileiro", "brasileiros", "africano", "africanos", "muculmano", "muculmanos", "judeu", "judeus", "imigrante", "imigrantes", "gay", "gays"];

/** Threats of violence. Folded, and spaces or hyphens between words both match. */
const THREATS = [
  "vou te matar",
  "vou-te matar",
  "vamos te matar",
  "vamos-te matar",
  "te vou matar",
  "vou mata-lo",
  "vou mata-la",
  "vou-te partir",
  "vou te partir",
  "merecias morrer",
  "mereces morrer",
  "merece morrer",
  "devias morrer",
  "devia morrer",
  "devias ser morto",
  "levar um tiro",
  "levar com um tiro",
  "dar-lhe um tiro",
  "dar lhe um tiro",
  "matem-no",
  "matem-na",
  "matem-nos",
  "sei onde moras",
  "sei onde vives",
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+");
const words = (list: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "u");
const SLUR = words([...SLURS, ...GROUPS.map((g) => `${g} de merda`)]);
const THREAT = words(THREATS);

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;
/**
 * Portuguese phone numbers. Mobiles (91, 92, 93, 96) also when grouped "912 345 678"; other
 * numbers only written together or with +351, so budget figures ("200 000 000") pass.
 */
const PHONE = /(?<!\d)(?:(?:\+|00)351[\s.-]?[29]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}|9[1236]\d[\s.-]?\d{3}[\s.-]?\d{3}|2\d{8})(?!\d)/;
const LINK = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|pt|net|org|io|xyz|info|biz|ru|top)\b/gi;
const MAX_LINKS = 2;

export type ScreenResult = { code: "personal_data" | "hate" | "threat" | "too_many_links"; message: string } | null;

/** Why this text can't be published, or null. */
export const screenText = (...texts: (string | null | undefined)[]): ScreenResult => {
  const text = texts.filter(Boolean).join("\n");
  if (!text) return null;
  const folded = fold(text);
  if (EMAIL.test(text) || PHONE.test(text)) {
    return { code: "personal_data", message: "Não publiques contactos (email ou telefone): os teus ou de outra pessoa." };
  }
  if (THREAT.test(folded)) return { code: "threat", message: "Ameaças não são publicadas." };
  if (SLUR.test(folded)) return { code: "hate", message: "Insultos a grupos de pessoas não são publicados. Critica ideias, não grupos." };
  if ((text.match(LINK) ?? []).length > MAX_LINKS) {
    return { code: "too_many_links", message: `No máximo ${MAX_LINKS} links por mensagem.` };
  }
  return null;
};

/** Throws a 400 the frontend can show as is (`message` is in Portuguese) when the text is refused. */
export const assertPublishable = (...texts: (string | null | undefined)[]) => {
  const refused = screenText(...texts);
  if (refused) throw new ApiError(400, refused.code, refused.message);
};
