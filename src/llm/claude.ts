import {
  JUDGE_INSTRUCTIONS,
  TUTOR_INSTRUCTIONS,
  judgeSchema,
  judgeUserPrompt,
} from "./prompts";
import type { JudgeEvent, JudgeInput, Llm, TutorInput } from "./types";
import type { Outcome } from "../srs/schedule";

const OUTCOMES = new Set<Outcome>([
  "produced",
  "recognized",
  "unknown",
  "misunderstood",
]);

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

type ContentBlock = { type: string; text?: string };

type MessageResponse = {
  content?: ContentBlock[];
  error?: { message?: string };
};

export type ClaudeOptions = {
  apiKey: string;
  tutorModel: string;
  judgeModel: string;
  tutorEffort: string;
  judgeEffort: string;
  fetchImpl?: typeof fetch;
};

function asEffort(value: string): Effort {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return "low";
}

function textOf(content: ContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

async function createMessage(
  fetchImpl: typeof fetch,
  apiKey: string,
  body: unknown,
): Promise<MessageResponse> {
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2026-10-21",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as MessageResponse;
  if (!response.ok) {
    const detail = payload.error?.message ?? `Claude returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
}

type SseFrame = {
  event: string;
  data: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string };
    error?: { message?: string };
  };
};

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join("\n")) as SseFrame["data"] };
}

/** Text deltas from a Claude messages stream. Thinking blocks are ignored. */
export async function* readClaudeStream(response: Response): AsyncGenerator<string> {
  if (!response.ok) {
    const payload = (await response.json()) as MessageResponse;
    const detail = payload.error?.message ?? `Claude returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!response.body) throw new Error("Claude returned an empty tutor reply");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const blockTypes = new Map<number, string>();
  let sawText = false;
  const take = (frame: SseFrame): string | null => {
    const data = frame.data;
    if (frame.event === "error" || data.type === "error") {
      throw new Error(data.error?.message ?? "Claude stream failed");
    }
    if (data.type === "content_block_start" && typeof data.index === "number") {
      blockTypes.set(data.index, data.content_block?.type ?? "");
    }
    if (data.type !== "content_block_delta" || data.delta?.type !== "text_delta")
      return null;
    const kind = blockTypes.get(data.index ?? 0);
    if (kind && kind !== "text") return null;
    const text = data.delta.text ?? "";
    if (!text) return null;
    sawText = true;
    return text;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let splitAt = buffer.indexOf("\n\n");
    while (splitAt !== -1) {
      const raw = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const frame = raw.trim().length > 0 ? parseFrame(raw) : null;
      if (frame) {
        const text = take(frame);
        if (text) yield text;
      }
      splitAt = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) {
    const frame = parseFrame(buffer);
    if (frame) {
      const text = take(frame);
      if (text) yield text;
    }
  }
  if (!sawText) throw new Error("Claude returned an empty tutor reply");
}

function dialogue(history: TutorInput["history"], studentText: string) {
  const messages = history
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .slice(-16)
    .map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
  if (messages.length > 0 && messages[messages.length - 1].role === "user")
    messages.pop();
  messages.push({ role: "user" as const, content: studentText });
  return messages;
}

export function createClaude(options: ClaudeOptions): Llm {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tutorEffort = asEffort(options.tutorEffort);
  const judgeEffort = asEffort(options.judgeEffort);
  return {
    name: "claude",
    async judge(input: JudgeInput): Promise<JudgeEvent[]> {
      const allowed = new Set(input.candidates.map((candidate) => candidate.hanzi));
      const payload = await createMessage(fetchImpl, options.apiKey, {
        model: options.judgeModel,
        max_tokens: 1500,
        system: [
          { type: "text", text: JUDGE_INSTRUCTIONS },
          { type: "text", text: judgeUserPrompt(input) },
        ],
        messages: [
          { role: "user", content: "Judge the student message. Return the events." },
        ],
        output_config: {
          effort: judgeEffort,
          format: { type: "json_schema", schema: judgeSchema() },
        },
      });
      const parsed = JSON.parse(textOf(payload.content)) as {
        events?: { id?: string; outcome?: string; quote?: string }[];
      };
      const events: JudgeEvent[] = [];
      for (const event of parsed.events ?? []) {
        if (!event.id || !allowed.has(event.id)) continue;
        if (!event.outcome || !OUTCOMES.has(event.outcome as Outcome)) continue;
        events.push({
          hanzi: event.id,
          outcome: event.outcome as Outcome,
          quote: event.quote ?? "",
        });
      }
      return events;
    },
    async tutor(input: TutorInput): Promise<string> {
      let text = "";
      for await (const delta of this.tutorStream(input)) text += delta;
      const reply = text.trim();
      if (!reply) throw new Error("Claude returned an empty tutor reply");
      return reply;
    },
    async *tutorStream(input: TutorInput, signal?: AbortSignal): AsyncIterable<string> {
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2026-10-21",
        },
        body: JSON.stringify({
          model: options.tutorModel,
          max_tokens: 2500,
          stream: true,
          system: [
            { type: "text", text: TUTOR_INSTRUCTIONS },
            { type: "text", text: input.brief },
          ],
          messages: dialogue(input.history, input.studentText),
          output_config: { effort: tutorEffort },
        }),
      });
      yield* readClaudeStream(response);
    },
  };
}
