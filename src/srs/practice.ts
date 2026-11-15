import type { Corpus } from "../corpus/model";
import type { IndexedExample } from "../corpus/examples";
import { alignSentencePinyin, pinyinSlice } from "../sentence-pinyin";
import { fsrs, State, type Card } from "./fsrs";
import { countsAsKnown, stableHanzi, type Evidence } from "./schedule";

export type PracticePurpose = "review" | "introduce";

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

function findExample(corpus: Corpus, hanzi: string): IndexedExample | null {
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

/**
 * The next pinyin prompt.
 * Nothing due: the introducing sentence of the next curriculum word with no card.
 * Something due: one sentence for the most urgent word. Prefer companions the
 * student knows well, then a sentence they have not seen, then the one shown
 * furthest in the past.
 * A sentence is eligible only when its file pinyin lines up with its characters.
 */
export function pickPractice(
  corpus: Corpus,
  cards: readonly Card[],
  seen: readonly SeenSentence[],
  now: number,
): PracticeActive | null {
  const seenAt = new Map(seen.map((row) => [row.hanzi, row.shownAt]));
  const stable = stableHanzi(cards, now);
  const known = new Set<string>();
  for (const card of cards) if (countsAsKnown(card)) known.add(card.hanzi);
  const held = new Set(cards.map((card) => card.hanzi));

  for (const card of dueCards(cards, now)) {
    const word = corpus.byHanzi.get(card.hanzi);
    if (!word) continue;
    const options = (corpus.examplesByToken.get(word.hanzi) ?? []).filter(
      sentenceAligns,
    );
    const chosen = bestSentence(options, word.hanzi, stable, known, seenAt);
    if (chosen) {
      return { hanzi: chosen.hanzi, purpose: "review", focus: word.hanzi };
    }
    return { hanzi: word.hanzi, purpose: "review", focus: word.hanzi };
  }

  const next = corpus.curriculum.find((word) => !held.has(word.hanzi));
  if (!next) return null;
  const hanzi = next.exampleHanzi.trim() || next.hanzi;
  const example = findExample(corpus, hanzi);
  if (example && sentenceAligns(example)) {
    return { hanzi: example.hanzi, purpose: "introduce", focus: next.hanzi };
  }
  return { hanzi: next.hanzi, purpose: "introduce", focus: next.hanzi };
}

export function promptFromActive(
  corpus: Corpus,
  active: PracticeActive,
): PracticePrompt {
  const example = findExample(corpus, active.hanzi);
  if (example) {
    return {
      hanzi: active.hanzi,
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
      purpose: active.purpose,
      focus: active.focus,
      pieces: [{ kind: "word", hanzi: word.hanzi, pinyin: word.pinyin }],
    };
  }
  return {
    hanzi: active.hanzi,
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
