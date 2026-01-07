import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { QuestionAnswerModal } from '@/app/game/components/QuestionAnswerModal'
import { QuestionList } from '@/app/game/components/QuestionList'
import { analytics } from '@/lib/analytics'
import { useAuth } from '@/lib/contexts/AuthContext'
import {
  getPracticePredictionsStream,
  getPracticeQuestionsStream,
} from '@/lib/firebase'
import { createPracticeQuestion } from '@/lib/practice'
import { toast } from 'sonner-native'

export default function PracticeScreen() {
  const { user } = useAuth()
  const insets = useSafeAreaInsets()
  const [questions, setQuestions] = useState<Question[]>([])
  const [predictions, setPredictions] = useState<Map<string, string>>(new Map())
  const [selectedQuestion, setSelectedQuestion] = useState<Question | null>(
    null
  )
  const [starting, setStarting] = useState(false)

  const practiceGameId = user?.id ? `practice-${user.id}` : 'practice'

  // Auto-open the latest open question
  useEffect(() => {
    const latest = questions[questions.length - 1]
    if (!latest) {
      setSelectedQuestion(null)
      return
    }
    const expiresAt =
      (latest.timeoutAt as any)?.toMillis?.() ?? Number(latest.timeoutAt)
    const timedOut = Number.isFinite(expiresAt) && expiresAt <= Date.now()
    const alreadyAnswered = predictions.get(latest.id) !== undefined
    if (latest.state !== 'open' || timedOut || alreadyAnswered) {
      setSelectedQuestion(null)
    } else {
      setSelectedQuestion(latest)
    }
  }, [predictions, questions])

  // Subscribe to practice questions/predictions for this user
  useEffect(() => {
    if (!user?.id) return

    let unsubscribeQuestions: (() => void) | undefined
    let unsubscribePredictions: (() => void) | undefined

    const subscribe = async () => {
      unsubscribeQuestions = await getPracticeQuestionsStream(
        user.id,
        setQuestions
      )
      unsubscribePredictions = await getPracticePredictionsStream(
        user.id,
        setPredictions
      )
    }

    subscribe()

    return () => {
      if (unsubscribeQuestions) unsubscribeQuestions()
      if (unsubscribePredictions) unsubscribePredictions()
    }
  }, [user?.id])

  const handleStartPractice = useCallback(async () => {
    if (!user) {
      toast.error('You must be signed in to practice.')
      return
    }
    setStarting(true)
    try {
      await createPracticeQuestion()
      analytics.track('Practice Question Requested', { user_id: user.id })
    } catch (error: any) {
      console.error('Failed to send practice question:', error)
      Alert.alert(
        'Practice unavailable',
        error?.message || 'Unable to start practice right now.'
      )
    } finally {
      setStarting(false)
    }
  }, [user])

  return (
    <View className="flex-1 bg-white dark:bg-black">
      {/* Header */}
      <View
        className="flex flex-row items-center justify-between border-b border-gray-200 dark:border-gray-800 px-4"
        style={{ paddingTop: insets.top, height: 64 + insets.top }}
      >
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="slategray" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-gray-900 dark:text-white">
          Practice Mode
        </Text>
        <TouchableOpacity onPress={() => router.push('/settings')}>
          <Ionicons name="settings-outline" size={24} color="slategray" />
        </TouchableOpacity>
      </View>

      <ScrollView
        className="flex-1 px-4"
        contentContainerStyle={{
          paddingVertical: 20,
          paddingBottom: insets.bottom + 24,
          gap: 16,
        }}
      >
        <View className="bg-card rounded-lg p-4 border border-border">
          <Text className="text-base text-foreground mb-2">
            Tap below to trigger a practice question. You will get the normal
            interactive notification from the content extension, and your answer
            will appear in the list.
          </Text>
          <TouchableOpacity
            onPress={handleStartPractice}
            disabled={starting}
            className="bg-blue-500 rounded-lg px-4 py-3 items-center justify-center mt-2"
          >
            {starting ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-lg">
                Send Practice Question
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <View className="bg-card rounded-lg border border-border">
          <View className="px-4 py-3 border-b border-border">
            <Text className="text-base font-semibold text-foreground">
              Your practice answers
            </Text>
            <Text className="text-sm text-muted-foreground">
              Questions resolve right after you answer.
            </Text>
          </View>
          {questions.length === 0 ? (
            <View className="px-4 py-6">
              <Text className="text-muted-foreground">
                No practice questions yet. Send one to get started.
              </Text>
            </View>
          ) : (
            <View className="h-[520px]">
              <QuestionList
                questions={questions}
                predictions={predictions}
                userId={user?.id}
                onSelect={(q) => setSelectedQuestion(q)}
              />
            </View>
          )}
        </View>
      </ScrollView>

      <QuestionAnswerModal
        question={selectedQuestion}
        gameId={practiceGameId}
        userId={user?.id}
        isPractice
      />
    </View>
  )
}
