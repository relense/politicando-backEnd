/** Names only the team uses: no account can take them, and no anonymous post can sign with them. */
export const RESERVED = new Set([
  "admin", "administrador", "administrator", "moderador", "moderator", "mod", "politicando", "redacao", "equipa", "staff",
  "suporte", "support", "root", "sistema", "system", "anonimo", "anonymous", "apagado", "deleted", "null", "undefined",
]);

/** Team words a free-text signature can't contain ("Moderação", "A Equipa", "Admin1"; accents, case and spacing ignored). */
const TEAM_WORDS = ["politicando", "admin", "moderador", "moderacao", "moderator", "redacao", "equipa", "staff", "suporte", "support"];
/** Too short to look for inside other names ("Modesto"): only on their own. */
const TEAM_EXACT = ["mod", "mods", "sistema", "system", "root"];

export const looksLikeTeam = (name: string) => {
  const plain = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return TEAM_WORDS.some((word) => plain.includes(word)) || TEAM_EXACT.includes(plain.replace(/\d+$/, ""));
};
