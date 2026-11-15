import type { Corpus } from "./corpus/model";
import { isQuestionWord } from "./corpus/model";
import type { Candidate, Mention } from "./llm/types";
import type { Llm } from "./llm/types";
import type { Card } from "./srs/fsrs";
import {
  applyEvidence,
  frontier,
  renderBrief,
  suggest,
  type AppliedReview,
  type Evidence,
  type Suggestion,
} from "./srs/schedule";

export type Snapshot = {
  messages: { role: "user" | "assistant"; content: string }[];
  cards: Card[];
};

export type Trace = {
  backend: string;
  events: AppliedReview[];
  suggestions: Suggestion[];
  brief: string;
  mentions: Mention[];
};

export type TurnResult = {
  reply: string;
  cards: Card[];
  trace: Trace;
};

function lastTutorText(messages: Snapshot["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return messages[i].content;
  }
  return "";
}

function trackedWords(corpus: Corpus, text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const part of corpus.segmenter.segment(text)) {
    if (part.kind !== "word" || seen.has(part.hanzi)) continue;
    const word = corpus.byHanzi.get(part.hanzi);
    if (!word?.tracked) continue;
    seen.add(part.hanzi);
    found.push(part.hanzi);
  }
  return found;
}

function candidatesFor(
  corpus: Corpus,
  studentText: string,
  tutorText: string,
): Candidate[] {
  const ordered: Candidate[] = [];
  const seen = new Set<string>();
  const push = (hanzi: string, where: Candidate["where"]) => {
    if (seen.has(hanzi)) return;
    const word = corpus.byHanzi.get(hanzi);
    if (!word?.tracked) return;
    seen.add(hanzi);
    ordered.push({ hanzi, gloss: word.gloss, where });
  };
  for (const hanzi of trackedWords(corpus, studentText)) push(hanzi, "student");
  for (const hanzi of trackedWords(corpus, tutorText)) push(hanzi, "tutor");
  return ordered.slice(0, 24);
}

function mentionsFor(corpus: Corpus, studentText: string): Mention[] {
  return trackedWords(corpus, studentText)
    .filter((hanzi) => !isQuestionWord(hanzi))
    .map((hanzi) => {
      const word = corpus.byHanzi.get(hanzi);
      return {
        hanzi,
        gloss: word?.gloss ?? "",
        exampleEnglish: word?.exampleEnglish ?? "",
      };
    });
}

export type PreparedTurn = {
  cards: Card[];
  trace: Trace;
  tutorInput: {
    history: Snapshot["messages"];
    studentText: string;
    brief: string;
    suggestions: Suggestion[];
    mentions: Mention[];
  };
};

/**
 * Read the message, record the evidence, and refresh the schedule.
 * The tutor call is separate so the reply can stream.
 */
export async function prepareTurn(input: {
  corpus: Corpus;
  snapshot: Snapshot;
  studentText: string;
  now: number;
  llm: Llm;
}): Promise<PreparedTurn> {
  const tutorText = lastTutorText(input.snapshot.messages);
  const candidates = candidatesFor(input.corpus, input.studentText, tutorText);
  let judged: Evidence[] = [];
  if (candidates.length > 0) {
    const events = await input.llm.judge({
      history: input.snapshot.messages,
      studentText: input.studentText,
      candidates,
    });
    judged = events.map((event) => ({
      hanzi: event.hanzi,
      outcome: event.outcome,
      quote: event.quote,
    }));
  }
  const allowed = new Set(candidates.map((candidate) => candidate.hanzi));
  const { cards, applied } = applyEvidence(
    input.snapshot.cards,
    judged,
    allowed,
    input.now,
  );
  const suggestions = suggest(input.corpus, cards, input.now);
  const mentions = mentionsFor(input.corpus, input.studentText);
  const brief = renderBrief(
    frontier(
      input.corpus,
      cards,
      input.now,
      mentions.map((mention) => mention.hanzi),
    ),
    suggestions,
  );
  return {
    cards,
    trace: {
      backend: input.llm.name,
      events: applied,
      suggestions,
      brief,
      mentions,
    },
    tutorInput: {
      history: input.snapshot.messages,
      studentText: input.studentText,
      brief,
      suggestions,
      mentions,
    },
  };
}

/**
 * One conversational turn:
 * read the message against the previous context, record the evidence,
 * refresh the schedule, then ask the tutor. Suggestions are optional.
 */
export async function runTurn(input: {
  corpus: Corpus;
  snapshot: Snapshot;
  studentText: string;
  now: number;
  llm: Llm;
}): Promise<TurnResult> {
  const prepared = await prepareTurn(input);
  const reply = (await input.llm.tutor(prepared.tutorInput)).trim();
  if (!reply) throw new Error("The tutor returned an empty reply.");
  return { reply, cards: prepared.cards, trace: prepared.trace };
}
