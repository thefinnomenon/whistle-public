import assert from 'node:assert/strict'
import {
  parseEspnNflPlayerPriorSeasonProfile,
  type EspnNflAthleteName,
  type EspnNflPlay,
} from '../src/lib/nfl'
import { buildQuestionChoices } from '../src/lib/engine'
import {
  buildNflQuestionCandidate,
  buildNflStatRange,
  getNflPeriodStats,
  NFL_QUESTION_MAX_LONG_HORIZON_SOURCE_AGE_MS,
  NFL_QUESTION_MAX_SOURCE_AGE_MS,
  projectNflPeriodPlayerThreshold,
  resolveNflQuestionForPlay,
  type NflActiveQuestion,
} from '../src/lib/nflQuestionEngine'

const BASE_TIME_MS = Date.parse('2026-08-13T00:00:00Z')

const buildPlay = (
  id: string,
  offsetMs: number,
  overrides: Partial<EspnNflPlay> = {}
): EspnNflPlay => ({
  id,
  driveId: 'drive_1',
  driveTeamId: '1',
  driveTeamAbbreviation: 'ATL',
  sequenceNumber: id,
  text: '',
  typeId: null,
  type: 'Rush',
  period: 1,
  clock: '10:00',
  wallclock: new Date(BASE_TIME_MS + offsetMs).toISOString(),
  modifiedAt: null,
  homeScore: 0,
  awayScore: 0,
  scoringPlay: false,
  scoreValue: null,
  penalty: false,
  turnover: false,
  statYardage: 0,
  possessionTeamId: '1',
  start: null,
  end: {
    down: 2,
    distance: 5,
    yardLine: 50,
    yardsToEndzone: 50,
    downDistanceText: '2nd & 5',
    possessionText: 'ATL 50',
    teamId: '1',
  },
  reviewType: null,
  reviewResult: null,
  ...overrides,
})

const athletes: EspnNflAthleteName[] = [
  {
    id: 'athlete_1',
    teamId: '1',
    firstName: 'Kyle',
    lastName: 'Pitts Sr.',
    displayName: 'Kyle Pitts Sr.',
    roles: ['RECEIVER'],
    passingAttempts: 0,
    passingYards: 0,
    rushingAttempts: 0,
    rushingYards: 0,
    receptions: 2,
    receivingYards: 20,
    receivingTargets: 3,
    priorSeasonProfile: {
      seasonYear: 2025,
      passingGames: 0,
      passingAttemptsPerGame: 0,
      passingYardsPerGame: 0,
      rushingGames: 0,
      rushingAttemptsPerGame: 0,
      rushingYardsPerGame: 0,
      receivingGames: 17,
      receptionsPerGame: 4.2,
      receivingTargetsPerGame: 6.5,
    },
  },
  {
    id: 'athlete_2',
    teamId: '1',
    firstName: 'Drake',
    lastName: 'London',
    displayName: 'Drake London',
    roles: ['RECEIVER'],
    passingAttempts: 0,
    passingYards: 0,
    rushingAttempts: 0,
    rushingYards: 0,
    receptions: 2,
    receivingYards: 24,
    receivingTargets: 3,
    priorSeasonProfile: null,
  },
  {
    id: 'athlete_3',
    teamId: '1',
    firstName: 'Darnell',
    lastName: 'Mooney',
    displayName: 'Darnell Mooney',
    roles: ['RECEIVER'],
    passingAttempts: 0,
    passingYards: 0,
    rushingAttempts: 0,
    rushingYards: 0,
    receptions: 1,
    receivingYards: 12,
    receivingTargets: 2,
    priorSeasonProfile: null,
  },
]

const recentReceiver: EspnNflAthleteName = {
  id: 'athlete_4',
  teamId: '1',
  firstName: 'Ray-Ray',
  lastName: 'McCloud',
  displayName: 'Ray-Ray McCloud',
  roles: ['RECEIVER'],
  passingAttempts: 0,
  passingYards: 0,
  rushingAttempts: 0,
  rushingYards: 0,
  receptions: 1,
  receivingYards: 9,
  receivingTargets: 1,
  priorSeasonProfile: null,
}

const passerAthlete: EspnNflAthleteName = {
  id: 'athlete_qb',
  teamId: '1',
  firstName: 'Quentin',
  lastName: 'Player',
  displayName: 'Quentin Player',
  roles: ['PASSER'],
  passingAttempts: 20,
  passingYards: 240,
  rushingAttempts: 2,
  rushingYards: 8,
  receptions: 0,
  receivingYards: 0,
  receivingTargets: 0,
  priorSeasonProfile: {
    seasonYear: 2025,
    passingGames: 16,
    passingAttemptsPerGame: 31,
    passingYardsPerGame: 240,
    rushingGames: 16,
    rushingAttemptsPerGame: 3,
    rushingYardsPerGame: 14,
    receivingGames: 0,
    receptionsPerGame: 0,
    receivingTargetsPerGame: 0,
  },
}

const buildCandidate = (
  plays: EspnNflPlay[],
  nowMs: number = Date.parse(plays[plays.length - 1].wallclock ?? '') + 1_000
) =>
  buildNflQuestionCandidate({
    plays,
    anchorPlay: plays[plays.length - 1],
    homeTeam: 'ATL',
    awayTeam: 'TB',
    nowMs,
    redZoneAskedDriveIds: [],
    redZoneAskedPeriodKeys: [],
    receiverQuestionKeys: [],
    completionReceiverHalfKeys: [],
    timeoutQuestionDriveIds: [],
    gameQuestionKeys: ['winner'],
    periodQuestionKeys: ['team:1', 'player:1'],
    athletes,
  })

const driveStart = buildPlay('drive_start', 0)
const redZoneEntry = buildPlay('red_zone_entry', 130_000, {
  end: {
    down: 1,
    distance: 10,
    yardLine: 81,
    yardsToEndzone: 19,
    downDistanceText: '1st & 10 at TB 19',
    possessionText: 'TB 19',
    teamId: '1',
  },
})
const redZoneCandidate = buildCandidate([driveStart, redZoneEntry])
assert.equal(redZoneCandidate?.priority, 'RED_ZONE')
assert.equal(redZoneCandidate?.redZoneDriveId, 'drive_1')
assert.equal(redZoneCandidate?.redZonePeriodKey, '1')

const duplicatePeriodRedZoneCandidate = buildNflQuestionCandidate({
  plays: [driveStart, redZoneEntry],
  anchorPlay: redZoneEntry,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 131_000,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: ['1'],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: [],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: ['winner'],
  periodQuestionKeys: ['team:1', 'player:1'],
  athletes,
})
assert.equal(duplicatePeriodRedZoneCandidate, null)

const delayedRedZoneCandidate = buildCandidate(
  [driveStart, redZoneEntry],
  BASE_TIME_MS + 130_000 + NFL_QUESTION_MAX_SOURCE_AGE_MS + 1
)
assert.equal(delayedRedZoneCandidate?.priority, 'RED_ZONE')
assert.deepEqual(delayedRedZoneCandidate?.payload.selectionReason?.slice(-2), [
  {
    code: 'NFL_SOURCE_AGE_GUARD',
    detail: `${NFL_QUESTION_MAX_LONG_HORIZON_SOURCE_AGE_MS}`,
  },
  { code: 'NFL_SOURCE_AGE_POLICY', detail: 'ENFORCE' },
])
const staleRedZoneCandidate = buildCandidate(
  [driveStart, redZoneEntry],
  BASE_TIME_MS + 130_000 + NFL_QUESTION_MAX_LONG_HORIZON_SOURCE_AGE_MS + 1
)
assert.equal(staleRedZoneCandidate, null)

const youngRedZoneEntry = buildPlay('young_red_zone_entry', 30_000, {
  end: redZoneEntry.end,
})
assert.equal(buildCandidate([driveStart, youngRedZoneEntry]), null)

assert.deepEqual(buildQuestionChoices(redZoneCandidate!.payload), [
  { id: 'touchdown', value: 'Touchdown' },
  { id: 'field_goal', value: 'Made field goal' },
  { id: 'turnover', value: 'Turnover or failed fourth down' },
  { id: 'no_score', value: 'No score' },
])

const redZoneOutcomeQuestion: NflActiveQuestion = {
  id: 'question_red_zone',
  templateId: 'NFL_RED_ZONE_OUTCOME',
  windowType: 'NFL_DRIVE',
  createdAtMs: BASE_TIME_MS,
  resolutionContext: {
    type: 'NFL_RED_ZONE_OUTCOME',
    anchorPlayId: redZoneEntry.id,
    driveId: 'drive_1',
    teamId: '1',
  },
}
const passingTouchdown = buildPlay('passing_td', 10_000, {
  type: 'Passing Touchdown',
  scoringPlay: true,
  scoreValue: 6,
})
assert.equal(
  resolveNflQuestionForPlay(redZoneOutcomeQuestion, passingTouchdown, [
    redZoneEntry,
    passingTouchdown,
  ]),
  null
)
const touchdownConfirmation = buildPlay('touchdown_confirmation', 20_000, {
  type: 'Official Timeout',
})
assert.deepEqual(
  resolveNflQuestionForPlay(redZoneOutcomeQuestion, touchdownConfirmation, [
    redZoneEntry,
    passingTouchdown,
    touchdownConfirmation,
  ]),
  { state: 'resolved', answer: 'touchdown', reason: null }
)

const redZoneFieldGoal = buildPlay('red_zone_field_goal', 10_000, {
  type: 'Field Goal Good',
  scoringPlay: true,
  scoreValue: 3,
})
assert.deepEqual(
  resolveNflQuestionForPlay(redZoneOutcomeQuestion, touchdownConfirmation, [
    redZoneEntry,
    redZoneFieldGoal,
    touchdownConfirmation,
  ]),
  { state: 'resolved', answer: 'field_goal', reason: null }
)

const redZoneInterception = buildPlay('red_zone_interception', 10_000, {
  type: 'Interception',
  turnover: true,
})
assert.deepEqual(
  resolveNflQuestionForPlay(redZoneOutcomeQuestion, touchdownConfirmation, [
    redZoneEntry,
    redZoneInterception,
    touchdownConfirmation,
  ]),
  { state: 'resolved', answer: 'turnover', reason: null }
)

const targetOne = buildPlay('target_1', 0, {
  type: 'Pass Reception',
  text: 'Q.Player pass short right to K.Pitts for 8 yards.',
})
const targetTwo = buildPlay('target_2', 10_000, {
  type: 'Pass Incompletion',
  text: 'Q.Player pass incomplete deep left to K.Pitts.',
})
const receiverAnchor = buildPlay('receiver_anchor', 131_000, {
  type: 'Rush',
  text: 'R.Runner up the middle for 4 yards.',
})
const receiverCandidate = buildCandidate(
  [targetOne, targetTwo, receiverAnchor],
  BASE_TIME_MS + 132_000
)
assert.equal(receiverCandidate?.priority, 'RECEIVER_TARGET')
assert.equal(
  receiverCandidate?.payload.question,
  "Will Kyle Pitts Sr. catch another pass on ATL's current drive?"
)
assert.equal(receiverCandidate?.payload.windowType, 'NFL_DRIVE')

const receiverQuestion: NflActiveQuestion = {
  id: 'question_receiver',
  templateId: receiverCandidate?.payload.templateId ?? '',
  windowType: 'NFL_DRIVE',
  createdAtMs: BASE_TIME_MS + 131_000,
  resolutionContext: receiverCandidate?.payload.resolutionContext ?? {},
}
const receiverCatch = buildPlay('target_3', 150_000, {
  type: 'Pass Reception',
  text: 'Q.Player pass short left to K.Pitts for 5 yards.',
})
assert.equal(
  resolveNflQuestionForPlay(receiverQuestion, receiverCatch, [
    receiverAnchor,
    receiverCatch,
  ]),
  null
)
const receiverCatchConfirmation = buildPlay(
  'receiver_catch_confirmation',
  170_000
)
assert.deepEqual(
  resolveNflQuestionForPlay(receiverQuestion, receiverCatchConfirmation, [
    receiverAnchor,
    receiverCatch,
    receiverCatchConfirmation,
  ]),
  { state: 'resolved', answer: 'yes', reason: null }
)
const receiverDriveEnd = buildPlay('receiver_drive_end', 180_000, {
  driveId: 'drive_2',
  driveTeamId: '2',
  driveTeamAbbreviation: 'TB',
  possessionTeamId: '2',
})
assert.deepEqual(
  resolveNflQuestionForPlay(receiverQuestion, receiverDriveEnd, [
    receiverAnchor,
    receiverDriveEnd,
  ]),
  { state: 'resolved', answer: 'no', reason: null }
)

const drivePassOne = buildPlay('drive_pass_one', 30_000, {
  type: 'Pass Reception',
  text: 'Q.Player pass short right to K.Pitts for 12 yards.',
  statYardage: 12,
})
const drivePassTwo = buildPlay('drive_pass_two', 60_000, {
  type: 'Pass Incompletion',
  text: 'Q.Player pass incomplete short left to K.Pitts.',
})
const drivePassThree = buildPlay('drive_pass_three', 100_000, {
  type: 'Pass Reception',
  text: 'Q.Player pass short left to K.Pitts for 8 yards.',
  statYardage: 8,
})
const driveRangeSetup = buildPlay('drive_range_setup', 125_000, {
  end: {
    down: 2,
    distance: 6,
    yardLine: 60,
    yardsToEndzone: 40,
    downDistanceText: '2nd & 6 at TB 40',
    possessionText: 'TB 40',
    teamId: '1',
  },
})
const driveRangeTimeout = buildPlay('drive_range_timeout', 130_000, {
  type: 'Timeout',
  text: 'Timeout #1 by ATL.',
})
const driveRangeCandidate = buildNflQuestionCandidate({
  plays: [
    driveStart,
    drivePassOne,
    drivePassTwo,
    drivePassThree,
    driveRangeSetup,
    driveRangeTimeout,
  ],
  anchorPlay: driveRangeTimeout,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 131_000,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: ['1'],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: ['first_half'],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: ['winner'],
  periodQuestionKeys: ['team:1', 'player:1'],
  athletes: [...athletes, passerAthlete],
})
assert.equal(driveRangeCandidate?.priority, 'DRIVE_PLAYER')
assert.equal(
  driveRangeCandidate?.payload.question,
  'How many passing yards will Quentin Player finish this drive with?'
)
assert.deepEqual(buildQuestionChoices(driveRangeCandidate!.payload), [
  { id: 'range_0', value: '29 yards or fewer' },
  { id: 'range_1', value: '30-39 yards' },
  { id: 'range_2', value: '40-49 yards' },
  { id: 'range_3', value: '50 yards or more' },
])
const driveRangeQuestion: NflActiveQuestion = {
  id: 'question_drive_range',
  templateId: driveRangeCandidate!.payload.templateId,
  windowType: 'NFL_DRIVE',
  createdAtMs: BASE_TIME_MS + 130_000,
  resolutionContext: driveRangeCandidate!.payload.resolutionContext ?? {},
}
const drivePunt = buildPlay('drive_punt', 150_000, { type: 'Punt' })
const driveRangeNextDrivePlay = buildPlay('drive_range_next_play', 170_000, {
  driveId: 'drive_2',
  driveTeamId: '2',
  driveTeamAbbreviation: 'TB',
  possessionTeamId: '2',
})
assert.deepEqual(
  resolveNflQuestionForPlay(driveRangeQuestion, driveRangeNextDrivePlay, [
    driveStart,
    drivePassOne,
    drivePassTwo,
    drivePassThree,
    driveRangeSetup,
    driveRangeTimeout,
    drivePunt,
    driveRangeNextDrivePlay,
  ]),
  { state: 'resolved', answer: 'range_0', reason: null }
)

const fourthDownPlay = buildPlay('fourth_down', 0, {
  end: {
    down: 4,
    distance: 6,
    yardLine: 83,
    yardsToEndzone: 17,
    downDistanceText: '4th & 6 at TB 17',
    possessionText: 'TB 17',
    teamId: '1',
  },
})
const fieldGoalTimeout = buildPlay('field_goal_timeout', 1_000, {
  type: 'Timeout',
  text: 'Timeout #2 by TB.',
})
fourthDownPlay.wallclock = new Date(BASE_TIME_MS + 130_000).toISOString()
fieldGoalTimeout.wallclock = new Date(BASE_TIME_MS + 131_000).toISOString()
const fieldGoalCandidate = buildCandidate(
  [driveStart, fourthDownPlay, fieldGoalTimeout],
  BASE_TIME_MS + 132_000
)
assert.equal(fieldGoalCandidate?.priority, 'FIELD_GOAL')
const staleFieldGoalCandidate = buildCandidate(
  [driveStart, fourthDownPlay, fieldGoalTimeout],
  BASE_TIME_MS + 131_000 + NFL_QUESTION_MAX_SOURCE_AGE_MS + 1
)
assert.equal(staleFieldGoalCandidate, null)
const observedStaleFieldGoalCandidate = buildNflQuestionCandidate({
  plays: [driveStart, fourthDownPlay, fieldGoalTimeout],
  anchorPlay: fieldGoalTimeout,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 131_000 + NFL_QUESTION_MAX_SOURCE_AGE_MS + 1,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: ['1'],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: [],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: ['winner'],
  periodQuestionKeys: ['team:1', 'player:1'],
  athletes,
  sourceAgePolicy: 'OBSERVE',
})
assert.equal(observedStaleFieldGoalCandidate?.priority, 'FIELD_GOAL')
const staleFieldGoalPeriodFallback = buildNflQuestionCandidate({
  plays: [driveStart, fourthDownPlay, fieldGoalTimeout],
  anchorPlay: fieldGoalTimeout,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 131_000 + NFL_QUESTION_MAX_SOURCE_AGE_MS + 1,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: ['1'],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: [],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: ['winner'],
  periodQuestionKeys: [],
  athletes,
})
assert.equal(staleFieldGoalPeriodFallback?.priority, 'PERIOD_TEAM')

const fieldGoalQuestion: NflActiveQuestion = {
  id: 'question_field_goal',
  templateId: fieldGoalCandidate?.payload.templateId ?? '',
  windowType: 'NFL_DRIVE',
  createdAtMs: BASE_TIME_MS + 1_000,
  resolutionContext: fieldGoalCandidate?.payload.resolutionContext ?? {},
}
const madeFieldGoal = buildPlay('made_field_goal', 20_000, {
  type: 'Field Goal Good',
  scoringPlay: true,
  scoreValue: 3,
})
assert.equal(
  resolveNflQuestionForPlay(fieldGoalQuestion, madeFieldGoal, [
    fieldGoalTimeout,
    madeFieldGoal,
  ]),
  null
)
const fieldGoalConfirmation = buildPlay('field_goal_confirmation', 30_000, {
  type: 'Official Timeout',
})
assert.deepEqual(
  resolveNflQuestionForPlay(fieldGoalQuestion, fieldGoalConfirmation, [
    fieldGoalTimeout,
    madeFieldGoal,
    fieldGoalConfirmation,
  ]),
  { state: 'resolved', answer: 'yes', reason: null }
)

const shortFourthDownPlay = buildPlay('short_fourth_down', 130_000, {
  end: {
    down: 4,
    distance: 1,
    yardLine: 53,
    yardsToEndzone: 47,
    downDistanceText: '4th & 1 at TB 47',
    possessionText: 'TB 47',
    teamId: '1',
  },
})
const shortFourthDownTimeout = buildPlay('short_fourth_down_timeout', 131_000, {
  type: 'Timeout',
  text: 'Timeout #1 by ATL.',
})
const fourthDownCandidate = buildCandidate([
  driveStart,
  shortFourthDownPlay,
  shortFourthDownTimeout,
])
assert.equal(fourthDownCandidate?.priority, 'FOURTH_DOWN')
assert.equal(
  fourthDownCandidate?.payload.question,
  'Will ATL convert this 4th & 1?'
)
assert.equal(
  buildNflQuestionCandidate({
    plays: [driveStart, shortFourthDownPlay, shortFourthDownTimeout],
    anchorPlay: shortFourthDownTimeout,
    homeTeam: 'ATL',
    awayTeam: 'TB',
    nowMs: BASE_TIME_MS + 132_000,
    redZoneAskedDriveIds: [],
    redZoneAskedPeriodKeys: [],
    receiverQuestionKeys: [],
    completionReceiverHalfKeys: [],
    timeoutQuestionDriveIds: [],
    gameQuestionKeys: ['winner'],
    periodQuestionKeys: ['team:1', 'player:1', 'fourth:1'],
    athletes,
  }),
  null
)

const fourthDownQuestion: NflActiveQuestion = {
  id: 'question_fourth_down',
  templateId: fourthDownCandidate?.payload.templateId ?? '',
  windowType: 'NFL_NEXT_PLAY',
  createdAtMs: BASE_TIME_MS + 131_000,
  resolutionContext: fourthDownCandidate?.payload.resolutionContext ?? {},
}
const convertedFourthDown = buildPlay('converted_fourth_down', 150_000, {
  type: 'Rush',
  start: {
    down: 4,
    distance: 1,
    yardLine: 53,
    yardsToEndzone: 47,
    downDistanceText: '4th & 1 at TB 47',
    possessionText: 'TB 47',
    teamId: '1',
  },
  end: {
    down: 1,
    distance: 10,
    yardLine: 55,
    yardsToEndzone: 45,
    downDistanceText: '1st & 10 at TB 45',
    possessionText: 'TB 45',
    teamId: '1',
  },
})
assert.equal(
  resolveNflQuestionForPlay(fourthDownQuestion, convertedFourthDown, [
    shortFourthDownTimeout,
    convertedFourthDown,
  ]),
  null
)
const fourthDownConfirmation = buildPlay('fourth_down_confirmation', 170_000)
assert.deepEqual(
  resolveNflQuestionForPlay(fourthDownQuestion, fourthDownConfirmation, [
    shortFourthDownTimeout,
    convertedFourthDown,
    fourthDownConfirmation,
  ]),
  { state: 'resolved', answer: 'yes', reason: null }
)

const failedFourthDown = buildPlay('failed_fourth_down', 150_000, {
  type: 'Pass Incompletion',
  start: {
    down: 4,
    distance: 1,
    yardLine: 53,
    yardsToEndzone: 47,
    downDistanceText: '4th & 1 at TB 47',
    possessionText: 'TB 47',
    teamId: '1',
  },
  end: {
    down: 1,
    distance: 10,
    yardLine: 53,
    yardsToEndzone: 53,
    downDistanceText: '1st & 10 at TB 47',
    possessionText: 'TB 47',
    teamId: '2',
  },
})
const failedFourthDownConfirmation = buildPlay(
  'failed_fourth_down_confirmation',
  170_000,
  {
    driveId: 'drive_2',
    driveTeamId: '2',
    driveTeamAbbreviation: 'TB',
  }
)
assert.deepEqual(
  resolveNflQuestionForPlay(fourthDownQuestion, failedFourthDownConfirmation, [
    shortFourthDownTimeout,
    failedFourthDown,
    failedFourthDownConfirmation,
  ]),
  { state: 'resolved', answer: 'no', reason: null }
)

const puntRangeFourthDown = buildPlay('punt_range_fourth_down', 0, {
  end: {
    down: 4,
    distance: 12,
    yardLine: 40,
    yardsToEndzone: 60,
    downDistanceText: '4th & 12 at ATL 40',
    possessionText: 'ATL 40',
    teamId: '1',
  },
})
const puntTimeout = buildPlay('punt_timeout', 1_000, {
  type: 'Timeout',
  text: 'Timeout #1 by TB.',
})
puntRangeFourthDown.wallclock = new Date(BASE_TIME_MS + 130_000).toISOString()
puntTimeout.wallclock = new Date(BASE_TIME_MS + 131_000).toISOString()
assert.equal(
  buildCandidate(
    [driveStart, puntRangeFourthDown, puntTimeout],
    BASE_TIME_MS + 132_000
  ),
  null
)

const youngDriveSetup = buildPlay('young_drive_setup', 90_000)
const youngDriveTimeout = buildPlay('young_drive_timeout', 100_000, {
  type: 'Timeout',
  text: 'Timeout #1 by ATL.',
})
assert.equal(
  buildCandidate([driveStart, youngDriveSetup, youngDriveTimeout]),
  null
)

const stableDriveSetup = buildPlay('stable_drive_setup', 130_000)
const stableDriveTimeout = buildPlay('stable_drive_timeout', 131_000, {
  type: 'Timeout',
  text: 'Timeout #1 by ATL.',
})
assert.equal(
  buildCandidate([driveStart, stableDriveSetup, stableDriveTimeout])?.priority,
  'TIMEOUT_NEXT_PLAY'
)

const receiverOneTarget = buildPlay('receiver_one_target', 20_000, {
  type: 'Pass Incompletion',
  text: 'Q.Player pass incomplete short right to K.Pitts.',
})
const receiverTwoTarget = buildPlay('receiver_two_target', 50_000, {
  type: 'Pass Reception',
  text: 'Q.Player pass short left to D.London for 8 yards.',
  statYardage: 8,
})
const receiverThreeTarget = buildPlay('receiver_three_target', 80_000, {
  type: 'Pass Incompletion',
  text: 'Q.Player pass incomplete deep right to D.Mooney.',
})
const multiReceiverSetup = buildPlay('multi_receiver_setup', 120_000, {
  type: 'Rush',
  text: 'R.Runner up the middle for 4 yards.',
  end: {
    down: 2,
    distance: 6,
    yardLine: 54,
    yardsToEndzone: 46,
    downDistanceText: '2nd & 6 at TB 46',
    possessionText: 'TB 46',
    teamId: '1',
  },
})
const multiReceiverTimeout = buildPlay('multi_receiver_timeout', 130_000, {
  type: 'Timeout',
  text: 'Timeout #1 by ATL.',
})
const multiReceiverPlays = [
  driveStart,
  receiverOneTarget,
  receiverTwoTarget,
  receiverThreeTarget,
  multiReceiverSetup,
  multiReceiverTimeout,
]
const multiReceiverCandidate = buildNflQuestionCandidate({
  plays: multiReceiverPlays,
  anchorPlay: multiReceiverTimeout,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 131_000,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: [],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: [],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: ['winner'],
  periodQuestionKeys: ['team:1', 'player:1'],
  athletes,
})
assert.equal(multiReceiverCandidate?.priority, 'NEXT_COMPLETION_RECEIVER')
assert.equal(
  multiReceiverCandidate?.payload.question,
  "Who will catch ATL's next completed pass on this drive?"
)
assert.deepEqual(multiReceiverCandidate?.payload.resolutionContext?.choices, [
  { id: 'athlete_2', value: 'Drake London' },
  { id: 'athlete_3', value: 'Darnell Mooney' },
  { id: 'athlete_1', value: 'Kyle Pitts Sr.' },
  { id: 'other', value: 'Someone else' },
  { id: 'no_completion', value: 'No completed pass' },
])

const staleLondonTargets = [0, 10_000, 20_000, 30_000].map((offset, index) =>
  buildPlay(`stale_london_${index}`, offset, {
    driveId: 'drive_stale',
    type: 'Pass Reception',
    text: 'Q.Player pass short left to D.London for 5 yards.',
    statYardage: 5,
  })
)
const recentDriveOneTarget = buildPlay('recent_drive_one_target', 50_000, {
  driveId: 'drive_recent_1',
  type: 'Pass Reception',
  text: 'Q.Player pass short left to K.Pitts for 7 yards.',
  statYardage: 7,
})
const recentDriveTwoTarget = buildPlay('recent_drive_two_target', 100_000, {
  driveId: 'drive_recent_2',
  type: 'Pass Reception',
  text: 'Q.Player pass short right to D.Mooney for 6 yards.',
  statYardage: 6,
})
const recentCurrentDriveStart = buildPlay('recent_current_start', 150_000)
const recentCurrentTargetOne = buildPlay('recent_current_target_one', 220_000, {
  type: 'Pass Reception',
  text: 'Q.Player pass short right to R.McCloud for 9 yards.',
  statYardage: 9,
})
const recentCurrentTargetTwo = buildPlay('recent_current_target_two', 260_000, {
  type: 'Pass Incompletion',
  text: 'Q.Player pass incomplete short left to K.Pitts.',
})
const recentCurrentSetup = buildPlay('recent_current_setup', 280_000)
const recentCurrentTimeout = buildPlay('recent_current_timeout', 281_000, {
  type: 'Timeout',
  text: 'Timeout #2 by ATL.',
})
const recentUsagePlays = [
  ...staleLondonTargets,
  recentDriveOneTarget,
  recentDriveTwoTarget,
  recentCurrentDriveStart,
  recentCurrentTargetOne,
  recentCurrentTargetTwo,
  recentCurrentSetup,
  recentCurrentTimeout,
]
const recentUsageCandidate = buildNflQuestionCandidate({
  plays: recentUsagePlays,
  anchorPlay: recentCurrentTimeout,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 282_000,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: [],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: [],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: ['winner'],
  periodQuestionKeys: ['team:1', 'player:1'],
  athletes: [...athletes, recentReceiver],
})
const recentChoiceIds = recentUsageCandidate
  ? buildQuestionChoices(recentUsageCandidate.payload).map(
      (choice) => choice.id
    )
  : []
assert.equal(recentUsageCandidate?.priority, 'NEXT_COMPLETION_RECEIVER')
assert.equal(recentChoiceIds.includes('athlete_4'), true)
assert.equal(recentChoiceIds.includes('athlete_2'), false)

const thirdDownMultiSetup = buildPlay('third_down_multi_setup', 120_000, {
  end: {
    down: 3,
    distance: 6,
    yardLine: 54,
    yardsToEndzone: 46,
    downDistanceText: '3rd & 6 at TB 46',
    possessionText: 'TB 46',
    teamId: '1',
  },
})
const thirdDownMultiTimeout = buildPlay('third_down_multi_timeout', 130_000, {
  type: 'Timeout',
  text: 'Timeout #1 by ATL.',
})
assert.equal(
  buildNflQuestionCandidate({
    plays: [
      driveStart,
      receiverOneTarget,
      receiverTwoTarget,
      receiverThreeTarget,
      thirdDownMultiSetup,
      thirdDownMultiTimeout,
    ],
    anchorPlay: thirdDownMultiTimeout,
    homeTeam: 'ATL',
    awayTeam: 'TB',
    nowMs: BASE_TIME_MS + 131_000,
    redZoneAskedDriveIds: [],
    redZoneAskedPeriodKeys: [],
    receiverQuestionKeys: [],
    completionReceiverHalfKeys: [],
    timeoutQuestionDriveIds: [],
    gameQuestionKeys: ['winner'],
    periodQuestionKeys: ['team:1', 'player:1'],
    athletes,
  })?.priority,
  'TIMEOUT_NEXT_PLAY'
)

const multiReceiverQuestion: NflActiveQuestion = {
  id: 'question_multi_receiver',
  templateId: multiReceiverCandidate?.payload.templateId ?? '',
  windowType: 'NFL_DRIVE',
  createdAtMs: BASE_TIME_MS + 130_000,
  resolutionContext: multiReceiverCandidate?.payload.resolutionContext ?? {},
}
const multiReceiverCompletion = buildPlay(
  'multi_receiver_completion',
  150_000,
  {
    type: 'Pass Reception',
    text: 'Q.Player pass short right to D.Mooney for 7 yards.',
    statYardage: 7,
  }
)
assert.equal(
  resolveNflQuestionForPlay(multiReceiverQuestion, multiReceiverCompletion, [
    ...multiReceiverPlays,
    multiReceiverCompletion,
  ]),
  null
)
const multiReceiverConfirmation = buildPlay(
  'multi_receiver_confirmation',
  170_000
)
assert.deepEqual(
  resolveNflQuestionForPlay(multiReceiverQuestion, multiReceiverConfirmation, [
    ...multiReceiverPlays,
    multiReceiverCompletion,
    multiReceiverConfirmation,
  ]),
  { state: 'resolved', answer: 'athlete_3', reason: null }
)
const nextDrivePlay = buildPlay('next_drive_play', 190_000, {
  driveId: 'drive_2',
  driveTeamId: '2',
  driveTeamAbbreviation: 'TB',
  possessionTeamId: '2',
})
assert.deepEqual(
  resolveNflQuestionForPlay(multiReceiverQuestion, nextDrivePlay, [
    ...multiReceiverPlays,
    nextDrivePlay,
  ]),
  { state: 'resolved', answer: 'no_completion', reason: null }
)

const gameStartPlay = buildPlay('game_start', 0, {
  type: 'Kickoff',
  clock: '15:00',
})
const gameWinnerCandidate = buildNflQuestionCandidate({
  plays: [gameStartPlay],
  anchorPlay: gameStartPlay,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 1_000,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: [],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: [],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: [],
  periodQuestionKeys: [],
  athletes,
})
assert.equal(gameWinnerCandidate?.priority, 'GAME')
assert.equal(gameWinnerCandidate?.payload.templateId, 'NFL_GAME_WINNER')
assert.equal(
  gameWinnerCandidate?.payload.question,
  'What will the game result be?'
)
assert.deepEqual(buildQuestionChoices(gameWinnerCandidate!.payload), [
  { id: 'ATL', value: 'ATL' },
  { id: 'TB', value: 'TB' },
  { id: 'tie', value: 'Tie' },
])
const gameWinnerQuestion: NflActiveQuestion = {
  id: 'question_game_winner',
  templateId: gameWinnerCandidate?.payload.templateId ?? '',
  windowType: 'GAME',
  createdAtMs: BASE_TIME_MS,
  resolutionContext: gameWinnerCandidate?.payload.resolutionContext ?? {},
}
const gameEnd = buildPlay('game_end', 60_000, {
  period: 4,
  type: 'End of Game',
  homeScore: 24,
  awayScore: 17,
})
assert.deepEqual(
  resolveNflQuestionForPlay(gameWinnerQuestion, gameEnd, [gameEnd], true),
  { state: 'resolved', answer: 'ATL', reason: null }
)
const tiedGameEnd = buildPlay('tied_game_end', 60_000, {
  period: 4,
  type: 'End of Game',
  homeScore: 20,
  awayScore: 20,
})
assert.deepEqual(
  resolveNflQuestionForPlay(
    gameWinnerQuestion,
    tiedGameEnd,
    [tiedGameEnd],
    true
  ),
  { state: 'resolved', answer: 'tie', reason: null }
)

const firstQuarterEnd = buildPlay('first_quarter_end', 0, {
  period: 1,
  type: 'End Period',
  homeScore: 7,
  awayScore: 3,
})
const secondQuarterPass = buildPlay('second_quarter_pass', 10_000, {
  period: 2,
  type: 'Pass Reception',
  text: 'Q.Player pass short right to K.Pitts for 20 yards.',
  statYardage: 20,
  homeScore: 7,
  awayScore: 3,
})
const periodTeamCandidate = buildNflQuestionCandidate({
  plays: [firstQuarterEnd, secondQuarterPass],
  anchorPlay: secondQuarterPass,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 11_000,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: [],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: [],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: ['winner'],
  periodQuestionKeys: [],
  athletes,
})
assert.equal(periodTeamCandidate?.priority, 'PERIOD_TEAM')
assert.equal(
  periodTeamCandidate?.payload.templateId,
  'NFL_PERIOD_TEAM_COMPARE_PASSING_YARDS'
)
assert.deepEqual(buildQuestionChoices(periodTeamCandidate!.payload), [
  { id: 'ATL', value: 'ATL' },
  { id: 'TB', value: 'TB' },
  { id: 'tie', value: 'Tie' },
])
const secondQuarterRush = buildPlay('second_quarter_rush', 20_000, {
  period: 2,
  driveTeamId: '2',
  driveTeamAbbreviation: 'TB',
  possessionTeamId: '2',
  type: 'Rush',
  text: 'R.Runner left tackle for 10 yards.',
  statYardage: 10,
  homeScore: 7,
  awayScore: 3,
})
const secondQuarterEnd = buildPlay('second_quarter_end', 30_000, {
  period: 2,
  type: 'End Period',
  homeScore: 10,
  awayScore: 3,
})
const periodPlays = [
  firstQuarterEnd,
  secondQuarterPass,
  secondQuarterRush,
  secondQuarterEnd,
]
const periodStats = getNflPeriodStats(periodPlays, 2, 'ATL', 'TB')
assert.equal(periodStats.teams.get('ATL')?.points, 3)
assert.equal(periodStats.teams.get('ATL')?.passingYards, 20)
assert.equal(periodStats.teams.get('TB')?.rushingYards, 10)
assert.equal(periodStats.players.get('kpitts')?.receptions, 1)

const periodTeamQuestion: NflActiveQuestion = {
  id: 'question_period_team',
  templateId: 'NFL_PERIOD_TEAM_COMPARE_PASSING_YARDS',
  windowType: 'PERIOD',
  createdAtMs: BASE_TIME_MS,
  resolutionContext: {
    type: 'NFL_PERIOD_TEAM_COMPARE',
    anchorPlayId: secondQuarterPass.id,
    period: 2,
    statType: 'PASSING_YARDS',
    homeTricode: 'ATL',
    awayTricode: 'TB',
  },
}
assert.deepEqual(
  resolveNflQuestionForPlay(periodTeamQuestion, secondQuarterEnd, periodPlays),
  { state: 'resolved', answer: 'ATL', reason: null }
)

const secondQuarterCatchTwo = buildPlay('second_quarter_catch_two', 40_000, {
  period: 2,
  clock: '10:00',
  type: 'Pass Reception',
  text: 'Q.Player pass short left to K.Pitts for 8 yards.',
  statYardage: 8,
})
const playerPeriodCandidate = buildNflQuestionCandidate({
  plays: [firstQuarterEnd, secondQuarterPass, secondQuarterCatchTwo],
  anchorPlay: secondQuarterCatchTwo,
  homeTeam: 'ATL',
  awayTeam: 'TB',
  nowMs: BASE_TIME_MS + 41_000,
  redZoneAskedDriveIds: [],
  redZoneAskedPeriodKeys: [],
  receiverQuestionKeys: [],
  completionReceiverHalfKeys: [],
  timeoutQuestionDriveIds: [],
  gameQuestionKeys: ['winner'],
  periodQuestionKeys: ['team:2'],
  athletes,
})
assert.equal(playerPeriodCandidate?.priority, 'PERIOD_PLAYER')
assert.equal(
  playerPeriodCandidate?.payload.question,
  'How many catches will Kyle Pitts Sr. finish the second quarter with?'
)
assert.deepEqual(buildQuestionChoices(playerPeriodCandidate!.payload), [
  { id: 'range_0', value: '2 catches or fewer' },
  { id: 'range_1', value: '3 catches' },
  { id: 'range_2', value: '4 catches' },
  { id: 'range_3', value: '5 catches or more' },
])

const secondQuarterCatchThree = buildPlay(
  'second_quarter_catch_three',
  50_000,
  {
    period: 2,
    type: 'Pass Reception',
    text: 'Q.Player pass short right to K.Pitts for 6 yards.',
    statYardage: 6,
  }
)
const playerPeriodQuestion: NflActiveQuestion = {
  id: 'question_period_player',
  templateId: playerPeriodCandidate?.payload.templateId ?? '',
  windowType: 'PERIOD',
  createdAtMs: BASE_TIME_MS + 40_000,
  resolutionContext: playerPeriodCandidate?.payload.resolutionContext ?? {},
}
assert.deepEqual(
  resolveNflQuestionForPlay(playerPeriodQuestion, secondQuarterEnd, [
    firstQuarterEnd,
    secondQuarterPass,
    secondQuarterCatchTwo,
    secondQuarterCatchThree,
    secondQuarterEnd,
  ]),
  { state: 'resolved', answer: 'range_1', reason: null }
)

assert.deepEqual(buildNflStatRange('PASSING_YARDS', 47, 71), {
  bucketWidth: 15,
  cutoffs: [59, 74, 89],
  choices: [
    { id: 'range_0', value: '59 yards or fewer' },
    { id: 'range_1', value: '60-74 yards' },
    { id: 'range_2', value: '75-89 yards' },
    { id: 'range_3', value: '90 yards or more' },
  ],
})

const parsedPriorSeasonProfile = parseEspnNflPlayerPriorSeasonProfile(
  {
    categories: [
      {
        name: 'passing',
        names: ['gamesPlayed', 'passingAttempts', 'passingYards'],
        statistics: [
          {
            teamId: '5',
            season: { year: 2025 },
            stats: ['4', '160', '815'],
          },
          {
            teamId: '4',
            season: { year: 2025 },
            stats: ['9', '256', '1,664'],
          },
          {
            teamId: null,
            teamSlug: '2025 Totals',
            season: { year: 2025 },
            stats: ['13', '416', '2,479'],
          },
        ],
      },
      {
        name: 'rushing',
        names: ['gamesPlayed', 'rushingAttempts', 'rushingYards'],
        statistics: [
          {
            season: { year: 2025 },
            stats: ['16', '58', '307'],
          },
        ],
      },
      {
        name: 'receiving',
        names: ['gamesPlayed', 'receptions', 'receivingTargets'],
        statistics: [],
      },
    ],
  },
  2025
)
assert.equal(parsedPriorSeasonProfile?.passingGames, 13)
assert.equal(parsedPriorSeasonProfile?.passingYardsPerGame, 2479 / 13)
assert.equal(parsedPriorSeasonProfile?.rushingYardsPerGame, 19.1875)

const passerWithHistory: EspnNflAthleteName = {
  id: 'passer_with_history',
  teamId: '1',
  firstName: 'Test',
  lastName: 'Passer',
  displayName: 'Test Passer',
  roles: ['PASSER'],
  passingAttempts: 5,
  passingYards: 20,
  rushingAttempts: 0,
  rushingYards: 0,
  receptions: 0,
  receivingYards: 0,
  receivingTargets: 0,
  priorSeasonProfile: {
    seasonYear: 2025,
    passingGames: 16,
    passingAttemptsPerGame: 34,
    passingYardsPerGame: 250,
    rushingGames: 0,
    rushingAttemptsPerGame: 0,
    rushingYardsPerGame: 0,
    receivingGames: 0,
    receptionsPerGame: 0,
    receivingTargetsPerGame: 0,
  },
}
const tenMinutesRemainingProjection = projectNflPeriodPlayerThreshold({
  statType: 'PASSING_YARDS',
  currentValue: 20,
  clockRemainingMs: 10 * 60_000,
  athlete: passerWithHistory,
})
const fiveMinutesRemainingProjection = projectNflPeriodPlayerThreshold({
  statType: 'PASSING_YARDS',
  currentValue: 20,
  clockRemainingMs: 5 * 60_000,
  athlete: passerWithHistory,
})
assert.equal(tenMinutesRemainingProjection?.target, 50)
assert.equal(fiveMinutesRemainingProjection?.target, 30)
assert.equal(
  tenMinutesRemainingProjection?.projectionSource,
  'PRIOR_SEASON_LIVE_BLEND'
)
const rookiePasserProjection = projectNflPeriodPlayerThreshold({
  statType: 'PASSING_YARDS',
  currentValue: 50,
  clockRemainingMs: 13 * 60_000,
  athlete: {
    ...passerWithHistory,
    id: 'rookie_passer',
    priorSeasonProfile: null,
  },
})
assert.equal(rookiePasserProjection?.target, 90)
assert.equal(
  rookiePasserProjection?.projectionSource,
  'POSITION_BASELINE_LIVE_BLEND'
)

const nearRushingIncrementProjection = projectNflPeriodPlayerThreshold({
  statType: 'RUSHING_YARDS',
  currentValue: 8,
  clockRemainingMs: 9 * 60_000 + 51_000,
  athlete: {
    ...passerWithHistory,
    id: 'rusher_near_increment',
    roles: ['RUSHER'],
    priorSeasonProfile: {
      seasonYear: 2025,
      passingGames: 0,
      passingAttemptsPerGame: 0,
      passingYardsPerGame: 0,
      rushingGames: 17,
      rushingAttemptsPerGame: 7.4,
      rushingYardsPerGame: 31.76,
      receivingGames: 17,
      receptionsPerGame: 1.2,
      receivingTargetsPerGame: 1.6,
    },
  },
})
assert.equal(nearRushingIncrementProjection?.target, 15)

console.log('[test-nfl-questions] passed')
