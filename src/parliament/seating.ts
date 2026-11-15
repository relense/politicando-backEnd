import { SEATS } from "./seatMap.js";

/*
 * Estimates who sits where when the real seating isn't known: within each party's official
 * block, the most important deputies take the front seats. Real assignments
 * (seatAssignments.ts) always win; estimated seats are flagged so the UI can say so.
 */

/** Centre of the chamber's arcs in seat-map coordinates (measured from the official drawing). */
const CENTRE = { x: 0.5, y: 0.486 };
/** Seats whose distances from the centre differ by less than this are in the same row. */
const ROW_GAP = 0.012;

const distance = (x: number, y: number) => Math.hypot(x - CENTRE.x, y - CENTRE.y);

/** Row index per seat, 0 being the front row, from clustering distances to the centre. */
const ROW_OF_SEAT = (() => {
  const distances = [...new Set(SEATS.map(([, , x, y]) => Math.round(distance(x, y) * 1000) / 1000))].sort((a, b) => a - b);
  const rowStarts: number[] = [];
  let previous = -Infinity;
  for (const d of distances) {
    if (d - previous >= ROW_GAP) rowStarts.push(d);
    previous = d;
  }
  return new Map(
    SEATS.map(([seat, , x, y]) => {
      const d = Math.round(distance(x, y) * 1000) / 1000;
      return [seat, rowStarts.filter((start) => start <= d).length - 1];
    }),
  );
})();

export const rowOfSeat = (seat: number) => ROW_OF_SEAT.get(seat) ?? null;

/**
 * A group's seats from front to back. Within a row, seats nearest the middle of the
 * group's block come first, where a group's most prominent members usually sit.
 */
export const seatsFrontToBack = (group: string): number[] => {
  const own = SEATS.filter(([, g]) => g === group);
  if (own.length === 0) return [];
  const middle = own.reduce((sum, [, , x]) => sum + x, 0) / own.length;
  return [...own]
    .sort(
      ([a, , ax, ay], [b, , bx, by]) =>
        ROW_OF_SEAT.get(a)! - ROW_OF_SEAT.get(b)! ||
        Math.abs(ax - middle) - Math.abs(bx - middle) ||
        distance(ax, ay) - distance(bx, by) ||
        a - b,
    )
    .map(([seat]) => seat);
};

/**
 * Fills each group's free seats, front to back, with its deputies in order of importance.
 * `taken` holds real assignments, which are left as they are.
 */
export const estimateSeats = (
  deputies: { id: number; group: string | null; importance: number; name: string }[],
  taken: Map<number, number>,
): Map<number, number> => {
  const usedSeats = new Set(taken.values());
  const estimated = new Map<number, number>();
  const byGroup = new Map<string, typeof deputies>();
  for (const deputy of deputies) {
    if (!deputy.group || taken.has(deputy.id)) continue;
    byGroup.set(deputy.group, [...(byGroup.get(deputy.group) ?? []), deputy]);
  }
  for (const [group, members] of byGroup) {
    const free = seatsFrontToBack(group).filter((seat) => !usedSeats.has(seat));
    const ranked = [...members].sort(
      (a, b) => b.importance - a.importance || a.name.localeCompare(b.name, "pt") || a.id - b.id,
    );
    ranked.forEach((deputy, i) => {
      const seat = free[i];
      if (seat !== undefined) estimated.set(deputy.id, seat);
    });
  }
  return estimated;
};
