/*
 * Who leads each party with seats in parliament. No open source says this (the parliament's
 * data only names each parliamentary group's leader), so it's kept by hand. Update it, and
 * LEADERS_AS_OF, when a party changes leader.
 */

export const LEADERS_AS_OF = "2026-11-15";

export interface PartyLeader {
  party: string;
  name: string;
  title: string;
  /** Set when they sit in parliament now. */
  deputyId: number | null;
  /** Set when they're in the Government now. */
  governmentMemberId: string | null;
}

export const PARTY_LEADERS_LIST: readonly PartyLeader[] = [
  { party: "psd", name: "Luís Montenegro", title: "Presidente do PSD", deputyId: null, governmentMemberId: "6d6019aee9774dde80cc8342401a7065" },
  { party: "chega", name: "André Ventura", title: "Presidente do CHEGA", deputyId: 6535, governmentMemberId: null },
  { party: "ps", name: "José Luís Carneiro", title: "Secretário-Geral do Partido Socialista", deputyId: 2105, governmentMemberId: null },
  { party: "il", name: "Mariana Leitão", title: "Presidente da Iniciativa Liberal", deputyId: 7973, governmentMemberId: null },
  { party: "livre", name: "Rui Tavares", title: "Porta-voz do LIVRE", deputyId: 7337, governmentMemberId: null },
  { party: "pcp", name: "Paulo Raimundo", title: "Secretário-Geral do PCP", deputyId: 8719, governmentMemberId: null },
  { party: "cds-pp", name: "Nuno Melo", title: "Presidente do CDS-PP", deputyId: null, governmentMemberId: "8c442f363dee49d7b0edeaa841b51c80" },
  { party: "be", name: "José Manuel Pureza", title: "Coordenador do Bloco de Esquerda", deputyId: null, governmentMemberId: null },
  { party: "pan", name: "Inês de Sousa Real", title: "Porta-voz do PAN", deputyId: 6864, governmentMemberId: null },
  { party: "jpp", name: "Élvio Sousa", title: "Secretário-Geral do JPP", deputyId: null, governmentMemberId: null },
];

export const leaderOf = (party: string) => PARTY_LEADERS_LIST.find((l) => l.party === party) ?? null;
