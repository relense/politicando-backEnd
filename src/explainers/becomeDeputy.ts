/*
 * "Como se chega a deputado": the rules, in plain Portuguese, each with its legal basis.
 * Shown to readers as is. Keep it to rules that are in the law; review it when the electoral
 * law changes.
 */

export interface ExplainerSection {
  id: string;
  title: string;
  body: string[];
  sources: { label: string; url: string | null }[];
}

const CONSTITUICAO = "https://www.parlamento.pt/Legislacao/Paginas/ConstituicaoRepublicaPortuguesa.aspx";

export const BECOME_DEPUTY: { title: string; reviewedAt: string; sections: ExplainerSection[] } = {
  title: "Como se chega a deputado",
  reviewedAt: "2026-11-15",
  sections: [
    {
      id: "quem-pode",
      title: "Quem pode ser deputado",
      body: [
        "Qualquer cidadão português com 18 anos ou mais e recenseado como eleitor.",
        "Há exceções enquanto exercem certas funções: por exemplo, o Presidente da República, magistrados em funções, militares e agentes das forças de segurança no ativo e diplomatas de carreira.",
      ],
      sources: [
        { label: "Constituição, art. 150.º", url: CONSTITUICAO },
        { label: "Lei Eleitoral da Assembleia da República (Lei n.º 14/79), inelegibilidades", url: null },
      ],
    },
    {
      id: "partidos",
      title: "Só os partidos apresentam listas",
      body: [
        "As listas de candidatos são apresentadas pelos partidos, sozinhos ou em coligação. Não há listas de independentes nas legislativas.",
        "Um independente pode ser candidato, mas numa lista de um partido que o convide.",
        "Ninguém pode ser candidato em mais de um círculo, nem estar em mais de uma lista.",
        "Cada partido escolhe os seus candidatos e a ordem em que aparecem, segundo as suas próprias regras internas.",
      ],
      sources: [{ label: "Constituição, art. 151.º", url: CONSTITUICAO }],
    },
    {
      id: "circulos",
      title: "Os 22 círculos",
      body: [
        "Os 230 deputados são eleitos em 22 círculos: os 18 distritos do continente, os Açores, a Madeira, a Europa e Fora da Europa.",
        "Cada círculo elege um número de deputados proporcional aos seus eleitores; os dois círculos da emigração elegem dois cada.",
        "Os círculos maiores elegem muitos deputados (Lisboa, perto de 50), os mais pequenos só dois ou três. Por isso, num círculo pequeno, um partido precisa de uma parte muito maior dos votos para eleger alguém.",
      ],
      sources: [
        { label: "Constituição, arts. 148.º e 149.º", url: CONSTITUICAO },
        { label: "Lei Eleitoral da Assembleia da República, círculos e mandatos", url: null },
      ],
    },
    {
      id: "listas-fechadas",
      title: "Vota-se numa lista, não numa pessoa",
      body: [
        "No boletim escolhe-se um partido ou coligação. Não é possível escolher candidatos nem mudar a ordem da lista.",
        "Os lugares que a lista ganha vão para os primeiros nomes, pela ordem em que o partido os pôs. O lugar na lista é, por isso, decisivo: quem vem em primeiro num círculo grande é quase certamente eleito, quem vem muito abaixo dificilmente é.",
      ],
      sources: [{ label: "Lei Eleitoral da Assembleia da República", url: null }],
    },
    {
      id: "dhondt",
      title: "Como se distribuem os lugares: o método de Hondt",
      body: [
        "Em cada círculo, os votos de cada lista são divididos por 1, 2, 3, e assim por diante. Os lugares vão para os maiores resultados, um a um, até se esgotarem.",
        "Se o último lugar ficar empatado entre listas diferentes, vai para a que teve menos votos.",
      ],
      sources: [
        { label: "Constituição, art. 149.º", url: CONSTITUICAO },
        { label: "Lei Eleitoral da Assembleia da República, art. 16.º", url: null },
      ],
    },
    {
      id: "paridade",
      title: "Paridade",
      body: [
        "Cada lista tem de ter pelo menos 40% de candidatos de cada sexo, e não pode ter mais de dois candidatos seguidos do mesmo sexo.",
      ],
      sources: [{ label: "Lei da Paridade (Lei Orgânica n.º 3/2006, alterada pela Lei Orgânica n.º 1/2019)", url: null }],
    },
    {
      id: "substituicoes",
      title: "Também se chega lá por substituição",
      body: [
        "Quando um deputado sai, suspende o mandato ou vai para o Governo, o lugar passa para o candidato seguinte da mesma lista, no mesmo círculo, que ainda não tenha sido eleito.",
        "Por isso há deputados que não foram eleitos na noite das eleições: estavam logo abaixo na lista.",
      ],
      sources: [{ label: "Estatuto dos Deputados (Lei n.º 7/93)", url: null }],
    },
    {
      id: "mandato",
      title: "Quanto tempo dura",
      body: [
        "Uma legislatura dura quatro anos, mas pode acabar mais cedo se o Presidente da República dissolver o Parlamento e marcar eleições antecipadas.",
      ],
      sources: [{ label: "Constituição, arts. 171.º e 172.º", url: CONSTITUICAO }],
    },
  ],
};
