/**
 * Parliamentary group acronyms as the parliament writes them, mapped to our party slugs.
 * Only "BE" differs from our acronym ("B.E."). A group missing here is stored with no
 * party; add it when a new party enters parliament.
 */
export const GROUP_TO_PARTY_SLUG: Record<string, string> = {
  PSD: "psd",
  CH: "chega",
  PS: "ps",
  IL: "il",
  L: "livre",
  PCP: "pcp",
  "CDS-PP": "cds-pp",
  BE: "be",
  PAN: "pan",
  JPP: "jpp",
  PEV: "pev",
};

export const partySlugForGroup = (group: string | null | undefined) =>
  (group && GROUP_TO_PARTY_SLUG[group]) ?? null;
