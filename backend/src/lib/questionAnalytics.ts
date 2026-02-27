type CanonicalTimeHorizon =
  | 'next_play'
  | 'next_2_min'
  | 'quarter_end'
  | 'game_end'

type CanonicalQuestionStructure =
  | 'binary'
  | 'threshold'
  | 'head_to_head'
  | 'multi_option'

type CanonicalPredictabilityBucket =
  | 'low_variance'
  | 'medium_variance'
  | 'high_variance'

type CanonicalLatencyBucket = '0-5s' | '5-10s' | '10-20s' | '20-40s' | '40s+'

type AnalyticsChoice = { id: string; value: string }

type QuestionDimensionInput = {
  templateId?: string | null
  trigger?: string | null
  windowType?: string | null
  questionText?: string | null
  choices?: AnalyticsChoice[] | null
}

export type QuestionDimensions = {
  question_type: string
  trigger_type: string
  time_horizon: CanonicalTimeHorizon
  question_structure: CanonicalQuestionStructure
  predictability_bucket: CanonicalPredictabilityBucket
  is_binary: boolean
}

export const QUESTION_ANALYTICS_SCHEMA_VERSION = 'v1'

const normalizeUpper = (value: string | null | undefined) =>
  String(value || '')
    .trim()
    .toUpperCase()

const normalizeLower = (value: string | null | undefined) =>
  String(value || '')
    .trim()
    .toLowerCase()

const toIsoOrNull = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null

export const toLatencyBucket = (
  latencyMs: number | null | undefined
): CanonicalLatencyBucket | null => {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return null
  if (latencyMs < 5_000) return '0-5s'
  if (latencyMs < 10_000) return '5-10s'
  if (latencyMs < 20_000) return '10-20s'
  if (latencyMs < 40_000) return '20-40s'
  return '40s+'
}

const deriveTriggerType = (trigger: string | null | undefined) => {
  const raw = normalizeLower(trigger)
  if (!raw) return 'manual'
  const colonIndex = raw.indexOf(':')
  return colonIndex > 0 ? raw.slice(0, colonIndex) : raw
}

const deriveTimeHorizon = (
  windowType: string | null | undefined,
  triggerType: string
): CanonicalTimeHorizon => {
  const raw = normalizeUpper(windowType)
  if (raw === 'GAME') return 'game_end'
  if (raw === 'PERIOD') return 'quarter_end'
  if (raw === 'NEXT_N_MIN') return 'next_2_min'
  if (raw === 'NEXT_EVENT' || raw === 'JUMP_BALL') return 'next_play'
  if (triggerType === 'period_end' || triggerType === 'period_start')
    return 'quarter_end'
  if (triggerType === 'game_end' || triggerType === 'game_start')
    return 'game_end'
  return 'next_play'
}

const isBinaryChoiceLabel = (value: string) =>
  value === 'yes' ||
  value === 'no' ||
  value === 'true' ||
  value === 'false' ||
  value === '1' ||
  value === '0'

const deriveQuestionStructure = (
  templateId: string,
  questionText: string,
  choices: AnalyticsChoice[]
): CanonicalQuestionStructure => {
  const thresholdTemplateHints = [
    'MILESTONE',
    'TOTAL_POINTS',
    'TEAM_POINTS',
    'ASSISTS',
    'REBOUNDS',
    'STEALS',
    'THREES',
    'BLOCKS',
  ]
  const isThresholdTemplate = thresholdTemplateHints.some((hint) =>
    templateId.includes(hint)
  )
  const looksThresholdText =
    /\d\+/.test(questionText) ||
    questionText.includes('at least') ||
    questionText.includes('more than') ||
    questionText.includes('over ')

  if (choices.length > 2) return 'multi_option'
  if (choices.length === 2) {
    const ids = choices.map((choice) => normalizeLower(choice.id))
    const values = choices.map((choice) => normalizeLower(choice.value))
    const binaryByLabels = [...ids, ...values].every((label) =>
      isBinaryChoiceLabel(label)
    )
    if (binaryByLabels) return isThresholdTemplate ? 'threshold' : 'binary'
    return 'head_to_head'
  }

  if (isThresholdTemplate || looksThresholdText) return 'threshold'
  return 'binary'
}

const derivePredictabilityBucket = (
  questionType: string,
  triggerType: string,
  timeHorizon: CanonicalTimeHorizon,
  structure: CanonicalQuestionStructure
): CanonicalPredictabilityBucket => {
  const highVarianceHints = [
    'JUMP_BALL',
    'NEXT_SHOT',
    'NEXT_PLAY',
    'FOUL',
    'TIMEOUT',
  ]
  if (highVarianceHints.some((hint) => questionType.includes(hint))) {
    return 'high_variance'
  }
  if (triggerType === 'foul' || triggerType === 'timeout') {
    return 'high_variance'
  }
  if (timeHorizon === 'next_play') return 'high_variance'
  if (structure === 'threshold' && timeHorizon === 'quarter_end') {
    return 'low_variance'
  }
  return 'medium_variance'
}

export const deriveQuestionDimensions = (
  input: QuestionDimensionInput
): QuestionDimensions => {
  const questionType = normalizeUpper(input.templateId) || 'MANUAL'
  const triggerType = deriveTriggerType(input.trigger)
  const timeHorizon = deriveTimeHorizon(input.windowType, triggerType)
  const choices = Array.isArray(input.choices) ? input.choices : []
  const questionText = normalizeLower(input.questionText)
  const questionStructure = deriveQuestionStructure(
    questionType,
    questionText,
    choices
  )
  const predictabilityBucket = derivePredictabilityBucket(
    questionType,
    triggerType,
    timeHorizon,
    questionStructure
  )

  return {
    question_type: questionType,
    trigger_type: triggerType,
    time_horizon: timeHorizon,
    question_structure: questionStructure,
    predictability_bucket: predictabilityBucket,
    is_binary: questionStructure === 'binary',
  }
}

type CreatedPropsInput = {
  gameId: string
  league: string
  questionId: string
  expectedResolutionTimeMs?: number | null
  dimensions: QuestionDimensions
}

export const buildQuestionCreatedProps = (
  input: CreatedPropsInput
): Record<string, string | boolean | null> => ({
  game_id: input.gameId,
  league: input.league,
  question_id: input.questionId,
  question_type: input.dimensions.question_type,
  trigger_type: input.dimensions.trigger_type,
  time_horizon: input.dimensions.time_horizon,
  question_structure: input.dimensions.question_structure,
  predictability_bucket: input.dimensions.predictability_bucket,
  expected_resolution_time: toIsoOrNull(input.expectedResolutionTimeMs),
  is_binary: input.dimensions.is_binary,
  schema_version: QUESTION_ANALYTICS_SCHEMA_VERSION,
})

type SentPropsInput = {
  questionId: string
  userId: string
  gameId: string
  sendTimestampMs: number
  dimensions: QuestionDimensions
}

export const buildQuestionSentProps = (
  input: SentPropsInput
): Record<string, string | number | null> => ({
  question_id: input.questionId,
  user_id: input.userId,
  game_id: input.gameId,
  send_timestamp: new Date(input.sendTimestampMs).toISOString(),
  push_delivery_latency_ms: null,
  latency_bucket: null,
  user_game_delay_estimate_ms: null,
  question_type: input.dimensions.question_type,
  trigger_type: input.dimensions.trigger_type,
  time_horizon: input.dimensions.time_horizon,
  question_structure: input.dimensions.question_structure,
  predictability_bucket: input.dimensions.predictability_bucket,
  schema_version: QUESTION_ANALYTICS_SCHEMA_VERSION,
})

type ResolvedPropsInput = {
  questionId: string
  gameId: string
  resolvedTimestampMs: number
  outcome: string | null
  resolutionType: 'normal' | 'void'
  voidReason: string | null
}

export const buildQuestionResolvedProps = (
  input: ResolvedPropsInput
): Record<string, string | null> => {
  const base: Record<string, string | null> = {
    question_id: input.questionId,
    game_id: input.gameId,
    resolved_timestamp: new Date(input.resolvedTimestampMs).toISOString(),
    outcome: input.outcome,
    resolution_type: input.resolutionType,
    schema_version: QUESTION_ANALYTICS_SCHEMA_VERSION,
  }
  if (input.resolutionType === 'void') {
    base.void_reason = input.voidReason || 'void'
  }
  return base
}
