import { describe, expect, it } from "vitest";
import { plainStatus, plainTitle, plainType, topicsOf, type PlainStatusInput } from "../src/parliament/plain.js";

describe("plainTitle", () => {
  it("drops parentheses that only cite the laws changed", () => {
    expect(plainTitle("Extinção de custas processuais (20.ª alteração ao Decreto-Lei n.º 34/2008, de 26 de fevereiro)")).toBe(
      "Extinção de custas processuais",
    );
    expect(plainTitle("Repõe a taxa reduzida de IVA à eletricidade (Altera o Código do IVA, aprovado pelo Decreto-Lei n.º 394-B/84)")).toBe(
      "Repõe a taxa reduzida de IVA à eletricidade",
    );
  });

  it("keeps parentheses that are names or places", () => {
    for (const title of [
      "Recomenda ao Governo um nó de acesso na zona de Meirinhas (Pombal) – Barracão (Leiria)",
      "Assegura a execução do Regulamento (UE) 2022/2065 (Regulamento dos Serviços Digitais)",
      "Recomenda ao Governo a criação da Empresa Nacional de Dragagens, E.P.E.",
    ]) {
      expect(plainTitle(title)).toBe(title);
    }
  });

  it("drops trailing clauses that only say which law changes, never new content", () => {
    expect(plainTitle("Reforça a formação dos magistrados, alterando a Lei n.º 2/2008, de 14 de Janeiro")).toBe(
      "Reforça a formação dos magistrados",
    );
    expect(plainTitle("Alarga as garantias de proteção às vítimas de violência doméstica, procedendo à alteração de diversos diplomas")).toBe(
      "Alarga as garantias de proteção às vítimas de violência doméstica",
    );
    const content = "Aprova regras de transparência para entidades privadas e procede à criação de um registo de transparência";
    expect(plainTitle(content)).toBe(content);
  });

  it("turns 'Procede à alteração da Lei n.º…, que…' into 'Altera a lei que…'", () => {
    expect(plainTitle("Procede à primeira alteração ao Decreto-Lei n.º 53/2009, de 2 de março, que define as regras dos radioamadores")).toBe(
      "Altera a lei que define as regras dos radioamadores",
    );
  });

  it("never returns something too short to read", () => {
    expect(plainTitle("Altera a Lei n.º 7/2009")).toBe("Altera a Lei n.º 7/2009");
  });
});

describe("topicsOf", () => {
  it("finds topics by keyword, ignoring accents and case", () => {
    expect(topicsOf("Garante rendas acessíveis para promover o direito à habitação")).toEqual(["habitacao"]);
    expect(topicsOf("Procede à redução da taxa de IVA aplicável na alimentação dos animais de companhia")).toEqual(["impostos", "animais"]);
    expect(topicsOf("Reforça o financiamento do INEM")).toEqual(["saude"]);
    expect(topicsOf("Deslocação do Presidente da República à Alemanha")).toEqual(["internacional"]);
    expect(topicsOf("Constituição de uma Comissão Eventual de Verificação de Poderes")).toEqual([]);
  });

  it("doesn't take words inside other words", () => {
    expect(topicsOf("Medidas para Leiria")).toEqual([]);
    expect(topicsOf("Mobilização do património imobiliário público para habitação")).toEqual(["habitacao"]);
    expect(topicsOf("Programa de apoio aos ivadores")).toEqual([]);
  });
});

describe("plainType", () => {
  it("explains each kind of initiative", () => {
    expect(plainType("Projeto de Resolução")).toMatchObject({ label: "Recomendação", makesLaw: false });
    expect(plainType("Proposta de Lei")).toMatchObject({ label: "Proposta de lei do Governo", makesLaw: true });
    expect(plainType("Algo novo")).toEqual({ label: "Algo novo", explainer: "", makesLaw: false });
  });
});

describe("plainStatus", () => {
  const base: PlainStatusInput = {
    type: "Projeto de Lei", status: "in_progress", phase: "Anúncio", publishedAt: null, presidency: null, lastVote: null,
  };
  const stage = (over: Partial<PlainStatusInput>) => plainStatus({ ...base, ...over }).stage;

  it("follows a law from entry to publication", () => {
    expect(stage({})).toBe("submitted");
    expect(stage({ phase: "Baixa comissão distribuição inicial generalidade" })).toBe("committee");
    expect(stage({ phase: "Publicação em Separata" })).toBe("consultation");
    expect(stage({ phase: "Baixa comissão especialidade", lastVote: { phase: "Votação na generalidade", result: "Aprovado" } })).toBe(
      "approved_in_principle",
    );
    expect(stage({ status: "approved", phase: "Votação final global" })).toBe("approved");
    expect(stage({ status: "approved", presidency: { status: "pending" } })).toBe("awaiting_president");
    expect(stage({ status: "approved", presidency: { status: "vetoed" } })).toBe("vetoed");
    expect(stage({ status: "approved", presidency: { status: "promulgated" } })).toBe("promulgated");
    expect(plainStatus({ ...base, status: "approved", publishedAt: "2025-10-20" })).toEqual({
      label: "Aprovada e publicada", stage: "published",
    });
  });

  it("says a recommendation was approved, not published as law", () => {
    expect(plainStatus({ ...base, type: "Projeto de Resolução", status: "approved", publishedAt: "2025-10-20" }).label).toBe("Aprovada");
  });

  it("covers the ends: rejected, not admitted, withdrawn", () => {
    expect(plainStatus({ ...base, status: "rejected" }).label).toBe("Chumbada");
    expect(stage({ phase: "Não admissão" })).toBe("not_admitted");
    expect(stage({ status: "withdrawn" })).toBe("withdrawn");
  });
});
