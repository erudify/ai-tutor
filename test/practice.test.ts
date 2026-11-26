import { describe, expect, it } from "vitest";
import type { BuiltSentence, BuiltWord } from "../src/corpus/build";
import { indexCorpus } from "../src/corpus/model";
import { freshCard, State, type Card } from "../src/srs/fsrs";
import {
  gradePractice,
  pickPractice,
  promptFromActive,
  type PracticePrompt,
} from "../src/srs/practice";
import { applyEvidence } from "../src/srs/schedule";

const now = 1_700_000_000_000;

function word(
  partial: Pick<BuiltWord, "hanzi" | "gloss" | "ord" | "curriculum" | "pinyin"> &
    Partial<BuiltWord>,
): BuiltWord {
  return {
    level: 1,
    exampleHanzi: partial.exampleHanzi ?? `${partial.hanzi}。`,
    examplePinyin: "",
    exampleEnglish: partial.gloss,
    ...partial,
  };
}

function sentence(hanzi: string, pinyin: string, english = ""): BuiltSentence {
  return { id: hanzi, hanzi, pinyin, english };
}

const corpus = indexCorpus(
  [
    word({
      hanzi: "我",
      gloss: "I",
      pinyin: "wǒ",
      ord: 0,
      curriculum: true,
      exampleHanzi: "我在学校。",
    }),
    word({
      hanzi: "在",
      gloss: "at",
      pinyin: "zài",
      ord: 1,
      curriculum: true,
      exampleHanzi: "我在学校。",
    }),
    word({
      hanzi: "学校",
      gloss: "school",
      pinyin: "xué xiào",
      ord: 2,
      curriculum: true,
      exampleHanzi: "我在学校。",
    }),
    word({
      hanzi: "每天",
      gloss: "every day",
      pinyin: "měi tiān",
      ord: 3,
      curriculum: true,
      exampleHanzi: "我每天上班。",
    }),
    word({
      hanzi: "上班",
      gloss: "go to work",
      pinyin: "shàng bān",
      ord: 4,
      curriculum: true,
      exampleHanzi: "我每天上班。",
    }),
    word({
      hanzi: "蓝色",
      gloss: "blue",
      pinyin: "lán sè",
      ord: 5,
      curriculum: true,
      exampleHanzi: "蓝色。",
    }),
  ],
  [
    sentence("我在学校。", "wǒ zài xuéxiào."),
    sentence("我每天上班。", "wǒ měitiān shàngbān."),
    sentence("我上班。", "wǒ shàngbān."),
    sentence("学校上班。", "xuéxiào shàngbān."),
    sentence("每天上班。", "měitiān shàngbān."),
  ],
);

function held(partial: Partial<Card> & Pick<Card, "hanzi">): Card {
  return {
    ...freshCard(partial.hanzi, now),
    state: State.Review,
    stability: 30,
    difficulty: 5,
    due: now + 86_400_000,
    lastReview: now,
    reps: 3,
    lapses: 0,
    elapsedDays: 0,
    scheduledDays: 30,
    ...partial,
  };
}

describe("pickPractice", () => {
  it("starts at the first curriculum sentence when nothing is due", () => {
    const pick = pickPractice(corpus, [], [], now);
    expect(pick).toEqual({ hanzi: "我在学校。", purpose: "introduce", focus: "我" });
    const prompt = promptFromActive(corpus, pick!);
    expect(prompt.pieces).toEqual([
      { kind: "word", hanzi: "我", pinyin: "wǒ" },
      { kind: "word", hanzi: "在", pinyin: "zài" },
      { kind: "word", hanzi: "学校", pinyin: "xuéxiào" },
      { kind: "gap", text: "。" },
    ]);
  });

  it("skips a word that already has a card", () => {
    const pick = pickPractice(corpus, [held({ hanzi: "我" })], [], now);
    expect(pick).toEqual({ hanzi: "我在学校。", purpose: "introduce", focus: "在" });
  });

  it("reviews the most urgent word beside companions the student knows well", () => {
    const cards = [
      held({ hanzi: "我" }),
      held({
        hanzi: "上班",
        due: now,
        stability: 0,
        lastReview: null,
        reps: 2,
      }),
      held({ hanzi: "每天", reps: 1, stability: 1 }),
    ];
    expect(pickPractice(corpus, cards, [], now)).toEqual({
      hanzi: "我上班。",
      purpose: "review",
      focus: "上班",
    });
  });

  it("prefers a sentence the student has not seen", () => {
    const cards = [
      held({ hanzi: "我" }),
      held({ hanzi: "学校" }),
      held({ hanzi: "上班", due: now, stability: 0, lastReview: null }),
    ];
    expect(
      pickPractice(corpus, cards, [{ hanzi: "我上班。", shownAt: now }], now),
    ).toEqual({
      hanzi: "学校上班。",
      purpose: "review",
      focus: "上班",
    });
  });

  it("keeps a review inside words that already have cards", () => {
    const cards = [
      held({
        hanzi: "我",
        state: State.Learning,
        stability: 0,
        lastReview: null,
        reps: 1,
        lapses: 1,
        due: now + 60_000,
      }),
      held({ hanzi: "上班", due: now, stability: 0, lastReview: null, reps: 2 }),
    ];
    expect(
      pickPractice(corpus, cards, [{ hanzi: "我上班。", shownAt: now }], now),
    ).toEqual({
      hanzi: "我上班。",
      purpose: "review",
      focus: "上班",
    });
  });

  it("otherwise picks the sentence shown furthest in the past", () => {
    const cards = [
      held({ hanzi: "我" }),
      held({ hanzi: "学校" }),
      held({ hanzi: "上班", due: now, stability: 0, lastReview: null }),
    ];
    const pick = pickPractice(
      corpus,
      cards,
      [
        { hanzi: "我上班。", shownAt: now },
        { hanzi: "学校上班。", shownAt: now - 5_000 },
      ],
      now,
    );
    expect(pick?.hanzi).toBe("学校上班。");
  });

  it("still returns a sentence when the other words are unknown", () => {
    const only = indexCorpus(
      [
        word({
          hanzi: "每天",
          gloss: "every day",
          pinyin: "měi tiān",
          ord: 0,
          curriculum: true,
          exampleHanzi: "每天上班。",
        }),
        word({
          hanzi: "上班",
          gloss: "go to work",
          pinyin: "shàng bān",
          ord: 1,
          curriculum: true,
          exampleHanzi: "每天上班。",
        }),
      ],
      [sentence("每天上班。", "měitiān shàngbān.")],
    );
    expect(
      pickPractice(
        only,
        [held({ hanzi: "上班", due: now, stability: 0, lastReview: null })],
        [],
        now,
      ),
    ).toEqual({ hanzi: "每天上班。", purpose: "review", focus: "上班" });
  });

  it("reads 要 as yào from the sentence file", () => {
    const hanzi = "我们明天要去她家。";
    const trip = indexCorpus(
      [
        word({
          hanzi: "我们",
          gloss: "we",
          pinyin: "wǒ men",
          ord: 0,
          curriculum: true,
          exampleHanzi: hanzi,
        }),
        word({
          hanzi: "明天",
          gloss: "tomorrow",
          pinyin: "míng tiān",
          ord: 1,
          curriculum: true,
          exampleHanzi: hanzi,
        }),
        word({
          hanzi: "要",
          gloss: "to demand",
          pinyin: "yāo",
          ord: 2,
          curriculum: true,
          exampleHanzi: hanzi,
        }),
        word({
          hanzi: "去",
          gloss: "go",
          pinyin: "qù",
          ord: 3,
          curriculum: true,
          exampleHanzi: hanzi,
        }),
        word({
          hanzi: "她",
          gloss: "she",
          pinyin: "tā",
          ord: 4,
          curriculum: true,
          exampleHanzi: hanzi,
        }),
        word({
          hanzi: "家",
          gloss: "home",
          pinyin: "jiā",
          ord: 5,
          curriculum: true,
          exampleHanzi: hanzi,
        }),
      ],
      [
        sentence(
          hanzi,
          "Wǒmen míngtiān yào qù tā jiā.",
          "We are going to her house tomorrow.",
        ),
      ],
    );
    const pick = pickPractice(trip, [], [], now);
    expect(pick).toEqual({ hanzi, purpose: "introduce", focus: "我们" });
    const prompt = promptFromActive(trip, pick!);
    expect(prompt.english).toBe("We are going to her house tomorrow.");
    expect(prompt.pieces).toEqual([
      { kind: "word", hanzi: "我们", pinyin: "Wǒmen" },
      { kind: "word", hanzi: "明天", pinyin: "míngtiān" },
      { kind: "word", hanzi: "要", pinyin: "yào" },
      { kind: "word", hanzi: "去", pinyin: "qù" },
      { kind: "word", hanzi: "她", pinyin: "tā" },
      { kind: "word", hanzi: "家", pinyin: "jiā" },
      { kind: "gap", text: "。" },
    ]);
  });

  it("leaves a sentence blank when its pinyin does not line up", () => {
    const broken = indexCorpus(
      [
        word({
          hanzi: "要",
          gloss: "to demand",
          pinyin: "yāo",
          ord: 0,
          curriculum: true,
          exampleHanzi: "要去。",
        }),
        word({
          hanzi: "去",
          gloss: "go",
          pinyin: "qù",
          ord: 1,
          curriculum: true,
          exampleHanzi: "要去。",
        }),
      ],
      [sentence("要去。", "yāo")],
    );
    expect(pickPractice(broken, [], [], now)).toEqual({
      hanzi: "要",
      purpose: "introduce",
      focus: "要",
    });
    expect(
      promptFromActive(broken, {
        hanzi: "要去。",
        purpose: "introduce",
        focus: "要",
      }).pieces,
    ).toEqual([
      { kind: "word", hanzi: "要", pinyin: "" },
      { kind: "word", hanzi: "去", pinyin: "" },
      { kind: "gap", text: "。" },
    ]);
  });

  it("uses the word alone when no indexed sentence contains it", () => {
    const pick = pickPractice(
      corpus,
      [held({ hanzi: "蓝色", due: now, stability: 0, lastReview: null })],
      [],
      now,
    );
    expect(pick).toEqual({ hanzi: "蓝色", purpose: "review", focus: "蓝色" });
    const alone = promptFromActive(corpus, pick!);
    expect(alone.english).toBe("blue");
    expect(alone.pieces).toEqual([{ kind: "word", hanzi: "蓝色", pinyin: "lán sè" }]);
  });

  it("returns nothing when the curriculum is finished and nothing is due", () => {
    const cards = ["我", "在", "学校", "每天", "上班", "蓝色"].map((hanzi) =>
      held({ hanzi }),
    );
    expect(pickPractice(corpus, cards, [], now)).toBeNull();
  });
});

describe("gradePractice", () => {
  it("counts a revealed slot as a miss and still accepts the other words", () => {
    const prompt: PracticePrompt = {
      hanzi: "我在我",
      english: "",
      purpose: "review",
      focus: "我",
      pieces: [
        { kind: "word", hanzi: "我", pinyin: "wǒ" },
        { kind: "word", hanzi: "在", pinyin: "zài" },
        { kind: "word", hanzi: "我", pinyin: "wǒ" },
      ],
    };
    const events = gradePractice(prompt, [2]);
    expect(events.map((event) => event.outcome)).toEqual([
      "produced",
      "produced",
      "unknown",
    ]);
    const { cards } = applyEvidence([], events, new Set(["我", "在"]), now);
    const mine = cards.find((card) => card.hanzi === "我");
    const at = cards.find((card) => card.hanzi === "在");
    expect(mine?.lapses).toBe(1);
    expect(mine?.due).toBe(now + 60_000);
    expect(mine?.state).not.toBe(State.Review);
    expect(at?.lapses).toBe(0);
    expect(at?.state).toBe(State.Review);
    expect(at?.due).toBe(now + 14 * 86_400_000);
  });
});
