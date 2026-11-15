# Erudify

A web harness for a Mandarin tutor. Each turn reads the student's message, records evidence in a spaced-repetition schedule, and then asks the tutor for the next reply. The schedule can suggest a sentence. The tutor does not have to use it.

## Decisions

Word boundaries are decided in code, by longest match against the lexicon. The model judges evidence only for those ids. It does not invent cards, and a general segmenter such as jieba is not used: its dictionary is not this curriculum, and the ids have to stay stable.

The model does not receive a random sample of known words. Small sets that should change the reply are listed in full: fragile or due words, the next curriculum items (at most eight), and one to three optional suggestions. The brief names those words. It does not include pinyin or English glosses. While the student has few stable words, those are listed too. After that, the brief summarizes source-list coverage and keeps the fragile exceptions, plus whatever was just said. A question about 饺子 is answered as a question about 饺子. When that exchange ends, the next suggestion is already waiting.

Curriculum order is a flat list built by ordering those sentences. The next sentence introduces the earliest remaining lesson word and adds as few new words as possible. Words join in the order they first appear, and that sentence is their example. An example may use words from that sentence and from earlier sentences, and nothing from a later one. The sentence is chosen again for each student: unknown words make it simpler, and words the student already knows make it more complex.

## What a turn does

1. Receive the student's message.
2. Segment it, and the previous tutor message, against the lexicon.
3. Ask the judge for evidence on those candidate words only. No candidates means no judge call.
4. Record the evidence. Cards are created on first evidence. Outcomes are `produced`, `recognized`, `unknown`, and `misunderstood`. Asking what a word means is `unknown`, not `produced`.
5. Refresh suggestions. Due reviews come first. A new curriculum word is suggested only when nothing is due.
6. Ask the tutor for the reply and stream it into the conversation as it is written. The brief is guidance, not a script. The exchange is saved when the reply finishes.

Scheduling is FSRS-5 with the default weights, desired retention 0.9, learning steps of 1 and 10 minutes, and no fuzz. When the student recalls or produces a word they have never missed, the next review is at least 14 days out. A miss, including the first encounter, keeps the short steps.

## Data

The word set comes from the unlabeled example runs in [haoxue-public](https://github.com/haoxue-tutor/haoxue-public) (commit `3c12c3291d19180faf163b72082fb719a796a365`). The filenames say HSK 1–4. The text is not the official HSK lists. Teaching order is the sentence order described above, not the order of the files.

Spellings, pinyin, and glosses come from CC-CEDICT (CC BY-SA 4.0). See `vendor/cc-cedict/README.md`. A word the clusters never teach on purpose joins the list when an example needs it. 喜欢 is introduced with 蓝色, in 我喜欢蓝色。 Single-character words that never appear in an introducing sentence can be segmented, and they are not tracked.

Hover or tap a word in the conversation for its CC-CEDICT readings. The popup segments with the whole dictionary: forward and backward longest match, then fewer words, then fewer ordinary single characters. `npm run seed` writes `public/dict.json` and `public/lookup.js`. `npm run dict` writes those files without reseeding. The schedule keeps the recognition lexicon.

## Hosting

Cloudflare Worker plus static assets. The lexicon lives in D1 (`CORPUS`). Each learner's cards, reviews, and messages live in a SQLite Durable Object (`LEARNER`), keyed by the learner id. There is no login. The id is a capability: anyone who knows it can read and write that schedule.

The tutor and the judge are Claude Sonnet 5.5 (`claude-sonnet-5-5`) by default. Set `TUTOR_BACKEND` to `rules` for a deterministic offline tutor that does not call the API. The client cannot choose the backend.

## Local use

```bash
npm install
npm test
npm run seed
```

Copy `.dev.vars.example` to `.dev.vars` and set `ANTHROPIC_API_KEY` there. Wrangler reads that file locally. Do not commit it.

```bash
npx wrangler dev
```

To exercise the loop without a key:

```bash
npx wrangler dev --var TUTOR_BACKEND:rules
```

`npm run seed` applies the D1 migrations and loads `corpus/seed.sql` into the local database. Re-running it replaces the lexicon.

## Deploy

Create the remote database once, apply the same migration and seed file, set the secret, then deploy. Replace the placeholder `database_id` in `wrangler.jsonc` with the id from `d1 create`.

```bash
npx wrangler d1 create erudify-corpus
npx wrangler d1 migrations apply erudify-corpus --remote
npx wrangler d1 execute erudify-corpus --remote --file=corpus/seed.sql
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```
