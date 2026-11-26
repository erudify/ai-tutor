import { describe, expect, it } from "vitest";
import { freshCard, fsrs, LEARNING_MINUTES, Rating, State } from "../src/srs/fsrs";

const MINUTE = 60_000;

describe("FSRS-5", () => {
  it("treats stability as the interval where recall is about 0.9", () => {
    const stability = 12;
    expect(fsrs().forgettingCurve(stability, stability)).toBeCloseTo(0.9, 5);
  });

  it("schedules a new Good answer onto the second learning step", () => {
    const now = 1_700_000_000_000;
    const next = fsrs().review(freshCard("我", now), Rating.Good, now);
    expect(next.stability).toBeCloseTo(3.173, 5);
    expect(next.state).toBe(State.Learning);
    expect(next.due).toBe(now + LEARNING_MINUTES[1] * MINUTE);
  });

  it("schedules a new Again answer one minute out and counts the miss", () => {
    const now = 1_700_000_000_000;
    const next = fsrs().review(freshCard("饺子", now), Rating.Again, now);
    expect(next.state).toBe(State.Learning);
    expect(next.due).toBe(now + MINUTE);
    expect(next.lapses).toBe(1);
  });

  it("repeats a missed new word at every learning step before a day interval", () => {
    let now = 1_700_000_000_000;
    let card = fsrs().review(freshCard("饺子", now), Rating.Again, now);
    const gaps: number[] = [(card.due - now) / MINUTE];
    while (card.state === State.Learning) {
      now = card.due;
      card = fsrs().review(card, Rating.Good, now);
      if (card.state === State.Learning) gaps.push((card.due - now) / MINUTE);
    }
    expect(gaps).toEqual(LEARNING_MINUTES);
    expect(card.state).toBe(State.Review);
    expect(card.scheduledDays).toBeGreaterThanOrEqual(1);
  });
});
