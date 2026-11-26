/**
 * Spoken sentences through OpenRouter's text-to-speech endpoint.
 * Audio is cached by the Workers cache so each sentence is paid for once per colo.
 */

const SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
const CACHE_ORIGIN = "https://speech-cache.invalid";
const MAX_AGE = 60 * 60 * 24 * 365;

export type SpeechConfig = {
  apiKey: string;
  model: string;
  voice: string;
};

export class SpeechError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function cacheKey(config: SpeechConfig, text: string): Request {
  const url = new URL("/speech", CACHE_ORIGIN);
  url.searchParams.set("model", config.model);
  url.searchParams.set("voice", config.voice);
  url.searchParams.set("text", text);
  return new Request(url);
}

function audioResponse(body: BodyInit | null): Response {
  return new Response(body, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": `public, max-age=${MAX_AGE}, immutable`,
    },
  });
}

async function upstreamError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // Not JSON; fall through to the status line.
  }
  return `Speech request failed with status ${response.status}.`;
}

export async function synthesize(
  config: SpeechConfig,
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const response = await fetcher(SPEECH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
      voice: config.voice,
      response_format: "mp3",
    }),
  });
  if (!response.ok) throw new SpeechError(502, await upstreamError(response));
  return audioResponse(await response.arrayBuffer());
}

/** Serve speech for `text`, from the cache when possible. */
export async function speak(
  config: SpeechConfig,
  text: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = caches.default;
  const key = cacheKey(config, text);
  const hit = await cache.match(key);
  if (hit) return audioResponse(hit.body);
  const fresh = await synthesize(config, text);
  ctx.waitUntil(cache.put(key, fresh.clone()));
  return fresh;
}
