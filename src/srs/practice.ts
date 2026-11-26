import type { Corpus } from "../corpus/model";
import type { IndexedExample } from "../corpus/examples";
import { alignSentencePinyin, pinyinSlice } from "../sentence-pinyin";
import { fsrs, State, STATE_NAME, type Card } from "./fsrs";
import {
  countsAsKnown,
  introducesNewWord,
  stableHanzi,
  type Evidence,
} from "./schedule";

export type PracticePurpose = "review" | "introduce";

/**
 * Pinyin: read the characters, type the reading.
 * Listening: hear the sentence, type the characters. Its cards are separate.
 */
export type PracticeDeck = "pinyin" | "listening";

export const PRACTICE_DECKS: readonly PracticeDeck[] = ["pinyin", "listening"];

export function isPracticeDeck(value: unknown): value is PracticeDeck {
  return value === "pinyin" || value === "listening";
}

export type PlanOptions = {
  deck?: PracticeDeck;
  /**
   * Reading cards, for the listening deck. A word gets its first listening
   * exercise only after it counts as known from reading.
   */
  reading?: readonly Card[];
};

export type PracticeActive = {
  hanzi: string;
  purpose: PracticePurpose;
  focus: string | null;
};

export type SeenSentence = {
  hanzi: string;
  shownAt: number;
};

export type PracticePiece =
  { kind: "gap"; text: string } | { kind: "word"; hanzi: string; pinyin: string };

export type PracticePrompt = {
  hanzi: string;
  english: string;
  purpose: PracticePurpose;
  focus: string | null;
  pieces: PracticePiece[];
};

function retrievability(card: Card, now: number): number {
  if (card.stability <= 0 || card.lastReview === null) return 0;
  const elapsed = Math.max(0, (now - card.lastReview) / 86_400_000);
  return fsrs().forgettingCurve(elapsed, card.stability);
}

function dueCards(cards: readonly Card[], now: number): Card[] {
  return cards
    .filter((card) => card.state !== State.New && card.due <= now)
    .sort(
      (a, b) =>
        retrievability(a, now) - retrievability(b, now) ||
        a.hanzi.localeCompare(b.hanzi, "zh"),
    );
}

function companions(example: IndexedExample, focus: string): string[] {
  return example.tokens.filter((token) => token !== focus);
}

/**
 * 1: every other word is stable.
 * 2: every other word is known.
 * 3: anything that contains the focus, including a bare word.
 * A sentence with no other words stays in tier 3 so a known context wins.
 */
function sentenceTier(
  example: IndexedExample,
  focus: string,
  stable: ReadonlySet<string>,
  known: ReadonlySet<string>,
): number {
  const others = companions(example, focus);
  if (others.length > 0 && others.every((token) => stable.has(token))) return 1;
  if (others.length > 0 && others.every((token) => known.has(token))) return 2;
  return 3;
}

function preferSentence(
  current: IndexedExample,
  candidate: IndexedExample,
  seen: ReadonlyMap<string, number>,
): IndexedExample {
  const currentSeen = seen.get(current.hanzi);
  const candidateSeen = seen.get(candidate.hanzi);
  const currentUnseen = currentSeen === undefined;
  const candidateUnseen = candidateSeen === undefined;
  if (currentUnseen !== candidateUnseen) return candidateUnseen ? candidate : current;
  if (
    currentSeen !== undefined &&
    candidateSeen !== undefined &&
    candidateSeen !== currentSeen
  ) {
    return candidateSeen < currentSeen ? candidate : current;
  }
  if (candidate.tokens.length !== current.tokens.length) {
    return candidate.tokens.length < current.tokens.length ? candidate : current;
  }
  return candidate.hanzi.localeCompare(current.hanzi, "zh") < 0 ? candidate : current;
}

function bestSentence(
  options: readonly IndexedExample[],
  focus: string,
  stable: ReadonlySet<string>,
  known: ReadonlySet<string>,
  seen: ReadonlyMap<string, number>,
): IndexedExample | null {
  let best: IndexedExample | null = null;
  let bestTier = 4;
  for (const example of options) {
    const tier = sentenceTier(example, focus, stable, known);
    if (!best || tier < bestTier) {
      best = example;
      bestTier = tier;
      continue;
    }
    if (tier > bestTier) continue;
    best = preferSentence(best, example, seen);
  }
  return best;
}

export function findExample(corpus: Corpus, hanzi: string): IndexedExample | null {
  for (const list of corpus.examplesByToken.values()) {
    for (const example of list) {
      if (example.hanzi === hanzi) return example;
    }
  }
  return null;
}

function sentenceAligns(example: IndexedExample): boolean {
  return alignSentencePinyin(example.hanzi, example.pinyin) !== null;
}

function align(
  hanzi: string,
  tokens: readonly string[],
  readingFor: (start: number, end: number) => string,
): PracticePiece[] {
  const pieces: PracticePiece[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const at = hanzi.indexOf(token, cursor);
    if (at < 0) {
      pieces.push({ kind: "word", hanzi: token, pinyin: "" });
      continue;
    }
    if (at > cursor) pieces.push({ kind: "gap", text: hanzi.slice(cursor, at) });
    pieces.push({
      kind: "word",
      hanzi: token,
      pinyin: readingFor(at, at + token.length),
    });
    cursor = at + token.length;
  }
  if (cursor < hanzi.length) pieces.push({ kind: "gap", text: hanzi.slice(cursor) });
  return pieces;
}

/** Per-word readings taken from the sentence file. Never the dictionary. */
function piecesFromSentence(
  hanzi: string,
  tokens: readonly string[],
  pinyin: string,
): PracticePiece[] {
  const spans = alignSentencePinyin(hanzi, pinyin);
  return align(hanzi, tokens, (start, end) =>
    spans ? (pinyinSlice(pinyin, spans, start, end) ?? "") : "",
  );
}

/** One sentence the picker weighed for the focus word. */
export type PracticeCandidate = {
  hanzi: string;
  /** 1: other words all stable. 2: all known. 3: anything else. */
  tier: number;
  /** Words in the sentence that have no card yet. */
  newWords: string[];
  shownAt: number | null;
  tokens: number;
  chosen: boolean;
};

/** Why the current sentence was picked, recorded when it was picked. */
export type PracticeWhy = {
  decidedAt: number;
  purpose: PracticePurpose;
  focus: string;
  reasons: string[];
  /** Due words in the order the picker tried them, most urgent first. */
  dueQueue: { hanzi: string; retrievability: number; due: number }[];
  candidates: PracticeCandidate[];
};

export type PracticePlan = { active: PracticeActive; why: PracticeWhy };

const CANDIDATE_LIMIT = 8;

const TIER_REASON: Record<number, string> = {
  1: "every other word in it is stable",
  2: "every other word in it is known, though some are not yet stable",
  3: "it has no better option: some other words are fragile or new, or it is the word alone",
};

function ago(now: number, at: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** First dictionary sense, without CC-CEDICT cross-references. */
function shortGloss(gloss: string): string {
  const first = gloss
    .split(/[;/]/u)[0]
    .replace(/\s*\([^)]*\)/gu, "")
    .trim();
  return first || gloss;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * The next prompt and the reasons for it.
 * Nothing due: the introducing sentence of the next curriculum word with no card.
 * Something due: one sentence for the most urgent word. That sentence stays
 * inside words that already have cards when any indexed sentence can.
 * Among those, prefer companions the student knows well, then a sentence they
 * have not seen, then the one shown furthest in the past.
 * A pinyin sentence is eligible only when its file pinyin lines up with its characters.
 *
 * Listening plans the same way over its own cards, with three differences:
 * it always needs a sentence to speak, so a word with none is skipped; a new
 * word must already count as known from reading; and a review that cannot stay
 * inside listening cards prefers sentences whose words all have reading cards.
 */
export function planPractice(
  corpus: Corpus,
  cards: readonly Card[],
  seen: readonly SeenSentence[],
  now: number,
  options: PlanOptions = {},
): PracticePlan | null {
  const listening = options.deck === "listening";
  const eligible = listening ? () => true : sentenceAligns;
  const readingHeld = new Set((options.reading ?? []).map((card) => card.hanzi));
  const readingKnown = new Set(
    (options.reading ?? []).filter(countsAsKnown).map((card) => card.hanzi),
  );
  const seenAt = new Map(seen.map((row) => [row.hanzi, row.shownAt]));
  const stable = stableHanzi(cards, now);
  const known = new Set<string>();
  for (const card of cards) if (countsAsKnown(card)) known.add(card.hanzi);
  const held = new Set(cards.map((card) => card.hanzi));
  const due = dueCards(cards, now);
  const dueQueue = due.map((card) => ({
    hanzi: card.hanzi,
    retrievability: retrievability(card, now),
    due: card.due,
  }));

  for (const card of due) {
    const word = corpus.byHanzi.get(card.hanzi);
    if (!word) continue;
    const reasons: string[] = [
      `Review. ${due.length} word${due.length === 1 ? " is" : "s are"} due. ${word.hanzi} (${shortGloss(word.gloss)}) is the most urgent: recall chance ${percent(retrievability(card, now))}, due ${ago(now, card.due)}, ${STATE_NAME_OF[card.state]}.`,
    ];
    const options = (corpus.examplesByToken.get(word.hanzi) ?? []).filter(eligible);
    if (listening && options.length === 0) continue;
    const familiar = options.filter(
      (example) => !introducesNewWord(example.tokens, held),
    );
    const read = listening
      ? options.filter((example) => !introducesNewWord(example.tokens, readingHeld))
      : [];
    const pool = familiar.length > 0 ? familiar : read.length > 0 ? read : options;
    const chosen = bestSentence(pool, word.hanzi, stable, known, seenAt);
    if (options.length === 0) {
      reasons.push(
        `No sentence with ${word.hanzi} has pinyin that lines up, so the word is shown alone.`,
      );
    } else if (familiar.length > 0) {
      reasons.push(
        `${options.length} sentence${options.length === 1 ? "" : "s"} contain ${word.hanzi}; ${familiar.length} use only words that already have cards, so only those were considered.`,
      );
    } else if (read.length > 0) {
      reasons.push(
        `${options.length} sentence${options.length === 1 ? "" : "s"} contain ${word.hanzi}; each adds a word with no listening card, so the ${read.length} whose words all have reading cards were considered.`,
      );
    } else {
      reasons.push(
        `${options.length} sentence${options.length === 1 ? "" : "s"} contain ${word.hanzi}, but each adds a word with no card, so all were considered.`,
      );
    }
    if (chosen) {
      const tier = sentenceTier(chosen, word.hanzi, stable, known);
      reasons.push(`Picked this sentence because ${TIER_REASON[tier]}.`);
      const shown = seenAt.get(chosen.hanzi);
      const ties = pool.filter(
        (example) => sentenceTier(example, word.hanzi, stable, known) === tier,
      ).length;
      if (ties > 1) {
        reasons.push(
          shown === undefined
            ? `${ties} sentences tie at that level; this one has not been shown before.`
            : `${ties} sentences tie at that level and all have been shown; this one was shown longest ago (${ago(now, shown)}).`,
        );
      } else if (shown !== undefined) {
        reasons.push(`It was last shown ${ago(now, shown)}.`);
      }
    }
    const candidates = rankCandidates(
      options,
      word.hanzi,
      stable,
      known,
      held,
      seenAt,
      chosen,
    );
    return {
      active: {
        hanzi: chosen?.hanzi ?? word.hanzi,
        purpose: "review",
        focus: word.hanzi,
      },
      why: {
        decidedAt: now,
        purpose: "review",
        focus: word.hanzi,
        reasons,
        dueQueue,
        candidates,
      },
    };
  }

  if (listening) {
    return planFirstListen(corpus, cards, held, readingKnown, stable, known, seenAt, {
      now,
      dueQueue,
    });
  }
  const next = corpus.curriculum.find((word) => !held.has(word.hanzi));
  if (!next) return null;
  const reasons: string[] = [];
  const upcoming = cards
    .filter((card) => card.state !== State.New && card.due > now)
    .sort((a, b) => a.due - b.due)[0];
  reasons.push(
    upcoming
      ? `New word. Nothing is due; the next review is ${upcoming.hanzi} in ${until(now, upcoming.due)}.`
      : "New word. Nothing is due and no word has a card yet.",
  );
  const rank = corpus.curriculum.indexOf(next) + 1;
  reasons.push(
    `${next.hanzi} (${shortGloss(next.gloss)}) is the most frequent curriculum word without a card (#${rank} of ${corpus.curriculum.length}).`,
  );
  const hanzi = next.exampleHanzi.trim() || next.hanzi;
  const example = findExample(corpus, hanzi);
  const usable = example && sentenceAligns(example);
  reasons.push(
    usable
      ? "Shown in its own introducing sentence. Get it right and it jumps to a 14-day interval; reveal it and it starts the short learning steps."
      : "Its introducing sentence has no usable pinyin, so the word is shown alone.",
  );
  return {
    active: {
      hanzi: usable ? example.hanzi : next.hanzi,
      purpose: "introduce",
      focus: next.hanzi,
    },
    why: {
      decidedAt: now,
      purpose: "introduce",
      focus: next.hanzi,
      reasons,
      dueQueue,
      candidates: usable
        ? rankCandidates([example], next.hanzi, stable, known, held, seenAt, example)
        : [],
    },
  };
}

/**
 * The next curriculum word that is known from reading and has no listening card,
 * heard in its own introducing sentence (or, failing that, any sentence with it).
 */
function planFirstListen(
  corpus: Corpus,
  cards: readonly Card[],
  held: ReadonlySet<string>,
  readingKnown: ReadonlySet<string>,
  stable: ReadonlySet<string>,
  known: ReadonlySet<string>,
  seenAt: ReadonlyMap<string, number>,
  at: { now: number; dueQueue: PracticeWhy["dueQueue"] },
): PracticePlan | null {
  const { now, dueQueue } = at;
  for (const next of corpus.curriculum) {
    if (held.has(next.hanzi) || !readingKnown.has(next.hanzi)) continue;
    const own = findExample(corpus, next.exampleHanzi.trim());
    const example =
      own && own.tokens.includes(next.hanzi)
        ? own
        : bestSentence(
            corpus.examplesByToken.get(next.hanzi) ?? [],
            next.hanzi,
            stable,
            known,
            seenAt,
          );
    if (!example) continue;
    const reasons: string[] = [];
    const upcoming = cards
      .filter((card) => card.state !== State.New && card.due > now)
      .sort((a, b) => a.due - b.due)[0];
    reasons.push(
      upcoming
        ? `First listen. No listening card is due; the next is ${upcoming.hanzi} in ${until(now, upcoming.due)}.`
        : "First listen. No word has a listening card yet.",
    );
    const rank = corpus.curriculum.indexOf(next) + 1;
    reasons.push(
      `${next.hanzi} (${shortGloss(next.gloss)}) is the most frequent curriculum word that is known from reading and has no listening card (#${rank} of ${corpus.curriculum.length}).`,
    );
    reasons.push(
      example === own
        ? "Heard in its own introducing sentence."
        : "Its introducing sentence could not be found, so another sentence with it was picked.",
    );
    return {
      active: { hanzi: example.hanzi, purpose: "introduce", focus: next.hanzi },
      why: {
        decidedAt: now,
        purpose: "introduce",
        focus: next.hanzi,
        reasons,
        dueQueue,
        candidates: rankCandidates(
          [example],
          next.hanzi,
          stable,
          known,
          held,
          seenAt,
          example,
        ),
      },
    };
  }
  return null;
}

export function pickPractice(
  corpus: Corpus,
  cards: readonly Card[],
  seen: readonly SeenSentence[],
  now: number,
  options: PlanOptions = {},
): PracticeActive | null {
  return planPractice(corpus, cards, seen, now, options)?.active ?? null;
}

const STATE_NAME_OF = ["new", "learning", "in review", "relearning"] as const;

function until(now: number, at: number): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function rankCandidates(
  options: readonly IndexedExample[],
  focus: string,
  stable: ReadonlySet<string>,
  known: ReadonlySet<string>,
  held: ReadonlySet<string>,
  seen: ReadonlyMap<string, number>,
  chosen: IndexedExample | null,
): PracticeCandidate[] {
  const rows = options.map((example) => ({
    hanzi: example.hanzi,
    tier: sentenceTier(example, focus, stable, known),
    newWords: example.tokens.filter((token) => !held.has(token)),
    shownAt: seen.get(example.hanzi) ?? null,
    tokens: example.tokens.length,
    chosen: example === chosen,
  }));
  rows.sort(
    (a, b) =>
      Number(b.chosen) - Number(a.chosen) ||
      a.newWords.length - b.newWords.length ||
      a.tier - b.tier ||
      a.tokens - b.tokens,
  );
  return rows.slice(0, CANDIDATE_LIMIT);
}

export function promptFromActive(
  corpus: Corpus,
  active: PracticeActive,
): PracticePrompt {
  const example = findExample(corpus, active.hanzi);
  if (example) {
    return {
      hanzi: active.hanzi,
      english: example.english,
      purpose: active.purpose,
      focus: active.focus,
      pieces: piecesFromSentence(example.hanzi, example.tokens, example.pinyin),
    };
  }
  // A word shown on its own uses its dictionary reading. That prompt is not a sentence.
  const word = corpus.byHanzi.get(active.hanzi);
  if (word?.pinyin) {
    return {
      hanzi: active.hanzi,
      english: word.gloss,
      purpose: active.purpose,
      focus: active.focus,
      pieces: [{ kind: "word", hanzi: word.hanzi, pinyin: word.pinyin }],
    };
  }
  return {
    hanzi: active.hanzi,
    english: "",
    purpose: active.purpose,
    focus: active.focus,
    pieces: [{ kind: "gap", text: active.hanzi }],
  };
}

/** One event per word. A revealed slot is a recall miss. Duplicates merge later. */
export function gradePractice(
  prompt: PracticePrompt,
  revealed: readonly number[],
): Evidence[] {
  const shown = new Set(revealed);
  const events: Evidence[] = [];
  let index = 0;
  for (const piece of prompt.pieces) {
    if (piece.kind !== "word") continue;
    events.push({
      hanzi: piece.hanzi,
      outcome: shown.has(index) ? "unknown" : "produced",
      quote: piece.hanzi,
    });
    index += 1;
  }
  return events;
}

/** One card as the scheduler sees it, for the debug panel. */
export type KnowledgeRow = {
  hanzi: string;
  pinyin: string;
  gloss: string;
  state: string;
  /** stable, known (not yet stable) or fragile (missed and not graduated). */
  standing: "stable" | "known" | "fragile";
  retrievability: number;
  stability: number;
  difficulty: number;
  due: number;
  lastReview: number | null;
  reps: number;
  lapses: number;
};

/** Every card, soonest due first. */
export function knowledgeModel(
  corpus: Corpus,
  cards: readonly Card[],
  now: number,
): KnowledgeRow[] {
  const stable = stableHanzi(cards, now);
  return cards
    .map((card) => {
      const word = corpus.byHanzi.get(card.hanzi);
      const standing: KnowledgeRow["standing"] = stable.has(card.hanzi)
        ? "stable"
        : countsAsKnown(card)
          ? "known"
          : "fragile";
      return {
        hanzi: card.hanzi,
        pinyin: word?.pinyin ?? "",
        gloss: word?.gloss ?? "",
        state: STATE_NAME[card.state],
        standing,
        retrievability: retrievability(card, now),
        stability: card.stability,
        difficulty: card.difficulty,
        due: card.due,
        lastReview: card.lastReview,
        reps: card.reps,
        lapses: card.lapses,
      };
    })
    .sort((a, b) => a.due - b.due || a.hanzi.localeCompare(b.hanzi, "zh"));
}
