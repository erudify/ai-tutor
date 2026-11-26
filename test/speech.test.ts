import { describe, expect, it } from "vitest";
import { SpeechError, synthesize } from "../src/speech";

const config = { apiKey: "test-key", model: "qwen/qwen3-tts-1.7b", voice: "vivian" };

describe("synthesize", () => {
  it("posts the sentence to OpenRouter and returns cacheable mp3", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      });
    }) as unknown as typeof fetch;
    const response = await synthesize(config, "我喜欢喝茶。", fetcher);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/audio/speech");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: "qwen/qwen3-tts-1.7b",
      input: "我喜欢喝茶。",
      voice: "vivian",
      response_format: "mp3",
    });
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("surfaces the upstream error message", async () => {
    const fetcher = (async () =>
      Response.json(
        { error: { code: 402, message: "Insufficient credits" } },
        { status: 402 },
      )) as unknown as typeof fetch;
    const failure = synthesize(config, "你好。", fetcher);
    await expect(failure).rejects.toBeInstanceOf(SpeechError);
    await expect(failure).rejects.toThrow("Insufficient credits");
  });
});
