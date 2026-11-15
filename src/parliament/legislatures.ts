/**
 * When each legislature of the Assembleia da República began (its first sitting). Each ends
 * when the next begins. Fixed history; add the next one after each general election.
 */
export const LEGISLATURES: readonly { id: string; start: string }[] = [
  { id: "Constituinte", start: "1975-06-02" },
  { id: "I", start: "1976-06-03" },
  { id: "II", start: "1980-11-13" },
  { id: "III", start: "1983-05-31" },
  { id: "IV", start: "1985-11-04" },
  { id: "V", start: "1987-08-13" },
  { id: "VI", start: "1991-11-04" },
  { id: "VII", start: "1995-10-27" },
  { id: "VIII", start: "1999-10-25" },
  { id: "IX", start: "2002-04-05" },
  { id: "X", start: "2005-03-10" },
  { id: "XI", start: "2009-10-15" },
  { id: "XII", start: "2011-06-20" },
  { id: "XIII", start: "2015-10-23" },
  { id: "XIV", start: "2019-10-25" },
  { id: "XV", start: "2022-03-29" },
  { id: "XVI", start: "2024-03-26" },
  { id: "XVII", start: "2025-06-03" },
];

/** A legislature's dates; `end` is null for the current one. Null if unknown. */
export const legislatureDates = (id: string) => {
  const i = LEGISLATURES.findIndex((l) => l.id === id);
  if (i < 0) return null;
  return { start: LEGISLATURES[i]!.start, end: LEGISLATURES[i + 1]?.start ?? null };
};
