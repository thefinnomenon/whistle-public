import { getIdToken as getIdTokenModular } from '@react-native-firebase/auth'
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
} from '@react-native-firebase/firestore'
import React, { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import Svg, { Circle } from 'react-native-svg'

import { analytics } from '@/lib/analytics'
import { env } from '@/lib/env'

type Props = {
  question: Question | null
  gameId: string
  userId?: string
}

export function QuestionAnswerModal({ question, gameId, userId }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [timeRemainingMs, setTimeRemainingMs] = useState(0)
  const [totalDurationMs, setTotalDurationMs] = useState(0)
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null)

  useEffect(() => {
    if (!question) return
    const timeoutMs =
      (question.timeoutAt as any)?.toMillis?.() ?? Number(question.timeoutAt)
    if (!Number.isFinite(timeoutMs)) return

    const startMs =
      (question.triggeredAt as any)?.toMillis?.() ??
      (question.createdAt as any)?.toMillis?.() ??
      Date.now()
    const total = Math.max(0, timeoutMs - startMs)
    setTotalDurationMs(total)

    const update = () => {
      const remaining = Math.max(0, timeoutMs - Date.now())
      setTimeRemainingMs(remaining)
    }
    update()
    const interval = setInterval(update, 100)
    return () => clearInterval(interval)
  }, [question])

  useEffect(() => {
    if (!question) {
      setSubmitting(false)
      setSelectedChoiceId(null)
    }
  }, [question])

  if (!question) return null

  const handleAnswer = async (answer: string) => {
    if (!userId) return

    setSelectedChoiceId(answer)
    setSubmitting(true)
    try {
      const authModule = await import('@react-native-firebase/auth')
      const currentUser = authModule.default().currentUser
      const idToken = currentUser
        ? await getIdTokenModular(currentUser)
        : undefined
      const apiUrl = `${env.DOMAIN}/api/games/${gameId}/questions/${question.id}/prediction`

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({
          prediction: answer,
          source: `${Platform.OS}-app`,
          questionTimeoutAt: Number(question.timeoutAt),
        }),
      })

      if (!resp.ok) {
        throw new Error(`API response ${resp.status}`)
      }

      const db = getFirestore()
      const userPredictionRef = doc(
        db,
        `users/${userId}/games/${gameId}/predictions/${question.id}`
      )

      await setDoc(userPredictionRef, {
        prediction: answer,
        source: 'app',
        createdAt: serverTimestamp(),
      })

      analytics.track('Prediction Made', {
        user_id: userId,
        game_id: gameId,
        question_id: question.id,
        prediction: answer,
        method: 'app',
      })
    } catch (error) {
      console.error('Failed to submit prediction:', error)
      Alert.alert('Error', 'Failed to submit prediction. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const canAnswer =
    question.state === 'open' && userId !== undefined && !submitting

  return (
    <Modal visible={!!question} transparent animationType="fade">
      <Pressable className="flex-1 bg-black/50 items-center justify-center">
        <Pressable className="bg-white dark:bg-gray-800 rounded-2xl p-6 mx-6 w-5/6 max-w-md">
          <Text className="text-xl font-bold text-gray-900 dark:text-white mb-4 text-center">
            {question.question}
          </Text>

          <View className="gap-3">
            <View className="items-center mb-2">
              <View className="w-20 h-20 items-center justify-center">
                <Svg width={80} height={80} viewBox="0 0 80 80">
                  <Circle
                    cx={40}
                    cy={40}
                    r={36}
                    stroke="#e5e7eb"
                    strokeWidth={4}
                    fill="none"
                  />
                  {totalDurationMs > 0 && (
                    <Circle
                      cx={40}
                      cy={40}
                      r={36}
                      stroke={
                        timeRemainingMs <= 5000
                          ? '#ef4444'
                          : timeRemainingMs <= 15000
                            ? '#f59e0b'
                            : '#3b82f6'
                      }
                      strokeWidth={4}
                      fill="none"
                      strokeDasharray={2 * Math.PI * 36}
                      strokeDashoffset={
                        2 *
                        Math.PI *
                        36 *
                        (1 -
                          Math.max(
                            0,
                            Math.min(1, timeRemainingMs / totalDurationMs)
                          ))
                      }
                      strokeLinecap="round"
                    />
                  )}
                </Svg>
                <View className="absolute inset-0 items-center justify-center">
                  <Text className="text-lg font-bold text-gray-900 dark:text-white">
                    {Math.max(0, Math.floor(timeRemainingMs / 1000))}
                  </Text>
                </View>
              </View>
            </View>

            {question.choices.map((choice: any) => {
              const choiceId = typeof choice === 'string' ? choice : choice.id
              const label = typeof choice === 'string' ? choice : choice.value
              const isSelected = submitting && selectedChoiceId === choiceId
              return (
                <TouchableOpacity
                  key={choiceId}
                  className={`py-4 px-6 rounded-lg ${
                    submitting ? 'bg-blue-300' : 'bg-blue-500'
                  }`}
                  onPress={() =>
                    !submitting && canAnswer && handleAnswer(choiceId)
                  }
                  disabled={submitting || !canAnswer}
                >
                  <View className="flex-row items-center justify-center gap-2">
                    {isSelected && <ActivityIndicator color="#fff" />}
                    <Text className="text-white font-bold text-lg text-center">
                      {label}
                    </Text>
                  </View>
                </TouchableOpacity>
              )
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
