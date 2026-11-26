import { DurableObject } from "cloudflare:workers";
import { State, type Card, type StateValue } from "./srs/fsrs";
import type { PracticeDeck, PracticePurpose, PracticeWhy } from "./srs/practice";
import type { AppliedReview } from "./srs/schedule";
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

/** Where each deck keeps its cards, its seen sentences and its active exercise. */
const DECK_STORE: Record<
  PracticeDeck,
  { cards: string; seen: string; meta: string; source: string }
> = {
  pinyin: {
    cards: "cards",
    seen: "seen_sentences",
    meta: "practice",
    source: "practice",
  },
  listening: {
    cards: "listening_cards",
    seen: "listening_seen",
    meta: "listening",
    source: "listening",
  },
};

export type PracticeView = {
  deck: PracticeDeck;
  /** Cards of this deck. */
  cards: Card[];
  /** Reading cards: the chat and pinyin schedule. Same as cards for pinyin. */
  readingCards: Card[];
  seen: { hanzi: string; shownAt: number }[];
  active: PracticeActive | null;
  /** Why the active sentence was picked. Null for a sentence picked before this was kept. */
  why: PracticeWhy | null;
  revision: number;
  trace: Trace | null;
};

export type RememberInput = {
  deck: PracticeDeck;
  hanzi: string;
  purpose: PracticePurpose;
  focus: string | null;
  why: PracticeWhy;
  now: number;
};

export type FinishPracticeInput = {
  deck: PracticeDeck;
  now: number;
  hanzi: string;
  revision: number;
  cards: Card[];
  trace: Trace;
};

const LOCK_MS = 90_000;

/** Raw review-log fields added after the first schema. */
const REVIEW_LOG_COLUMNS: [string, string][] = [
  ["source", "TEXT"],
  ["sentence", "TEXT"],
  ["is_focus", "INTEGER"],
  ["difficulty", "REAL"],
  ["state_after", "TEXT"],
  ["state_before", "TEXT"],
  ["stability_before", "REAL"],
  ["difficulty_before", "REAL"],
  ["last_review_before", "INTEGER"],
  ["reps_before", "INTEGER"],
  ["lapses_before", "INTEGER"],
];

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
      this.logReviews(input.trace.events, input.now, "chat", null, null);
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

  practiceView(deck: PracticeDeck = "pinyin"): PracticeView {
    const reading = this.cards();
    return {
      deck,
      cards: deck === "pinyin" ? reading : this.cards(DECK_STORE[deck].cards),
      readingCards: reading,
      seen: this.seenSentences(deck),
      active: this.activePractice(deck),
      why: this.practiceWhy(deck),
      revision: this.revision(),
      trace: deck === "pinyin" ? this.lastTrace() : this.deckTrace(deck),
    };
  }

  /**
   * Remember the sentence the student is looking at.
   * A sentence already in progress wins, so a refresh does not reshuffle it.
   */
  remember(input: RememberInput): {
    ok: true;
    active: PracticeActive;
    why: PracticeWhy | null;
  } {
    const store = DECK_STORE[input.deck];
    const existing = this.activePractice(input.deck);
    if (existing)
      return { ok: true, active: existing, why: this.practiceWhy(input.deck) };
    const active: PracticeActive = {
      hanzi: input.hanzi,
      purpose: input.purpose === "introduce" ? "introduce" : "review",
      focus: input.focus,
    };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO ${store.seen} (hanzi, shown_at) VALUES (?, ?)
         ON CONFLICT(hanzi) DO UPDATE SET shown_at = excluded.shown_at`,
        active.hanzi,
        input.now,
      );
      this.setMeta(store.meta, active.hanzi);
      this.setMeta(`${store.meta}_purpose`, active.purpose);
      this.setMeta(`${store.meta}_focus`, active.focus ?? "");
      this.setMeta(`${store.meta}_why`, JSON.stringify(input.why));
    });
    return { ok: true, active, why: input.why };
  }

  finishPractice(
    input: FinishPracticeInput,
  ): { ok: true } | { ok: false; error: "busy" | "stale" } {
    const store = DECK_STORE[input.deck];
    let result: { ok: true } | { ok: false; error: "busy" | "stale" } = {
      ok: false,
      error: "stale",
    };
    this.ctx.storage.transactionSync(() => {
      if (this.metaNumber("busy_until") > input.now) {
        result = { ok: false, error: "busy" };
        return;
      }
      if (this.meta(store.meta) !== input.hanzi || this.revision() !== input.revision) {
        result = { ok: false, error: "stale" };
        return;
      }
      for (const card of input.cards) this.writeCard(card, store.cards);
      this.logReviews(
        input.trace.events,
        input.now,
        store.source,
        input.hanzi,
        this.meta(`${store.meta}_focus`) || null,
      );
      if (input.deck === "pinyin") {
        this.sql.exec(
          "INSERT INTO traces (at, payload) VALUES (?, ?)",
          input.now,
          JSON.stringify(input.trace),
        );
        this.sql.exec(
          "DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY id DESC LIMIT 20)",
        );
      } else {
        // The chat's "last turn" stays about reading; this deck keeps its own.
        this.setMeta(`${store.meta}_trace`, JSON.stringify(input.trace));
      }
      this.sql.exec(
        `DELETE FROM meta WHERE key IN ('${store.meta}', '${store.meta}_purpose', '${store.meta}_focus')`,
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
      this.sql.exec("DELETE FROM listening_cards");
      this.sql.exec("DELETE FROM listening_seen");
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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS listening_cards (
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
    this.addColumns("reviews", REVIEW_LOG_COLUMNS);
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
    for (const table of ["seen_sentences", "listening_seen"]) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        hanzi TEXT PRIMARY KEY,
        shown_at INTEGER NOT NULL
      )`);
    }
  }

  /** SQLite has no ADD COLUMN IF NOT EXISTS. Older rows keep NULL. */
  private addColumns(table: string, columns: readonly [string, string][]): void {
    const present = new Set(
      this.sql
        .exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
        .toArray()
        .map((row) => row.name),
    );
    for (const [name, type] of columns) {
      if (!present.has(name))
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * One row per graded word, with the card before and after, so the
   * scheduler can be refitted from this table alone.
   */
  private logReviews(
    events: readonly AppliedReview[],
    now: number,
    source: string,
    sentence: string | null,
    focus: string | null,
  ): void {
    for (const event of events) {
      this.sql.exec(
        `INSERT INTO reviews (
          id, hanzi, rating, outcome, quote, at, stability, due,
          source, sentence, is_focus, difficulty, state_after,
          state_before, stability_before, difficulty_before,
          last_review_before, reps_before, lapses_before
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        event.hanzi,
        event.rating,
        event.outcome,
        event.quote,
        now,
        event.stability,
        event.dueAt,
        source,
        sentence,
        focus === null ? null : event.hanzi === focus ? 1 : 0,
        event.difficulty,
        event.state,
        event.before.state,
        event.before.stability,
        event.before.difficulty,
        event.before.lastReview,
        event.before.reps,
        event.before.lapses,
      );
    }
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

  private cards(table = "cards"): Card[] {
    const rows = this.sql
      .exec<CardRow>(
        `SELECT hanzi, state, stability, difficulty, due, last_review, reps, lapses,
                elapsed_days, scheduled_days, learning_step
         FROM ${table}`,
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

  private deckTrace(deck: PracticeDeck): Trace | null {
    const raw = this.meta(`${DECK_STORE[deck].meta}_trace`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Trace;
    } catch {
      return null;
    }
  }

  private seenSentences(deck: PracticeDeck): { hanzi: string; shownAt: number }[] {
    return this.sql
      .exec<{ hanzi: string; shown_at: number }>(
        `SELECT hanzi, shown_at FROM ${DECK_STORE[deck].seen}`,
      )
      .toArray()
      .map((row) => ({ hanzi: row.hanzi, shownAt: row.shown_at }));
  }

  private activePractice(deck: PracticeDeck): PracticeActive | null {
    const key = DECK_STORE[deck].meta;
    const hanzi = this.meta(key);
    if (!hanzi) return null;
    const purpose = this.meta(`${key}_purpose`);
    const focus = this.meta(`${key}_focus`);
    return {
      hanzi,
      purpose: purpose === "introduce" ? "introduce" : "review",
      focus: focus ? focus : null,
    };
  }

  private practiceWhy(deck: PracticeDeck): PracticeWhy | null {
    const key = DECK_STORE[deck].meta;
    const raw = this.meta(`${key}_why`);
    if (!raw || !this.meta(key)) return null;
    try {
      return JSON.parse(raw) as PracticeWhy;
    } catch {
      return null;
    }
  }

  private revision(): number {
    return this.metaNumber("schedule_rev");
  }

  private bumpRevision(): void {
    this.setMeta("schedule_rev", String(this.revision() + 1));
  }

  private writeCard(card: Card, table = "cards"): void {
    this.sql.exec(
      `INSERT INTO ${table} (
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
