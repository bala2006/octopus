const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar days from `start` to `end`, both ISO dates or date-times, counted in UTC. */
export function daysBetween(start, end) {
  return Math.floor((new Date(end) - new Date(start)) / DAY_MS);
}
