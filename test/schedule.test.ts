import { describe, expect, it } from "vitest";
import type { BuiltSentence, BuiltWord } from "../src/corpus/build";
import { indexCorpus } from "../src/corpus/model";
import {
  applyEvidence,
  frontier,
  KNOWN_INTERVAL_DAYS,
  LOW_KNOWN_LIMIT,
  renderBrief,
  suggest,
  type Frontier,
  type Suggestion,
} from "../src/srs/schedule";
import { DAY_MS, freshCard, fsrs, Rating, State, type Card } from "../src/srs/fsrs";

const now = 1_700_000_000_000;
const allowed = new Set(["我", "饺子"]);

function word(
  partial: Pick<BuiltWord, "hanzi" | "gloss" | "ord" | "curriculum"> &
    Partial<BuiltWord>,
): BuiltWord {
  return {
    pinyin: partial.pinyin ?? "wai4",
    level: partial.level ?? 1,
    exampleHanzi: partial.exampleHanzi ?? `${partial.hanzi}。`,
    examplePinyin: partial.examplePinyin ?? "",
    exampleEnglish: partial.exampleEnglish ?? partial.gloss,
    ...partial,
  };
}

const corpus = indexCorpus(
  [
    word({
      hanzi: "我",
      gloss: "I-gloss",
      pinyin: "wo3-pinyin",
      ord: 0,
      curriculum: true,
      exampleHanzi: "我是学生。",
      exampleEnglish: "I-am-a-student-english",
    }),
    word({
      hanzi: "饺子",
      gloss: "dumpling-gloss",
      pinyin: "jiao3zi-pinyin",
      ord: 1,
      curriculum: true,
      exampleHanzi: "我喜欢吃饺子。",
      exampleEnglish: "dumplings-english",
    }),
  ],
  [],
);

function blankFrontier(partial: Partial<Frontier> = {}): Frontier {
  return {
    knownCount: 0,
    stableCount: 0,
    stableListed: [],
    stableOmitted: false,
    levelsReached: [],
    fragile: [],
    nextNew: [],
    inPlay: [],
    ...partial,
  };
}

describe("never-missed successes", () => {
  it("schedules a first production at least two weeks out", () => {
    const { cards, applied } = applyEvidence(
      [],
      [{ hanzi: "我", outcome: "produced", quote: "我" }],
      allowed,
      now,
    );
    expect(applied[0].state).toBe("review");
    expect(applied[0].dueAt).toBe(now + KNOWN_INTERVAL_DAYS * DAY_MS);
    expect(cards[0].stability).toBeGreaterThanOrEqual(KNOWN_INTERVAL_DAYS);
    expect(cards[0].lapses).toBe(0);
  });

  it("schedules a first recognition the same way", () => {
    const { cards } = applyEvidence(
      [],
      [{ hanzi: "我", outcome: "recognized", quote: "我" }],
      allowed,
      now,
    );
    expect(cards[0].state).toBe(State.Review);
    expect(cards[0].due).toBe(now + KNOWN_INTERVAL_DAYS * DAY_MS);
  });

  it("keeps the short steps after a miss", () => {
    const missed = applyEvidence(
      [],
      [{ hanzi: "饺子", outcome: "unknown", quote: "什么意思" }],
      allowed,
      now,
    );
    expect(missed.cards[0].lapses).toBe(1);
    expect(missed.cards[0].due).toBe(now + 60_000);
    const later = now + 60_000;
    const recovered = applyEvidence(
      missed.cards,
      [{ hanzi: "饺子", outcome: "produced", quote: "饺子" }],
      allowed,
      later,
    );
    expect(recovered.cards[0].state).toBe(State.Learning);
    expect(recovered.cards[0].due).toBe(later + 10 * 60_000);
  });

  it("does not pull a longer never-missed interval back to two weeks", () => {
    const card = freshCard("我", now - 40 * DAY_MS);
    card.state = State.Review;
    card.stability = 40;
    card.difficulty = 5;
    card.due = now;
    card.lastReview = now - 40 * DAY_MS;
    card.reps = 4;
    card.lapses = 0;
    card.scheduledDays = 40;
    const { cards } = applyEvidence(
      [card],
      [{ hanzi: "我", outcome: "produced", quote: "我" }],
      allowed,
      now,
    );
    expect(cards[0].due).toBeGreaterThan(now + KNOWN_INTERVAL_DAYS * DAY_MS);
    expect(cards[0].stability).toBeGreaterThan(KNOWN_INTERVAL_DAYS);
  });

  it("lets a second never-missed success grow past two weeks", () => {
    const first = applyEvidence(
      [],
      [{ hanzi: "我", outcome: "produced", quote: "我" }],
      allowed,
      now,
    );
    const later = now + KNOWN_INTERVAL_DAYS * DAY_MS;
    const second = applyEvidence(
      first.cards,
      [{ hanzi: "我", outcome: "produced", quote: "我" }],
      allowed,
      later,
    );
    expect(second.cards[0].lapses).toBe(0);
    expect(second.cards[0].stability).toBeGreaterThan(KNOWN_INTERVAL_DAYS);
    expect(second.cards[0].due).toBeGreaterThan(later + KNOWN_INTERVAL_DAYS * DAY_MS);
  });
});

describe("learner brief", () => {
  it("names words without pinyin or English", () => {
    const produced = applyEvidence(
      [],
      [{ hanzi: "我", outcome: "produced", quote: "我" }],
      allowed,
      now,
    );
    const view = frontier(corpus, produced.cards, now, ["我"]);
    const suggestion: Suggestion = {
      purpose: "review",
      hanzi: "我",
      gloss: "I-gloss",
      pinyin: "wo3-pinyin",
      exampleHanzi: "我是学生。",
      examplePinyin: "wo3",
      exampleEnglish: "I-am-a-student-english",
    };
    const brief = renderBrief(view, [suggestion]);
    expect(brief).toContain(`Known words: 1. That is few (under ${LOW_KNOWN_LIMIT}).`);
    expect(brief).toContain("- 我 — review, R=1");
    expect(brief).toContain("- 我: fragile");
    expect(brief).toContain("due now: 我. You could say something near: 我是学生。");
    expect(brief).not.toContain("wo3-pinyin");
    expect(brief).not.toContain("I-gloss");
    expect(brief).not.toContain("I-am-a-student-english");
    expect(brief).not.toContain("dumpling-gloss");
    expect(brief).not.toContain("dumplings-english");
    expect(brief).not.toContain("jiao3zi-pinyin");
  });

  it("drops the few-words mark once the known set is large enough", () => {
    const brief = renderBrief(blankFrontier({ knownCount: LOW_KNOWN_LIMIT }), []);
    expect(brief).toContain(`Known words: ${LOW_KNOWN_LIMIT}.`);
    expect(brief).not.toContain("That is few");
  });
});

describe("review lapses", () => {
  it("counts one lapse when a graduated card is missed", () => {
    const first = fsrs().review(freshCard("我", now), Rating.Good, now);
    const graduated = fsrs().review(first, Rating.Good, now + 10 * 60_000);
    expect(graduated.lapses).toBe(0);
    const missed = fsrs().review(graduated, Rating.Again, now + DAY_MS);
    expect(missed.lapses).toBe(1);
  });
});

describe("review sentences", () => {
  function sentence(hanzi: string): BuiltSentence {
    return { id: hanzi, hanzi, pinyin: "", english: "" };
  }

  const reviewCorpus = indexCorpus(
    [
      word({
        hanzi: "我",
        gloss: "I",
        ord: 0,
        curriculum: true,
        exampleHanzi: "我上班。",
      }),
      word({
        hanzi: "他",
        gloss: "he",
        ord: 1,
        curriculum: true,
        exampleHanzi: "他。",
      }),
      word({
        hanzi: "上班",
        gloss: "work",
        ord: 2,
        curriculum: true,
        exampleHanzi: "我上班。",
      }),
      word({
        hanzi: "学校",
        gloss: "school",
        ord: 8,
        curriculum: true,
        exampleHanzi: "学校。",
      }),
    ],
    [sentence("我上班。"), sentence("他上班。"), sentence("学校上班。")],
  );

  function card(hanzi: string, partial: Partial<Card> = {}): Card {
    return {
      ...freshCard(hanzi, now),
      state: State.Learning,
      stability: 0,
      difficulty: 5,
      due: now + 60_000,
      lastReview: null,
      reps: 1,
      lapses: 1,
      elapsedDays: 0,
      scheduledDays: 0,
      ...partial,
    };
  }

  it("reviews with a sentence whose other words already have cards", () => {
    const cards = [
      card("我"),
      card("上班", { due: now, reps: 2, state: State.Review }),
    ];
    expect(suggest(reviewCorpus, cards, now)).toEqual([
      expect.objectContaining({
        purpose: "review",
        hanzi: "上班",
        exampleHanzi: "我上班。",
      }),
    ]);
  });

  it("uses a later word the student already has rather than adding one", () => {
    const cards = [
      card("学校"),
      card("上班", { due: now, reps: 2, state: State.Review }),
    ];
    expect(suggest(reviewCorpus, cards, now)).toEqual([
      expect.objectContaining({
        purpose: "review",
        hanzi: "上班",
        exampleHanzi: "学校上班。",
      }),
    ]);
  });

  it("still introduces the next word in a sentence that contains new words", () => {
    expect(suggest(reviewCorpus, [], now)).toEqual([
      expect.objectContaining({
        purpose: "introduce",
        hanzi: "我",
        exampleHanzi: "我上班。",
      }),
    ]);
  });

  it("reviews with a sentence that adds a word when every sentence does", () => {
    const cards = [card("上班", { due: now, reps: 2, state: State.Review })];
    expect(suggest(reviewCorpus, cards, now)[0]?.exampleHanzi).toBe("他上班。");
  });
});
