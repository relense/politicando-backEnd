import { describe, expect, it } from "vitest";
import { importanceOf, parseLeadership } from "../src/parliament/leadership.js";
import { SEATS } from "../src/parliament/seatMap.js";
import { estimateSeats, rowOfSeat, seatsFrontToBack } from "../src/parliament/seating.js";

const open = { sioDes: "Efetivo", sioDtInicio: "2025-06-03", sioDtFim: null };
const role = (carDes: string, carDtFim: string | null = null) => ({ carDes, carDtInicio: "2025-06-03", carDtFim });

describe("parseLeadership", () => {
  it("reads current positions from each body and ignores ended ones", () => {
    const leadership = parseLeadership({
      ConferenciaLideres: {
        HistoricoComposicao: [
          { depCadId: 1, depSituacao: [open], depCargo: [role("Líder de Grupo Parlamentar")] },
          { depCadId: 2, depSituacao: [open], depCargo: [role("Líder de Grupo Parlamentar", "2025-09-01")] },
          // Situations aren't in date order: the open one decides.
          { depCadId: 3, depSituacao: [open, { sioDes: "Suspenso", sioDtInicio: "2025-01-01", sioDtFim: "2025-06-02" }], depCargo: [role("Líder de Grupo Parlamentar")] },
          { depCadId: 4, depSituacao: [{ sioDes: "Cessou", sioDtInicio: "2025-07-01", sioDtFim: null }], depCargo: [role("Líder de Grupo Parlamentar")] },
        ],
      },
      MesaAR: { HistoricoComposicaoMesa: [{ depCadId: 5, depCargo: [role("Presidente")] }] },
      Comissoes: [
        { DetalheOrgao: { nomeSigla: "Comissão de Saúde" }, HistoricoComposicao: [{ depCadId: 1, depSituacao: [open], depCargo: [role("Presidente"), role("CGP")] }] },
        { DetalheOrgao: { nomeSigla: "Comissão de Defesa" }, HistoricoComposicao: [{ depCadId: 1, depSituacao: [open], depCargo: [role("CGP")] }] },
      ],
    });
    expect(leadership.get(1)).toEqual({ positions: ["Líder do grupo parlamentar", "Presidente da Comissão de Saúde"], score: 155 });
    expect(leadership.has(2)).toBe(false);
    expect(leadership.get(3)?.positions).toEqual(["Líder do grupo parlamentar"]);
    expect(leadership.has(4)).toBe(false);
    expect(leadership.get(5)?.positions).toEqual(["Presidente da Assembleia da República"]);
  });

  it("returns nothing for a missing or odd file", () => {
    expect(parseLeadership(undefined).size).toBe(0);
    expect(parseLeadership({ ConferenciaLideres: "?" }).size).toBe(0);
  });
});

describe("importanceOf", () => {
  it("adds party leadership, positions and capped seniority, and lowers temporary substitutes", () => {
    const leadership = parseLeadership({});
    expect(importanceOf({ id: 6535, situation: "Efetivo", pastLegislatures: ["XVI", "XV"] }, leadership)).toEqual({
      positions: ["Presidente do CHEGA"],
      score: 116,
    });
    expect(importanceOf({ id: 9, situation: "Efetivo", pastLegislatures: Array(20).fill("X") }, leadership).score).toBe(24);
    expect(importanceOf({ id: 9, situation: "Efetivo Temporário", pastLegislatures: [] }, leadership).score).toBe(-15);
  });
});

describe("seating", () => {
  it("orders every group's seats from the front row back", () => {
    for (const group of new Set(SEATS.map(([, g]) => g))) {
      const seats = seatsFrontToBack(group);
      expect(seats).toHaveLength(SEATS.filter(([, g]) => g === group).length);
      const rows = seats.map((s) => rowOfSeat(s)!);
      expect(rows).toEqual([...rows].sort((a, b) => a - b));
    }
    expect(rowOfSeat(seatsFrontToBack("PSD")[0]!)).toBe(0);
  });

  it("gives the most important deputies the front seats and keeps real assignments", () => {
    const front = seatsFrontToBack("PS");
    const deputies = [
      { id: 1, group: "PS", importance: 5, name: "B" },
      { id: 2, group: "PS", importance: 100, name: "A" },
      { id: 3, group: "PS", importance: 5, name: "A" },
      { id: 4, group: "PS", importance: 200, name: "Z" },
      { id: 5, group: null, importance: 999, name: "Sem grupo" },
    ];
    const seats = estimateSeats(deputies, new Map([[4, front[5]!]]));
    expect(seats.has(4)).toBe(false);
    expect(seats.has(5)).toBe(false);
    expect([seats.get(2), seats.get(3), seats.get(1)]).toEqual([front[0], front[1], front[2]]);
  });
});
