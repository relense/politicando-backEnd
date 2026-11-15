/**
 * Which seat each deputy sits in: deputy ID (the parliament's cadastro ID) → seat number
 * from src/parliament/seatMap.ts.
 *
 * Empty on purpose. The official map (Deliberação n.º 5-PL/2025) only says which
 * parliamentary group owns each seat; each group decides internally who sits where, and
 * that isn't published. Until a reliable source exists (for example the plenary seating
 * plan requested from the parliament's services), the API returns `seat: null` rather
 * than guessing. Every entry is checked on sync: a seat must exist and belong to the
 * deputy's group, and no two deputies may share one.
 */
export const SEAT_ASSIGNMENTS: Readonly<Record<number, number>> = {};
