import { fetchEspnNflSummary, type EspnNflPlay } from '../src/lib/nfl'
import { buildQuestionChoices } from '../src/lib/engine'
import {
  buildNflQuestionCandidate,
  getNflPlayWallclockMs,
  NFL_MAX_QUESTIONS_PER_GAME,
  NFL_QUESTION_MIN_INTERVAL_MS,
  NFL_QUESTION_RESPONSE_MS,
  resolveNflQuestionForPlay,
  type NflActiveQuestion,
  type NflQuestionSourceAgePolicy,
} from '../src/lib/nflQuestionEngine'

type SimActiveQuestion = NflActiveQuestion & {
  question: string
}

const formatProjectionNumber = (
  value: NflActiveQuestion['resolutionContext'][string]
): string =>
  typeof value === 'number' ? String(Math.round(value * 100) / 100) : 'none'

const eventId = process.argv[2]?.trim()
if (!eventId) {
  throw new Error(
    'Usage: yarn sim:nfl <espn-event-id> [source-delay-ms] [OBSERVE|ENFORCE]'
  )
}
const sourceDelayMs = Number(process.argv[3] ?? 1_000)
if (!Number.isFinite(sourceDelayMs) || sourceDelayMs < 0) {
  throw new Error('source-delay-ms must be a non-negative number')
}
const sourceAgePolicyArg = (process.argv[4] ?? 'ENFORCE').toUpperCase()
if (sourceAgePolicyArg !== 'OBSERVE' && sourceAgePolicyArg !== 'ENFORCE') {
  throw new Error('source-age-policy must be OBSERVE or ENFORCE')
}
const sourceAgePolicy: NflQuestionSourceAgePolicy = sourceAgePolicyArg

const run = async (): Promise<void> => {
  const summary = await fetchEspnNflSummary(eventId)
  const replayedPlays: EspnNflPlay[] = []
  let activeQuestions: SimActiveQuestion[] = []
  let redZoneAskedDriveIds: string[] = []
  let redZoneAskedPeriodKeys: string[] = []
  let receiverQuestionKeys: string[] = []
  let completionReceiverHalfKeys: string[] = []
  let timeoutQuestionDriveIds: string[] = []
  let gameQuestionKeys: string[] = []
  let periodQuestionKeys: string[] = []
  let lastQuestionAtMs: number | null = null
  let questionSequence = 0
  let created = 0
  let resolved = 0
  let cancelled = 0

  for (const [playIndex, play] of summary.plays.entries()) {
    replayedPlays.push(play)
    const nextActiveQuestions: SimActiveQuestion[] = []
    for (const question of activeQuestions) {
      const decision = resolveNflQuestionForPlay(
        question,
        play,
        replayedPlays,
        summary.completed && playIndex === summary.plays.length - 1
      )
      if (!decision) {
        nextActiveQuestions.push(question)
        continue
      }
      if (decision.state === 'resolved') resolved += 1
      else cancelled += 1
      const answerLabel =
        decision.state === 'resolved'
          ? (buildQuestionChoices({
              templateId: question.templateId,
              question: question.question,
              windowType: question.windowType,
              timeoutMs: 0,
              resolutionContext: question.resolutionContext,
              trigger: 'simulation',
              period: play.period ?? 0,
              clockMs: 0,
            }).find((choice) => choice.id === decision.answer)?.value ??
            decision.answer)
          : null
      console.log(
        `[sim-nfl] resolution question=${question.id} state=${decision.state} answer=${answerLabel ?? 'null'} reason=${decision.reason ?? 'null'} play=${play.id} type=${play.type}`
      )
    }
    activeQuestions = nextActiveQuestions

    const wallclockMs = getNflPlayWallclockMs(play)
    if (wallclockMs === null) continue
    const candidate = buildNflQuestionCandidate({
      plays: replayedPlays,
      anchorPlay: play,
      homeTeam: summary.homeTeam,
      awayTeam: summary.awayTeam,
      nowMs: wallclockMs + sourceDelayMs,
      redZoneAskedDriveIds,
      redZoneAskedPeriodKeys,
      receiverQuestionKeys,
      completionReceiverHalfKeys,
      timeoutQuestionDriveIds,
      gameQuestionKeys,
      periodQuestionKeys,
      athletes: summary.athletes,
      sourceAgePolicy,
    })
    if (!candidate) continue
    if (created >= NFL_MAX_QUESTIONS_PER_GAME) continue

    const cadenceReady =
      lastQuestionAtMs === null ||
      wallclockMs - lastQuestionAtMs >= NFL_QUESTION_MIN_INTERVAL_MS
    const responseWindowActive = activeQuestions.some(
      (question) =>
        wallclockMs - question.createdAtMs < NFL_QUESTION_RESPONSE_MS
    )
    const bypassCadence =
      candidate.priority === 'RED_ZONE' ||
      candidate.priority === 'FIELD_GOAL' ||
      candidate.priority === 'FOURTH_DOWN' ||
      candidate.priority === 'GAME' ||
      candidate.priority === 'PERIOD_TEAM'
    if (responseWindowActive || (!bypassCadence && !cadenceReady)) {
      continue
    }

    questionSequence += 1
    const id = `sim_${questionSequence}`
    activeQuestions.push({
      id,
      templateId: candidate.payload.templateId,
      windowType: candidate.payload.windowType,
      resolutionContext: candidate.payload.resolutionContext ?? {},
      createdAtMs: wallclockMs,
      question: candidate.payload.question,
    })
    created += 1
    lastQuestionAtMs = wallclockMs
    if (candidate.redZoneDriveId) {
      redZoneAskedDriveIds = [...redZoneAskedDriveIds, candidate.redZoneDriveId]
    }
    if (candidate.redZonePeriodKey) {
      redZoneAskedPeriodKeys = [
        ...redZoneAskedPeriodKeys,
        candidate.redZonePeriodKey,
      ]
    }
    if (candidate.receiverQuestionKey) {
      receiverQuestionKeys = [
        ...receiverQuestionKeys,
        candidate.receiverQuestionKey,
      ]
    }
    if (candidate.completionReceiverHalfKey) {
      completionReceiverHalfKeys = [
        ...completionReceiverHalfKeys,
        candidate.completionReceiverHalfKey,
      ]
    }
    if (candidate.timeoutQuestionDriveId) {
      timeoutQuestionDriveIds = [
        ...timeoutQuestionDriveIds,
        candidate.timeoutQuestionDriveId,
      ]
    }
    if (candidate.gameQuestionKey) {
      gameQuestionKeys = [...gameQuestionKeys, candidate.gameQuestionKey]
    }
    if (candidate.periodQuestionKey) {
      periodQuestionKeys = [...periodQuestionKeys, candidate.periodQuestionKey]
    }
    const context = candidate.payload.resolutionContext
    const projectionLog =
      context?.type === 'NFL_PERIOD_PLAYER_THRESHOLD'
        ? ` projectionSource=${typeof context.projectionSource === 'string' ? context.projectionSource : 'none'} current=${formatProjectionNumber(context.currentValueAtAsk)} target=${formatProjectionNumber(context.target)} priorSeason=${formatProjectionNumber(context.priorSeasonYear)} priorAverage=${formatProjectionNumber(context.priorSeasonAveragePerGame)} projected=${formatProjectionNumber(context.projectedPeriodTotal)}`
        : ''
    console.log(
      `[sim-nfl] question id=${id} period=${play.period ?? 0} clock=${play.clock ?? 'null'} play=${play.id} priority=${candidate.priority}${projectionLog} text=${candidate.payload.question} choices=${buildQuestionChoices(
        candidate.payload
      )
        .map((choice) => choice.value)
        .join('|')}`
    )
  }

  console.log(
    `[sim-nfl] complete event=${eventId} sourceDelayMs=${sourceDelayMs} sourceAgePolicy=${sourceAgePolicy} plays=${summary.plays.length} questions=${created} resolved=${resolved} cancelled=${cancelled} stillActive=${activeQuestions.length}`
  )
}

void run()
