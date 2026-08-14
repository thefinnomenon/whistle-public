import assert from 'assert'
import {
  hydrateStoredEngineEvent,
  prepareEngineEventForStorage,
  REPLAY_BOX_SCORE_ENCODING,
  type StoredEngineEvent,
} from '../src/lib/eventReplayStorage'
import {
  EngineEventSource,
  EventType,
  NbaEventResult,
  NbaEventSubType,
  type EngineEvent,
} from '../src/types/engine'

const event: EngineEvent = {
  eventId: 42,
  source: EngineEventSource.NBA_COM,
  type: EventType.MADE_3,
  subType: NbaEventSubType.JUMP_SHOT,
  context: {
    shot: {
      shooterId: 23,
      teamId: 1,
      teamTricode: 'AAA',
      result: NbaEventResult.MADE,
      shotType: NbaEventSubType.JUMP_SHOT,
    },
  },
  description: 'Three point shot made',
  questionId: null,
  gameState: {
    period: 2,
    clockMs: 321_000,
    scoreHome: 48,
    scoreAway: 47,
    possession: 1,
    boxScore: {
      gameId: 'test-game',
      period: 2,
      gameClock: 'PT05M21.00S',
      homeTeam: {
        teamId: 1,
        teamTricode: 'AAA',
        score: 48,
        players: Array.from({ length: 15 }, (_, index) => ({
          personId: index + 1,
          name: `Home Player ${index + 1}`,
          statistics: {
            points: index,
            assists: index % 5,
            reboundsTotal: index % 7,
          },
        })),
      },
      awayTeam: {
        teamId: 2,
        teamTricode: 'BBB',
        score: 47,
        players: Array.from({ length: 15 }, (_, index) => ({
          personId: index + 101,
          name: `Away Player ${index + 1}`,
          statistics: {
            points: index + 1,
            assists: index % 4,
            reboundsTotal: index % 6,
          },
        })),
      },
    },
  },
  ingestedAt: null,
}

const stored = prepareEngineEventForStorage(event)
assert.equal(stored.gameState.boxScore, undefined)
assert.equal(stored.replayBoxScoreEncoding, REPLAY_BOX_SCORE_ENCODING)
assert.ok(stored.replayBoxScoreGzip)

const rawBytes = Buffer.byteLength(JSON.stringify(event.gameState.boxScore))
assert.ok((stored.replayBoxScoreGzip?.byteLength ?? rawBytes) < rawBytes)
assert.deepStrictEqual(hydrateStoredEngineEvent(stored), event)

const legacyEvent: StoredEngineEvent = { ...event }
assert.deepStrictEqual(hydrateStoredEngineEvent(legacyEvent), event)

const eventWithoutBoxScore: EngineEvent = {
  ...event,
  gameState: { ...event.gameState, boxScore: null },
}
assert.deepStrictEqual(
  hydrateStoredEngineEvent(prepareEngineEventForStorage(eventWithoutBoxScore)),
  eventWithoutBoxScore
)

assert.throws(
  () =>
    hydrateStoredEngineEvent({
      ...stored,
      replayBoxScoreGzip: Buffer.from('not gzip data'),
    }),
  /incorrect header check|invalid/i
)

console.log(
  `[test/event-replay-storage] passed rawBytes=${rawBytes} compressedBytes=${stored.replayBoxScoreGzip?.byteLength ?? 0}`
)
