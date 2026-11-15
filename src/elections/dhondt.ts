/*
 * The d'Hondt method, as Portuguese elections use it (Lei Eleitoral da AR, art. 16.º; the
 * same for European, regional and local councils): each list's votes are divided by 1, 2,
 * 3…, and the seats go to the largest quotients. When the last seat is a tie between
 * lists, it goes to the list with fewer votes.
 */

export interface DhondtInput {
  list: string;
  votes: number;
}

export interface DhondtResult<T extends DhondtInput> {
  lists: (T & {
    seats: number;
    /** Its first quotients (votes / 1, 2, 3…), enough to show the table. */
    quotients: number[];
    /** Extra votes it needed, all else equal, to win one more seat. Null if it won them all. */
    votesShortOfNextSeat: number | null;
  })[];
  /** The quotient that won the last seat, and whose it was. Null with no seats. */
  lastSeat: { list: string; quotient: number } | null;
  /** The first quotient that missed out. */
  firstLoser: { list: string; quotient: number } | null;
}

const QUOTIENTS_SHOWN = 6;

export const dhondt = <T extends DhondtInput>(input: T[], seats: number): DhondtResult<T> => {
  const lists = input.filter((l) => l.votes > 0);
  const quotients = lists.flatMap((l, index) =>
    Array.from({ length: seats + 1 }, (_, d) => ({ index, list: l.list, votes: l.votes, quotient: l.votes / (d + 1) })),
  );
  // Largest quotient first; on a tie, the list with fewer votes first.
  quotients.sort((a, b) => b.quotient - a.quotient || a.votes - b.votes || a.list.localeCompare(b.list));
  const winners = quotients.slice(0, seats);
  const won = new Array<number>(lists.length).fill(0);
  for (const q of winners) won[q.index]!++;
  const last = winners.at(-1);
  const loser = quotients[seats];

  return {
    lists: input
      .map((l) => {
        const index = lists.indexOf(l);
        const s = index < 0 ? 0 : won[index]!;
        // One more seat means its (s+1)th quotient ranks among the top `seats`: it must beat
        // the (seats - s)th largest quotient of the other lists (strictly, as ties favour fewer votes).
        const others = quotients.filter((q) => q.list !== l.list);
        const threshold = others[seats - s - 1]?.quotient;
        const short =
          seats - s - 1 < 0 ? null : threshold === undefined ? 0 : Math.max(0, Math.floor(threshold * (s + 1)) - l.votes + 1);
        return {
          ...l,
          seats: s,
          quotients: Array.from({ length: Math.min(QUOTIENTS_SHOWN, Math.max(seats, 1)) }, (_, d) => Math.round((l.votes / (d + 1)) * 100) / 100),
          votesShortOfNextSeat: short,
        };
      })
      .sort((a, b) => b.seats - a.seats || b.votes - a.votes),
    lastSeat: last ? { list: last.list, quotient: Math.round(last.quotient * 100) / 100 } : null,
    firstLoser: loser ? { list: loser.list, quotient: Math.round(loser.quotient * 100) / 100 } : null,
  };
};
