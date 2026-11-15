import { SEATS } from "../src/parliament/seatMap.js";

/** Builders for the parliament's open data files, shaped like the real ones. */

export const deputyEntry = (
  id: number,
  name: string,
  group: string,
  situation = "Efetivo",
  extra: Record<string, unknown> = {},
) => ({
  DepCadId: id,
  DepNomeParlamentar: name,
  DepNomeCompleto: `${name} Completo`,
  DepCPDes: "Lisboa",
  DepGP: [{ gpSigla: group, gpDtInicio: "2025-06-03", gpDtFim: null }],
  DepSituacao: [{ sioDes: situation, sioDtInicio: "2025-06-03", sioDtFim: null }],
  DepCargo: null,
  LegDes: "XVII",
  ...extra,
});

/** A full chamber that fits the official seat map, plus the named deputies tests use. */
export const chamber = () => {
  const named = [
    deputyEntry(7341, "Francisco César", "PS"),
    deputyEntry(817, "Alfredo Maia", "PCP"),
    deputyEntry(9001, "Ana Saída", "PSD", "Renunciou", {
      DepSituacao: [
        { sioDes: "Efetivo", sioDtInicio: "2025-06-03", sioDtFim: "2025-09-01" },
        { sioDes: "Renunciou", sioDtInicio: "2025-09-01", sioDtFim: null },
      ],
    }),
    deputyEntry(9002, "Bruno Suplente", "PS", "Suplente"),
  ];
  const remaining = new Map<string, number>();
  for (const [, group] of SEATS) remaining.set(group, (remaining.get(group) ?? 0) + 1);
  for (const entry of named) {
    if (entry.DepSituacao.at(-1)!.sioDes === "Efetivo") {
      const group = entry.DepGP[0]!.gpSigla;
      remaining.set(group, remaining.get(group)! - 1);
    }
  }
  let nextId = 100_000;
  const filler = [...remaining].flatMap(([group, n]) =>
    Array.from({ length: n }, (_, i) => deputyEntry(nextId++, `Deputado ${group} ${i}`, group)),
  );
  return { Deputados: [...named, ...filler] };
};

export const biographies = () => [
  {
    CadId: 7341,
    CadNomeCompleto: "Francisco Miguel Vital Gomes do Vale César",
    CadSexo: "M",
    CadDtNascimento: "1978-11-11",
    CadProfissao: "Economista",
    CadHabilitacoes: [{ HabDes: "Economia", HabEstado: "C" }],
    CadCargosFuncoes: [
      { FunDes: "Presidente do PS-Açores", FunAntiga: "N", FunOrdem: 0 },
      { FunDes: "Deputado regional", FunAntiga: "S", FunOrdem: 1 },
    ],
    CadActividadeOrgaos: {
      actividadeCom: [
        { orgDes: "Comissão de Agricultura", orgSigla: "CAPes", timDes: "Efetivo", legDes: "XVII", cargoDes: [{ tiaDes: "CGP" }] },
        { orgDes: "Comissão Antiga", orgSigla: "CA", timDes: "Efetivo", legDes: "XVI", cargoDes: null },
      ],
    },
    CadDeputadoLegis: [{ LegDes: "XVII" }, { LegDes: "XVI" }, { LegDes: "XV" }],
  },
];

export const event = (Fase: string, DataFase: string, Votacao: unknown[] | null = null) => ({ Fase, DataFase, Votacao });
export const vote = (id: string, resultado: string, detalhe: string | null = null, unanime: string | null = null) => ({
  id, data: null, resultado, detalhe, unanime,
});

export const initiative = (
  id: number,
  title: string,
  events: ReturnType<typeof event>[],
  authors: { groups?: string[]; deputies?: number[]; other?: string } = {},
) => ({
  IniId: String(id),
  IniLeg: "XVII",
  IniNr: String(id % 1000),
  IniTitulo: title,
  IniDescTipo: "Projeto de Lei",
  IniTipo: "J",
  IniLinkTexto: `http://app.parlamento.pt/webutils/docs/doc.pdf?path=${id}`,
  IniEventos: events,
  IniAutorGruposParlamentares: authors.groups?.map((GP) => ({ GP })) ?? null,
  IniAutorDeputados: authors.deputies?.map((idCadastro) => ({ idCadastro: String(idCadastro), nome: "x", GP: "x" })) ?? null,
  IniAutorOutros: authors.other ? { nome: authors.other, sigla: "V" } : { nome: "Grupos Parlamentares", sigla: "G" },
});

export const initiativesFile = () => [
  initiative(1, "Lei aprovada e publicada", [
    event("Entrada", "2025-07-01"),
    event("Votação na generalidade", "2025-09-10", [vote("v1", "Aprovado")]),
    event("Votação final global", "2025-10-01", [
      vote("v2", "Aprovado", "A Favor: <I>PSD</I>, <I> 3-PS</I>, <I> Pedro Vaz (PS)</I><BR>Contra:<I>CH</I><BR>Abstenção:<I>PS</I>, <I> PCP</I>"),
    ]),
    event("Envio para promulgação", "2025-10-05"),
    event("Promulgação", "2025-10-15"),
    event("Lei (Publicação DR)", "2025-10-20"),
  ], { groups: ["PS"], deputies: [7341] }),
  initiative(2, "Chumbada na generalidade", [
    event("Entrada", "2025-07-02"),
    event("Votação na generalidade", "2025-09-11", [vote("v3", "Rejeitado", "A Favor: <I>PCP</I><BR>Contra:<I>PSD</I>, <I> CH</I>")]),
  ], { groups: ["PCP"], deputies: [817] }),
  initiative(3, "Aprovada na generalidade, falta a votação final", [
    event("Entrada", "2025-07-03"),
    event("Votação na generalidade", "2025-09-12", [vote("v4", "Aprovado", null, "unanime")]),
    event("Baixa comissão especialidade", "2025-09-13"),
  ], { groups: ["PS", "L"], deputies: [7341] }),
  initiative(4, "Retirada", [
    event("Entrada", "2025-07-04"),
    event("Retirada da iniciativa", "2025-08-01"),
  ], { groups: ["CH"] }),
  initiative(5, "Proposta do Governo em discussão", [event("Entrada", "2025-11-01")], { other: "Governo" }),
];

/** A minimal "Composição dos Órgãos" file: Francisco César leads the PS group. */
export const organs = () => ({
  ConferenciaLideres: {
    HistoricoComposicao: [
      {
        depCadId: 7341,
        depSituacao: [{ sioDes: "Efetivo", sioDtInicio: "2025-06-03", sioDtFim: null }],
        depCargo: [{ carDes: "Líder de Grupo Parlamentar", carDtInicio: "2025-06-03", carDtFim: null }],
      },
    ],
  },
});

type Dataset = "deputies" | "biographies" | "initiatives" | "organs";

/** A loader for syncParliament that serves the given files. */
export const loaderFor = (files: { deputies?: unknown; biographies?: unknown; initiatives?: unknown; organs?: unknown } = {}) => {
  const data = (dataset: Dataset) =>
    ({
      deputies: files.deputies ?? chamber(),
      biographies: files.biographies ?? biographies(),
      initiatives: files.initiatives ?? initiativesFile(),
      organs: files.organs ?? organs(),
    })[dataset];
  return {
    json: async (dataset: Dataset) => data(dataset),
    items: async function* (dataset: Dataset) {
      yield* data(dataset) as unknown[];
    },
  };
};
