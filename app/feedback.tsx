import { Button } from '@/components/ui/button'
import { Text } from '@/components/ui/text'
import { Textarea } from '@/components/ui/textarea'
import { analytics } from '@/lib/analytics'
import { useAuth } from '@/lib/contexts/AuthContext'
import { env } from '@/lib/env'
import { Ionicons } from '@expo/vector-icons'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  TouchableOpacity,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { toast } from 'sonner-native'

type FeedbackResponse = {
  error?: string
  ok?: boolean
  feedbackId?: string
}

type FeedbackPayload = {
  text?: string
  gameId?: string
  funRating?: number
  questionVolume?: 'too_many' | 'just_right' | 'too_few'
  questionTiming?: 'too_early' | 'too_late' | 'good_timing'
  submissionSource?: string
}

const MAX_FEEDBACK_LENGTH = 5000
const QUESTION_VOLUME_OPTIONS = [
  { label: 'Too few', value: 'too_few' },
  { label: 'Just right', value: 'just_right' },
  { label: 'Too many', value: 'too_many' },
] as const
const QUESTION_TIMING_OPTIONS = [
  { label: 'Too early', value: 'too_early' },
  { label: 'Good timing', value: 'good_timing' },
  { label: 'Too late', value: 'too_late' },
] as const

const isValidRating = (rating: number | null) =>
  rating !== null && Number.isInteger(rating) && rating >= 1 && rating <= 5

type QuestionVolume = (typeof QUESTION_VOLUME_OPTIONS)[number]['value']
type QuestionTiming = (typeof QUESTION_TIMING_OPTIONS)[number]['value']

type ChoiceOption<T extends string> = {
  label: string
  value: T
}

type RatingRowProps = {
  label: string
  value: number | null
  onChange: (nextValue: number) => void
  disabled: boolean
}

const RatingRow = ({ label, value, onChange, disabled }: RatingRowProps) => (
  <View className="mb-4">
    <Text className="text-sm text-foreground mb-2">{label}</Text>
    <View className="flex-row items-center gap-1">
      {[1, 2, 3, 4, 5].map((ratingValue) => (
        <TouchableOpacity
          key={ratingValue}
          onPress={() => onChange(ratingValue)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${label} ${ratingValue} stars`}
          className="p-1"
        >
          <Ionicons
            name={ratingValue <= (value ?? 0) ? 'star' : 'star-outline'}
            size={28}
            color={ratingValue <= (value ?? 0) ? '#f59e0b' : '#94a3b8'}
          />
        </TouchableOpacity>
      ))}
      <Text className="text-xs text-muted-foreground ml-2">
        {value ? `${value}/5` : 'Not rated'}
      </Text>
    </View>
  </View>
)

type ChoiceRowProps<T extends string> = {
  label: string
  value: T | null
  options: readonly ChoiceOption<T>[]
  onChange: (nextValue: T) => void
  disabled: boolean
}

const ChoiceRow = <T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: ChoiceRowProps<T>) => (
  <View className="mb-4">
    <Text className="text-sm text-foreground mb-2">{label}</Text>
    <View className="flex-row flex-wrap gap-2">
      {options.map((option) => {
        const selected = option.value === value
        return (
          <TouchableOpacity
            key={option.value}
            onPress={() => onChange(option.value)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${option.label}`}
            className={`rounded-full px-3 py-2 border ${
              selected
                ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950'
                : 'border-border bg-card'
            }`}
          >
            <Text
              className={`text-sm ${
                selected
                  ? 'text-blue-700 dark:text-blue-300'
                  : 'text-foreground'
              }`}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        )
      })}
    </View>
  </View>
)

export default function FeedbackScreen() {
  const { gameId: gameIdParam, source: sourceParam } = useLocalSearchParams<{
    gameId?: string | string[]
    source?: string | string[]
  }>()
  const { firebaseUser } = useAuth()
  const insets = useSafeAreaInsets()
  const gameId = Array.isArray(gameIdParam) ? gameIdParam[0] : gameIdParam
  const isGameFeedback = typeof gameId === 'string' && gameId.length > 0
  const source = Array.isArray(sourceParam) ? sourceParam[0] : sourceParam
  const feedbackSource =
    typeof source === 'string' && source.length > 0
      ? source
      : isGameFeedback
        ? 'game_end_notification'
        : 'settings'
  const [feedbackText, setFeedbackText] = useState('')
  const [funRating, setFunRating] = useState<number | null>(null)
  const [questionVolume, setQuestionVolume] = useState<QuestionVolume | null>(
    null
  )
  const [questionTiming, setQuestionTiming] = useState<QuestionTiming | null>(
    null
  )
  const [submitting, setSubmitting] = useState(false)
  const [errorText, setErrorText] = useState('')

  useEffect(() => {
    analytics.track('feedback_screen_opened', {
      source: 'client',
      feedback_source: feedbackSource,
      is_game_feedback: isGameFeedback,
      game_id: gameId || null,
    })
  }, [feedbackSource, gameId, isGameFeedback])

  const handleSubmit = async () => {
    const text = feedbackText.trim()
    if (!firebaseUser) {
      analytics.track('feedback_submit_validation_failed', {
        source: 'client',
        feedback_source: feedbackSource,
        reason: 'missing_auth',
        is_game_feedback: isGameFeedback,
        game_id: gameId || null,
      })
      setErrorText('You must be signed in to submit feedback.')
      return
    }
    if (
      isGameFeedback &&
      (!isValidRating(funRating) || !questionVolume || !questionTiming)
    ) {
      analytics.track('feedback_submit_validation_failed', {
        source: 'client',
        feedback_source: feedbackSource,
        reason: 'missing_game_feedback_fields',
        is_game_feedback: isGameFeedback,
        game_id: gameId || null,
      })
      setErrorText('Please complete all game feedback fields.')
      return
    }
    if (!isGameFeedback && !text) {
      analytics.track('feedback_submit_validation_failed', {
        source: 'client',
        feedback_source: feedbackSource,
        reason: 'missing_text',
        is_game_feedback: isGameFeedback,
        game_id: gameId || null,
      })
      setErrorText('Please enter feedback before submitting.')
      return
    }

    analytics.track('feedback_submit_clicked', {
      source: 'client',
      feedback_source: feedbackSource,
      is_game_feedback: isGameFeedback,
      game_id: gameId || null,
      has_text: text.length > 0,
      text_length: text.length,
      fun_rating: funRating ?? null,
      question_volume: questionVolume ?? null,
      question_timing: questionTiming ?? null,
    })

    setSubmitting(true)
    setErrorText('')

    try {
      const payload: FeedbackPayload = {}
      if (text) payload.text = text
      payload.submissionSource = feedbackSource
      if (isGameFeedback && gameId) {
        payload.gameId = gameId
        payload.funRating = funRating ?? undefined
        payload.questionVolume = questionVolume ?? undefined
        payload.questionTiming = questionTiming ?? undefined
      }

      const idToken = await firebaseUser.getIdToken()
      const resp = await fetch(`${env.DOMAIN}/api/feedback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const data = (await resp.json()) as FeedbackResponse
      if (!resp.ok) {
        throw new Error(data.error || `Request failed (${resp.status})`)
      }

      analytics.track('feedback_submit_succeeded', {
        source: 'client',
        feedback_source: feedbackSource,
        is_game_feedback: isGameFeedback,
        game_id: gameId || null,
        feedback_id: data.feedbackId || null,
      })
      toast.success('Feedback submitted. Thank you!')
      setFeedbackText('')
      router.back()
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to submit feedback right now.'
      analytics.track('feedback_submit_failed', {
        source: 'client',
        feedback_source: feedbackSource,
        is_game_feedback: isGameFeedback,
        game_id: gameId || null,
        error_message: message,
      })
      setErrorText(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: false,
        }}
      />
      <View className="flex-1 bg-white dark:bg-black">
        <View
          className="px-5 pb-4 border-b border-gray-300 dark:border-gray-800"
          style={{
            paddingTop: Platform.OS === 'android' ? insets.top + 12 : 20,
          }}
        >
          <View className="flex-row items-center gap-3">
            <TouchableOpacity
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Back"
              className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-900"
            >
              <Ionicons name="arrow-back" size={18} color="slategray" />
            </TouchableOpacity>
            <Text className="text-2xl font-bold text-gray-900 dark:text-white">
              Submit feedback
            </Text>
          </View>
        </View>

        <ScrollView
          className="flex-1 px-4"
          contentContainerStyle={{
            paddingTop: 16,
            paddingBottom: insets.bottom + 24,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View>
            <Text className="text-sm text-muted-foreground mb-2">
              {isGameFeedback
                ? 'Rate this game and share anything else you noticed.'
                : 'Tell us what is working, what is broken, or what you want to see next.'}
            </Text>

            {isGameFeedback ? (
              <View className="mb-4">
                <RatingRow
                  label="How fun was this game?"
                  value={funRating}
                  onChange={(value) => {
                    setFunRating(value)
                    if (errorText) setErrorText('')
                  }}
                  disabled={submitting}
                />
                <ChoiceRow
                  label="Were there too many questions?"
                  value={questionVolume}
                  options={QUESTION_VOLUME_OPTIONS}
                  onChange={(value) => {
                    setQuestionVolume(value)
                    if (errorText) setErrorText('')
                  }}
                  disabled={submitting}
                />
                <ChoiceRow
                  label="Did questions feel well-timed?"
                  value={questionTiming}
                  options={QUESTION_TIMING_OPTIONS}
                  onChange={(value) => {
                    setQuestionTiming(value)
                    if (errorText) setErrorText('')
                  }}
                  disabled={submitting}
                />
              </View>
            ) : null}

            <Textarea
              value={feedbackText}
              onChangeText={(value) => {
                setFeedbackText(value)
                if (errorText) setErrorText('')
              }}
              placeholder={
                isGameFeedback
                  ? 'Any other feedback about this game?'
                  : 'Type your feedback...'
              }
              editable={!submitting}
              maxLength={MAX_FEEDBACK_LENGTH}
              className="min-h-36"
            />
            <Text className="text-xs text-muted-foreground mt-2 text-right">
              {feedbackText.length}/{MAX_FEEDBACK_LENGTH}
            </Text>
            {errorText ? (
              <Text className="text-sm text-red-500 mt-2">{errorText}</Text>
            ) : null}
          </View>

          <Button
            onPress={handleSubmit}
            disabled={
              submitting ||
              (isGameFeedback
                ? !isValidRating(funRating) ||
                  !questionVolume ||
                  !questionTiming
                : !feedbackText.trim())
            }
          >
            {submitting ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text>Submit feedback</Text>
            )}
          </Button>
        </ScrollView>
      </View>
    </>
  )
}
