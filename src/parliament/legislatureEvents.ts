/*
 * What happened in each legislature, kept by hand: main laws and reforms, crises,
 * controversies, and economic or international moments. Every event has at least one source.
 * Wording rules (see docs/legislatures-api.md): neutral, factual, and for criminal cases the
 * exact legal stage as of a date, never more. Governments taking office or falling aren't
 * repeated here: the legislature page has them from src/government/history.ts.
 */

export type LegislatureEventKind = "law" | "policy" | "crisis" | "controversy" | "economy" | "international" | "society";

export interface LegislatureEvent {
  date: string;
  /** How much of the date is known: "month" and "year" dates use the first day. */
  precision: "day" | "month" | "year";
  kind: LegislatureEventKind;
  title: string;
  summary: string;
  /** About a criminal case: the summary gives the legal stage as of a date. */
  judicial: boolean;
  sources: { url: string; title: string; publisher: string }[];
}

export const LEGISLATURE_EVENTS: Readonly<Record<string, readonly LegislatureEvent[]>> = {
  "Constituinte": [
    {
      "date": "1975-06-25",
      "precision": "day",
      "kind": "international",
      "title": "Independência de Moçambique",
      "summary": "Moçambique tornou-se independente, no quadro do processo de descolonização iniciado após o 25 de Abril. Cabo Verde, São Tomé e Príncipe e Angola seguir-se-iam no mesmo ano.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Independência_de_Moçambique",
          "title": "Independência de Moçambique",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1975-07-09",
      "precision": "day",
      "kind": "crisis",
      "title": "PS sai do IV Governo Provisório por causa do caso República",
      "summary": "O PS abandonou o Governo em protesto contra a ocupação do jornal República e a falta de resposta do Conselho da Revolução, abrindo a crise política do chamado Verão Quente de 1975.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Verão_Quente",
          "title": "Verão Quente",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1975-07-29",
      "precision": "day",
      "kind": "law",
      "title": "Decreto-Lei 406-A/75 define o regime de expropriações da reforma agrária",
      "summary": "O Ministério da Agricultura e Pescas fixou o regime de expropriação de terras que enquadrou a reforma agrária, sobretudo no Alentejo e Ribatejo.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Reforma_agrária_em_Portugal",
          "title": "Reforma agrária em Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1975-11-11",
      "precision": "day",
      "kind": "international",
      "title": "Independência de Angola",
      "summary": "Na véspera, o alto-comissário português declarou o fim da administração portuguesa e entregou a soberania \"ao povo angolano\", sem destinatário definido. O MPLA proclamou a independência em Luanda, em plena guerra civil.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Independência_de_Angola",
          "title": "Independência de Angola",
          "publisher": "Wikipédia"
        },
        {
          "url": "https://pt.wikipedia.org/wiki/Retornados",
          "title": "Retornados",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1975-11-12",
      "precision": "day",
      "kind": "crisis",
      "title": "Cerco à Assembleia Constituinte",
      "summary": "Uma manifestação de trabalhadores da construção civil junto a São Bento deixou deputados e membros do Governo retidos no edifício durante a noite. Os trabalhos da Constituinte foram suspensos.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2015/05/23/deputados-sem-comida-sem-cama-sem-saida/",
          "title": "Deputados sem comida, sem cama, sem saída",
          "publisher": "Observador"
        },
        {
          "url": "https://www.rtp.pt/noticias/politica/constituinte-tomou-posse-ha-50-anos-para-fazer-a-constituicao-de-um-povo-em-revolucao_n1658933",
          "title": "Constituinte tomou posse há 50 anos para fazer a Constituição de um povo em revolução",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "1975-11-25",
      "precision": "day",
      "kind": "crisis",
      "title": "25 de Novembro põe fim ao PREC",
      "summary": "Unidades militares ligadas à esquerda radical ocuparam bases e a RTP; o Presidente Costa Gomes decretou o estado de sítio parcial em Lisboa e a rebelião foi travada. O COPCON foi extinto e o processo revolucionário terminou.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Golpe_de_25_de_Novembro_de_1975",
          "title": "Golpe de 25 de Novembro de 1975",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1975-12-07",
      "precision": "day",
      "kind": "international",
      "title": "Indonésia invade Timor-Leste",
      "summary": "A Indonésia invadiu Timor-Leste, território ainda sob responsabilidade portuguesa. A 22 de dezembro, o Conselho de Segurança da ONU aprovou por unanimidade a Resolução 384, pedindo a retirada indonésia.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Indonesian_invasion_of_East_Timor",
          "title": "Indonesian invasion of East Timor",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "1976-02-26",
      "precision": "day",
      "kind": "policy",
      "title": "Segundo Pacto MFA-Partidos",
      "summary": "Partidos e Conselho da Revolução assinaram um novo acordo constitucional após o 25 de Novembro, comprometendo as Forças Armadas com o regime democrático pluripartidário e moldando o texto final da Constituição.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/especiais/o-processo-constitucional-em-curso/",
          "title": "O processo constitucional em curso",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "1976-04-02",
      "precision": "day",
      "kind": "law",
      "title": "Aprovada a Constituição da República Portuguesa",
      "summary": "A Assembleia Constituinte aprovou a Constituição, com voto contra apenas do CDS, e o Presidente promulgou-a no mesmo dia. Entrou em vigor a 25 de abril de 1976.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/constituinte-tomou-posse-ha-50-anos-para-fazer-a-constituicao-de-um-povo-em-revolucao_n1658933",
          "title": "Constituinte tomou posse há 50 anos para fazer a Constituição de um povo em revolução",
          "publisher": "RTP"
        },
        {
          "url": "https://observador.pt/especiais/o-processo-constitucional-em-curso/",
          "title": "O processo constitucional em curso",
          "publisher": "Observador"
        }
      ]
    }
  ],
  "I": [
    {
      "date": "1976-09-22",
      "precision": "day",
      "kind": "international",
      "title": "Portugal adere ao Conselho da Europa",
      "summary": "Portugal tornou-se membro do Conselho da Europa, um primeiro passo da integração europeia que o I Governo Constitucional definiu como prioridade.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/I_Governo_Constitucional_de_Portugal",
          "title": "I Governo Constitucional de Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1976-12-12",
      "precision": "day",
      "kind": "society",
      "title": "Primeiras eleições autárquicas democráticas",
      "summary": "Realizaram-se as primeiras eleições para os órgãos locais depois do 25 de Abril. PS e PPD conquistaram 115 câmaras cada; a abstenção rondou os 35%.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Eleições_autárquicas_portuguesas_de_1976",
          "title": "Eleições autárquicas portuguesas de 1976",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1977-01-01",
      "precision": "year",
      "kind": "economy",
      "title": "Primeiro recurso ao FMI",
      "summary": "Perante o desequilíbrio externo, Portugal recorreu a acordos stand-by com o FMI em 1977 e 1978, num total de 99,8 milhões de DSE, com medidas de austeridade associadas. Os montantes foram reembolsados.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.imf.org/external/np/exr/countryfacts/prt",
          "title": "Portugal and the IMF",
          "publisher": "Fundo Monetário Internacional"
        },
        {
          "url": "https://observador.pt/especiais/30-anos-o-percurso-acidentado-de-portugal-ate-a-europa/",
          "title": "30 anos: o percurso acidentado de Portugal até à Europa",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "1977-03-28",
      "precision": "day",
      "kind": "international",
      "title": "Portugal pede a adesão à CEE",
      "summary": "O Governo de Mário Soares apresentou o pedido formal de adesão à Comunidade Económica Europeia. As negociações durariam cerca de oito anos.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/cultura/cerimonia-no-mosteiro-dos-jeronimos-assinala-40-anos-da-adesao-a-cee_e1661438",
          "title": "Cerimónia no Mosteiro dos Jerónimos assinala 40 anos da adesão à CEE",
          "publisher": "RTP"
        },
        {
          "url": "https://en.wikipedia.org/wiki/1986_enlargement_of_the_European_Communities",
          "title": "1986 enlargement of the European Communities",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "1977-09-29",
      "precision": "day",
      "kind": "law",
      "title": "Lei Barreto altera a reforma agrária",
      "summary": "A Lei 77/77, conhecida pelo nome do ministro da Agricultura António Barreto, fixou as bases gerais da reforma agrária e procurou moderar o processo de ocupações e expropriações de 1975.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Reforma_agrária_em_Portugal",
          "title": "Reforma agrária em Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1979-07-13",
      "precision": "day",
      "kind": "crisis",
      "title": "Primeira dissolução do Parlamento e eleições intercalares",
      "summary": "Depois de Mota Pinto se demitir, invocando obstrução do Parlamento ao Orçamento e ao Plano, Eanes anunciou a dissolução da Assembleia. As eleições de 2 de dezembro de 1979 deram maioria absoluta à AD.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.noticiasaominuto.com/politica/1886902/legislativas-as-sete-dissolues-do-parlamento-desde-o-25-de-abril",
          "title": "Legislativas: as sete dissoluções do Parlamento desde o 25 de Abril",
          "publisher": "Notícias ao Minuto"
        },
        {
          "url": "https://pt.wikipedia.org/wiki/Eleições_legislativas_portuguesas_de_1979",
          "title": "Eleições legislativas portuguesas de 1979",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1979-09-15",
      "precision": "day",
      "kind": "law",
      "title": "Criação do Serviço Nacional de Saúde",
      "summary": "A Lei 56/79, preparada por António Arnaut, criou o Serviço Nacional de Saúde, concretizando o direito à saúde previsto na Constituição.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Serviço_Nacional_de_Saúde",
          "title": "Serviço Nacional de Saúde",
          "publisher": "Wikipédia"
        },
        {
          "url": "https://observador.pt/opiniao/quem-criou-o-sns/",
          "title": "Quem criou o SNS?",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "1979-11-01",
      "precision": "month",
      "kind": "law",
      "title": "Lei da amnistia confirmada após veto de Eanes",
      "summary": "O Parlamento confirmou, contra o veto político do Presidente, uma amnistia proposta pelo PS para crimes políticos posteriores ao 25 de Abril, incluindo os ligados às sublevações de 1975. PSD, CDS e UDP votaram contra.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2023/05/11/parlamento-confirmou-14-leis-vetadas-desde-1979-e-vai-aprovar-a-15-a-a-da-eutanasia/",
          "title": "Parlamento confirmou 14 leis vetadas desde 1979",
          "publisher": "Observador"
        }
      ]
    }
  ],
  "II": [
    {
      "date": "1980-12-04",
      "precision": "day",
      "kind": "crisis",
      "title": "Queda do avião em Camarate mata Sá Carneiro e Amaro da Costa",
      "summary": "O avião que levava o primeiro-ministro e o ministro da Defesa caiu em Camarate, matando os sete ocupantes. Dez comissões parlamentares chegaram a conclusões diferentes (acidente ou atentado); o processo judicial prescreveu em 2006 sem conclusão.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Caso_Camarate",
          "title": "Caso Camarate",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1981-07-01",
      "precision": "month",
      "kind": "crisis",
      "title": "Conselho da Revolução trava abertura da banca à iniciativa privada",
      "summary": "O Conselho da Revolução rejeitou a lei que abria a banca a privados, gerando um conflito com o Governo da AD que levou Pinto Balsemão a demitir-se a 10 de agosto, antes de formar novo executivo.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/VII_Governo_Constitucional_de_Portugal",
          "title": "VII Governo Constitucional de Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1982-08-12",
      "precision": "day",
      "kind": "law",
      "title": "Primeira revisão constitucional extingue o Conselho da Revolução",
      "summary": "Aprovada com 195 votos (PSD, CDS, PS, PPM, ASDI e UEDS) e votos contra de PCP e UDP, a revisão acabou com o Conselho da Revolução, criou o Tribunal Constitucional e flexibilizou a organização económica.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2016/04/01/nos-40-anos-da-constituicao-portuguesa-ja-aprovadas-sete-revisoes-ao-texto/",
          "title": "Nos 40 anos da Constituição portuguesa já aprovadas sete revisões ao texto",
          "publisher": "Observador"
        },
        {
          "url": "https://www.parlamento.pt/RevisoesConstitucionais/Paginas/default.aspx",
          "title": "Revisões Constitucionais",
          "publisher": "Assembleia da República"
        }
      ]
    },
    {
      "date": "1982-12-11",
      "precision": "day",
      "kind": "law",
      "title": "Lei de Defesa Nacional aprovada apesar do veto de Eanes",
      "summary": "A Lei de Defesa Nacional e das Forças Armadas, que subordinou as Forças Armadas ao poder político civil, foi vetada pelo Presidente e depois aprovada de novo pelo Parlamento.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2023/05/11/parlamento-confirmou-14-leis-vetadas-desde-1979-e-vai-aprovar-a-15-a-a-da-eutanasia/",
          "title": "Parlamento confirmou 14 leis vetadas desde 1979",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "1982-12-12",
      "precision": "day",
      "kind": "crisis",
      "title": "AD perde terreno nas autárquicas e Balsemão demite-se",
      "summary": "A AD venceu as eleições locais mas perdeu terreno e a maioria absoluta em Lisboa e no Porto. Uma semana depois, Pinto Balsemão anunciou a demissão irrevogável.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/VIII_Governo_Constitucional_de_Portugal",
          "title": "VIII Governo Constitucional de Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1983-01-23",
      "precision": "day",
      "kind": "crisis",
      "title": "Eanes dissolve o Parlamento contra parecer do Conselho de Estado",
      "summary": "Em vez de aceitar o novo Governo da AD proposto com Vítor Crespo, Eanes anunciou a dissolução da Assembleia, formalizada a 4 de fevereiro, apesar de o Conselho de Estado se ter pronunciado contra.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.noticiasaominuto.com/politica/1886902/legislativas-as-sete-dissolues-do-parlamento-desde-o-25-de-abril",
          "title": "Legislativas: as sete dissoluções do Parlamento desde o 25 de Abril",
          "publisher": "Notícias ao Minuto"
        },
        {
          "url": "https://pt.wikipedia.org/wiki/VIII_Governo_Constitucional_de_Portugal",
          "title": "VIII Governo Constitucional de Portugal",
          "publisher": "Wikipédia"
        }
      ]
    }
  ],
  "III": [
    {
      "date": "1983-08-16",
      "precision": "day",
      "kind": "law",
      "title": "Banca, seguros, cimentos e adubos abertos à iniciativa privada",
      "summary": "A Lei 11/83 autorizou o Governo a abrir estes setores a empresas privadas, o que fez pelo Decreto-Lei 406/83, de novembro. Em 1985 o Tribunal Constitucional considerou ambos os diplomas conformes à Constituição.",
      "judicial": false,
      "sources": [
        {
          "url": "https://kohenavocats.com/en/jurisprudences/acordao-tribunal-constitucional-ate-1998-processo-83-087i-1985-02-06/",
          "title": "Acórdão do Tribunal Constitucional, Processo 83-087I, 1985-02-06",
          "publisher": "Kohen Avocats (jurisprudência)"
        },
        {
          "url": "https://observador.pt/2017/01/07/bloco-central-quando-mario-soares-precisou-de-mota-pinto-para-governar/",
          "title": "Bloco Central: quando Mário Soares precisou de Mota Pinto para governar",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "1983-10-09",
      "precision": "day",
      "kind": "economy",
      "title": "Segundo programa do FMI e austeridade do Bloco Central",
      "summary": "O FMI anunciou um empréstimo a Portugal após negociações com o Governo PS-PSD. Seguiram-se aumentos de impostos, congelamento do investimento público e corte no subsídio de Natal, num período de salários em atraso e desemprego.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/arquivo/diario-de-noticias/cavaco-silva-recusou-se-a-chefiar-negociacoes-com-o-fmi.html",
          "title": "Cavaco Silva recusou-se a chefiar negociações com o FMI",
          "publisher": "Diário de Notícias"
        },
        {
          "url": "https://observador.pt/2017/01/07/bloco-central-quando-mario-soares-precisou-de-mota-pinto-para-governar/",
          "title": "Bloco Central: quando Mário Soares precisou de Mota Pinto para governar",
          "publisher": "Observador"
        },
        {
          "url": "https://www.imf.org/external/np/exr/countryfacts/prt",
          "title": "Portugal and the IMF",
          "publisher": "Fundo Monetário Internacional"
        }
      ]
    },
    {
      "date": "1984-02-14",
      "precision": "day",
      "kind": "law",
      "title": "Aprovada a primeira lei sobre interrupção voluntária da gravidez",
      "summary": "O Parlamento aprovou um diploma do PS que deixou de punir o aborto em casos de violação, malformação do feto ou risco para a vida ou saúde da mulher. PSD (na maioria) e CDS votaram contra. Tornou-se a Lei 6/84.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/politica/marcelo-nao-acredito-que-portugal-possa-vir-a-recuar-no-aborto-deixou-de-existir-como-questao-14859062.html/",
          "title": "Marcelo: \"Não acredito que Portugal possa vir a recuar no aborto\"",
          "publisher": "Diário de Notícias"
        }
      ]
    },
    {
      "date": "1984-06-19",
      "precision": "day",
      "kind": "controversy",
      "title": "Operação Orion: detenções no caso FP-25, incluindo Otelo",
      "summary": "A polícia deteve dezenas de suspeitos de ligação à organização armada FP-25; no dia seguinte foi detido Otelo Saraiva de Carvalho. O julgamento começou em julho de 1985.",
      "judicial": true,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Forças_Populares_25_de_Abril",
          "title": "Forças Populares 25 de Abril",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "1985-06-12",
      "precision": "day",
      "kind": "international",
      "title": "Assinado o Tratado de Adesão à CEE nos Jerónimos",
      "summary": "Mário Soares e outros membros do Governo assinaram em Lisboa o tratado de adesão de Portugal às Comunidades Europeias, no mesmo dia que Espanha. No dia seguinte, o PSD saiu do Governo.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/cultura/cerimonia-no-mosteiro-dos-jeronimos-assinala-40-anos-da-adesao-a-cee_e1661438",
          "title": "Cerimónia no Mosteiro dos Jerónimos assinala 40 anos da adesão à CEE",
          "publisher": "RTP"
        },
        {
          "url": "https://observador.pt/especiais/30-anos-o-percurso-acidentado-de-portugal-ate-a-europa/",
          "title": "30 anos: o percurso acidentado de Portugal até à Europa",
          "publisher": "Observador"
        }
      ]
    }
  ],
  "IV": [
    {
      "date": "1986-01-01",
      "precision": "day",
      "kind": "international",
      "title": "Portugal entra na CEE",
      "summary": "Entrou em vigor o tratado de adesão e Portugal tornou-se membro das Comunidades Europeias, passando a receber fundos de apoio ao desenvolvimento.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/cultura/cerimonia-no-mosteiro-dos-jeronimos-assinala-40-anos-da-adesao-a-cee_e1661438",
          "title": "Cerimónia no Mosteiro dos Jerónimos assinala 40 anos da adesão à CEE",
          "publisher": "RTP"
        },
        {
          "url": "https://www.dn.pt/política/portugal-entrou-na-cee-h-40-anos-um-processo-longo-e-duro-que-transformou-um-pas-com-fortes-marcas-da-ditadura",
          "title": "Portugal entrou na CEE há 40 anos",
          "publisher": "Diário de Notícias"
        }
      ]
    },
    {
      "date": "1986-01-01",
      "precision": "day",
      "kind": "economy",
      "title": "IVA entra em vigor",
      "summary": "O Código do IVA, criado em 1984 para cumprir as regras europeias, entrou em vigor e substituiu o antigo imposto de transações.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/opiniao/iva-para-que-te-quero/",
          "title": "IVA, para que te quero?",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "1986-10-14",
      "precision": "day",
      "kind": "law",
      "title": "Lei de Bases do Sistema Educativo alarga escolaridade obrigatória",
      "summary": "A Lei 46/86 estabeleceu um ensino básico universal, gratuito e obrigatório de nove anos, dos 6 aos 15 anos. Até então a escolaridade obrigatória era de seis anos.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Ensino_básico_em_Portugal",
          "title": "Ensino básico em Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1987-04-03",
      "precision": "day",
      "kind": "crisis",
      "title": "Moção de censura do PRD derruba o Governo de Cavaco Silva",
      "summary": "A moção do PRD, apoiada por PS, PCP e MDP/CDE, foi a primeira aprovada em democracia, num quadro de conflito entre o Governo minoritário e o Parlamento. Soares recusou um governo PS-PRD e dissolveu a Assembleia.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.noticiasaominuto.com/politica/1886902/legislativas-as-sete-dissolues-do-parlamento-desde-o-25-de-abril",
          "title": "Legislativas: as sete dissoluções do Parlamento desde o 25 de Abril",
          "publisher": "Notícias ao Minuto"
        },
        {
          "url": "https://www.rtp.pt/noticias/politica/a-decada-de-betao-do-cavaquismo_es901116",
          "title": "A \"década de betão\" do cavaquismo",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "1987-04-13",
      "precision": "day",
      "kind": "international",
      "title": "Declaração Conjunta sobre Macau assinada em Pequim",
      "summary": "Cavaco Silva e Zhao Ziyang acordaram a transferência da administração de Macau para a China a 20 de dezembro de 1999, com 50 anos de autonomia sob o princípio \"um país, dois sistemas\".",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Declaração_Conjunta_Sino-Portuguesa",
          "title": "Declaração Conjunta Sino-Portuguesa",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1987-05-01",
      "precision": "month",
      "kind": "controversy",
      "title": "Otelo condenado em primeira instância no processo FP-25",
      "summary": "Otelo Saraiva de Carvalho foi condenado em primeira instância a 15 anos de prisão; a pena foi depois fixada em 17 anos em recurso. O Tribunal Constitucional anulou parcialmente a sentença em 1989 e o Parlamento aprovou uma amnistia em 1996.",
      "judicial": true,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Forças_Populares_25_de_Abril",
          "title": "Forças Populares 25 de Abril",
          "publisher": "Wikipedia"
        }
      ]
    }
  ],
  "V": [
    {
      "date": "1988-03-28",
      "precision": "day",
      "kind": "society",
      "title": "Greve geral conjunta CGTP-UGT contra o pacote laboral",
      "summary": "Pela primeira vez, as duas centrais sindicais convocaram juntas uma greve geral, contra o pacote de leis laborais do Governo, que alterava regras de despedimento. Os sindicatos falaram em grande adesão; Cavaco Silva chamou-lhe \"parcialíssima\".",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/arquivo/diario-de-noticias/pacote-laboral-de-cavaco-uniu-centrais-sindicais-desavindas.html",
          "title": "Pacote laboral de Cavaco uniu centrais sindicais desavindas",
          "publisher": "Diário de Notícias"
        }
      ]
    },
    {
      "date": "1988-07-01",
      "precision": "month",
      "kind": "policy",
      "title": "Aprovada a lei que permite as primeiras privatizações",
      "summary": "Com oposição do PCP, foi aprovada a lei que permitiu vender parte do capital de empresas nacionalizadas. As primeiras privatizações parciais foram a Unicer e o Banco Totta & Açores.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/a-decada-de-betao-do-cavaquismo_es901116",
          "title": "A \"década de betão\" do cavaquismo",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "1988-09-26",
      "precision": "day",
      "kind": "law",
      "title": "Revogada a Lei Barreto da reforma agrária",
      "summary": "A Lei 109/88 revogou definitivamente a Lei 77/77, encerrando o enquadramento legal da reforma agrária iniciada em 1975.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Reforma_agrária_em_Portugal",
          "title": "Reforma agrária em Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1989-01-01",
      "precision": "day",
      "kind": "economy",
      "title": "Reforma fiscal cria o IRS e o IRC",
      "summary": "Entrou em vigor a reforma fiscal decidida em 1988, que substituiu os impostos anteriores sobre rendimentos pelo IRS e pelo IRC.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/a-decada-de-betao-do-cavaquismo_es901116",
          "title": "A \"década de betão\" do cavaquismo",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "1989-07-08",
      "precision": "day",
      "kind": "law",
      "title": "Segunda revisão constitucional acaba com a irreversibilidade das nacionalizações",
      "summary": "Negociada entre PSD e PS, a revisão permitiu reprivatizar empresas nacionalizadas, retirou da Constituição o conceito de reforma agrária, abriu a televisão a privados e reduziu o número de deputados.",
      "judicial": false,
      "sources": [
        {
          "url": "https://vlex.pt/vid/lei-constitucional-julho-33099638",
          "title": "Lei Constitucional n.º 1/89, de 08 de Julho de 1989",
          "publisher": "vLex (texto do Diário da República)"
        },
        {
          "url": "https://observador.pt/2016/04/01/nos-40-anos-da-constituicao-portuguesa-ja-aprovadas-sete-revisoes-ao-texto/",
          "title": "Nos 40 anos da Constituição portuguesa já aprovadas sete revisões ao texto",
          "publisher": "Observador"
        },
        {
          "url": "https://www.rtp.pt/noticias/politica/a-decada-de-betao-do-cavaquismo_es901116",
          "title": "A \"década de betão\" do cavaquismo",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "1990-01-01",
      "precision": "year",
      "kind": "controversy",
      "title": "Caso do fax de Macau leva à saída do governador Carlos Melancia",
      "summary": "O governador de Macau foi acusado de corrupção passiva ligada ao concurso do aeroporto e deixou o cargo, negando sempre as acusações. Foi absolvido em primeira instância em 1993; após recursos, o processo terminou em 2002 sem condenação.",
      "judicial": true,
      "sources": [
        {
          "url": "https://observador.pt/2022/10/24/morreu-carlos-melancia-antigo-governador-de-macau-aos-95-anos/",
          "title": "Morreu Carlos Melancia, antigo governador de Macau, aos 95 anos",
          "publisher": "Observador"
        },
        {
          "url": "https://en.wikipedia.org/wiki/Carlos_Melancia",
          "title": "Carlos Melancia",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "1990-02-01",
      "precision": "month",
      "kind": "policy",
      "title": "Anunciada a abertura da televisão a privados e o fim da taxa",
      "summary": "Cavaco Silva anunciou uma nova lei da televisão e o fim da taxa de televisão. As licenças para os primeiros canais privados (SIC e TVI) foram atribuídas em 1991.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/a-decada-de-betao-do-cavaquismo_es901116",
          "title": "A \"década de betão\" do cavaquismo",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "1990-04-05",
      "precision": "day",
      "kind": "law",
      "title": "Lei-quadro das privatizações",
      "summary": "A Lei 11/90 fixou as regras para reprivatizar empresas nacionalizadas depois de 1974: transformação em sociedades anónimas, avaliação independente prévia e venda preferencialmente por concurso ou bolsa.",
      "judicial": false,
      "sources": [
        {
          "url": "https://vlex.pt/vid/lei-33165811",
          "title": "Lei n.º 11/90, de 05 de Abril de 1990",
          "publisher": "vLex (texto do Diário da República)"
        }
      ]
    },
    {
      "date": "1990-08-24",
      "precision": "day",
      "kind": "law",
      "title": "Lei de Bases da Saúde",
      "summary": "A Lei 48/90 definiu um SNS universal e \"tendencialmente gratuito\", após a revisão de 1989, previu taxas moderadoras e enquadrou a coexistência e contratação de prestadores privados e sociais.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/opiniao/a-economia-e-a-politica-da-saude/",
          "title": "A economia e a política da saúde",
          "publisher": "Observador"
        },
        {
          "url": "https://www.pgdlisboa.pt/leis/lei_mostra_articulado.php?nid=2035&tabela=leis",
          "title": "Decreto-Lei n.º 113/2011 (refere a Base XXXIV da Lei 48/90)",
          "publisher": "Procuradoria-Geral Distrital de Lisboa"
        }
      ]
    },
    {
      "date": "1991-05-31",
      "precision": "day",
      "kind": "international",
      "title": "Acordos de Bicesse com mediação portuguesa",
      "summary": "Com mediação do Governo português, José Eduardo dos Santos (MPLA) e Jonas Savimbi (UNITA) assinaram um acordo de paz para Angola que previa a desmobilização e eleições multipartidárias em 1992.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Bicesse_Accords",
          "title": "Bicesse Accords",
          "publisher": "Wikipedia"
        }
      ]
    }
  ],
  "VI": [
    {
      "date": "1992-01-01",
      "precision": "day",
      "kind": "international",
      "title": "Portugal assume pela primeira vez a presidência das Comunidades Europeias",
      "summary": "No primeiro semestre de 1992, sob o lema «Rumo à União Europeia», a presidência liderada por Cavaco Silva ficou marcada pela assinatura do Tratado de Maastricht (7 de fevereiro), do acordo do Espaço Económico Europeu no Porto (2 de maio) e pela reforma da PAC.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.cmjornal.pt/politica/amp/cinco-principais-momentos-da-participacao-portuguesa-na-uniao-europeia",
          "title": "Cinco principais momentos da participação portuguesa na União Europeia",
          "publisher": "Correio da Manhã"
        },
        {
          "url": "https://observador.pt/2020/11/02/presidencia-da-ue-portugal-preside-pela-quarta-vez-a-uniao-europeia-a-partir-de-janeiro/",
          "title": "Presidência da UE: Portugal preside pela quarta vez à União Europeia a partir de janeiro",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "1992-04-06",
      "precision": "day",
      "kind": "economy",
      "title": "Escudo entra no Mecanismo de Taxas de Câmbio do Sistema Monetário Europeu",
      "summary": "O escudo aderiu ao mecanismo cambial do SME com uma banda de flutuação de 6%, depois de um período em que o Banco de Portugal o acompanhava informalmente. Manteve-se no mecanismo até à adoção do euro, em 1999.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.bportugal.pt/sites/default/files/anexos/papers/ab200306_p.pdf",
          "title": "A experiência do escudo no MTC e a eficácia da gestão cambial",
          "publisher": "Banco de Portugal"
        }
      ]
    },
    {
      "date": "1992-10-01",
      "precision": "month",
      "kind": "society",
      "title": "SIC inicia emissões, primeira televisão privada em Portugal",
      "summary": "Depois de o Governo ter atribuído em 1991–1992 licenças de televisão à SIC e à TVI, a SIC começou a emitir em outubro de 1992, abrindo a televisão portuguesa a operadores privados.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/a-decada-de-betao-do-cavaquismo_es901116",
          "title": "A \"década de betão\" do cavaquismo",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "1992-11-25",
      "precision": "day",
      "kind": "law",
      "title": "Terceira revisão constitucional adapta a Constituição a Maastricht",
      "summary": "A Lei Constitucional n.º 1/92 adaptou a Constituição ao Tratado da União Europeia: permitiu que cidadãos da UE residentes em Portugal votem nas eleições europeias e retirou ao Banco de Portugal a exclusividade da emissão de moeda, abrindo caminho ao euro.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Constituição_portuguesa_de_1976",
          "title": "Constituição portuguesa de 1976",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1993-06-01",
      "precision": "month",
      "kind": "controversy",
      "title": "Ministro do Ambiente sai após anedota sobre mortes na hemodiálise de Évora",
      "summary": "Depois da morte de 25 doentes da unidade de hemodiálise de Évora, com níveis elevados de alumínio no sangue, o ministro Carlos Borrego deixou o Governo por ter contado publicamente uma anedota sobre o caso. Foi substituído por Teresa Patrício Gouveia.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/os-dias-quentes-do-primeiro-ministro-cavaco-silva_es901117",
          "title": "Os dias quentes do primeiro-ministro Cavaco Silva",
          "publisher": "RTP"
        },
        {
          "url": "https://pt.wikipedia.org/wiki/XII_Governo_Constitucional_de_Portugal",
          "title": "XII Governo Constitucional de Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1993-11-24",
      "precision": "day",
      "kind": "society",
      "title": "Polícia carrega sobre estudantes na escadaria do Parlamento",
      "summary": "No auge dos protestos contra a subida das propinas, a primeira desde 1941, a polícia carregou sobre estudantes junto à Assembleia da República. Em dezembro, Mário Soares vetou a regulamentação das propinas e o ministro Couto dos Santos saiu do Governo.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/os-dias-quentes-do-primeiro-ministro-cavaco-silva_es901117",
          "title": "Os dias quentes do primeiro-ministro Cavaco Silva",
          "publisher": "RTP"
        },
        {
          "url": "https://www.sabado.pt/portugal/detalhe/couto-dos-santos-1949-2025-o-ministro-das-questoes-dificeis-que-enfrentou-uma-geracao-em-protesto",
          "title": "Couto dos Santos (1949-2025): o ministro das questões difíceis que enfrentou uma geração em protesto",
          "publisher": "Sábado"
        }
      ]
    },
    {
      "date": "1994-06-24",
      "precision": "day",
      "kind": "crisis",
      "title": "Bloqueio da Ponte 25 de Abril contra o aumento das portagens",
      "summary": "Camiões bloquearam o acesso sul da ponte em protesto contra a subida da portagem de 100 para 150 escudos, após dias de buzinões. A intervenção policial deixou um jovem baleado e paraplégico; o episódio é apontado como o início do fim do cavaquismo.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/poder/bloqueio-da-ponte-o-principio-do-fim-do-cavaquismo-foi-ha-25-anos-11035094.html",
          "title": "Bloqueio da ponte. O princípio do fim do cavaquismo foi há 25 anos",
          "publisher": "DN"
        }
      ]
    }
  ],
  "VII": [
    {
      "date": "1996-07-01",
      "precision": "day",
      "kind": "law",
      "title": "Arranca o Rendimento Mínimo Garantido",
      "summary": "O Governo de Guterres, com Ferro Rodrigues na Solidariedade, criou o Rendimento Mínimo Garantido, prestação não contributiva com programa de inserção. Começou com projetos-piloto e foi depois alargado ao país; mais tarde deu lugar ao Rendimento Social de Inserção.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/economia/rsi-um-quarto-de-seculo-a-dividir-a-esquerda-e-a-direita-em-portugal_n1330639",
          "title": "RSI. Um quarto de século a dividir a esquerda e a direita em Portugal",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "1997-09-20",
      "precision": "day",
      "kind": "law",
      "title": "Quarta revisão constitucional muda regras eleitorais e do referendo",
      "summary": "A Lei Constitucional n.º 1/97 permitiu círculos uninominais, fixou entre 180 e 230 deputados, criou a iniciativa legislativa de cidadãos, deu voto aos emigrantes nas presidenciais e tornou obrigatório referendar a regionalização.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Constituição_portuguesa_de_1976",
          "title": "Constituição portuguesa de 1976",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "1998-05-22",
      "precision": "day",
      "kind": "society",
      "title": "Abre a Expo 98 em Lisboa",
      "summary": "A exposição mundial dedicada aos oceanos decorreu até 30 de setembro, com 143 países representados e mais de 10 milhões de visitantes. A zona oriental de Lisboa reconvertida deu origem ao Parque das Nações.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Expo_%2798",
          "title": "Expo '98",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "1998-06-28",
      "precision": "day",
      "kind": "policy",
      "title": "Referendo sobre o aborto: vence o «não» com baixa participação",
      "summary": "O «não» à despenalização da interrupção voluntária da gravidez até às 10 semanas venceu com 50,9% contra 49,1%. Votaram 31,9% dos eleitores; o resultado não foi vinculativo, mas a lei manteve-se inalterada.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/1998_Portuguese_abortion_referendum",
          "title": "1998 Portuguese abortion referendum",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "1998-11-08",
      "precision": "day",
      "kind": "policy",
      "title": "Referendo rejeita a criação das regiões administrativas",
      "summary": "Cerca de 63,5% dos votantes disseram «não» à instituição das regiões administrativas, com uma participação de 48,1%. A regionalização prevista na Constituição não avançou.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/1998_Portuguese_regionalisation_referendum",
          "title": "1998 Portuguese regionalisation referendum",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "1999-01-01",
      "precision": "day",
      "kind": "economy",
      "title": "Portugal entra no euro entre os 11 países fundadores",
      "summary": "O euro foi lançado como moeda escritural, com a taxa de conversão fixada em 200,482 escudos por euro. As notas e moedas só entrariam em circulação em 2002.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/descodificador/20-anos-do-euro-o-que-precisa-de-saber/05-e-estao-todos-no-euro-desde-o-inicio/",
          "title": "20 anos do euro. O que precisa de saber",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "1999-09-15",
      "precision": "day",
      "kind": "international",
      "title": "Crise em Timor-Leste mobiliza Portugal; ONU aprova força internacional",
      "summary": "Após o referendo de 30 de agosto, em que 78,5% votaram pela independência, milícias e forças indonésias lançaram uma vaga de violência que gerou forte mobilização pública em Portugal. A 15 de setembro, o Conselho de Segurança aprovou a força multinacional INTERFET.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/1999_East_Timorese_crisis",
          "title": "1999 East Timorese crisis",
          "publisher": "Wikipedia"
        },
        {
          "url": "https://www.dn.pt/arquivo/diario-de-noticias/a-festa-do-referendo-timorense-ficou-manchada-pela-violencia-das-milicias-11250352.html",
          "title": "A festa do referendo timorense ficou manchada pela violência das milícias",
          "publisher": "DN"
        }
      ]
    }
  ],
  "VIII": [
    {
      "date": "1999-12-20",
      "precision": "day",
      "kind": "international",
      "title": "Macau passa para a soberania da China",
      "summary": "À meia-noite terminou a administração portuguesa de Macau, que passou a Região Administrativa Especial da China. Jorge Sampaio e António Guterres estiveram na cerimónia de transferência.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Transfer_of_sovereignty_over_Macau",
          "title": "Transfer of sovereignty over Macau",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "2000-01-01",
      "precision": "day",
      "kind": "international",
      "title": "Segunda presidência portuguesa da UE lança a Estratégia de Lisboa",
      "summary": "No primeiro semestre de 2000, a presidência liderada por Guterres fez aprovar a Estratégia de Lisboa, para a competitividade e a economia digital, e promoveu a primeira cimeira UE-África, no Cairo.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2020/11/02/presidencia-da-ue-portugal-preside-pela-quarta-vez-a-uniao-europeia-a-partir-de-janeiro/",
          "title": "Presidência da UE: Portugal preside pela quarta vez à União Europeia a partir de janeiro",
          "publisher": "Observador"
        },
        {
          "url": "https://www.cmjornal.pt/politica/amp/cinco-principais-momentos-da-participacao-portuguesa-na-uniao-europeia",
          "title": "Cinco principais momentos da participação portuguesa na União Europeia",
          "publisher": "Correio da Manhã"
        }
      ]
    },
    {
      "date": "2000-01-01",
      "precision": "year",
      "kind": "crisis",
      "title": "Orçamentos passam graças ao «deputado limiano» do CDS",
      "summary": "Com o PS a um deputado da maioria absoluta, o Governo viabilizou orçamentos com o voto do deputado do CDS Daniel Campelo, de Ponte de Lima, num acordo que ficou conhecido como «orçamento limiano».",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/guterres-o-quarto-secretario-geral-do-ps-dos-estados-gerais-ao-pantano-politico_v1479999",
          "title": "Guterres. O quarto secretário-geral do PS, dos Estados Gerais ao \"pântano político\"",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2000-11-29",
      "precision": "day",
      "kind": "law",
      "title": "Consumo de drogas deixa de ser crime",
      "summary": "A Lei n.º 30/2000 transformou o consumo e a posse para consumo próprio em contraordenação, com encaminhamento para comissões de dissuasão da toxicodependência. Entrou em vigor em julho de 2001; o tráfico continuou a ser crime.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Drug_policy_of_Portugal",
          "title": "Drug policy of Portugal",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "2000-12-01",
      "precision": "month",
      "kind": "controversy",
      "title": "Armando Vara e Luís Patrão saem do Governo por causa de fundação",
      "summary": "O ministro da Juventude e Desporto e o secretário de Estado da Administração Interna saíram, por proposta de Guterres, após notícias de irregularidades no financiamento público da Fundação para a Prevenção e Segurança. Segundo o Observador, o caso acabou arquivado.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/demissao-de-vara-foi-uma-iniciativa-de-guterres-apesar-da-pressao-de-sampaio_n988780",
          "title": "Demissão de Vara foi uma iniciativa de Guterres apesar da pressão de Sampaio",
          "publisher": "RTP / Lusa"
        },
        {
          "url": "https://observador.pt/especiais/a-historia-completa-da-ascensao-queda-e-prisao-de-armando-vara/",
          "title": "A história completa da ascensão, queda e prisão de Armando Vara",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2001-03-04",
      "precision": "day",
      "kind": "society",
      "title": "Queda da ponte de Entre-os-Rios mata 59 pessoas; Jorge Coelho demite-se",
      "summary": "Um pilar da ponte Hintze Ribeiro, sobre o Douro, cedeu e arrastou um autocarro e três carros. O ministro do Equipamento Social, Jorge Coelho, demitiu-se nessa madrugada, assumindo a responsabilidade política: «a culpa não pode morrer solteira».",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Hintze_Ribeiro_disaster",
          "title": "Hintze Ribeiro disaster",
          "publisher": "Wikipedia"
        },
        {
          "url": "https://www.noticiasaominuto.com/politica/1727143/jorge-coelho-da-esquerda-radical-a-ministro-sorridente",
          "title": "Jorge Coelho, da esquerda radical a ministro sorridente",
          "publisher": "Notícias ao Minuto / Lusa"
        }
      ]
    },
    {
      "date": "2001-12-12",
      "precision": "day",
      "kind": "law",
      "title": "Quinta revisão constitucional permite aderir ao Tribunal Penal Internacional",
      "summary": "A Lei Constitucional n.º 1/2001 permitiu a Portugal ratificar o Estatuto de Roma do Tribunal Penal Internacional e alterou regras sobre extradição, expulsão, asilo e inviolabilidade do domicílio e da correspondência.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Constituição_portuguesa_de_1976",
          "title": "Constituição portuguesa de 1976",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "2001-12-16",
      "precision": "day",
      "kind": "crisis",
      "title": "Guterres demite-se após derrota nas autárquicas para evitar o «pântano político»",
      "summary": "Na noite de uma pesada derrota do PS nas autárquicas, Guterres anunciou que pediria a demissão, argumentando que de outro modo o país cairia num «pântano político». A crise levou à dissolução do Parlamento e a eleições antecipadas.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/guterres-o-quarto-secretario-geral-do-ps-dos-estados-gerais-ao-pantano-politico_v1479999",
          "title": "Guterres. O quarto secretário-geral do PS, dos Estados Gerais ao \"pântano político\"",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2002-01-01",
      "precision": "day",
      "kind": "economy",
      "title": "Notas e moedas de euro entram em circulação",
      "summary": "Três anos depois do lançamento do euro como moeda escritural, as notas e moedas chegaram às carteiras e o escudo deixou de ser a moeda em circulação.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/descodificador/20-anos-do-euro-o-que-precisa-de-saber/05-e-estao-todos-no-euro-desde-o-inicio/",
          "title": "20 anos do euro. O que precisa de saber",
          "publisher": "ECO"
        }
      ]
    }
  ],
  "IX": [
    {
      "date": "2002-06-01",
      "precision": "month",
      "kind": "economy",
      "title": "Orçamento retificativo sobe o IVA de 17% para 19%",
      "summary": "Perante um défice de 2001 muito acima do previsto, o Governo de Durão Barroso, que descrevera o país como estando «de tanga», fez aprovar um orçamento retificativo com medidas de cerca de 0,6% do PIB, incluindo a subida do IVA e cortes no investimento.",
      "judicial": false,
      "sources": [
        {
          "url": "https://ec.europa.eu/economy_finance/economic_governance/sgp/pdf/20_scps/2002-03/02_technical_assessment/pt_2003-02-18_ta_en.pdf",
          "title": "Portugal: Technical analysis of the stability programme update (2002)",
          "publisher": "Comissão Europeia"
        },
        {
          "url": "https://www.ffms.pt/sites/default/files/2022-06/Recessao_2002-2003.pdf",
          "title": "Recessão de 2002:T1 – 2003:T2",
          "publisher": "Fundação Francisco Manuel dos Santos"
        }
      ]
    },
    {
      "date": "2002-11-05",
      "precision": "day",
      "kind": "economy",
      "title": "UE abre procedimento por défice excessivo contra Portugal",
      "summary": "O Conselho Ecofin declarou a existência de défice excessivo depois de o défice de 2001 ter chegado a 4,1% do PIB, acima do limite de 3% do Pacto de Estabilidade, quando a meta inicial era 2,2%.",
      "judicial": false,
      "sources": [
        {
          "url": "https://ec.europa.eu/economy_finance/economic_governance/sgp/pdf/20_scps/2002-03/02_technical_assessment/pt_2003-02-18_ta_en.pdf",
          "title": "Portugal: Technical analysis of the stability programme update (2002)",
          "publisher": "Comissão Europeia"
        }
      ]
    },
    {
      "date": "2002-11-23",
      "precision": "day",
      "kind": "controversy",
      "title": "Rebenta o escândalo de abusos sexuais na Casa Pia",
      "summary": "O deputado e ex-secretário de Estado Paulo Pedroso esteve em prisão preventiva em 2003, mas não foi pronunciado e o Estado foi condenado a indemnizá-lo. Em setembro de 2010, seis arguidos foram condenados em primeira instância; a Relação reviu depois parte das penas.",
      "judicial": true,
      "sources": [
        {
          "url": "https://www.dn.pt/sociedade/casa-pia-vinte-anos-de-um-dos-mais-mediaticos-processos-que-ainda-esta-por-encerrar-15375087.html",
          "title": "Casa Pia. Vinte anos de um dos mais mediáticos processos que ainda está por encerrar",
          "publisher": "DN"
        },
        {
          "url": "https://en.wikipedia.org/wiki/Casa_Pia_scandal",
          "title": "Casa Pia scandal",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "2003-03-16",
      "precision": "day",
      "kind": "international",
      "title": "Cimeira das Lajes, nos Açores, antecede a invasão do Iraque",
      "summary": "Durão Barroso acolheu na Base das Lajes George W. Bush, Tony Blair e José María Aznar, que deram ao regime de Saddam Hussein um ultimato de 24 horas. A invasão do Iraque começou dias depois, sem mandato explícito da ONU.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Azores_Summit",
          "title": "Azores Summit",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "2003-08-01",
      "precision": "month",
      "kind": "society",
      "title": "Grandes incêndios florestais devastam o centro e o sul do país",
      "summary": "No verão de 2003, o maior incêndio, iniciado em Nisa a 30 de julho, queimou mais de 41 mil hectares, e outros quatro passaram os 20 mil, de Castelo Branco ao Algarve e à Chamusca.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/lusa/incendios-um-dos-maiores-fogos-queimou-41-mil-hectares-em-2003-8577610.html",
          "title": "Incêndios: Um dos maiores fogos queimou 41 mil hectares em 2003",
          "publisher": "DN / Lusa"
        }
      ]
    },
    {
      "date": "2004-01-01",
      "precision": "year",
      "kind": "controversy",
      "title": "Assinado o contrato de compra de dois submarinos alemães",
      "summary": "Com Paulo Portas na Defesa, o Estado comprou dois submarinos ao consórcio alemão GSC. Em Portugal, o inquérito por suspeitas de corrupção no negócio foi arquivado em dezembro de 2014 sem acusação.",
      "judicial": true,
      "sources": [
        {
          "url": "https://www.cmjornal.pt/politica/detalhe/caso_dos_submarinos_arquivado",
          "title": "Caso dos submarinos arquivado",
          "publisher": "Correio da Manhã"
        }
      ]
    },
    {
      "date": "2004-06-29",
      "precision": "day",
      "kind": "international",
      "title": "Durão Barroso escolhido para presidir à Comissão Europeia",
      "summary": "Depois de o Conselho Europeu o escolher por unanimidade, Durão Barroso anunciou que deixaria o Governo para presidir à Comissão Europeia. O Parlamento Europeu aprovou-o a 22 de julho e Santana Lopes sucedeu-lhe como primeiro-ministro.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/José_Manuel_Durão_Barroso",
          "title": "José Manuel Durão Barroso",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "2004-07-24",
      "precision": "day",
      "kind": "law",
      "title": "Sexta revisão constitucional reforça autonomias regionais",
      "summary": "A Lei Constitucional n.º 1/2004 aprofundou a autonomia dos Açores e da Madeira, substituiu o Ministro da República pelo Representante da República, abriu caminho à limitação de mandatos e proibiu a discriminação em razão da orientação sexual.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Constituição_portuguesa_de_1976",
          "title": "Constituição portuguesa de 1976",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "2004-10-01",
      "precision": "month",
      "kind": "controversy",
      "title": "Marcelo Rebelo de Sousa deixa a TVI após críticas de ministro",
      "summary": "Depois de o ministro Rui Gomes da Silva criticar os comentários de Marcelo ao Governo, o comentador saiu da TVI após conversa com o presidente da Media Capital. O Governo negou pressões; a oposição acusou-o de querer calar críticos e a AACS abriu um processo.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/pais/saida-de-marcelo-da-tvi-motiva-processo-da-aacs-e-criticas-da-oposicao-sintese_n714",
          "title": "Saída de Marcelo da TVI motiva processo da AACS e críticas da oposição",
          "publisher": "RTP / Lusa"
        },
        {
          "url": "https://observador.pt/especiais/sampaio-vs-santana-fomos-comparar-as-duas-versoes/",
          "title": "Sampaio vs Santana: fomos comparar as duas versões",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2004-11-30",
      "precision": "day",
      "kind": "crisis",
      "title": "Sampaio decide dissolver o Parlamento após demissão de Henrique Chaves",
      "summary": "Dias depois de o ministro Henrique Chaves se demitir acusando Santana Lopes de «grave inversão dos valores de lealdade e verdade», Sampaio comunicou que convocaria eleições. Adiou o decreto de dissolução para salvaguardar o Orçamento de 2005; as eleições foram marcadas para 20 de fevereiro.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/especiais/sampaio-vs-santana-fomos-comparar-as-duas-versoes/",
          "title": "Sampaio vs Santana: fomos comparar as duas versões",
          "publisher": "Observador"
        },
        {
          "url": "https://www.dn.pt/politica/jorge-sampaio-o-presidente-que-acabou-com-um-governo-ao-fim-de-quatro-meses-14106935.html",
          "title": "O Presidente que acabou com um governo ao fim de quatro meses",
          "publisher": "DN"
        },
        {
          "url": "https://observador.pt/2023/11/08/o-momento-em-que-sampaio-adiou-um-despacho-para-salvar-o-orcamento-e-que-serve-de-exemplo-para-marcelo/",
          "title": "O momento em que Sampaio adiou um despacho para salvar o Orçamento",
          "publisher": "Observador"
        }
      ]
    }
  ],
  "X": [
    {
      "date": "2005-08-12",
      "precision": "day",
      "kind": "law",
      "title": "Sétima revisão constitucional permite referendar tratados europeus",
      "summary": "A Lei Constitucional n.º 1/2005 acrescentou um artigo que permite submeter a referendo a aprovação de um tratado de construção e aprofundamento da União Europeia.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Constituição_portuguesa_de_1976",
          "title": "Constituição portuguesa de 1976",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "2006-08-01",
      "precision": "month",
      "kind": "law",
      "title": "Lei da Paridade impõe um terço de cada sexo nas listas eleitorais",
      "summary": "Depois de vetar a primeira versão em junho por considerar as sanções excessivas, Cavaco Silva promulgou a lei que exige pelo menos 33,3% de candidatos de cada sexo nas listas às legislativas, autárquicas e europeias, com corte no reembolso das campanhas para quem não cumprir.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.ksl.com/article/409877",
          "title": "Portugal enacts gender quota law (dpa)",
          "publisher": "KSL / dpa"
        }
      ]
    },
    {
      "date": "2007-02-11",
      "precision": "day",
      "kind": "policy",
      "title": "Segundo referendo ao aborto: vence o «sim» à despenalização",
      "summary": "O «sim» à despenalização da interrupção voluntária da gravidez até às 10 semanas obteve 59,3%, com participação de 43,6%. Apesar de não vinculativo, o Parlamento aprovou a nova lei a 9 de março, promulgada em abril.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/2007_Portuguese_abortion_referendum",
          "title": "2007 Portuguese abortion referendum",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "2007-03-13",
      "precision": "day",
      "kind": "controversy",
      "title": "Polémica sobre a licenciatura de José Sócrates na Universidade Independente",
      "summary": "Após dúvidas levantadas na imprensa, foi apresentada queixa por falsificação de documento relativa à licenciatura do primeiro-ministro. O DCIAP concluiu não haver crime e arquivou o inquérito a 31 de julho de 2007.",
      "judicial": true,
      "sources": [
        {
          "url": "https://www.ministeriopublico.pt/comunicados/licenciatura-de-jose-socrates",
          "title": "Comunicado: Licenciatura de José Sócrates",
          "publisher": "Ministério Público (DCIAP)"
        },
        {
          "url": "https://observador.pt/especiais/os-5-casos-da-face-oculta-de-socrates-na-justica/",
          "title": "Os 5 casos da face oculta de Sócrates na justiça",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2007-12-13",
      "precision": "day",
      "kind": "international",
      "title": "Tratado de Lisboa assinado no fim da presidência portuguesa da UE",
      "summary": "A terceira presidência portuguesa, no segundo semestre de 2007, teve como prioridade o novo tratado europeu, que substituiu a Constituição rejeitada em França e nos Países Baixos. Foi assinado nos Jerónimos e entrou em vigor em dezembro de 2009.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2020/11/02/presidencia-da-ue-portugal-preside-pela-quarta-vez-a-uniao-europeia-a-partir-de-janeiro/",
          "title": "Presidência da UE: Portugal preside pela quarta vez à União Europeia a partir de janeiro",
          "publisher": "Observador"
        },
        {
          "url": "https://en.wikipedia.org/wiki/Treaty_of_Lisbon",
          "title": "Treaty of Lisbon",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "2008-01-01",
      "precision": "month",
      "kind": "policy",
      "title": "Governo troca a Ota por Alcochete para o novo aeroporto de Lisboa",
      "summary": "Depois de anos com a Ota como localização escolhida, o Governo optou pelo Campo de Tiro de Alcochete para o novo aeroporto de Lisboa. A obra não chegou a avançar nesta legislatura.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Alcochete_Airport",
          "title": "Alcochete Airport",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "2008-03-08",
      "precision": "day",
      "kind": "society",
      "title": "Cerca de 100 mil professores manifestam-se contra a avaliação docente",
      "summary": "A «Marcha da Indignação», em Lisboa, juntou cerca de 100 mil professores contra o modelo de avaliação da ministra Maria de Lurdes Rodrigues, a maior manifestação de sempre de uma classe profissional em Portugal.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/portugal/interior/sindicatos-querem-voltar-a-ter-cem-mil---na-rua-o-que-mudou-em-dez-anos-9190882.html",
          "title": "Sindicatos querem voltar a ter cem mil na rua. O que mudou em dez anos?",
          "publisher": "DN"
        }
      ]
    },
    {
      "date": "2008-11-02",
      "precision": "day",
      "kind": "economy",
      "title": "Governo nacionaliza o BPN",
      "summary": "Perante perdas e irregularidades, o Estado nacionalizou o BPN e entregou a gestão à CGD; foi vendido ao BIC em 2012. O ex-presidente do banco e ex-secretário de Estado Oliveira e Costa foi condenado em 2017, em primeira instância, a 14 anos de prisão.",
      "judicial": true,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Banco_Português_de_Negócios",
          "title": "Banco Português de Negócios",
          "publisher": "Wikipedia"
        },
        {
          "url": "https://www.dn.pt/poder/interior/primeiro-14-anos-agora-12-a-segunda-condenacao-de-oliveira-costa-10167347.html",
          "title": "Primeiro 14 anos; agora 12. Oliveira Costa continua fora da prisão",
          "publisher": "DN"
        },
        {
          "url": "https://observador.pt/2019/10/16/caso-bpn-oliveira-e-costa-condenado-por-fraude-fiscal-mas-mantem-15-anos-de-prisao/",
          "title": "Caso BPN: Oliveira e Costa condenado por fraude fiscal mas mantém 15 anos de prisão",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2009-01-23",
      "precision": "day",
      "kind": "controversy",
      "title": "Caso Freeport volta à atualidade",
      "summary": "Uma reportagem da TVI reacendeu suspeitas sobre a alteração da zona protegida do Tejo para o outlet de Alcochete, quando Sócrates era ministro do Ambiente. Sócrates nunca foi arguido; o inquérito terminou em 2010 e os dois únicos arguidos foram absolvidos em julho de 2012.",
      "judicial": true,
      "sources": [
        {
          "url": "https://observador.pt/especiais/os-5-casos-da-face-oculta-de-socrates-na-justica/",
          "title": "Os 5 casos da face oculta de Sócrates na justiça",
          "publisher": "Observador"
        },
        {
          "url": "https://www.dn.pt/arquivo/diario-de-noticias/acordao-e-lido-hoje-apos-mp-ter-pedido-absolvicao-dos-arguidos.html",
          "title": "Acórdão é lido hoje após MP ter pedido absolvição dos arguidos",
          "publisher": "DN"
        }
      ]
    }
  ],
  "XI": [
    {
      "date": "2009-10-28",
      "precision": "day",
      "kind": "controversy",
      "title": "Operação Face Oculta faz buscas, incluindo a Armando Vara",
      "summary": "A PJ fez buscas, incluindo à casa e ao gabinete no BCP do ex-ministro Armando Vara. Vara foi condenado em 2014 a cinco anos de prisão por tráfico de influências, pena confirmada pela Relação do Porto em 2017, e esteve preso até ser libertado em outubro de 2021.",
      "judicial": true,
      "sources": [
        {
          "url": "https://observador.pt/especiais/a-historia-completa-da-ascensao-queda-e-prisao-de-armando-vara/",
          "title": "A história completa da ascensão, queda e prisão de Armando Vara",
          "publisher": "Observador"
        },
        {
          "url": "https://observador.pt/especiais/os-5-casos-da-face-oculta-de-socrates-na-justica/",
          "title": "Os 5 casos da face oculta de Sócrates na justiça",
          "publisher": "Observador"
        },
        {
          "url": "https://www.sabado.pt/portugal/amp/armando-vara-detido-pela-psp-para-cumprimento-de-pena",
          "title": "Armando Vara detido pela PSP para cumprimento de pena",
          "publisher": "Sábado"
        }
      ]
    },
    {
      "date": "2010-02-11",
      "precision": "day",
      "kind": "law",
      "title": "Parlamento aprova o casamento entre pessoas do mesmo sexo",
      "summary": "A lei, que excluía a adoção, foi aprovada em votação final global, declarada constitucional pelo Tribunal Constitucional em abril e promulgada por Cavaco Silva a 17 de maio. Entrou em vigor a 5 de junho de 2010.",
      "judicial": false,
      "sources": [
        {
          "url": "https://en.wikipedia.org/wiki/Same-sex_marriage_in_Portugal",
          "title": "Same-sex marriage in Portugal",
          "publisher": "Wikipedia"
        }
      ]
    },
    {
      "date": "2010-03-08",
      "precision": "day",
      "kind": "economy",
      "title": "Primeiro pacote de austeridade perante défice de 9,4%",
      "summary": "Depois de o défice de 2009 ser revisto para 9,4% do PIB e de cortes de rating, o Governo anunciou o congelamento salarial na função pública, a retoma de privatizações e mais impostos sobre rendimentos altos.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/especiais/o-resgate-em-datas/",
          "title": "O resgate em datas",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2010-09-29",
      "precision": "day",
      "kind": "economy",
      "title": "Governo anuncia cortes salariais na função pública e IVA a 23%",
      "summary": "Num novo pacote, o Governo de Sócrates anunciou cortes de 3,5% a 10% nos salários públicos acima de 1500 euros e a subida da taxa normal do IVA para 23%, os primeiros grandes cortes da crise.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/especiais/o-resgate-em-datas/",
          "title": "O resgate em datas",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2011-03-12",
      "precision": "day",
      "kind": "society",
      "title": "Protesto «Geração à Rasca» enche as ruas do país",
      "summary": "Convocada nas redes sociais, sem ligação a partidos ou sindicatos, a manifestação contra a precariedade juntou cerca de 500 mil pessoas em várias cidades, a maior mobilização desde o 25 de Abril.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.sabado.pt/ultima-hora/detalhe/ainda-existe-uma-geracao-a-rasca-cinco-anos-depois-do-protesto",
          "title": "Ainda existe uma geração à rasca cinco anos depois do protesto?",
          "publisher": "Sábado"
        }
      ]
    },
    {
      "date": "2011-03-23",
      "precision": "day",
      "kind": "crisis",
      "title": "Parlamento chumba o PEC IV e Sócrates demite-se",
      "summary": "A oposição aprovou em bloco resoluções de rejeição do quarto Programa de Estabilidade e Crescimento, com cortes em pensões e deduções no IRS. Sócrates apresentou a demissão nesse dia e foram convocadas eleições antecipadas.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/especiais/o-resgate-em-datas/",
          "title": "O resgate em datas",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2011-04-06",
      "precision": "day",
      "kind": "economy",
      "title": "Portugal pede ajuda financeira externa",
      "summary": "Depois de o ministro das Finanças, Teixeira dos Santos, admitir publicamente a necessidade de resgate, Sócrates anunciou nessa noite o pedido de assistência à UE e ao FMI.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/especiais/o-resgate-em-datas/",
          "title": "O resgate em datas",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2011-05-03",
      "precision": "day",
      "kind": "economy",
      "title": "Acordo com a troika: empréstimo de 78 mil milhões de euros",
      "summary": "Portugal acordou com a UE e o FMI um empréstimo de 78 mil milhões de euros por três anos, em troca de um memorando de medidas de austeridade e reformas, aprovado em Conselho de Ministros a 5 de maio e pelos ministros das Finanças da UE em meados do mês.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/especiais/o-resgate-em-datas/",
          "title": "O resgate em datas",
          "publisher": "Observador"
        }
      ]
    }
  ],
  "XII": [
    {
      "date": "2011-12-22",
      "precision": "day",
      "kind": "economy",
      "title": "Estado vende 21,35% da EDP à China Three Gorges",
      "summary": "No âmbito do programa de privatizações acordado com a troika, o Governo vendeu a participação do Estado na EDP à China Three Gorges por cerca de 2,7 mil milhões de euros.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/XIX_Governo_Constitucional_de_Portugal",
          "title": "XIX Governo Constitucional de Portugal",
          "publisher": "Wikipédia"
        }
      ]
    },
    {
      "date": "2012-07-05",
      "precision": "day",
      "kind": "law",
      "title": "Tribunal Constitucional declara inconstitucional o corte dos subsídios",
      "summary": "O TC considerou inconstitucional, por violar o princípio da igualdade, a suspensão dos subsídios de férias e de Natal de funcionários públicos e pensionistas prevista no Orçamento de 2012, mas manteve o corte nesse ano.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.tribunalconstitucional.pt/tc/imprensa0200-bd1859.html",
          "title": "Comunicado de 5 de julho de 2012 (Acórdão n.º 353/12)",
          "publisher": "Tribunal Constitucional"
        }
      ]
    },
    {
      "date": "2012-09-15",
      "precision": "day",
      "kind": "society",
      "title": "Grandes manifestações contra a troika e a proposta de mudança da TSU",
      "summary": "Depois de o Governo propor subir a TSU dos trabalhadores de 11% para 18% e baixar a das empresas, milhares saíram à rua. A medida foi abandonada e substituída por um forte aumento de impostos.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2019/05/07/os-grandes-recuos-na-politica-nacional-da-tsu-aos-professores/",
          "title": "Os grandes recuos na política nacional. Da TSU aos professores",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2013-07-02",
      "precision": "day",
      "kind": "crisis",
      "title": "Crise do \"irrevogável\": saem Gaspar e Portas pede a demissão",
      "summary": "Um dia após a saída do ministro das Finanças Vítor Gaspar, Paulo Portas apresentou a demissão \"irrevogável\". Passos Coelho recusou-a e, dias depois, Portas recuou e tornou-se vice-primeiro-ministro.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/poder/paulo-portas-irrevogavel-foi-ha-cinco-anos-9537368.html",
          "title": "Paulo Portas \"irrevogável\". Foi há cinco anos",
          "publisher": "DN"
        }
      ]
    },
    {
      "date": "2013-12-05",
      "precision": "day",
      "kind": "economy",
      "title": "CTT privatizados: 70% do capital vendido em bolsa",
      "summary": "O Estado colocou 70% dos CTT em bolsa a 5,52 euros por ação e vendeu os restantes 30% em setembro de 2014, concluindo a privatização dos Correios.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2018/12/05/digital-extravia-ctt-cinco-anos-depois-vale-menos-um-terco-em-bolsa/",
          "title": "Digital extravia CTT. Cinco anos depois, vale menos um terço em bolsa",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2014-05-17",
      "precision": "day",
      "kind": "economy",
      "title": "Portugal termina o programa da troika sem programa cautelar",
      "summary": "Chegou ao fim o programa de assistência de 78 mil milhões de euros iniciado em 2011. O Governo optou por uma \"saída limpa\", sem pedir linha cautelar.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2019/05/16/cinco-anos-depois-do-resgate-da-troika-como-esta-portugal/",
          "title": "Cinco anos após a saída da troika, Portugal caminha para excedente e desemprego caiu para metade",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2014-08-03",
      "precision": "day",
      "kind": "economy",
      "title": "Banco de Portugal aplica medida de resolução ao BES e cria o Novo Banco",
      "summary": "Com o colapso do Grupo Espírito Santo, o BES foi dividido: a atividade considerada viável passou para o Novo Banco, capitalizado com 4,9 mil milhões de euros pelo Fundo de Resolução.",
      "judicial": false,
      "sources": [
        {
          "url": "https://pt.wikipedia.org/wiki/Banco_Esp%C3%ADrito_Santo",
          "title": "Banco Espírito Santo",
          "publisher": "Wikipédia"
        },
        {
          "url": "https://observador.pt/explicadores/tudo-o-que-se-sabe-sobre-o-novo-banco-e-o-bes/",
          "title": "O Novo Banco e o BES: factos e sombras",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2014-11-21",
      "precision": "day",
      "kind": "controversy",
      "title": "Operação Marquês: o ex-primeiro-ministro José Sócrates é detido",
      "summary": "Sócrates foi detido no aeroporto de Lisboa. Acusado de 22 crimes, entre eles corrupção, começou a ser julgado a 3 de julho de 2025 e nega as acusações; presume-se inocente até decisão final.",
      "judicial": true,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/pais/apos-mais-de-uma-decada-comeca-o-julgamento-da-operacao-marques_n1666502",
          "title": "Após mais de uma década, começa o julgamento da Operação Marquês",
          "publisher": "RTP"
        },
        {
          "url": "https://www.dn.pt/política/operação-marquês-mais-de-10-anos-e-50-recursos-depois-arranca-o-julgamento-de-josé-sócrates",
          "title": "Operação Marquês: mais de 10 anos e 50 recursos depois, arranca o julgamento de José Sócrates",
          "publisher": "DN"
        }
      ]
    },
    {
      "date": "2015-06-11",
      "precision": "day",
      "kind": "economy",
      "title": "Governo escolhe consórcio de Neeleman e Pedrosa para privatizar a TAP",
      "summary": "O consórcio Gateway, de David Neeleman e Humberto Pedrosa, foi escolhido para comprar até 66% da TAP, com o objetivo de recapitalizar a companhia. A operação seria depois parcialmente revertida.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.cmjornal.pt/economia/amp/david_neeleman_e_humberto_pedrosa_novos_donos_da_tap",
          "title": "David Neeleman e Humberto Pedrosa novos donos da TAP",
          "publisher": "Correio da Manhã"
        }
      ]
    }
  ],
  "XIII": [
    {
      "date": "2015-11-10",
      "precision": "day",
      "kind": "crisis",
      "title": "Acordos à esquerda e moção de rejeição derrubam o Governo PSD/CDS",
      "summary": "O PS assinou acordos separados com BE, PCP e PEV e, no mesmo dia, a moção de rejeição ao programa do Governo de Passos Coelho foi aprovada com 123 votos. Abriu caminho à chamada \"geringonça\".",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2018/11/08/geringonca-faz-tres-anos-acordo-ditou-queda-do-governo-psd-pp/",
          "title": "Geringonça faz três anos. Acordo ditou queda do Governo PSD/PP",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2015-12-20",
      "precision": "day",
      "kind": "economy",
      "title": "Resolução do Banif e venda ao Santander Totta",
      "summary": "O Banco de Portugal aplicou uma medida de resolução ao Banif e vendeu a sua atividade ao Santander Totta por 150 milhões de euros, com recurso a auxílio de Estado.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2022/11/16/governo-recorda-comunicado-do-banco-de-portugal-a-justificar-resolucao-do-banif/",
          "title": "Governo recorda comunicado do Banco de Portugal a justificar resolução do Banif",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2016-02-06",
      "precision": "day",
      "kind": "policy",
      "title": "Estado recupera 50% da TAP",
      "summary": "O Governo de António Costa chegou a acordo com o consórcio Gateway para o Estado voltar a deter 50% da TAP, mantendo a gestão privada, revertendo parte da privatização de 2015.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2016/02/06/tap-empresa-sera-privada-maior-acionista-estado/",
          "title": "TAP: \"A empresa será privada\", mas maior acionista é o Estado",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2016-02-10",
      "precision": "day",
      "kind": "law",
      "title": "Parlamento confirma adoção por casais do mesmo sexo após veto",
      "summary": "Depois do veto de Cavaco Silva, a Assembleia reconfirmou a lei com 137 votos a favor, obrigando à promulgação. A lei entrou em vigor a 1 de março de 2016.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.publico.pt/2016/02/10/politica/noticia/parlamento-confirma-decretos-da-ivg-e-adopcao-gay-1722921",
          "title": "Parlamento confirma decretos da IVG e adopção \"gay\"",
          "publisher": "Público"
        },
        {
          "url": "https://www.dn.pt/1242110976/alteracao-a-lei-permitiu-que-40-casais-homossexuais-adotassem-55-criancas-desde-2016/",
          "title": "Alteração à lei permitiu que 40 casais homossexuais adotassem 55 crianças desde 2016",
          "publisher": "DN"
        }
      ]
    },
    {
      "date": "2017-06-16",
      "precision": "day",
      "kind": "economy",
      "title": "Portugal sai do Procedimento por Défice Excessivo",
      "summary": "O Conselho da UE encerrou o procedimento aberto em 2009, depois de o défice de 2016 ter descido para 2% do PIB, abaixo do limite de 3%.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2017/06/16/portugal-vive-momento-de-viragem-com-saida-do-pde",
          "title": "Portugal vive \"momento de viragem\" com saída do PDE",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2017-06-17",
      "precision": "day",
      "kind": "society",
      "title": "Incêndio de Pedrógão Grande causa 64 mortos",
      "summary": "O incêndio fez 64 mortos, 47 deles na EN236. A comissão técnica independente apontou falhas de comando, ataque inicial insuficiente e falta de alerta às populações.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/pais/pedrogao-grande-relatorio-da-comissao-tecnica_n1033042",
          "title": "Pedrógão Grande: relatório da Comissão Técnica",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2017-06-28",
      "precision": "day",
      "kind": "controversy",
      "title": "Furto de armamento nos paióis de Tancos",
      "summary": "O caso levou à demissão do ministro da Defesa, Azeredo Lopes. Acusado no processo, foi absolvido em janeiro de 2022, absolvição mantida numa nova decisão do tribunal de Santarém em novembro de 2024.",
      "judicial": true,
      "sources": [
        {
          "url": "https://www.dn.pt/sociedade/tancos-julgamento-termina-hoje-com-leitura-do-acordao-no-tribunal-de-santarem-14469167.html",
          "title": "Tancos. Ex-ministro Azeredo Lopes absolvido. \"Saio de cabeça levantada\"",
          "publisher": "DN"
        },
        {
          "url": "https://executivedigest.sapo.pt/caso-tancos-tribunal-de-santarem-mantem-condenacoes",
          "title": "Caso Tancos: Tribunal de Santarém mantém condenações",
          "publisher": "Executive Digest"
        }
      ]
    },
    {
      "date": "2017-10-15",
      "precision": "day",
      "kind": "society",
      "title": "Incêndios de outubro e demissão da ministra da Administração Interna",
      "summary": "Os incêndios de 15 de outubro fizeram mais de 40 mortos. A 18 de outubro, Constança Urbano de Sousa demitiu-se, após críticas à resposta aos incêndios de junho e outubro.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2017/10/18/ministra-da-administracao-interna-demite-se",
          "title": "Ministra da Administração Interna demite-se",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2019-05-03",
      "precision": "day",
      "kind": "crisis",
      "title": "Costa ameaça demitir-se por causa do tempo de serviço dos professores",
      "summary": "Depois de uma comissão parlamentar aprovar a contagem integral de 9 anos, 4 meses e 2 dias, Costa anunciou que se demitiria se a medida passasse. PSD e CDS recuaram e a crise terminou.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.sabado.pt/portugal/detalhe/professores-tudo-o-que-aconteceu-ate-a-ameaca-de-demissao-de-costa",
          "title": "Professores: tudo o que aconteceu até à ameaça de demissão de Costa",
          "publisher": "Sábado"
        },
        {
          "url": "https://eco.sapo.pt/2019/05/07/os-grandes-recuos-na-politica-nacional-da-tsu-aos-professores/",
          "title": "Os grandes recuos na política nacional. Da TSU aos professores",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2019-07-19",
      "precision": "day",
      "kind": "law",
      "title": "Aprovada nova Lei de Bases da Saúde",
      "summary": "PS, BE, PCP e PAN aprovaram uma nova Lei de Bases da Saúde, que substitui a de 1990 e adia a definição do regime das parcerias público-privadas. Foi promulgada em agosto.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2019/08/16/marcelo-da-luz-verde-a-lei-de-bases-da-saude/",
          "title": "Marcelo dá luz verde à Lei de Bases da Saúde. Legislação não proíbe PPP",
          "publisher": "ECO"
        }
      ]
    }
  ],
  "XIV": [
    {
      "date": "2020-03-12",
      "precision": "day",
      "kind": "controversy",
      "title": "Morte de cidadão ucraniano sob custódia do SEF no aeroporto de Lisboa",
      "summary": "Três inspetores do SEF foram condenados em 2021 por ofensa à integridade física agravada pela morte; a Relação fixou nove anos de prisão a cada um e o Supremo manteve as penas em julho de 2022.",
      "judicial": true,
      "sources": [
        {
          "url": "https://observador.pt/2022/07/29/ihor-homeniuk-supremo-mantem-penas-de-nove-anos-de-prisao-para-inspetores-do-sef/",
          "title": "Ihor Homeniuk. Supremo mantém penas de nove anos de prisão para inspetores do SEF",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2020-03-18",
      "precision": "day",
      "kind": "policy",
      "title": "Covid-19: primeiro estado de emergência da democracia",
      "summary": "O Presidente decretou o estado de emergência, com aprovação do Parlamento, permitindo ao Governo impor confinamento e limitar a circulação. Foi renovado várias vezes.",
      "judicial": false,
      "sources": [
        {
          "url": "https://covid.ingsa.org/covid-19-policy-tracker/europe/portugal/18-march-2020-portugal-declares-state-of-emergency/",
          "title": "18 March 2020 – Portugal declares state of emergency",
          "publisher": "INGSA"
        },
        {
          "url": "https://www.rtp.pt/noticias/pais/covid-19-as-cinco-razoes-de-marcelo-rebelo-de-sousa-para-decretar-estado-de-emergencia_n1213358",
          "title": "Covid-19. As cinco razões de Marcelo Rebelo de Sousa para decretar estado de emergência",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2020-07-02",
      "precision": "day",
      "kind": "economy",
      "title": "Estado passa a controlar 72,5% da TAP",
      "summary": "Com a TAP em crise pela pandemia, o Governo acordou comprar a posição de David Neeleman por 55 milhões de euros, ficando com 72,5% do capital e evitando a nacionalização total.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2020/07/02/governo-chega-a-acordo-e-tap-nao-devera-ser-nacionalizada/",
          "title": "Acordo à vista na TAP pode evitar nacionalização. Estado reforça posição na companhia",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2021-01-01",
      "precision": "day",
      "kind": "international",
      "title": "Portugal assume a presidência do Conselho da União Europeia",
      "summary": "Durante o semestre, foram aprovados a decisão sobre recursos próprios que permitiu financiar a recuperação, a Lei Europeia do Clima e o Compromisso Social do Porto.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2021/06/30/portugal-honrou-o-lema-da-presidencia-da-uniao-europeia-diz-antonio-costa/",
          "title": "Portugal \"honrou\" o lema da presidência da União Europeia, diz António Costa",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2021-03-15",
      "precision": "day",
      "kind": "law",
      "title": "Tribunal Constitucional trava a primeira lei da eutanásia",
      "summary": "Aprovada pelo Parlamento em janeiro de 2021, a lei foi declarada inconstitucional por 7 votos contra 5, por falta de clareza de conceitos como \"lesão definitiva de gravidade extrema\".",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/pais/eutanasia-avancos-e-recuos-no-parlamento-desde-2016_n1649795",
          "title": "Eutanásia. Avanços e recuos no parlamento desde 2016",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2021-06-16",
      "precision": "day",
      "kind": "economy",
      "title": "Bruxelas aprova o Plano de Recuperação e Resiliência português",
      "summary": "O PRR de 16,6 mil milhões de euros, entre subvenções e empréstimos, foi o primeiro plano nacional aprovado pela Comissão Europeia.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2021/06/16/comissao-europeia-da-luz-verde-a-prr-portugues-anuncia-ursula-von-der-leyen/",
          "title": "Comissão Europeia dá \"luz verde\" a PRR português, anuncia Ursula von der Leyen",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2021-10-27",
      "precision": "day",
      "kind": "crisis",
      "title": "Orçamento do Estado para 2022 chumbado na generalidade",
      "summary": "Com os votos contra de PSD, BE, PCP, CDS, PEV, Chega e IL, o Orçamento foi rejeitado. O Presidente dissolveu o Parlamento e marcou eleições antecipadas para 30 de janeiro de 2022.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/pais/presidente-da-republica-convoca-eleicoes-antecipadas-para-30-de-janeiro-de-2022_n1360906",
          "title": "Presidente da República convoca eleições antecipadas para 30 de janeiro de 2022",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2021-12-03",
      "precision": "day",
      "kind": "controversy",
      "title": "Eduardo Cabrita demite-se após acusação no caso do atropelamento na A6",
      "summary": "O motorista do carro onde seguia o ministro foi acusado de homicídio por negligência pela morte de um trabalhador em junho de 2021. Cabrita demitiu-se; o processo contra ele foi arquivado em 2022.",
      "judicial": true,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2021/12/03/cabrita-demite-se-apos-acusacao-do-mp-ao-acidente-mortal/",
          "title": "Cabrita demite-se após acusação do MP ao acidente mortal",
          "publisher": "ECO"
        },
        {
          "url": "https://www.dn.pt/arquivo/diario-de-noticias/atropelamento-na-a6-processo-contra-cabrita-foi-arquivado-14846468.html",
          "title": "Atropelamento na A6. Processo contra Eduardo Cabrita foi arquivado",
          "publisher": "DN"
        }
      ]
    }
  ],
  "XV": [
    {
      "date": "2022-09-05",
      "precision": "day",
      "kind": "policy",
      "title": "Pacote \"Famílias Primeiro\" contra a inflação",
      "summary": "O Governo aprovou 2,4 mil milhões de euros em apoios: 125 euros por adulto com rendimento até 2.700 euros, 50 euros por dependente, meia pensão extra e travão de 2% nas rendas.",
      "judicial": false,
      "sources": [
        {
          "url": "https://portugal.gov.pt/gc23/comunicacao/noticias/familias-primeiro-perguntas-e-respostas",
          "title": "Famílias Primeiro - perguntas e respostas",
          "publisher": "Governo de Portugal"
        }
      ]
    },
    {
      "date": "2022-12-28",
      "precision": "day",
      "kind": "controversy",
      "title": "Indemnização na TAP leva à demissão de Pedro Nuno Santos",
      "summary": "A revelação de que a TAP pagou 500 mil euros à ex-administradora Alexandra Reis, depois nomeada secretária de Estado do Tesouro, levou às saídas desta e do ministro das Infraestruturas.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/pedro-nuno-santos-demitiu-se-do-cargo-de-ministro-das-infraestruturas-e-da-habitacao_n1456515",
          "title": "Pedro Nuno Santos demitiu-se do cargo de ministro das Infraestruturas e da Habitação",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2023-04-18",
      "precision": "day",
      "kind": "policy",
      "title": "Entra em vigor o \"IVA zero\" num cabaz de alimentos",
      "summary": "Para conter a subida dos preços, cerca de 46 bens alimentares essenciais passaram a ter IVA de 0%, inicialmente até 31 de outubro de 2023.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2023/04/18/marque-na-agenda-entra-hoje-em-vigor-o-iva-zero/",
          "title": "Marque na agenda: entra hoje em vigor o \"IVA zero\"",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2023-05-02",
      "precision": "day",
      "kind": "controversy",
      "title": "Caso Galamba: Costa recusa demissão e Marcelo discorda",
      "summary": "Após um incidente no Ministério das Infraestruturas por causa de um computador com informação sobre a TAP, que envolveu o SIS, Costa recusou a demissão de João Galamba e o Presidente discordou publicamente.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.noticiasaominuto.com/pais/2311987/galamba-mantem-se-com-o-apoio-de-costa-apesar-da-discordancia-de-marcelo",
          "title": "Galamba mantém-se com o apoio de Costa, apesar da discordância de Marcelo",
          "publisher": "Notícias ao Minuto (Lusa)"
        }
      ]
    },
    {
      "date": "2023-05-12",
      "precision": "day",
      "kind": "law",
      "title": "Parlamento confirma lei da eutanásia após veto",
      "summary": "Depois de dois chumbos no TC e dois vetos, a lei foi reconfirmada com 129 votos e promulgada a 16 de maio. Ficou por regulamentar e, por isso, não entrou em vigor.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/politica/aprovada-lei-da-eutanasia-16340966.html",
          "title": "Aprovada lei da Eutanásia. Marcelo está obrigado a promulgar",
          "publisher": "DN"
        },
        {
          "url": "https://www.rtp.pt/noticias/pais/eutanasia-avancos-e-recuos-no-parlamento-desde-2016_n1649795",
          "title": "Eutanásia. Avanços e recuos no parlamento desde 2016",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2023-09-22",
      "precision": "day",
      "kind": "law",
      "title": "Programa Mais Habitação reconfirmado após veto",
      "summary": "Vetado pelo Presidente em agosto, o pacote foi reaprovado só com votos do PS. Inclui arrendamento forçado de casas devolutas, limites a novas licenças de alojamento local e fim dos vistos gold.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2023/09/30/marcelo-promulga-mais-habitacao",
          "title": "Marcelo promulga Mais Habitação",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2023-11-07",
      "precision": "day",
      "kind": "controversy",
      "title": "Operação Influencer e demissão de António Costa",
      "summary": "Buscas e detenções sobre negócios de lítio, hidrogénio e um centro de dados em Sines levaram Costa a demitir-se. Costa nunca foi arguido; em novembro de 2025 havia nove arguidos, incluindo João Galamba, e nenhuma acusação.",
      "judicial": true,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2025/11/07/operacao-influencer-mais-um-ano-e-pouco-mudou-na-investigacao-pgr-diz-que-a-prova-e-extensa-e-complexa/",
          "title": "Operação Influencer. Mais um ano e pouco mudou na investigação. PGR diz que a prova é extensa e complexa",
          "publisher": "ECO"
        }
      ]
    }
  ],
  "XVI": [
    {
      "date": "2024-03-27",
      "precision": "day",
      "kind": "crisis",
      "title": "Impasse na eleição do presidente da Assembleia da República",
      "summary": "Aguiar-Branco só foi eleito à quarta votação, com 160 votos, após um acordo entre PSD e PS para repartir a presidência do Parlamento ao longo da legislatura.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.jornaldenegocios.pt/economia/detalhe/a-quarta-foi-de-vez-aguiar-branco-e-o-novo-presidente-da-assembleia-da-republica",
          "title": "À quarta foi de vez. Aguiar-Branco é o novo presidente da Assembleia da República",
          "publisher": "Jornal de Negócios"
        }
      ]
    },
    {
      "date": "2024-05-21",
      "precision": "day",
      "kind": "policy",
      "title": "Acordo para devolver tempo de serviço congelado aos professores",
      "summary": "Governo e sete sindicatos acordaram recuperar os 6 anos, 6 meses e 23 dias congelados, de forma faseada até 2027. Cinco sindicatos, incluindo a Fenprof, não assinaram.",
      "judicial": false,
      "sources": [
        {
          "url": "https://observador.pt/2024/05/21/governo-e-professores-retomam-negociacoes-fne-prestes-a-terminar-reuniao/",
          "title": "Professores recuperam 50% do tempo de serviço num ano e 100% até 2027. Cinco sindicatos não assinaram acordo",
          "publisher": "Observador"
        }
      ]
    },
    {
      "date": "2024-06-03",
      "precision": "day",
      "kind": "policy",
      "title": "Fim das manifestações de interesse na imigração",
      "summary": "O Plano de Ação para as Migrações, com 41 medidas, acabou com a possibilidade de quem entra com visto de turista pedir residência em Portugal. A mudança entrou em vigor no dia seguinte.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/sociedade/saiba-tudo-sobre-o-plano-de-acao-para-as-migracoes-que-ja-esta-em-vigor",
          "title": "Saiba tudo sobre o Plano de Ação para as Migrações que já está em vigor",
          "publisher": "DN (Lusa)"
        },
        {
          "url": "https://www.rtp.pt/noticias/pais/portas-abertas-nao-escancaradas-governo-apresentou-plano-de-acao-para-as-migracoes_n1576526",
          "title": "Portas 'abertas', não 'escancaradas'. Governo apresentou Plano de Ação para as Migrações",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2024-06-27",
      "precision": "day",
      "kind": "international",
      "title": "António Costa escolhido para presidente do Conselho Europeu",
      "summary": "Os líderes da UE elegeram o ex-primeiro-ministro para suceder a Charles Michel, com mandato a partir de 1 de dezembro de 2024. É o primeiro português no cargo.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2024/06/27/e-oficial-antonio-costa-vai-ser-o-novo-presidente-do-conselho-europeu/",
          "title": "É oficial. António Costa nomeado para presidente do Conselho Europeu",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2024-11-29",
      "precision": "day",
      "kind": "policy",
      "title": "Orçamento para 2025 aprovado com abstenção do PS",
      "summary": "O primeiro Orçamento do Governo de Montenegro passou com votos de PSD e CDS e abstenção do PS. Incluiu o IRS Jovem e a descida do IRC de 21% para 20%.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2024/11/29/orcamento-do-estado-para-2025-aprovado-com-a-ajuda-do-ps/",
          "title": "Orçamento do Estado para 2025 aprovado com a ajuda do PS",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2025-03-11",
      "precision": "day",
      "kind": "crisis",
      "title": "Caso Spinumviva: Parlamento chumba moção de confiança",
      "summary": "Perguntas sobre a empresa da família do primeiro-ministro e os seus clientes levaram o PS a propor um inquérito. Montenegro respondeu com uma moção de confiança, rejeitada por PS, Chega, PCP, BE, Livre e PAN.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2025/03/11/parlamento-chumba-mocao-de-confianca-e-dita-queda-do-governo/",
          "title": "Parlamento chumba moção de confiança e dita queda do Governo",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2025-04-22",
      "precision": "day",
      "kind": "law",
      "title": "TC declara inconstitucionais seis normas da lei da eutanásia",
      "summary": "A pedido de deputados do PSD e da Provedora de Justiça, o TC chumbou normas sobre a escolha do método, mas validou a quase totalidade da lei, que continuava por regulamentar.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2025/04/22/tc-declara-inconstitucionais-algumas-normas-do-diploma-da-eutanasia/",
          "title": "TC declara inconstitucionais algumas normas do diploma da eutanásia",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2025-04-28",
      "precision": "day",
      "kind": "society",
      "title": "Apagão elétrico em Portugal e Espanha",
      "summary": "A Península Ibérica ficou sem eletricidade durante horas. Os peritos europeus apontaram como causa mais provável aumentos de tensão em cascata iniciados no sul de Espanha, um fenómeno inédito na Europa.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/economia/apagao-peritos-apontam-causa-inedita-e-defendem-reforco-da-rede-eletrica-europeia_n1670743",
          "title": "Apagão. Peritos apontam causa inédita e defendem reforço da rede elétrica europeia",
          "publisher": "RTP"
        }
      ]
    }
  ],
  "XVII": [
    {
      "date": "2025-08-08",
      "precision": "day",
      "kind": "law",
      "title": "TC chumba alterações à lei de estrangeiros; nova versão aprovada depois",
      "summary": "O TC declarou inconstitucionais cinco normas sobre reagrupamento familiar e o Presidente vetou. Uma nova versão foi aprovada a 30 de setembro e promulgada a 16 de outubro de 2025.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/sociedade/tc-declara-que-mudanças-na-lei-da-imigração-não-estão-de-acordo-com-a-constituição",
          "title": "TC declara que mudanças na lei da imigração são inconstitucionais. Presidente vetou de seguida",
          "publisher": "DN"
        },
        {
          "url": "https://www.dn.pt/política/marcelo-promulga-nova-lei-dos-estrangeiros-que-limita-fluxos-de-imigrantes",
          "title": "Marcelo promulga nova Lei dos Estrangeiros, que limita fluxos de imigrantes",
          "publisher": "DN"
        }
      ]
    },
    {
      "date": "2025-09-03",
      "precision": "day",
      "kind": "society",
      "title": "Descarrilamento do Elevador da Glória faz 16 mortos",
      "summary": "O acidente em Lisboa fez 16 mortos e 23 feridos. O relatório preliminar concluiu que o cabo que unia as duas cabinas cedeu no ponto de fixação.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2025/09/06/cabo-que-unia-as-duas-cabinas-do-elevador-da-gloria-cedeu-diz-relatorio/",
          "title": "\"Cabo que unia as duas cabinas do elevador\" da Glória cedeu, diz relatório",
          "publisher": "ECO"
        }
      ]
    },
    {
      "date": "2025-12-11",
      "precision": "day",
      "kind": "society",
      "title": "Greve geral da CGTP e da UGT contra a reforma laboral",
      "summary": "Foi a primeira greve geral conjunta das duas centrais desde 2013, contra o pacote \"Trabalho XXI\" do Governo, com forte impacto nos transportes e na administração pública.",
      "judicial": false,
      "sources": [
        {
          "url": "https://eco.sapo.pt/2025/11/08/greve-geral-a-11-de-dezembro-foi-possivel-uma-convergencia-anuncia-cgtp/",
          "title": "Greve geral a 11 de dezembro. CGTP e UGT juntas contra a reforma laboral",
          "publisher": "ECO"
        },
        {
          "url": "https://www.rtp.pt/noticias/politica/dez-meses-de-braco-de-ferro-sobre-as-alteracoes-a-lei-laboral-da-proposta-trabalho-xxi_es1744370",
          "title": "Dez meses de braço de ferro sobre as alterações à lei laboral da proposta \"Trabalho XXI\"",
          "publisher": "RTP"
        }
      ]
    },
    {
      "date": "2025-12-15",
      "precision": "day",
      "kind": "law",
      "title": "Lei da Nacionalidade: TC chumba normas e nova versão entra em vigor em 2026",
      "summary": "O TC travou várias normas, incluindo a perda de nacionalidade como pena. Uma versão revista foi aprovada a 1 de abril de 2026 e promulgada a 3 de maio, subindo para 7 ou 10 anos a residência exigida.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/sociedade/tribunal-constitucional-decide-hoje-sobre-a-lei-dos-estrangeiros",
          "title": "Tribunal Constitucional chumba Lei da Nacionalidade. PSD considera que pontos centrais foram viabilizados",
          "publisher": "DN"
        },
        {
          "url": "https://www.noticiasaominuto.com/pais/2983415/pr-promulga-decreto-da-lei-da-nacionalidade-mas-desejava-maior-consenso",
          "title": "Seguro promulga Lei da Nacionalidade, mas desejava \"maior consenso\"",
          "publisher": "Notícias ao Minuto (Lusa)"
        }
      ]
    },
    {
      "date": "2026-01-28",
      "precision": "day",
      "kind": "society",
      "title": "Depressão Kristin: mortos e situação de calamidade no Centro",
      "summary": "A tempestade fez pelo menos oito mortos e grandes estragos, sobretudo no distrito de Leiria. O Governo declarou situação de calamidade em dezenas de municípios.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.dn.pt/sociedade/balano-trgico-subiu-para-oito-o-nmero-de-mortos-resultado-da-depresso-kristin",
          "title": "Balanço trágico: Subiu para oito o número de mortos resultado da depressão Kristin",
          "publisher": "DN"
        }
      ]
    },
    {
      "date": "2026-02-08",
      "precision": "day",
      "kind": "society",
      "title": "António José Seguro vence a segunda volta das presidenciais",
      "summary": "Seguro derrotou André Ventura com cerca de 66,8% dos votos, tornando-se o Presidente mais votado de sempre. Por causa das tempestades, a votação foi adiada uma semana em algumas freguesias.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.rtp.pt/noticias/politica/nao-serei-oposicao-serei-exigencia-seguro-e-o-presidente-eleito-e-o-mais-votado-de-sempre_n1717436",
          "title": "'Não serei oposição, serei exigência'. Seguro é o presidente eleito e o mais votado de sempre",
          "publisher": "RTP"
        },
        {
          "url": "https://executivedigest.sapo.pt/presidenciais-resultados-antonio-jose-seguro-eleito-presidente-com-6683-resultados-globais/",
          "title": "Presidenciais/resultados: António José Seguro eleito Presidente com 66,83%",
          "publisher": "Executive Digest"
        }
      ]
    },
    {
      "date": "2026-06-19",
      "precision": "day",
      "kind": "crisis",
      "title": "Parlamento chumba a reforma laboral do Governo",
      "summary": "A proposta de revisão da lei laboral foi rejeitada na generalidade, com votos contra de Chega, PS, Livre, PCP, BE, PAN e JPP, depois de falhadas as negociações entre PSD e Chega.",
      "judicial": false,
      "sources": [
        {
          "url": "https://www.jornaldenegocios.pt/economia/detalhe/ugt-aplaude-chumbo-da-proposta-do-governo-de-revisao-da-legislacao-laboral",
          "title": "UGT aplaude chumbo da proposta do Governo de revisão da legislação laboral",
          "publisher": "Jornal de Negócios"
        }
      ]
    },
    {
      "date": "2026-10-14",
      "precision": "day",
      "kind": "economy",
      "title": "Governo escolhe a Lufthansa para a privatização parcial da TAP",
      "summary": "O Conselho de Ministros aprovou vender 44,9% da TAP à Lufthansa, mais até 5% se os trabalhadores não os comprarem, por 1.201 milhões de euros. O Estado mantém 50,1% nesta fase.",
      "judicial": false,
      "sources": [
        {
          "url": "https://portugal.gov.pt/gc25/comunicacao/comunicados/governo-seleciona-a-lufthansa-para-aquisicao-de-ate-499-do-capital-social-da-tap",
          "title": "Governo seleciona a Lufthansa para aquisição de até 49,9% do capital social da TAP",
          "publisher": "Governo de Portugal"
        }
      ]
    }
  ]
};
