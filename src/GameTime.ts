export const GAME_YEAR_OFFSET = 100;
export const GAME_TIME_OFFSET_HOURS = -4;

/** Returns live local time shifted 100 calendar years ahead and four hours back. */
export function getGameDate(now = Date.now()): Date {
  const date = new Date(now);
  date.setFullYear(date.getFullYear() + GAME_YEAR_OFFSET);
  date.setTime(date.getTime() + GAME_TIME_OFFSET_HOURS * 60 * 60 * 1_000);
  return date;
}
