import { describe, expect, it } from "vitest";
import { dhondt } from "../src/elections/dhondt.js";

describe("dhondt", () => {
  it("shares seats by the largest quotients", () => {
    // The textbook example: 7 seats.
    const result = dhondt([{ list: "A", votes: 100_000 }, { list: "B", votes: 80_000 }, { list: "C", votes: 30_000 }, { list: "D", votes: 20_000 }], 7);
    expect(result.lists.map((l) => [l.list, l.seats])).toEqual([["A", 3], ["B", 3], ["C", 1], ["D", 0]]);
    // Quotients: A 100k 50k 33.3k | B 80k 40k 26.7k | C 30k: B's third wins the last seat.
    expect(result.lastSeat).toEqual({ list: "B", quotient: 26_666.67 });
    expect(result.firstLoser).toEqual({ list: "A", quotient: 25_000 });
    expect(result.lists[0]!.quotients.slice(0, 3)).toEqual([100_000, 50_000, 33_333.33]);
  });

  it("says how many votes each list was short of one more seat", () => {
    const result = dhondt([{ list: "A", votes: 100_000 }, { list: "B", votes: 80_000 }, { list: "C", votes: 30_000 }, { list: "D", votes: 20_000 }], 7);
    const short = Object.fromEntries(result.lists.map((l) => [l.list, l.votes + l.votesShortOfNextSeat!]));
    // D must beat B's 26 667; A needs a 4th quotient above it; C a 2nd one.
    expect(short.D).toBe(26_667);
    expect(short.A).toBe(106_667);
    expect(short.C).toBe(53_334);
    // B holds the last seat itself: a 4th seat must beat C's 30 000 with votes / 4.
    expect(short.B).toBe(120_001);
    // Checking: with those votes each would indeed win one more.
    for (const list of ["A", "B", "C", "D"]) {
      const input = result.lists.map((l) => ({ list: l.list, votes: l.list === list ? short[list]! : l.votes }));
      const before = result.lists.find((l) => l.list === list)!.seats;
      expect(dhondt(input, 7).lists.find((l) => l.list === list)!.seats).toBe(before + 1);
    }
  });

  it("gives a tied last seat to the list with fewer votes", () => {
    // A's 2nd quotient and B's 1st are both 50; B has fewer votes.
    const result = dhondt([{ list: "A", votes: 100 }, { list: "B", votes: 50 }], 2);
    expect(result.lists.map((l) => [l.list, l.seats])).toEqual([["A", 1], ["B", 1]]);
  });

  it("handles lists with no votes and no seats", () => {
    const result = dhondt([{ list: "A", votes: 10 }, { list: "B", votes: 0 }], 1);
    expect(result.lists).toMatchObject([{ list: "A", seats: 1, votesShortOfNextSeat: null }, { list: "B", seats: 0 }]);
    expect(dhondt([{ list: "A", votes: 10 }], 0)).toMatchObject({ lastSeat: null, lists: [{ seats: 0 }] });
  });
});
