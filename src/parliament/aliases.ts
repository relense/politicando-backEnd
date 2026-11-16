/**
 * Shorter names the press uses for some deputies, keyed by deputy ID (cadastro).
 * The full parliamentary name always counts; these are extra.
 *
 * - `standalone`: distinctive enough to count on its own ("Aguiar-Branco").
 * - `withContext`: a common surname or name that counts only when the same article
 *   also names the deputy's party or uses their full name. "Ventura" counts in a
 *   story that mentions Chega, but a footballer called Carneiro isn't linked to PS.
 *
 * Case-sensitive whole words, like party terms. Add a test in
 * test/parliamentParse.test.ts when you add one that could be ambiguous.
 */
export const DEPUTY_ALIASES: Readonly<Record<number, { standalone?: string[]; withContext?: string[] }>> = {
  6535: { withContext: ["Ventura"] }, // André Ventura (CH)
  2105: { withContext: ["Carneiro"] }, // José Luís Carneiro (PS)
  2051: { standalone: ["Pedro Nuno"] }, // Pedro Nuno Santos (PS)
  8719: { withContext: ["Raimundo"] }, // Paulo Raimundo (PCP)
  7337: { withContext: ["Tavares"] }, // Rui Tavares (L)
  6864: { standalone: ["Sousa Real"] }, // Inês de Sousa Real (PAN)
  2061: { standalone: ["Aguiar-Branco"] }, // José Pedro Aguiar-Branco (PSD), President of the Assembly
  5600: { standalone: ["Brilhante Dias"] }, // Eurico Brilhante Dias (PS)
  1657: { withContext: ["João Almeida"] }, // João Pinho de Almeida (CDS-PP)
};
