import { Feather } from '@expo/vector-icons'
import React from 'react'
import { Text, TouchableOpacity, View, useColorScheme } from 'react-native'

export type QuestionListItemProps = {
  question: Question
  prediction?: string
  userId?: string
  onSelect?: (question: Question) => void
}

export const resolveChoiceLabel = (question: Question, choiceId: string) => {
  const match = question.choices.find((c: any) =>
    typeof c === 'string'
      ? c === choiceId
      : c.id === choiceId || c.value === choiceId
  )
  if (!match) return choiceId
  return typeof match === 'string' ? match : match.value
}

export function QuestionListItem({
  question,
  prediction,
  userId,
  onSelect,
}: QuestionListItemProps) {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === 'dark'

  let questionState: UserQuestionState = question.state
  if (question.state === 'resolved' && prediction === undefined)
    questionState = 'incorrect'
  else if (question.state === 'resolved' && prediction !== undefined)
    questionState =
      prediction === (question.answer ?? '') ? 'correct' : 'incorrect'

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
    question.state === 'open' && prediction === undefined && !!userId

  const content = (
    <View className={`flex flex-row items-center p-6 ${questionStyling.bg}`}>
      <Feather
        name={questionStyling.icon as any}
        size={24}
        color={questionStyling.iconColor}
      />
      <View className="flex-1 flex-row justify-between bg-transparent">
        <Text className={`ml-4 ${questionStyling.text}`}>
          {question.question}
        </Text>
        {prediction !== undefined && (
          <Text className={`${questionStyling.text} text-md font-bold ml-2`}>
            {resolveChoiceLabel(question, prediction)}
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
