import { Feather } from '@expo/vector-icons'
import React from 'react'
import { Text, TouchableOpacity, View, useColorScheme } from 'react-native'

import { getQuestionPoints } from '@/lib/questionPoints'

export type QuestionListItemProps = {
  question: Question
  prediction?: string
  userId?: string
  onSelect?: (question: Question) => void
}

export const resolveChoiceLabel = (question: Question, choiceId: string) => {
  const match = question.choices.find(
    (choice) => choice.id === choiceId || choice.value === choiceId
  )
  if (!match) return choiceId
  return match.value
}

export function QuestionListItem({
  question,
  prediction,
  userId,
  onSelect,
}: QuestionListItemProps) {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'

  const predictionValue =
    prediction === undefined ? undefined : String(prediction)
  const answerValue =
    question.answer === undefined ? undefined : String(question.answer)
  const resolvedLabel =
    question.state === 'resolved' && answerValue !== undefined
      ? resolveChoiceLabel(question, answerValue)
      : null
  const timeoutAt =
    (question.timeoutAt as any)?.toMillis?.() ?? Number(question.timeoutAt)
  const timedOut = Number.isFinite(timeoutAt) && timeoutAt <= Date.now()

  let questionState: UserQuestionState = question.state
  if (question.state === 'resolved' && predictionValue === undefined)
    questionState = 'incorrect'
  else if (question.state === 'resolved' && predictionValue !== undefined) {
    questionState =
      predictionValue === (answerValue ?? '') ? 'correct' : 'incorrect'
  }
  if (questionState === 'open' && timedOut) questionState = 'closed'

  let questionStyling = { bg: '', text: '', icon: '', iconColor: '' }
  switch (questionState) {
    case 'open':
      questionStyling = {
        bg: 'bg-white dark:bg-gray-800',
        text: 'text-slate-600 dark:text-slate-300',
        icon: 'clock',
        iconColor: isDark ? '#e5e7eb' : 'black',
      }
      break
    case 'closed':
      questionStyling = {
        bg: 'bg-slate-200 dark:bg-slate-700',
        text: 'text-slate-900 dark:text-slate-100',
        icon: 'help-circle',
        iconColor: 'gray',
      }
      break
    case 'correct':
      questionStyling = {
        bg: 'bg-green-200 dark:bg-green-900',
        text: 'text-green-900 dark:text-green-100',
        icon: 'check-circle',
        iconColor: 'green',
      }
      break
    case 'incorrect':
      questionStyling = {
        bg: 'bg-red-200 dark:bg-red-900',
        text: 'text-red-900 dark:text-red-100',
        icon: 'x-circle',
        iconColor: 'red',
      }
      break
    case 'cancelled':
      questionStyling = {
        bg: 'bg-gray-100 dark:bg-gray-800',
        text: 'text-gray-400 dark:text-gray-500',
        icon: 'slash',
        iconColor: isDark ? '#6b7280' : '#d1d5db',
      }
  }

  const canAnswer =
    question.state === 'open' &&
    !timedOut &&
    prediction === undefined &&
    !!userId

  const content = (
    <View className={`flex flex-row items-start p-6 ${questionStyling.bg}`}>
      <Feather
        name={questionStyling.icon as any}
        size={24}
        color={questionStyling.iconColor}
      />
      <View className="flex-1 ml-4 bg-transparent">
        <Text className={`${questionStyling.text}`}>{question.question}</Text>
        <Text className={`${questionStyling.text} text-xs mt-1 font-semibold`}>
          {questionState === 'correct' ? '+' : ''}
          {getQuestionPoints(question)} pts
        </Text>
        {(prediction !== undefined || resolvedLabel) && (
          <Text className={`${questionStyling.text} text-md mt-2`}>
            {prediction !== undefined ? (
              questionState === 'correct' ? (
                <Text className="font-bold">
                  {resolveChoiceLabel(question, prediction)}
                </Text>
              ) : questionState === 'incorrect' ? (
                <Text className="line-through">
                  {resolveChoiceLabel(question, prediction)}
                </Text>
              ) : (
                <Text className="font-bold">
                  {resolveChoiceLabel(question, prediction)}
                </Text>
              )
            ) : null}
            {questionState === 'incorrect' && resolvedLabel ? '  ·  ' : null}
            {questionState === 'incorrect' && resolvedLabel ? (
              <Text className="font-bold">{resolvedLabel}</Text>
            ) : prediction === undefined && resolvedLabel ? (
              <Text className="font-bold">{resolvedLabel}</Text>
            ) : null}
          </Text>
        )}
      </View>
    </View>
  )

  if (!canAnswer) return content

  return (
    <TouchableOpacity onPress={() => onSelect?.(question)}>
      {content}
    </TouchableOpacity>
  )
}
