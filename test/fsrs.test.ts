import { describe, expect, it } from "vitest";
import { freshCard, fsrs, Rating, State } from "../src/srs/fsrs";

const MINUTE = 60_000;

describe("FSRS-5", () => {
  it("treats stability as the interval where recall is about 0.9", () => {
    const stability = 12;
    expect(fsrs().forgettingCurve(stability, stability)).toBeCloseTo(0.9, 5);
  });

  it("schedules a new Good answer onto the ten-minute step", () => {
    const now = 1_700_000_000_000;
    const next = fsrs().review(freshCard("我", now), Rating.Good, now);
    expect(next.stability).toBeCloseTo(3.173, 5);
    expect(next.state).toBe(State.Learning);
    expect(next.due).toBe(now + 10 * MINUTE);
  });

  it("schedules a new Again answer one minute out and counts the miss", () => {
    const now = 1_700_000_000_000;
    const next = fsrs().review(freshCard("饺子", now), Rating.Again, now);
    expect(next.state).toBe(State.Learning);
    expect(next.due).toBe(now + MINUTE);
    expect(next.lapses).toBe(1);
  });

  it("graduates the second Good answer to a review interval of at least a day", () => {
    const now = 1_700_000_000_000;
    const first = fsrs().review(freshCard("我", now), Rating.Good, now);
    const second = fsrs().review(first, Rating.Good, now + 10 * MINUTE);
    expect(second.state).toBe(State.Review);
    expect(second.scheduledDays).toBeGreaterThanOrEqual(1);
  });
});
