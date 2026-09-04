import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_TIME_OFFSET_HOURS,
  GAME_YEAR_OFFSET,
  getGameDate,
} from "../src/GameTime.ts";

const HOUR_MILLISECONDS = 60 * 60 * 1_000;

test("automatic game time is 100 calendar years ahead and four hours behind", () => {
  const now = new Date(2026, 7, 23, 12, 34, 56, 789);
  const date = getGameDate(now.getTime());

  assert.equal(GAME_YEAR_OFFSET, 100);
  assert.equal(GAME_TIME_OFFSET_HOURS, -4);
  assert.equal(date.getFullYear(), 2126);
  assert.equal(date.getMonth(), 7);
  assert.equal(date.getDate(), 23);
  assert.equal(date.getHours(), 8);
  assert.equal(date.getMinutes(), 34);
  assert.equal(date.getSeconds(), 56);
  assert.equal(date.getMilliseconds(), 789);
});

test("the four-hour offset rolls into the previous calendar day", () => {
  const now = new Date(2026, 0, 1, 2, 15);
  const date = getGameDate(now.getTime());

  assert.equal(date.getFullYear(), 2125);
  assert.equal(date.getMonth(), 11);
  assert.equal(date.getDate(), 31);
  assert.equal(date.getHours(), 22);
  assert.equal(date.getMinutes(), 15);
});

test("automatic game time continues at real-time speed", () => {
  const now = new Date(2026, 7, 23, 12).getTime();

  assert.equal(
    getGameDate(now + HOUR_MILLISECONDS).getTime() - getGameDate(now).getTime(),
    HOUR_MILLISECONDS,
  );
});
