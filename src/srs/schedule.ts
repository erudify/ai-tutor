import { pickExample, type IndexedExample } from "../corpus/examples";
import type { Corpus, Word } from "../corpus/model";
import {
  DAY_MS,
  freshCard,
  fsrs,
  ratingName,
  Rating,
  State,
  STATE_NAME,
  type Card,
  type RatingValue,
} from "./fsrs";

export type Outcome = "produced" | "recognized" | "unknown" | "misunderstood";

export type Evidence = {
  hanzi: string;
  outcome: Outcome;
  quote: string;
};

/** A never-missed success skips the minute-scale steps. */
export const KNOWN_INTERVAL_DAYS = 14;

/** Below this many known words the tutor stays in the survey phase. */
export const LOW_KNOWN_LIMIT = 15;

export type AppliedReview = {
  hanzi: string;
  outcome: Outcome;
  rating: RatingValue;
  ratingName: string;
  quote: string;
  dueAt: number;
  state: string;
  stability: number;
  difficulty: number;
  /** The card as it was before this review. Raw input for refitting weights. */
  before: {
    state: string;
    stability: number;
    difficulty: number;
    lastReview: number | null;
    reps: number;
    lapses: number;
  };
};

const OUTCOME_RANK: Record<Outcome, number> = {
  recognized: 1,
  produced: 2,
  unknown: 3,
  misunderstood: 4,
};

export function mergeEvidence(events: readonly Evidence[]): Evidence[] {
  const byWord = new Map<string, Evidence>();
  for (const event of events) {
    const current = byWord.get(event.hanzi);
    if (!current || OUTCOME_RANK[event.outcome] > OUTCOME_RANK[current.outcome]) {
      byWord.set(event.hanzi, event);
    }
  }
  return [...byWord.values()];
}

/**
 * Pass or fail. Practice never asks how hard a word felt, so it never claims
 * Easy. "recognized" only comes from the chat judge: seen, not produced.
 */
export function outcomeToRating(outcome: Outcome): RatingValue {
  if (outcome === "misunderstood" || outcome === "unknown") return Rating.Again;
  if (outcome === "recognized") return Rating.Hard;
  return Rating.Good;
}

export function applyEvidence(
  cards: readonly Card[],
  events: readonly Evidence[],
  allowed: ReadonlySet<string>,
  now: number,
): { cards: Card[]; applied: AppliedReview[] } {
  const next = new Map(cards.map((card) => [card.hanzi, card]));
  const applied: AppliedReview[] = [];
  for (const event of mergeEvidence(events)) {
    if (!allowed.has(event.hanzi)) continue;
    const current = next.get(event.hanzi) ?? freshCard(event.hanzi, now);
    const rating = outcomeToRating(event.outcome);
    const updated = fsrs().review(current, rating, now);
    if (current.lapses === 0 && rating !== Rating.Again)
      scheduleNeverMissed(updated, now);
    next.set(event.hanzi, updated);
    applied.push({
      hanzi: event.hanzi,
      outcome: event.outcome,
      rating,
      ratingName: ratingName(rating),
      quote: event.quote,
      dueAt: updated.due,
      state: STATE_NAME[updated.state],
      stability: updated.stability,
      difficulty: updated.difficulty,
      before: {
        state: STATE_NAME[current.state],
        stability: current.stability,
        difficulty: current.difficulty,
        lastReview: current.lastReview,
        reps: current.reps,
        lapses: current.lapses,
      },
    });
  }
  return { cards: [...next.values()], applied };
}

export type Suggestion = {
  purpose: "review" | "introduce";
  hanzi: string;
  gloss: string;
  pinyin: string;
  exampleHanzi: string;
  examplePinyin: string;
  exampleEnglish: string;
};

function retrievability(card: Card, now: number): number {
  if (card.stability <= 0 || card.lastReview === null) return 0;
  const elapsed = Math.max(0, (now - card.lastReview) / 86_400_000);
  return fsrs().forgettingCurve(elapsed, card.stability);
}

/**
 * True when a sentence would add a word.
 * Example tokens are curriculum words, so a token with no card is a new word.
 * A card in any state, including Learning, means the word is already in play.
 */
export function introducesNewWord(
  tokens: readonly string[],
  held: ReadonlySet<string>,
): boolean {
  return tokens.some((token) => !held.has(token));
}

function exampleFor(
  corpus: Corpus,
  word: Word,
  known: ReadonlySet<string>,
  held: ReadonlySet<string> | null = null,
): Suggestion {
  const chosen = chooseExample(corpus, word, known, held);
  return {
    purpose: "review",
    hanzi: word.hanzi,
    gloss: word.gloss,
    pinyin: word.pinyin,
    exampleHanzi: chosen?.hanzi ?? word.exampleHanzi,
    examplePinyin: chosen?.pinyin ?? word.examplePinyin,
    exampleEnglish: chosen?.english ?? word.exampleEnglish,
  };
}

/**
 * Review stays inside words that already have cards when any sentence can.
 * A word past this item's example window still counts as already introduced.
 */
function chooseExample(
  corpus: Corpus,
  word: Word,
  known: ReadonlySet<string>,
  held: ReadonlySet<string> | null,
): IndexedExample | null {
  const sentences = corpus.examplesByToken.get(word.hanzi) ?? [];
  const ordOf = (hanzi: string): number | null =>
    corpus.byHanzi.get(hanzi)?.ord ?? null;
  if (!held) return pickExample(sentences, word.hanzi, word.exampleLimit, ordOf, known);
  const familiar = sentences.filter(
    (sentence) => !introducesNewWord(sentence.tokens, held),
  );
  if (familiar.length === 0) {
    return pickExample(sentences, word.hanzi, word.exampleLimit, ordOf, known);
  }
  const limit = word.exampleLimit;
  return (
    pickExample(familiar, word.hanzi, limit, ordOf, known) ??
    pickExample(
      familiar,
      word.hanzi,
      limit,
      (hanzi) => {
        const ord = ordOf(hanzi);
        if (limit !== null && held.has(hanzi) && (ord === null || ord > limit))
          return limit;
        return ord;
      },
      known,
    ) ??
    familiar[0]
  );
}

export function stableHanzi(cards: readonly Card[], now: number): Set<string> {
  const stable = new Set<string>();
  for (const card of cards) {
    if (
      card.state === State.Review &&
      card.reps >= 2 &&
      retrievability(card, now) >= 0.9
    ) {
      stable.add(card.hanzi);
    }
  }
  return stable;
}

/**
 * Due reviews first. A new curriculum word only when nothing is due.
 * A review sentence adds a word with no card only when every sentence would.
 */
export function suggest(
  corpus: Corpus,
  cards: readonly Card[],
  now: number,
): Suggestion[] {
  const byHanzi = new Map(cards.map((card) => [card.hanzi, card]));
  const known = knownHanzi(cards);
  const held = new Set(cards.map((card) => card.hanzi));
  const due = cards
    .filter((card) => card.state !== State.New && card.due <= now)
    .sort((a, b) => retrievability(a, now) - retrievability(b, now))
    .slice(0, 2);
  const suggestions: Suggestion[] = [];
  for (const card of due) {
    const word = corpus.byHanzi.get(card.hanzi);
    if (!word) continue;
    suggestions.push({ ...exampleFor(corpus, word, known, held), purpose: "review" });
  }
  if (suggestions.length === 0) {
    const next = corpus.curriculum.find((word) => !byHanzi.has(word.hanzi));
    if (next)
      suggestions.push({ ...exampleFor(corpus, next, known), purpose: "introduce" });
  }
  return suggestions;
}

export type FrontierWord = {
  hanzi: string;
  gloss: string;
  pinyin: string;
  state: string;
  retrievability: number;
};

export type Frontier = {
  knownCount: number;
  stableCount: number;
  stableListed: string[];
  stableOmitted: boolean;
  levelsReached: number[];
  fragile: FrontierWord[];
  nextNew: Suggestion[];
  inPlay: { hanzi: string; status: string; gloss: string }[];
};

const STABLE_LIST_CAP = 80;

export function frontier(
  corpus: Corpus,
  cards: readonly Card[],
  now: number,
  focus: readonly string[],
): Frontier {
  const byHanzi = new Map(cards.map((card) => [card.hanzi, card]));
  const known = knownHanzi(cards);
  const stable = stableHanzi(cards, now);
  const stableWords = [...stable].sort((a, b) => a.localeCompare(b, "zh"));
  const fragile: FrontierWord[] = [];
  for (const card of cards) {
    if (stable.has(card.hanzi)) continue;
    const word = corpus.byHanzi.get(card.hanzi);
    if (!word) continue;
    fragile.push({
      hanzi: card.hanzi,
      gloss: word.gloss,
      pinyin: word.pinyin,
      state: STATE_NAME[card.state],
      retrievability: Math.round(retrievability(card, now) * 100) / 100,
    });
  }
  fragile.sort((a, b) => a.retrievability - b.retrievability);
  const nextNew: Suggestion[] = [];
  for (const word of corpus.curriculum) {
    if (byHanzi.has(word.hanzi)) continue;
    nextNew.push({ ...exampleFor(corpus, word, known), purpose: "introduce" });
    if (nextNew.length === 8) break;
  }
  const levelTotals = new Map<number, { total: number; stable: number }>();
  for (const word of corpus.curriculum) {
    if (word.level === null) continue;
    const bucket = levelTotals.get(word.level) ?? { total: 0, stable: 0 };
    bucket.total += 1;
    if (stable.has(word.hanzi)) bucket.stable += 1;
    levelTotals.set(word.level, bucket);
  }
  const levelsReached = [...levelTotals.entries()]
    .filter(([, bucket]) => bucket.total > 0 && bucket.stable / bucket.total >= 0.8)
    .map(([level]) => level)
    .sort((a, b) => a - b);
  const inPlay = focus.map((hanzi) => {
    const word = corpus.byHanzi.get(hanzi);
    let status = "not in the schedule";
    if (word?.curriculum && !byHanzi.has(hanzi)) status = "not yet studied";
    else if (stable.has(hanzi)) status = "stable";
    else if (byHanzi.has(hanzi)) status = "fragile";
    else if (word?.tracked) status = "known word, no card yet";
    return { hanzi, status, gloss: word?.gloss ?? "" };
  });
  return {
    knownCount: cards.filter(countsAsKnown).length,
    stableCount: stable.size,
    stableListed: stableWords.length <= STABLE_LIST_CAP ? stableWords : [],
    stableOmitted: stableWords.length > STABLE_LIST_CAP,
    levelsReached,
    fragile: fragile.slice(0, 30),
    nextNew,
    inPlay,
  };
}

export type DueItem = {
  hanzi: string;
  gloss: string;
  dueAt: number;
  state: string;
};

export function preview(
  corpus: Corpus,
  cards: readonly Card[],
  now: number,
): {
  stableCount: number;
  due: DueItem[];
  nextNew: Suggestion[];
  curriculumRemaining: number;
} {
  const known = new Set(cards.map((card) => card.hanzi));
  const view = frontier(corpus, cards, now, []);
  const due = cards
    .filter((card) => card.state !== State.New && card.due <= now)
    .sort((a, b) => a.due - b.due)
    .slice(0, 8)
    .map((card) => ({
      hanzi: card.hanzi,
      gloss: corpus.byHanzi.get(card.hanzi)?.gloss ?? "",
      dueAt: card.due,
      state: STATE_NAME[card.state],
    }));
  return {
    stableCount: view.stableCount,
    due,
    nextNew: view.nextNew.slice(0, 5),
    curriculumRemaining: corpus.curriculum.filter((word) => !known.has(word.hanzi))
      .length,
  };
}

function knownHanzi(cards: readonly Card[]): Set<string> {
  const known = new Set<string>();
  for (const card of cards) if (countsAsKnown(card)) known.add(card.hanzi);
  return known;
}

export function countsAsKnown(card: Card): boolean {
  return card.reps > 0 && (card.lapses === 0 || card.state === State.Review);
}

function scheduleNeverMissed(card: Card, now: number): void {
  const floorDue = now + KNOWN_INTERVAL_DAYS * DAY_MS;
  if (card.stability < KNOWN_INTERVAL_DAYS) card.stability = KNOWN_INTERVAL_DAYS;
  if (card.due < floorDue) card.due = floorDue;
  const days = Math.max(KNOWN_INTERVAL_DAYS, Math.round((card.due - now) / DAY_MS));
  if (card.scheduledDays < days) card.scheduledDays = days;
  card.state = State.Review;
  card.learningStep = 0;
}

export function renderBrief(
  view: Frontier,
  suggestions: readonly Suggestion[],
): string {
  const lines: string[] = ["Learner state. This is the schedule, not a script."];
  lines.push(
    view.knownCount < LOW_KNOWN_LIMIT
      ? `Known words: ${view.knownCount}. That is few (under ${LOW_KNOWN_LIMIT}).`
      : `Known words: ${view.knownCount}.`,
  );
  if (view.stableCount === 0) {
    lines.push("Stable words: none yet.");
  } else if (!view.stableOmitted) {
    lines.push(
      `Stable words (${view.stableCount}), usable without a gloss: ${view.stableListed.join(" ")}`,
    );
  } else {
    const reached =
      view.levelsReached.length > 0
        ? `Source lists largely learned: ${view.levelsReached.join(", ")}.`
        : "No source list is 80% stable yet.";
    lines.push(
      `Stable words: ${view.stableCount}. The full list is omitted so it is not parroted. ${reached} Treat a word as already usable when it is simpler than the fragile list and it is not listed under "not yet studied". Gloss anything harder than that list.`,
    );
  }
  if (view.fragile.length === 0) {
    lines.push("Fragile words: none.");
  } else {
    lines.push(
      "Fragile words (known, not reliable). Retrievability is the chance of recall right now:",
    );
    for (const word of view.fragile) {
      lines.push(`- ${word.hanzi} — ${word.state}, R=${word.retrievability}`);
    }
  }
  if (view.nextNew.length === 0) {
    lines.push("Not yet studied: the curriculum list on file is exhausted.");
  } else {
    lines.push(
      "Not yet studied, in curriculum order. Introduce at most one, and gloss it:",
    );
    for (const word of view.nextNew) {
      lines.push(`- ${word.hanzi}. Example: ${word.exampleHanzi}`);
    }
  }
  if (view.inPlay.length > 0) {
    lines.push("Words in the latest student message:");
    for (const word of view.inPlay) {
      lines.push(`- ${word.hanzi}: ${word.status}`);
    }
  }
  if (suggestions.length === 0) {
    lines.push("Optional practice: none this turn.");
  } else {
    lines.push(
      "Optional practice. Use one only when the conversation is free. If the student asked about something else, answer that and leave this list alone:",
    );
    for (const suggestion of suggestions) {
      const kind = suggestion.purpose === "review" ? "due now" : "introduce";
      lines.push(
        `- ${kind}: ${suggestion.hanzi}. You could say something near: ${suggestion.exampleHanzi}`,
      );
    }
  }
  return lines.join("\n");
}
