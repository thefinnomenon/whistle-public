import React from 'react'
import { FlashList } from '@shopify/flash-list'

import { QuestionListItem } from './QuestionListItem'

type Props = {
  questions: Question[]
  predictions: Map<string, string>
  userId?: string
  onSelect: (question: Question) => void
}

export function QuestionList({
  questions,
  predictions,
  userId,
  onSelect,
}: Props) {
  return (
    <FlashList
      data={questions}
      renderItem={({ item }) => (
        <QuestionListItem
          question={item}
          prediction={predictions.get(item.id)}
          userId={userId}
          onSelect={onSelect}
        />
      )}
      extraData={[predictions, userId]}
    />
  )
}
