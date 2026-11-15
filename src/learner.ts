import { DurableObject } from "cloudflare:workers";
import { State, type Card, type StateValue } from "./srs/fsrs";
import type { PracticePurpose } from "./srs/practice";
import type { Trace } from "./turn";

type DialogueMessage = { role: "user" | "assistant"; content: string };
type TranscriptMessage = { role: "user" | "assistant" | "state"; content: string };

/** About 100 turns, with a learner-state row beside each student and tutor row. */
const TRANSCRIPT_LIMIT = 300;

type CardRow = {
  hanzi: string;
  state: number;
  stability: number;
  difficulty: number;
  due: number;
  last_review: number | null;
  reps: number;
  lapses: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_step: number;
};

export type BeginOk = {
  ok: true;
  token: string;
  messages: DialogueMessage[];
  cards: Card[];
};

export type BeginResult = BeginOk | { ok: false; error: "busy" };

export type CommitInput = {
  token: string;
  now: number;
  studentText: string;
  reply: string;
  cards: Card[];
  trace: Trace;
};

export type PracticeActive = {
  hanzi: string;
  purpose: PracticePurpose;
  focus: string | null;
};

export type PracticeView = {
  cards: Card[];
  seen: { hanzi: string; shownAt: number }[];
  active: PracticeActive | null;
  revision: number;
  trace: Trace | null;
};

export type RememberInput = {
  hanzi: string;
  purpose: PracticePurpose;
  focus: string | null;
  now: number;
};

export type FinishPracticeInput = {
  now: number;
  hanzi: string;
  revision: number;
  cards: Card[];
  trace: Trace;
};

const LOCK_MS = 90_000;

function isState(value: number): value is StateValue {
  return (
    value === State.New ||
    value === State.Learning ||
    value === State.Review ||
    value === State.Relearning
  );
}

export class Learner extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  snapshot(): { messages: TranscriptMessage[]; cards: Card[]; trace: Trace | null } {
    return {
      messages: this.transcript(TRANSCRIPT_LIMIT),
      cards: this.cards(),
      trace: this.lastTrace(),
    };
  }

  begin(now: number): BeginResult {
    const busyUntil = this.metaNumber("busy_until");
    if (busyUntil > now) return { ok: false, error: "busy" };
    const token = crypto.randomUUID();
    this.setMeta("busy_until", String(now + LOCK_MS));
    this.setMeta("token", token);
    return { ok: true, token, messages: this.dialogue(40), cards: this.cards() };
  }

  abort(token: string): { ok: boolean } {
    if (this.meta("token") !== token) return { ok: false };
    this.clearLock();
    return { ok: true };
  }

  commit(input: CommitInput): { ok: true } | { ok: false; error: "stale" } {
    if (this.meta("token") !== input.token) return { ok: false, error: "stale" };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO messages (role, content, at) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)",
        "state",
        input.trace.brief,
        input.now,
        "user",
        input.studentText,
        input.now,
        "assistant",
        input.reply,
        input.now,
      );
      for (const card of input.cards) {
        this.sql.exec(
          `INSERT INTO cards (
            hanzi, state, stability, difficulty, due, last_review, reps, lapses,
            elapsed_days, scheduled_days, learning_step
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(hanzi) DO UPDATE SET
            state = excluded.state,
            stability = excluded.stability,
            difficulty = excluded.difficulty,
            due = excluded.due,
            last_review = excluded.last_review,
            reps = excluded.reps,
            lapses = excluded.lapses,
            elapsed_days = excluded.elapsed_days,
            scheduled_days = excluded.scheduled_days,
            learning_step = excluded.learning_step`,
          card.hanzi,
          card.state,
          card.stability,
          card.difficulty,
          card.due,
          card.lastReview,
          card.reps,
          card.lapses,
          card.elapsedDays,
          card.scheduledDays,
          card.learningStep,
        );
      }
      for (const event of input.trace.events) {
        this.sql.exec(
          "INSERT INTO reviews (id, hanzi, rating, outcome, quote, at, stability, due) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          crypto.randomUUID(),
          event.hanzi,
          event.rating,
          event.outcome,
          event.quote,
          input.now,
          event.stability,
          event.dueAt,
        );
      }
      this.sql.exec(
        "INSERT INTO traces (at, payload) VALUES (?, ?)",
        input.now,
        JSON.stringify(input.trace),
      );
      this.sql.exec(
        `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ${TRANSCRIPT_LIMIT})`,
      );
      this.sql.exec(
        "DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY id DESC LIMIT 20)",
      );
      this.sql.exec("DELETE FROM meta WHERE key IN ('busy_until', 'token')");
      this.bumpRevision();
    });
    return { ok: true };
  }

  practiceView(): PracticeView {
    return {
      cards: this.cards(),
      seen: this.seenSentences(),
      active: this.activePractice(),
      revision: this.revision(),
      trace: this.lastTrace(),
    };
  }

  /**
   * Remember the sentence the student is looking at.
   * A sentence already in progress wins, so a refresh does not reshuffle it.
   */
  remember(input: RememberInput): { ok: true; active: PracticeActive } {
    const existing = this.activePractice();
    if (existing) return { ok: true, active: existing };
    const active: PracticeActive = {
      hanzi: input.hanzi,
      purpose: input.purpose === "introduce" ? "introduce" : "review",
      focus: input.focus,
    };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO seen_sentences (hanzi, shown_at) VALUES (?, ?)
         ON CONFLICT(hanzi) DO UPDATE SET shown_at = excluded.shown_at`,
        active.hanzi,
        input.now,
      );
      this.setMeta("practice", active.hanzi);
      this.setMeta("practice_purpose", active.purpose);
      this.setMeta("practice_focus", active.focus ?? "");
    });
    return { ok: true, active };
  }

  finishPractice(
    input: FinishPracticeInput,
  ): { ok: true } | { ok: false; error: "busy" | "stale" } {
    let result: { ok: true } | { ok: false; error: "busy" | "stale" } = {
      ok: false,
      error: "stale",
    };
    this.ctx.storage.transactionSync(() => {
      if (this.metaNumber("busy_until") > input.now) {
        result = { ok: false, error: "busy" };
        return;
      }
      if (this.meta("practice") !== input.hanzi || this.revision() !== input.revision) {
        result = { ok: false, error: "stale" };
        return;
      }
      for (const card of input.cards) this.writeCard(card);
      for (const event of input.trace.events) {
        this.sql.exec(
          "INSERT INTO reviews (id, hanzi, rating, outcome, quote, at, stability, due) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          crypto.randomUUID(),
          event.hanzi,
          event.rating,
          event.outcome,
          event.quote,
          input.now,
          event.stability,
          event.dueAt,
        );
      }
      this.sql.exec(
        "INSERT INTO traces (at, payload) VALUES (?, ?)",
        input.now,
        JSON.stringify(input.trace),
      );
      this.sql.exec(
        "DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY id DESC LIMIT 20)",
      );
      this.sql.exec(
        "DELETE FROM meta WHERE key IN ('practice', 'practice_purpose', 'practice_focus')",
      );
      this.bumpRevision();
      result = { ok: true };
    });
    return result;
  }

  reset(): { ok: true } {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM cards");
      this.sql.exec("DELETE FROM reviews");
      this.sql.exec("DELETE FROM messages");
      this.sql.exec("DELETE FROM traces");
      this.sql.exec("DELETE FROM seen_sentences");
      this.sql.exec("DELETE FROM meta");
    });
    return { ok: true };
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cards (
      hanzi TEXT PRIMARY KEY,
      state INTEGER NOT NULL,
      stability REAL NOT NULL,
      difficulty REAL NOT NULL,
      due INTEGER NOT NULL,
      last_review INTEGER,
      reps INTEGER NOT NULL,
      lapses INTEGER NOT NULL,
      elapsed_days INTEGER NOT NULL,
      scheduled_days INTEGER NOT NULL,
      learning_step INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS cards_due ON cards (due)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      hanzi TEXT NOT NULL,
      rating INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      quote TEXT NOT NULL,
      at INTEGER NOT NULL,
      stability REAL NOT NULL,
      due INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      payload TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seen_sentences (
      hanzi TEXT PRIMARY KEY,
      shown_at INTEGER NOT NULL
    )`);
  }

  private dialogue(limit: number): DialogueMessage[] {
    return this.rows()
      .filter(
        (row): row is DialogueMessage =>
          row.role === "user" || row.role === "assistant",
      )
      .slice(-limit);
  }

  private transcript(limit: number): TranscriptMessage[] {
    const briefs = new Map<number, string>();
    for (const trace of this.sql
      .exec<{ at: number; payload: string }>(
        "SELECT at, payload FROM traces ORDER BY id ASC",
      )
      .toArray()) {
      try {
        const parsed = JSON.parse(trace.payload) as { brief?: unknown };
        if (typeof parsed.brief === "string") briefs.set(trace.at, parsed.brief);
      } catch {
        // A damaged trace does not hide the conversation.
      }
    }
    const transcript: TranscriptMessage[] = [];
    for (const row of this.sql
      .exec<{ role: string; content: string; at: number }>(
        "SELECT role, content, at FROM messages ORDER BY id ASC",
      )
      .toArray()) {
      if (row.role !== "user" && row.role !== "assistant" && row.role !== "state")
        continue;
      const brief = briefs.get(row.at);
      const previous = transcript[transcript.length - 1];
      if (row.role === "user" && brief && previous?.role !== "state") {
        transcript.push({ role: "state", content: brief });
      }
      transcript.push({ role: row.role, content: row.content });
    }
    return transcript.slice(-limit);
  }

  private rows(): { role: string; content: string }[] {
    return this.sql
      .exec<{ role: string; content: string }>(
        "SELECT role, content FROM messages ORDER BY id ASC",
      )
      .toArray();
  }

  private cards(): Card[] {
    const rows = this.sql
      .exec<CardRow>(
        `SELECT hanzi, state, stability, difficulty, due, last_review, reps, lapses,
                elapsed_days, scheduled_days, learning_step
         FROM cards`,
      )
      .toArray();
    const cards: Card[] = [];
    for (const row of rows) {
      if (!isState(row.state)) continue;
      cards.push({
        hanzi: row.hanzi,
        state: row.state,
        stability: row.stability,
        difficulty: row.difficulty,
        due: row.due,
        lastReview: row.last_review,
        reps: row.reps,
        lapses: row.lapses,
        elapsedDays: row.elapsed_days,
        scheduledDays: row.scheduled_days,
        learningStep: row.learning_step,
      });
    }
    return cards;
  }

  private lastTrace(): Trace | null {
    const rows = this.sql
      .exec<{ payload: string }>("SELECT payload FROM traces ORDER BY id DESC LIMIT 1")
      .toArray();
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].payload) as Trace;
    } catch {
      return null;
    }
  }

  private seenSentences(): { hanzi: string; shownAt: number }[] {
    return this.sql
      .exec<{ hanzi: string; shown_at: number }>(
        "SELECT hanzi, shown_at FROM seen_sentences",
      )
      .toArray()
      .map((row) => ({ hanzi: row.hanzi, shownAt: row.shown_at }));
  }

  private activePractice(): PracticeActive | null {
    const hanzi = this.meta("practice");
    if (!hanzi) return null;
    const purpose = this.meta("practice_purpose");
    const focus = this.meta("practice_focus");
    return {
      hanzi,
      purpose: purpose === "introduce" ? "introduce" : "review",
      focus: focus ? focus : null,
    };
  }

  private revision(): number {
    return this.metaNumber("schedule_rev");
  }

  private bumpRevision(): void {
    this.setMeta("schedule_rev", String(this.revision() + 1));
  }

  private writeCard(card: Card): void {
    this.sql.exec(
      `INSERT INTO cards (
        hanzi, state, stability, difficulty, due, last_review, reps, lapses,
        elapsed_days, scheduled_days, learning_step
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hanzi) DO UPDATE SET
        state = excluded.state,
        stability = excluded.stability,
        difficulty = excluded.difficulty,
        due = excluded.due,
        last_review = excluded.last_review,
        reps = excluded.reps,
        lapses = excluded.lapses,
        elapsed_days = excluded.elapsed_days,
        scheduled_days = excluded.scheduled_days,
        learning_step = excluded.learning_step`,
      card.hanzi,
      card.state,
      card.stability,
      card.difficulty,
      card.due,
      card.lastReview,
      card.reps,
      card.lapses,
      card.elapsedDays,
      card.scheduledDays,
      card.learningStep,
    );
  }

  private meta(key: string): string | null {
    const rows = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  private metaNumber(key: string): number {
    const value = this.meta(key);
    return value === null ? 0 : Number(value);
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private clearLock(): void {
    this.sql.exec("DELETE FROM meta WHERE key IN ('busy_until', 'token')");
  }
}
