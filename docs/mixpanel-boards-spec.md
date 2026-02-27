# Whistle Mixpanel Board Spec

## Step 1: Audit Summary

- Mixpanel token is shared between app and backend:
  - `EXPO_PUBLIC_MIXPANEL_TOKEN` in root app env.
  - `MIXPANEL_TOKEN` in backend env.
- Canonical lifecycle events are emitted:
  - `question_created` (server)
  - `question_sent` (server, per user)
  - `question_opened` (client)
  - `question_answered` (client + server confirm)
  - `question_resolved` (server)
- Distinct user identity:
  - Primary Mixpanel identity is Firebase UID (`user_id` / `distinct_id`).
  - Keep device identifiers as properties only, not as `distinct_id`.

## Global Filters and Conventions

- Default board ranges:
  - Last 7 days (primary operating view)
  - Last 30 days (trend view)
- Global event property filters:
  - `schema_version = "v1"`
- Accuracy charts:
  - Exclude void outcomes with `resolution_type != "void"`
- Engagement charts:
  - Include void outcomes (voids still represent engagement attempts)

## Board A: Live Game Engagement Core

### A1. Delivered Volume

- Type: Insights
- Metric: `count(question_sent)`
- Filters: `schema_version="v1"`
- Breakdown: none

### A2. Open Volume

- Type: Insights
- Metric: `count(question_opened)`
- Filters: `schema_version="v1"`
- Breakdown: none

### A3. Answer Volume

- Type: Insights
- Metric: `count(question_answered)`
- Filters: `schema_version="v1"`
- Breakdown: none

### A4. Send→Open Rate

- Type: Funnel
- Steps:
  1. `question_sent`
  2. `question_opened`
- Conversion window: 30 minutes
- Counting method: Unique users or totals (choose one and keep fixed)
- Filters: `schema_version="v1"`
- Breakdown: `question_type` (secondary saved view)

### A5. Send→Answer Rate

- Type: Funnel
- Steps:
  1. `question_sent`
  2. `question_answered`
- Conversion window: question lifetime (recommend 30 minutes)
- Filters: `schema_version="v1"`
- Breakdown: `question_type` (secondary saved view)

### A6. Median Time to Answer by Question Type

- Type: Insights
- Metric: `median(time_to_answer_ms)` on `question_answered`
- Filters: `schema_version="v1"`
- Breakdown: `question_type`

### A7. Answers per Active User per Game

- Mixpanel limitation: direct double-group mean is awkward.
- Compute in internal dashboard:
  - Group `question_answered` by `(user_id, game_id)` count
  - Return mean across groups

## Board B: Question Type Optimization

### B1. Send→Answer Rate by Question Type

- Type: Funnel
- Steps: `question_sent` → `question_answered`
- Filters: `schema_version="v1"`
- Breakdown: `question_type`

### B2. Send→Answer Rate by Trigger Type

- Type: Funnel
- Steps: `question_sent` → `question_answered`
- Filters: `schema_version="v1"`
- Breakdown: `trigger_type`

### B3. Median Response Speed by Question Type

- Type: Insights
- Metric: `median(time_to_answer_ms)` on `question_answered`
- Filters: `schema_version="v1"`
- Breakdown: `question_type`

### B4. Void Rate by Question Type and Trigger Type

- Type: Insights (formula or paired cards)
- Numerator: `count(question_resolved where resolution_type="void")`
- Denominator: `count(question_resolved)`
- Display:
  - Card 1 breakdown `question_type`
  - Card 2 breakdown `trigger_type`
- Tie handling:
  - tie questions must be `resolution_type="void"` and `void_reason="tie"`

### B5. Engagement Impact Score

- Prefer internal dashboard computation:
  - `score = 0.5 * send_to_answer_rate_norm + 0.3 * speed_norm + 0.2 * reengagement_norm`
  - `speed_norm = 1 - min(1, median_time_to_answer_ms / 30000)`
  - `reengagement_norm = pct(answered users who answer again within 3m)`
- Re-engagement definition:
  - Next `question_answered` event by same `user_id` within 180 seconds.

## Board C: Exec / Investor Narrative

### C1. Avg Answers per User per Live Game

- Type: Internal dashboard metric from canonical events
- Formula: mean(count of `question_answered` by `(user_id, game_id)`)

### C2. % Users Who Answer >= 5 Questions in a Game

- Type: Internal dashboard metric
- Formula:
  - numerator: `(user_id, game_id)` groups with count >= 5
  - denominator: all `(user_id, game_id)` groups with count >= 1

### C3. Median Response Time

- Type: Insights
- Metric: `median(time_to_answer_ms)` on `question_answered`
- Filters: `schema_version="v1"`

### C4. Latency Under 10s vs Over 10s Response Rate

- Type: Funnel cohorts or two cards
- Cohort A filter: `latency_bucket in ["0-5s","5-10s"]`
- Cohort B filter: `latency_bucket in ["10-20s","20-40s","40s+"]`
- Steps: `question_sent` → `question_answered`

### C5. Retention Proxy: Users Playing 2+ Games in 7 Days

- Type: Internal dashboard metric
- Source: unique `game_id` count per `user_id` from `question_answered`
- Output: count of users with distinct games >= 2

### C6. Engagement Minutes Uplift (Proxy)

- If session events exist:
  - Compare active session minutes before/after question windows.
- If session events do not exist:
  - Add minimal events:
    - `session_started`, `session_ended`, `game_screen_viewed`

## Step 3: Latency Bucket Requirements

Emit `latency_bucket` using:

- `0-5s`
- `5-10s`
- `10-20s`
- `20-40s`
- `40s+`

Source precedence:

1. `push_delivery_latency_ms`
2. `latency_at_answer_ms`
3. null (if unavailable)

Required charts:

- Send→Answer rate by `latency_bucket`
- Median `time_to_answer_ms` by `latency_bucket`
- Void rate by `latency_bucket` (when bucket is available at resolution context level)

## Internal Dashboard Mapping

The admin `/analytics` page consumes backend endpoint:

- `GET /api/admin/mixpanel/summary?range=7d|30d`

Returned sections:

- Totals: sent/opened/answered/resolved + top-level rates
- `by_question_type`
- `by_trigger_type`
- `by_latency_bucket`
- Investor summary metrics:
  - avg answers per user/game
  - % user-games with 5+ answers
  - users with 2+ games in 7d
