import { gunzipSync, gzipSync } from 'zlib'
import type { BoxScore, EngineEvent, EngineGameState } from '../types/engine'

export const REPLAY_BOX_SCORE_ENCODING = 'gzip-json-v1' as const

type StoredEngineGameState = Omit<EngineGameState, 'boxScore'> & {
  boxScore?: BoxScore | null
}

export type StoredEngineEvent = Omit<EngineEvent, 'gameState'> & {
  gameState: StoredEngineGameState
  replayBoxScoreEncoding?: typeof REPLAY_BOX_SCORE_ENCODING
  replayBoxScoreGzip?: Uint8Array
}

export type EncodedReplayBoxScore = {
  compressed: Buffer
  rawBytes: number
  compressedBytes: number
}

const parseCompressedBoxScore = (compressed: Uint8Array): BoxScore => {
  const json = gunzipSync(Buffer.from(compressed)).toString('utf8')
  const parsed = JSON.parse(json) as BoxScore | null

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Compressed replay box score is not an object')
  }

  return parsed
}

export const encodeReplayBoxScore = (
  boxScore: BoxScore
): EncodedReplayBoxScore => {
  const raw = Buffer.from(JSON.stringify(boxScore), 'utf8')
  const compressed = gzipSync(raw, { level: 9 })

  return {
    compressed,
    rawBytes: raw.byteLength,
    compressedBytes: compressed.byteLength,
  }
}

export const compressReplayBoxScore = (boxScore: BoxScore): Buffer =>
  encodeReplayBoxScore(boxScore).compressed

export const prepareEngineEventForStorage = (
  event: EngineEvent
): StoredEngineEvent => {
  const { boxScore, ...gameState } = event.gameState

  if (!boxScore) {
    return {
      ...event,
      gameState,
    }
  }

  return {
    ...event,
    gameState,
    replayBoxScoreEncoding: REPLAY_BOX_SCORE_ENCODING,
    replayBoxScoreGzip: compressReplayBoxScore(boxScore),
  }
}

export const hydrateStoredEngineEvent = (
  event: StoredEngineEvent
): EngineEvent => {
  const { replayBoxScoreEncoding, replayBoxScoreGzip, ...engineEvent } = event
  const inlineBoxScore = event.gameState.boxScore ?? null

  if (inlineBoxScore) {
    return {
      ...engineEvent,
      gameState: {
        ...event.gameState,
        boxScore: inlineBoxScore,
      },
    }
  }

  if (replayBoxScoreGzip) {
    if (replayBoxScoreEncoding !== REPLAY_BOX_SCORE_ENCODING) {
      throw new Error(
        `Unsupported replay box score encoding: ${String(replayBoxScoreEncoding)}`
      )
    }

    return {
      ...engineEvent,
      gameState: {
        ...event.gameState,
        boxScore: parseCompressedBoxScore(replayBoxScoreGzip),
      },
    }
  }

  return {
    ...engineEvent,
    gameState: {
      ...event.gameState,
      boxScore: null,
    },
  }
}

export const getReplayBoxScoreStorageSizes = (
  boxScore: BoxScore
): { rawBytes: number; compressedBytes: number } => {
  const encoded = encodeReplayBoxScore(boxScore)

  return {
    rawBytes: encoded.rawBytes,
    compressedBytes: encoded.compressedBytes,
  }
}
