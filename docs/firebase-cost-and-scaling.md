# Firebase Cost and Scaling Guardrails

This document describes the current NFL launch architecture. Counts are the
logical operation shape. Firestore can retry transactions, so billed reads may
be higher when a document is contended.

## Current write model

- First game join: four transaction reads, or five with a referral, and four
  writes. A repeat join does the reads but performs no writes.
- First live answer: one transaction read and two writes. The question read
  validates its current state, choices, and server deadline. The atomic writes
  create the canonical scoring prediction and update the existing player
  document with the selected choice and answer count. A duplicate create is
  treated as idempotent and performs no writes.
- Question eligibility: no fan-out writes when a question opens. At game end,
  the resolver reads the game questions and player documents once and stores
  one eligibility result per player.
- Featured pool count: updated only by a real join, scheduled-game leave, or
  account deletion. The recurring player-count worker is disabled by default.
- Cash payout: reads players and questions once, writes one deterministic ledger
  document per winner, and credits each winner in a retry-safe transaction.
  Cash is stored and divided in integer cents.
- Client listeners: the live screen uses snapshots for the game, questions,
  and current player. The player's bounded answer map drives selected-answer
  display, progress, and eligibility. Snapshot listeners are detached while the
  app is backgrounded.

At the launch target of 100 players and 20 questions, the answer path is about
2,000 question reads and 4,000 writes. Final eligibility adds about 100 writes.
The full question and leaderboard calculation work is bounded by the same 20
questions.

## Worker defaults

- NFL schedule, NFL live feed, scheduled-game start, expired-question close,
  and account notification workers can be enabled on one dedicated worker
  instance.
- NBA schedule, NBA live feed, NBA profile refresh, and player-count polling are
  disabled by default. They require their specific environment flag.
- Production API instances default to no background workers. Do not run polling
  loops on autoscaled web instances.
- NFL schedule sync skips unchanged game documents. NFL play-by-play writes only
  newly observed or revised plays. On worker startup, the NFL engine rebuilds
  its bounded in-memory state from persisted play and question documents.
  Backend-only fingerprints, question keys, and polling heartbeats are not
  written to the player-facing game document.

## Scaling thresholds to watch

1. **Featured game document contention**
   Watch join transaction latency, retries, `ABORTED`, and
   `DEADLINE_EXCEEDED`. Keep the exact counter for the initial 100-player pools.
   Move to distributed counter shards only when measured contention appears,
   because shards add reads and make exact threshold unlocks more complex.
2. **Leaderboard recomputation**
   The current resolver reads all game players after a resolved question. At
   several thousand concurrent players, replace full leaderboard rebuilds with
   score buckets or a separately materialized top-N leaderboard.
3. **End-game eligibility**
   The current two collection reads are intentionally simple for the 20-question
   cap. If a game reaches thousands of players, process eligibility in paged
   batches and keep payout status resumable.
4. **Winner fan-out**
   Winner credits run in batches of ten and each ledger document is idempotent.
   If hundreds of tied winners become normal, move the fan-out to a task queue
   while retaining the same ledger key.
5. **Live game listeners**
   Firestore reads grow with connected players and changed documents, not with
   idle wall-clock time. Monitor reads per active player per game. The shared
   game document contains only player-facing changes; play history and NFL
   engine bookkeeping remain off that document.

## Operational checks before a featured game

- Deploy in this order: backend, app/admin update, then Firestore Rules. Do not
  open a cash Featured Game until all three are deployed and prediction
  submission has been smoke-tested.
- Confirm exactly one worker instance has NFL live polling enabled.
- Confirm web/API instances have background workers disabled.
- Confirm player-count and NBA worker flags are false.
- Confirm the featured game has `prizeAmountCents` and `prizeType=USD`.
- After resolution, confirm `payoutStatus=completed`, the expected winner count,
  and one payout ledger document per winner before handling withdrawals.
