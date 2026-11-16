import type { InitiativeStatus } from "../db/schema.js";

/*
 * Plain-language readings of initiatives, by rule (no AI): what each kind of initiative is,
 * where it stands, its title without the legal boilerplate, and its topics. The wording is
 * in Portuguese because it is shown to readers as is.
 */

export interface PlainType {
  label: string;
  explainer: string;
  /** Whether approving it changes the law (laws, the Constitution, decree reviews, treaties). */
  makesLaw: boolean;
}

const TYPES: Record<string, PlainType> = {
  "Projeto de Lei": {
    label: "Proposta de lei dos deputados",
    explainer:
      "Uma lei nova ou uma alteração a uma lei, proposta por deputados. Só passa a valer se for aprovada no Parlamento, promulgada pelo Presidente da República e publicada em Diário da República.",
    makesLaw: true,
  },
  "Proposta de Lei": {
    label: "Proposta de lei do Governo",
    explainer:
      "Uma lei nova ou uma alteração a uma lei, proposta pelo Governo ou por uma assembleia regional. Faz o mesmo caminho: votação no Parlamento, promulgação e publicação.",
    makesLaw: true,
  },
  "Projeto de Resolução": {
    label: "Recomendação",
    explainer:
      "Uma recomendação ou tomada de posição do Parlamento, quase sempre dirigida ao Governo. Não é uma lei: o Governo não é obrigado a cumpri-la.",
    makesLaw: false,
  },
  "Proposta de Resolução": {
    label: "Tratado ou acordo internacional",
    explainer: "O Governo pede ao Parlamento que aprove um tratado ou acordo internacional assinado por Portugal.",
    makesLaw: true,
  },
  "Projeto de Deliberação": {
    label: "Decisão interna do Parlamento",
    explainer: "Uma decisão sobre o funcionamento do próprio Parlamento: calendário, comissões, conferências.",
    makesLaw: false,
  },
  "Apreciação Parlamentar": {
    label: "Revisão de um decreto do Governo",
    explainer:
      "Deputados pedem ao Parlamento que reveja um decreto-lei do Governo. O decreto pode ser alterado ou deixar de valer.",
    makesLaw: true,
  },
  "Inquérito Parlamentar": {
    label: "Comissão de inquérito",
    explainer: "Pedido para criar uma comissão de deputados que investiga um caso ou a atuação do Governo.",
    makesLaw: false,
  },
  "Projeto de Revisão Constitucional": {
    label: "Alteração à Constituição",
    explainer: "Proposta para mudar a Constituição. Precisa dos votos de dois terços dos deputados.",
    makesLaw: true,
  },
};

export const plainType = (type: string): PlainType =>
  TYPES[type] ?? { label: type, explainer: "", makesLaw: false };

export type PlainStage =
  | "submitted"
  | "committee"
  | "consultation"
  | "debate"
  | "approved_in_principle"
  | "approved"
  | "awaiting_president"
  | "vetoed"
  | "promulgated"
  | "published"
  | "rejected"
  | "not_admitted"
  | "withdrawn";

export interface PlainStatusInput {
  type: string;
  status: InitiativeStatus;
  phase: string;
  publishedAt: string | null;
  presidency: { status: "pending" | "promulgated" | "vetoed" } | null;
  lastVote: { phase: string; result: string } | null;
}

/** Where it stands, in one short phrase, and a stage for icons or a progress bar. */
export const plainStatus = (i: PlainStatusInput): { label: string; stage: PlainStage } => {
  const law = plainType(i.type).makesLaw;
  if (i.status === "withdrawn") return { label: "Retirada pelos autores", stage: "withdrawn" };
  if (i.status === "rejected") {
    return /Não admissão/i.test(i.phase)
      ? { label: "Não admitida", stage: "not_admitted" }
      : { label: "Chumbada", stage: "rejected" };
  }
  if (i.status === "approved") {
    if (i.publishedAt) return { label: law ? "Aprovada e publicada" : "Aprovada", stage: "published" };
    if (i.presidency?.status === "vetoed") return { label: "Vetada pelo Presidente da República", stage: "vetoed" };
    if (i.presidency?.status === "promulgated") return { label: "Promulgada, à espera de publicação", stage: "promulgated" };
    if (i.presidency?.status === "pending") return { label: "Aprovada, à espera do Presidente da República", stage: "awaiting_president" };
    return { label: "Aprovada no Parlamento", stage: "approved" };
  }
  if (/Não admissão/i.test(i.phase)) return { label: "Não admitida", stage: "not_admitted" };
  if (i.lastVote?.result === "Aprovado" && /generalidade/i.test(i.lastVote.phase)) {
    return { label: "Aprovada na generalidade, os detalhes estão em discussão", stage: "approved_in_principle" };
  }
  if (/Separata/i.test(i.phase)) return { label: "Em consulta pública", stage: "consultation" };
  if (/Parecer/i.test(i.phase)) return { label: "À espera de parecer", stage: "consultation" };
  if (/comiss/i.test(i.phase)) return { label: "Em análise numa comissão", stage: "committee" };
  if (/Votação|Discussão|Debate|Agendamento/i.test(i.phase)) return { label: "Em debate no Parlamento", stage: "debate" };
  return { label: "Entregue, à espera de debate", stage: "submitted" };
};

/** The steps of a law's path, for filters and tabs: each fine stage falls in one. */
export const STAGE_GROUPS = [
  { key: "submitted", label: "Entregue", plain: "Deu entrada no Parlamento e ainda não foi debatida." },
  { key: "debate", label: "Em debate", plain: "Em discussão: numa comissão, em consulta ou à espera de votação. Pode já ter sido aprovada na generalidade." },
  { key: "approved", label: "Aprovada", plain: "Aprovada pelo Parlamento, ainda não seguiu para o Presidente ou espera publicação." },
  { key: "president", label: "No Presidente", plain: "Enviada ao Presidente da República, que tem de promulgar ou vetar." },
  { key: "vetoed", label: "Vetada", plain: "O Presidente vetou e devolveu-a ao Parlamento, que pode alterá-la ou confirmá-la." },
  { key: "published", label: "Lei", plain: "Publicada em Diário da República: é lei, ou resolução, em vigor." },
  { key: "rejected", label: "Rejeitada", plain: "Chumbada numa votação, ou não admitida." },
  { key: "withdrawn", label: "Retirada", plain: "Os autores retiraram-na." },
] as const;
export type StageGroup = (typeof STAGE_GROUPS)[number]["key"];

export const STAGE_GROUP: Readonly<Record<PlainStage, StageGroup>> = {
  submitted: "submitted",
  committee: "debate",
  consultation: "debate",
  debate: "debate",
  approved_in_principle: "debate",
  approved: "approved",
  promulgated: "approved",
  awaiting_president: "president",
  vetoed: "vetoed",
  published: "published",
  rejected: "rejected",
  not_admitted: "rejected",
  withdrawn: "withdrawn",
};

/**
 * The same rules as plainStatus, grouped by STAGE_GROUP, as SQL over the initiatives table,
 * so lists can filter and count by step. Keep the two in step (a test checks they agree).
 */
export const STAGE_GROUP_SQL = `(case
  when initiatives.status = 'withdrawn' then 'withdrawn'
  when initiatives.status = 'rejected' then 'rejected'
  when initiatives.status = 'approved' then case
    when initiatives.published_at is not null then 'published'
    when initiatives.presidency->>'status' = 'vetoed' then 'vetoed'
    when initiatives.presidency->>'status' = 'pending' then 'president'
    else 'approved' end
  when initiatives.phase ~* 'Não admissão' then 'rejected'
  when (initiatives.votes->-1->>'result') = 'Aprovado' and (initiatives.votes->-1->>'phase') ~* 'generalidade' then 'debate'
  when initiatives.phase ~* '(Separata|Parecer|comiss|Votação|Discussão|Debate|Agendamento)' then 'debate'
  else 'submitted' end)`;

const LAW_REF = String.raw`(?:Lei|Decreto-Lei|Decreto Legislativo Regional|Decreto Regulamentar|Lei Orgânica|Portaria)\s*n\.?\s*[º°o]?\s*[\dA-Z/.-]+(?:,?\s*de\s+\d{1,2}\s+de\s+[a-zç]+(?:\s+de\s+\d{4})?)?`;

/**
 * The title without the legal boilerplate: parentheses that only cite the laws changed,
 * trailing "procedendo à n.ª alteração…" clauses, and "Procede à alteração da Lei n.º…
 * que …" openings. Returns the title unchanged when there's nothing to remove.
 */
export const plainTitle = (title: string): string => {
  let t = title.replace(/\s+/g, " ").trim();
  // "(6.ª alteração ao Decreto-Lei n.º 52/2022, …)", "(Altera a Lei n.º 6/2006 …)"
  t = t.replace(/\s*\((?=[^)]*(?:\bLei\b|\bDecreto|alteraç|\bAltera\b))[^)]*\)/gi, "");
  // ", procedendo à segunda alteração ao …", ", alterando a Lei n.º …", "e procede à … alteração …":
  // only when what follows is the law being changed, never new content ("e procede à criação…").
  t = t.replace(
    /[,;]?\s+(?:e\s+)?(?:procedendo|procede|alterando|revogando)\s+(?:à|ao|a|o|as|os)\s+(?:[\wªº.-]+\s+)?(?:alteraç|revogaç|Lei\b|Decreto|Código|regime|diversos diplomas).*$/iu,
    (match, offset: number) => (offset > 25 ? "" : match),
  );
  // "Procede à (terceira) alteração (à|ao|da|do) Lei n.º 45/2018, de 10 de agosto, que estabelece…"
  t = t.replace(new RegExp(String.raw`^Procede à (?:[\wªº.-]+\s+)?alteração (?:à|ao|da|do|de)\s+${LAW_REF},?\s+que\s+`, "i"), "Altera a lei que ");
  t = t.replace(/[\s,;:-]+$/, "");
  return t.length >= 15 ? t : title.replace(/\s+/g, " ").trim();
};

/** Topics, in the order shown. Patterns run on the title without accents, in lower case. */
export const TOPICS: readonly { slug: string; label: string; pattern: RegExp }[] = [
  { slug: "habitacao", label: "Habitação e urbanismo", pattern: /\b(habitac|urbanis|ordenamento do territorio|solos\b|expropriac|arrendament|rendas?\b|senhori|inquilin|alojamento local|despejo|condomini|imobiliari)/ },
  { slug: "saude", label: "Saúde", pattern: /\b(saude|sns\b|hospita|medic[oa]s?\b|medicament|enfermei|farmac|doenc|cuidados paliativos|vacina|infarmed|utentes?\b|terapia|oncolog|urgencias|medicin|demenc|terapeut|inem\b)/ },
  { slug: "educacao", label: "Educação", pattern: /\b(escola|escolar|ensino|educac|professor|docente|alunos?\b|universidad|propinas|creches?\b|pre-escolar|manuais escolares|estudantes?)/ },
  { slug: "impostos", label: "Impostos", pattern: /\b(impostos?\b|iva\b|irs\b|irc\b|imi\b|imt\b|isv\b|iuc\b|fiscal|fiscais|tributa|carga fiscal|isp\b)/ },
  { slug: "trabalho", label: "Trabalho e salários", pattern: /\b(trabalhador|trabalho\b|emprego|desemprego|salari|laboral|sindica|greve|precari|ferias\b|carreira)/ },
  { slug: "pensoes", label: "Pensões e apoios sociais", pattern: /\b(pensao|pensoes|pensionist|aposentac|seguranca social|abono|subsidio|prestac(?:ao|oes) socia|rendimento social|complemento solidario|idosos?\b|previdencia)/ },
  { slug: "justica", label: "Justiça", pattern: /\b(justica|tribuna(?:l|is)|juiz|juizes|magistrad|ministerio publico|penal|prisa|prisional|crimes?\b|criminal|advogad|processo civil|custas|arguid|processua)/ },
  { slug: "seguranca", label: "Segurança e proteção civil", pattern: /\b(polici|psp\b|gnr\b|forcas de seguranca|seguranca interna|criminalidade|bombeiro|protecao civil|incendio|emergencia medica|calamidade|tempestade|meteorologic)/ },
  { slug: "defesa", label: "Defesa", pattern: /\b(defesa nacional|forcas armadas|militar|nato\b|otan\b|exercito|marinha|forca aerea|antigos combatentes)/ },
  { slug: "ambiente", label: "Ambiente e clima", pattern: /\b(ambient|clima|emissoes|floresta|biodiversidade|poluic|residuos|reciclag|conservacao da natureza|ecossistema|litoral|rios?\b|recursos hidricos|agua\b)/ },
  { slug: "energia", label: "Energia e combustíveis", pattern: /\b(energ|eletricidade|combustive|gas natural|renovave|petrol|hidrogenio)/ },
  { slug: "transportes", label: "Transportes e mobilidade", pattern: /\b(transporte|ferrovi|comboio|metro\b|metropolitano|aeroporto|portage|autoestrada|estrada|en\d+\b|ponte\b|mobilidade|tvde\b|taxi|conducao|aviacao|portos?\b|embarcac|maritim|rodoviari)/ },
  { slug: "imigracao", label: "Imigração e nacionalidade", pattern: /\b(imigra|migrant|estrangeiros|nacionalidade|reagrupamento familiar|asilo|refugiad|aima\b)/ },
  { slug: "agricultura", label: "Agricultura e pescas", pattern: /\b(agricult|agricola|pesca|pescador|pecuari|vinho|viticult|regadio|rura(?:l|is))/ },
  { slug: "economia", label: "Economia e empresas", pattern: /\b(empresa|economi|comercio|industria|turismo|investimento|pme\b|startup|banca\b|bancos?\b|bancari|inflacao|custo de vida|precos?\b|consumidor)/ },
  { slug: "cultura", label: "Cultura e desporto", pattern: /\b(cultur|patrimonio (?:cultural|historic|arquitet|arqueolog|imaterial|classificad)|monumento|museu|artes?\b|artistas?|cinema|livros?\b|desport|futebol|atleta|comunicacao social|jornalis)/ },
  { slug: "igualdade", label: "Igualdade e direitos", pattern: /\b(igualdade|discrimina|violencia domestica|violencia contra as mulheres|genero|lgbt|deficiencia|racismo|direitos humanos|criancas|liberdade sexual|vitimas|transgener|prostituic)/ },
  { slug: "animais", label: "Animais", pattern: /\b(animais|animal\b|caes\b|gatos\b|bem-estar animal)/ },
  { slug: "transparencia", label: "Transparência e corrupção", pattern: /\b(corrupc|transparencia|lobbying|financiamento dos partidos|enriquecimento|conflitos? de interesses|incompatibilidades|branqueamento|escrutinio)/ },
  { slug: "estado", label: "Estado e autarquias", pattern: /\b(administracao publica|funcao publica|trabalhadores em funcoes publicas|autarqui|municipi|freguesias?\b|descentraliza|regionaliza|eleitora|eleic|orcamento do estado|setor empresarial do estado|regioes autonomas)/ },
  { slug: "digital", label: "Digital e ciência", pattern: /\b(digita|internet|dados pessoais|inteligencia artificial|ciencia|cientific|investigacao cientifica|tecnolog|ciberseguranca|id\.gov|plataforma eletronica)/ },
  { slug: "internacional", label: "Europa e internacional", pattern: /\b(europe|uniao europeia|internaciona|tratado|acordo entre|convencao|embaixad|ucrania|israel|palestin|gaza|deslocacao do presidente|estados unidos|cplp)/ },
];

const normalise = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Topic slugs for a title, in TOPICS order. */
export const topicsOf = (title: string): string[] => {
  const text = normalise(title);
  return TOPICS.filter((topic) => topic.pattern.test(text)).map((topic) => topic.slug);
};
