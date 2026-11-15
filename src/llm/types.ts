import type { Outcome } from "../srs/schedule";
import type { Suggestion } from "../srs/schedule";

export type DialogueTurn = {
  role: "user" | "assistant";
  content: string;
};

export type Candidate = {
  hanzi: string;
  gloss: string;
  where: "student" | "tutor";
};

export type JudgeEvent = {
  hanzi: string;
  outcome: Outcome;
  quote: string;
};

export type Mention = {
  hanzi: string;
  gloss: string;
  exampleEnglish: string;
};

export type JudgeInput = {
  history: DialogueTurn[];
  studentText: string;
  candidates: Candidate[];
};

export type TutorInput = {
  history: DialogueTurn[];
  studentText: string;
  brief: string;
  suggestions: Suggestion[];
  mentions: Mention[];
};

export interface Llm {
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeEvent[]>;
  tutor(input: TutorInput): Promise<string>;
  tutorStream(input: TutorInput, signal?: AbortSignal): AsyncIterable<string>;
}
