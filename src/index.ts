import type { Corpus } from "./corpus/model";
import type { Card } from "./srs/fsrs";
import { CorpusEmptyError, getCorpus } from "./corpus/load";
import { Learner } from "./learner";
import { createClaude } from "./llm/claude";
import { TUTOR_INSTRUCTIONS } from "./llm/prompts";
import { rulesLlm } from "./llm/rules";
import type { Llm } from "./llm/types";
import { speak, SpeechError } from "./speech";
import {
  findExample,
  gradePractice,
  isPracticeDeck,
  knowledgeModel,
  planPractice,
  promptFromActive,
  type PracticeDeck,
  type PracticePrompt,
  type PracticeWhy,
} from "./srs/practice";
import { applyEvidence, frontier, preview, renderBrief, suggest } from "./srs/schedule";
import { prepareTurn, type Snapshot, type Trace } from "./turn";

export { Learner };

const LEARNER_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_BODY = 20_000;
const MAX_TEXT = 2_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

declare global {
  interface Env {
    ANTHROPIC_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
  }
}

function llmFor(env: Env): Llm {
  const backend: string = env.TUTOR_BACKEND;
  if (backend === "rules") return rulesLlm();
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(
      500,
      "ANTHROPIC_API_KEY is not set. Add it with wrangler secret put, or a .dev.vars file for local dev.",
    );
  }
  return createClaude({
    apiKey: env.ANTHROPIC_API_KEY,
    tutorModel: env.TUTOR_MODEL,
    judgeModel: env.JUDGE_MODEL,
    tutorEffort: env.TUTOR_EFFORT,
    judgeEffort: env.JUDGE_EFFORT,
  });
}

function learnerStub(env: Env, id: string): DurableObjectStub<Learner> {
  if (!LEARNER_ID.test(id))
    throw new HttpError(400, "Learner id must be 1–64 letters, numbers, _ or -.");
  return env.LEARNER.get(env.LEARNER.idFromName(id));
}

async function readJson(request: Request): Promise<unknown> {
  const claimed = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(claimed) && claimed > MAX_BODY)
    throw new HttpError(413, "Request body is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request body is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}

function field(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

function revealedIndexes(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new HttpError(400, "Revealed words must be a short list of positions.");
  }
  const indexes: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 100) {
      throw new HttpError(400, "Revealed words must be a short list of positions.");
    }
    indexes.push(item);
  }
  return indexes;
}

function deckOf(body: unknown, url: URL): PracticeDeck {
  const value = field(body, "deck") ?? url.searchParams.get("deck") ?? "pinyin";
  if (!isPracticeDeck(value)) throw new HttpError(400, "Unknown practice deck.");
  return value;
}

function practiceResponse(input: {
  deck: PracticeDeck;
  prompt: PracticePrompt | null;
  why: PracticeWhy | null;
  corpus: Corpus;
  /** Cards of this deck. */
  cards: readonly Card[];
  /** Reading cards, for the schedule beside the exercise. */
  readingCards: readonly Card[];
  trace: Trace | null;
  now: number;
}) {
  return {
    deck: input.deck,
    prompt: input.prompt,
    preview: preview(input.corpus, input.readingCards, input.now),
    trace: input.trace,
    debug: {
      now: input.now,
      why: input.why,
      knowledge: knowledgeModel(input.corpus, input.cards, input.now),
    },
  };
}

function learnerId(body: unknown, url: URL): string {
  const fromBody = field(body, "learner");
  const value =
    typeof fromBody === "string" ? fromBody : (url.searchParams.get("learner") ?? "");
  return value.trim();
}

async function sessionPayload(env: Env, id: string, now: number) {
  const corpus = await getCorpus(env.CORPUS);
  const ledger = await learnerStub(env, id).snapshot();
  return {
    learner: id,
    backend: env.TUTOR_BACKEND,
    tutorModel: env.TUTOR_MODEL,
    judgeModel: env.JUDGE_MODEL,
    systemPrompt: TUTOR_INSTRUCTIONS,
    messages: ledger.messages,
    trace: ledger.trace,
    preview: preview(corpus, ledger.cards, now),
  };
}

const encoder = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function completeTurn(input: {
  stub: DurableObjectStub<Learner>;
  token: string;
  corpus: Corpus;
  llm: Llm;
  snapshot: Snapshot;
  studentText: string;
  now: number;
  learner: string;
}): Promise<Response> {
  try {
    const prepared = await prepareTurn({
      corpus: input.corpus,
      snapshot: input.snapshot,
      studentText: input.studentText,
      now: input.now,
      llm: input.llm,
    });
    const reply = (await input.llm.tutor(prepared.tutorInput)).trim();
    if (!reply) throw new Error("The tutor returned an empty reply.");
    const saved = await input.stub.commit({
      token: input.token,
      now: input.now,
      studentText: input.studentText,
      reply,
      cards: prepared.cards,
      trace: prepared.trace,
    });
    if (!saved.ok)
      throw new HttpError(409, "The turn lock expired before the reply was saved.");
    console.log(
      JSON.stringify({
        message: "turn complete",
        learner: input.learner,
        backend: prepared.trace.backend,
        events: prepared.trace.events.length,
        suggestions: prepared.trace.suggestions.length,
      }),
    );
    return Response.json({
      reply,
      trace: prepared.trace,
      preview: preview(input.corpus, prepared.cards, input.now),
    });
  } catch (error) {
    await input.stub.abort(input.token);
    throw error;
  }
}

function streamTurn(input: {
  request: Request;
  stub: DurableObjectStub<Learner>;
  token: string;
  corpus: Corpus;
  llm: Llm;
  snapshot: Snapshot;
  studentText: string;
  now: number;
  learner: string;
}): Response {
  const upstream = new AbortController();
  const onAbort = () => upstream.abort();
  input.request.signal.addEventListener("abort", onAbort);
  let committed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(sse(event, data));
      };
      try {
        const prepared = await prepareTurn({
          corpus: input.corpus,
          snapshot: input.snapshot,
          studentText: input.studentText,
          now: input.now,
          llm: input.llm,
        });
        send("meta", {
          trace: prepared.trace,
          preview: preview(input.corpus, prepared.cards, input.now),
        });
        let reply = "";
        for await (const delta of input.llm.tutorStream(
          prepared.tutorInput,
          upstream.signal,
        )) {
          reply += delta;
          send("delta", { text: delta });
        }
        reply = reply.trim();
        if (!reply) throw new Error("The tutor returned an empty reply.");
        const saved = await input.stub.commit({
          token: input.token,
          now: input.now,
          studentText: input.studentText,
          reply,
          cards: prepared.cards,
          trace: prepared.trace,
        });
        if (!saved.ok)
          throw new Error("The turn lock expired before the reply was saved.");
        committed = true;
        console.log(
          JSON.stringify({
            message: "turn complete",
            learner: input.learner,
            backend: prepared.trace.backend,
            events: prepared.trace.events.length,
            suggestions: prepared.trace.suggestions.length,
          }),
        );
        send("done", { reply });
        controller.close();
      } catch (error) {
        if (!committed) await input.stub.abort(input.token);
        if (committed || input.request.signal.aborted) {
          try {
            controller.close();
          } catch {
            // The client already went away.
          }
          return;
        }
        const message = error instanceof Error ? error.message : "The turn failed.";
        console.error(JSON.stringify({ message: "request failed", error: message }));
        try {
          send("error", { error: message });
          controller.close();
        } catch {
          // The stream is already closed.
        }
      } finally {
        input.request.signal.removeEventListener("abort", onAbort);
      }
    },
    cancel() {
      upstream.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({
          ok: true,
          backend: env.TUTOR_BACKEND,
          tutorModel: env.TUTOR_MODEL,
          judgeModel: env.JUDGE_MODEL,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        const id = learnerId(null, url);
        return Response.json(await sessionPayload(env, id, Date.now()));
      }
      if (request.method === "GET" && url.pathname === "/api/practice") {
        const id = learnerId(null, url);
        const deck = deckOf(null, url);
        const now = Date.now();
        const corpus = await getCorpus(env.CORPUS);
        const stub = learnerStub(env, id);
        const view = await stub.practiceView(deck);
        let active = view.active;
        let why = view.why;
        if (!active) {
          const plan = planPractice(corpus, view.cards, view.seen, now, {
            deck,
            reading: view.readingCards,
          });
          if (plan) {
            const kept = await stub.remember({
              ...plan.active,
              deck,
              why: plan.why,
              now,
            });
            active = kept.active;
            why = kept.why;
          }
        }
        return Response.json(
          practiceResponse({
            deck,
            prompt: active ? promptFromActive(corpus, active) : null,
            why,
            corpus,
            cards: view.cards,
            readingCards: view.readingCards,
            trace: view.trace,
            now,
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/practice") {
        const body = await readJson(request);
        const id = learnerId(body, url);
        const deck = deckOf(body, url);
        const hanzi = field(body, "hanzi");
        if (typeof hanzi !== "string" || hanzi.length === 0 || hanzi.length > 200) {
          throw new HttpError(400, "That practice sentence is missing.");
        }
        const revealed = revealedIndexes(field(body, "revealed"));
        const now = Date.now();
        const corpus = await getCorpus(env.CORPUS);
        const stub = learnerStub(env, id);
        const view = await stub.practiceView(deck);
        if (!view.active || view.active.hanzi !== hanzi) {
          throw new HttpError(409, "That sentence is no longer the current exercise.");
        }
        const events = gradePractice(promptFromActive(corpus, view.active), revealed);
        // A listening card is only made for a word the student has met in reading.
        const reading = new Set(view.readingCards.map((card) => card.hanzi));
        const allowed = new Set<string>();
        for (const event of events) {
          if (!corpus.byHanzi.get(event.hanzi)?.tracked) continue;
          if (deck === "listening" && !reading.has(event.hanzi)) continue;
          allowed.add(event.hanzi);
        }
        const graded = applyEvidence(view.cards, events, allowed, now);
        const readingCards = deck === "pinyin" ? graded.cards : view.readingCards;
        const suggestions = suggest(corpus, readingCards, now);
        const trace: Trace = {
          backend: deck === "pinyin" ? "practice" : deck,
          events: graded.applied,
          suggestions: deck === "pinyin" ? suggestions : [],
          brief:
            deck === "pinyin"
              ? renderBrief(frontier(corpus, graded.cards, now, []), suggestions)
              : "",
          mentions: [],
        };
        const saved = await stub.finishPractice({
          deck,
          now,
          hanzi,
          revision: view.revision,
          cards: graded.cards,
          trace,
        });
        if (!saved.ok) {
          throw new HttpError(
            409,
            saved.error === "busy"
              ? "A turn is already running for this learner."
              : "That sentence is no longer the current exercise.",
          );
        }
        const plan = planPractice(corpus, graded.cards, view.seen, now, {
          deck,
          reading: readingCards,
        });
        const kept = plan
          ? await stub.remember({ ...plan.active, deck, why: plan.why, now })
          : null;
        const active = kept?.active ?? null;
        console.log(
          JSON.stringify({
            message: "practice complete",
            learner: id,
            deck,
            events: trace.events.length,
            revealed: revealed.length,
          }),
        );
        return Response.json(
          practiceResponse({
            deck,
            prompt: active ? promptFromActive(corpus, active) : null,
            why: kept?.why ?? null,
            corpus,
            cards: graded.cards,
            readingCards,
            trace,
            now,
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/speech") {
        const text = url.searchParams.get("text") ?? "";
        if (text.length === 0 || text.length > 200) {
          throw new HttpError(400, "That sentence is missing.");
        }
        if (!env.OPENROUTER_API_KEY) {
          throw new HttpError(
            503,
            "OPENROUTER_API_KEY is not set. Add it with wrangler secret put, or a .dev.vars file for local dev.",
          );
        }
        const corpus = await getCorpus(env.CORPUS);
        if (!findExample(corpus, text)) {
          throw new HttpError(404, "Only practice sentences can be spoken.");
        }
        return await speak(
          {
            apiKey: env.OPENROUTER_API_KEY,
            model: env.TTS_MODEL,
            voice: env.TTS_VOICE,
          },
          text,
          ctx,
        );
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        const body = await readJson(request);
        const id = learnerId(body, url);
        await learnerStub(env, id).reset();
        return Response.json(await sessionPayload(env, id, Date.now()));
      }
      if (request.method === "POST" && url.pathname === "/api/turn") {
        const body = await readJson(request);
        const id = learnerId(body, url);
        const text = field(body, "text");
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new HttpError(400, "Type a message first.");
        }
        if (text.length > MAX_TEXT)
          throw new HttpError(400, "That message is too long.");
        const studentText = text.trim();
        const now = Date.now();
        const stub = learnerStub(env, id);
        const begun = await stub.begin(now);
        if (!begun.ok)
          throw new HttpError(409, "A turn is already running for this learner.");
        let corpus;
        let llm;
        try {
          corpus = await getCorpus(env.CORPUS);
          llm = llmFor(env);
        } catch (error) {
          await stub.abort(begun.token);
          throw error;
        }
        const turnInput = {
          request,
          stub,
          token: begun.token,
          corpus,
          llm,
          snapshot: { messages: begun.messages, cards: begun.cards },
          studentText,
          now,
          learner: id,
        };
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("text/event-stream")) return streamTurn(turnInput);
        return await completeTurn(turnInput);
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    } catch (error) {
      if (error instanceof CorpusEmptyError) {
        return Response.json({ error: error.message }, { status: 503 });
      }
      if (error instanceof HttpError || error instanceof SpeechError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      const message = error instanceof Error ? error.message : "The turn failed.";
      console.error(JSON.stringify({ message: "request failed", error: message }));
      return Response.json({ error: message }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
