import { describe, expect, it } from "vitest";
import { readClaudeStream } from "../src/llm/claude";
import { rulesLlm } from "../src/llm/rules";
import type { TutorInput } from "../src/llm/types";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamOf(parts: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    {
      status,
      headers: {
        "content-type": status === 200 ? "text/event-stream" : "application/json",
      },
    },
  );
}

const tutorInput: TutorInput = {
  history: [],
  studentText: "好",
  brief: "",
  suggestions: [
    {
      purpose: "introduce",
      hanzi: "我",
      gloss: "I",
      pinyin: "wǒ",
      exampleHanzi: "我是学生。",
      examplePinyin: "",
      exampleEnglish: "I am a student.",
    },
  ],
  mentions: [],
};

describe("readClaudeStream", () => {
  it("yields text deltas and skips thinking", async () => {
    const body = [
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hidden" },
      }),
      frame("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "你" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "好" },
      }),
    ].join("");
    const mid = Math.floor(body.length / 2);
    const chunks: string[] = [];
    for await (const delta of readClaudeStream(
      streamOf([body.slice(0, mid), body.slice(mid)]),
    )) {
      chunks.push(delta);
    }
    expect(chunks).toEqual(["你", "好"]);
  });

  it("raises the API error message", async () => {
    const response = new Response(JSON.stringify({ error: { message: "bad key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    await expect(readClaudeStream(response).next()).rejects.toThrow("bad key");
  });
});

describe("rules tutor stream", () => {
  it("joins to the same reply as tutor()", async () => {
    const llm = rulesLlm();
    const chunks: string[] = [];
    for await (const delta of llm.tutorStream(tutorInput)) chunks.push(delta);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(await llm.tutor(tutorInput));
  });
});
