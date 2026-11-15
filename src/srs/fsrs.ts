/**
 * FSRS-5 scheduler.
 * Memory formulas follow open-spaced-repetition/ts-fsrs v5 (FSRS-5, 19 weights
 * padded with the same-day power 0 and decay 0.5). Learning steps follow the
 * short Anki steps: 1 minute, then 10 minutes, then a review interval.
 * Fuzzing is off so a rating has one interval.
 */

export const DAY_MS = 86_400_000;
const S_MIN = 0.001;
const S_MAX = 36_500;

export const FSRS5_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621, 0, 0.5,
] as const;

export const Rating = {
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
} as const;

export type RatingValue = (typeof Rating)[keyof typeof Rating];

export const State = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const;

export type StateValue = (typeof State)[keyof typeof State];

export const STATE_NAME = ["new", "learning", "review", "relearning"] as const;

export type Card = {
  hanzi: string;
  state: StateValue;
  stability: number;
  difficulty: number;
  due: number;
  lastReview: number | null;
  reps: number;
  lapses: number;
  elapsedDays: number;
  scheduledDays: number;
  learningStep: number;
};

const LEARNING_MINUTES = [1, 10];
const RELEARNING_MINUTES = [10];

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function roundTo(value: number, digits = 8): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export class Fsrs {
  readonly weights: readonly number[] = FSRS5_WEIGHTS;
  readonly decay: number;
  readonly factor: number;
  readonly intervalModifier: number;

  constructor(requestRetention = 0.9) {
    this.decay = -this.weights[20];
    this.factor = roundTo(Math.exp((1 / this.decay) * Math.log(0.9)) - 1);
    this.intervalModifier = roundTo(
      (requestRetention ** (1 / this.decay) - 1) / this.factor,
    );
  }

  forgettingCurve(elapsedDays: number, stability: number): number {
    if (stability <= 0) return 0;
    return roundTo((1 + (this.factor * elapsedDays) / stability) ** this.decay);
  }

  private initStability(grade: RatingValue): number {
    return Math.max(this.weights[grade - 1], 0.1);
  }

  private initDifficulty(grade: RatingValue): number {
    return roundTo(this.weights[4] - Math.exp((grade - 1) * this.weights[5]) + 1);
  }

  private nextDifficulty(difficulty: number, grade: RatingValue): number {
    const delta = -this.weights[6] * (grade - 3);
    const damped = difficulty + (delta * (10 - difficulty)) / 9;
    const next =
      this.weights[7] * this.initDifficulty(Rating.Easy) +
      (1 - this.weights[7]) * damped;
    return clamp(roundTo(next), 1, 10);
  }

  private nextRecallStability(
    difficulty: number,
    stability: number,
    retrievability: number,
    grade: RatingValue,
  ): number {
    const hardPenalty = grade === Rating.Hard ? this.weights[15] : 1;
    const easyBonus = grade === Rating.Easy ? this.weights[16] : 1;
    return roundTo(
      clamp(
        stability *
          (1 +
            Math.exp(this.weights[8]) *
              (11 - difficulty) *
              stability ** -this.weights[9] *
              (Math.exp((1 - retrievability) * this.weights[10]) - 1) *
              hardPenalty *
              easyBonus),
        S_MIN,
        S_MAX,
      ),
    );
  }

  private nextForgetStability(
    difficulty: number,
    stability: number,
    retrievability: number,
  ): number {
    return roundTo(
      clamp(
        this.weights[11] *
          difficulty ** -this.weights[12] *
          ((stability + 1) ** this.weights[13] - 1) *
          Math.exp((1 - retrievability) * this.weights[14]),
        S_MIN,
        S_MAX,
      ),
    );
  }

  private nextShortTermStability(stability: number, grade: RatingValue): number {
    const factor =
      stability ** -this.weights[19] *
      Math.exp(this.weights[17] * (grade - 3 + this.weights[18]));
    const masked = grade >= Rating.Good ? Math.max(factor, 1) : factor;
    return roundTo(clamp(stability * masked, S_MIN, S_MAX));
  }

  private nextMemory(
    difficulty: number,
    stability: number,
    elapsedDays: number,
    grade: RatingValue,
  ): { difficulty: number; stability: number } {
    if (difficulty === 0 && stability === 0) {
      return {
        difficulty: clamp(this.initDifficulty(grade), 1, 10),
        stability: this.initStability(grade),
      };
    }
    const retrievability = this.forgettingCurve(elapsedDays, stability);
    let stabilityNext = this.nextRecallStability(
      difficulty,
      stability,
      retrievability,
      grade,
    );
    if (grade === Rating.Again) {
      const afterFail = this.nextForgetStability(difficulty, stability, retrievability);
      const minimum = stability / Math.exp(this.weights[17] * this.weights[18]);
      stabilityNext = clamp(roundTo(minimum), S_MIN, afterFail);
    }
    if (elapsedDays === 0) {
      stabilityNext = this.nextShortTermStability(stability, grade);
    }
    return {
      difficulty: this.nextDifficulty(difficulty, grade),
      stability: stabilityNext,
    };
  }

  private nextInterval(stability: number): number {
    return Math.min(Math.max(1, Math.round(stability * this.intervalModifier)), S_MAX);
  }

  review(card: Card, grade: RatingValue, now: number): Card {
    const elapsedDays =
      card.state === State.New || card.lastReview === null
        ? 0
        : Math.floor((now - card.lastReview) / DAY_MS);
    const next: Card = {
      ...card,
      lastReview: now,
      elapsedDays,
      reps: card.reps + 1,
    };
    // A miss on the first encounter counts too, so a later success can tell a
    // never-missed word from one the student already failed.
    if (grade === Rating.Again) next.lapses += 1;
    if (card.state === State.New) {
      const memory = this.nextMemory(0, 0, 0, grade);
      next.stability = memory.stability;
      next.difficulty = memory.difficulty;
      this.applySteps(next, grade, State.New, State.Learning, now);
      return next;
    }
    if (card.state === State.Learning || card.state === State.Relearning) {
      const memory = this.nextMemory(
        card.difficulty,
        card.stability,
        elapsedDays,
        grade,
      );
      next.stability = memory.stability;
      next.difficulty = memory.difficulty;
      this.applySteps(next, grade, card.state, card.state, now);
      return next;
    }
    const memory = this.nextMemory(card.difficulty, card.stability, elapsedDays, grade);
    next.stability = memory.stability;
    next.difficulty = memory.difficulty;
    if (grade === Rating.Again) {
      this.applySteps(next, Rating.Again, State.Review, State.Relearning, now);
      return next;
    }
    next.state = State.Review;
    next.learningStep = 0;
    next.scheduledDays = this.nextInterval(memory.stability);
    next.due = now + next.scheduledDays * DAY_MS;
    return next;
  }

  private applySteps(
    card: Card,
    grade: RatingValue,
    from: StateValue,
    to: StateValue,
    now: number,
  ): void {
    const steps =
      from === State.Review || from === State.Relearning
        ? RELEARNING_MINUTES
        : LEARNING_MINUTES;
    const info = stepFor(steps, from, card.learningStep, grade);
    if (info && info.minutes > 0 && info.minutes < 1440) {
      card.learningStep = info.nextStep;
      card.scheduledDays = 0;
      card.state = to;
      card.due = now + info.minutes * 60_000;
      return;
    }
    card.learningStep = 0;
    card.state = State.Review;
    const interval = this.nextInterval(card.stability);
    card.scheduledDays = interval;
    card.due = now + interval * DAY_MS;
  }
}

function stepFor(
  steps: readonly number[],
  state: StateValue,
  current: number,
  grade: RatingValue,
): { minutes: number; nextStep: number } | null {
  if (steps.length === 0 || current >= steps.length) return null;
  if (grade === Rating.Again) return { minutes: steps[0], nextStep: 0 };
  if (state === State.Review) return null;
  if (grade === Rating.Hard) {
    const minutes =
      steps.length === 1
        ? Math.round(steps[0] * 1.5)
        : Math.round((steps[0] + steps[1]) / 2);
    return { minutes, nextStep: current };
  }
  if (grade === Rating.Good && steps[current + 1] !== undefined) {
    return { minutes: steps[current + 1], nextStep: current + 1 };
  }
  return null;
}

export function freshCard(hanzi: string, now: number): Card {
  return {
    hanzi,
    state: State.New,
    stability: 0,
    difficulty: 0,
    due: now,
    lastReview: null,
    reps: 0,
    lapses: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningStep: 0,
  };
}

export function ratingName(rating: RatingValue): string {
  if (rating === Rating.Again) return "again";
  if (rating === Rating.Hard) return "hard";
  if (rating === Rating.Good) return "good";
  return "easy";
}

let shared: Fsrs | null = null;

export function fsrs(): Fsrs {
  shared ??= new Fsrs();
  return shared;
}
