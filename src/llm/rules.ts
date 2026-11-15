import { isQuestionWord } from "../corpus/model";
import type { Outcome } from "../srs/schedule";
import type { JudgeEvent, JudgeInput, Llm, TutorInput } from "./types";

const MEANING =
  /什么意思|是什么|什么是|what does|what is|what's|what’s|\bmeans?\b|don't know|do not know|不知道|不认识|不会/iu;

function outcomeFor(
  input: JudgeInput,
  hanzi: string,
  inStudent: boolean,
): Outcome | null {
  if (!inStudent) return null;
  if (MEANING.test(input.studentText) && !isQuestionWord(hanzi)) return "unknown";
  if (isQuestionWord(hanzi)) return null;
  return "produced";
}

function replyFor(input: TutorInput): string {
  if (MEANING.test(input.studentText)) {
    const mention = input.mentions.find((item) => !isQuestionWord(item.hanzi));
    if (mention) {
      const gloss = mention.gloss || mention.exampleEnglish;
      return `${mention.hanzi}的意思是“${gloss}”。${mention.exampleEnglish}`;
    }
  }
  const suggestion = input.suggestions[0];
  const asking = input.studentText.includes("?") || input.studentText.includes("？");
  if (suggestion && !asking) return `好。${suggestion.exampleHanzi}`;
  return "我在。你想说什么？";
}

export function rulesLlm(): Llm {
  return {
    name: "rules",
    judge(input: JudgeInput): Promise<JudgeEvent[]> {
      const events: JudgeEvent[] = [];
      for (const candidate of input.candidates) {
        if (candidate.where !== "student") continue;
        if (!input.studentText.includes(candidate.hanzi)) continue;
        const outcome = outcomeFor(input, candidate.hanzi, true);
        if (!outcome) continue;
        events.push({ hanzi: candidate.hanzi, outcome, quote: candidate.hanzi });
      }
      return Promise.resolve(events);
    },
    tutor(input: TutorInput): Promise<string> {
      return Promise.resolve(replyFor(input));
    },
    async *tutorStream(input: TutorInput, signal?: AbortSignal): AsyncIterable<string> {
      if (signal?.aborted) throw new Error("The turn was cancelled.");
      const reply = replyFor(input);
      const size = 3;
      for (let index = 0; index < reply.length; index += size) {
        yield reply.slice(index, index + size);
      }
    },
  };
}
