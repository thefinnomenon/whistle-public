'use client'

import { apiRequest } from '@/lib/api'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'

export default function NewQuestionPage() {
  const params = useParams()
  const router = useRouter()
  const gameId = params.id as string

  const [question, setQuestion] = useState('')
  const [choicesText, setChoicesText] = useState('Yes,No')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!question.trim()) {
      alert('Please enter a question')
      return
    }

    const parsedChoices = choicesText
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((value) => ({
        id: value.toLowerCase().replace(/\\s+/g, '-'),
        value,
      }))

    if (parsedChoices.length === 0) {
      alert('Please enter at least one choice')
      return
    }

    setLoading(true)

    try {
      const type = parsedChoices.length > 2 ? 'MULTIPLE_CHOICE' : 'YESNO'
      await apiRequest(`/api/games/${gameId}/questions`, {
        method: 'POST',
        body: {
          question: question.trim(),
          type,
          choices: parsedChoices,
          timeoutAt: (Date.now() + 30 * 1000).toString(),
        },
      })

      router.push(`/games/${gameId}`)
    } catch (error) {
      console.error('Error creating question:', error)
      alert('Failed to create question')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <Link href={`/games/${gameId}`} className="text-blue-600 hover:underline">
            ← Back to game
          </Link>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h1 className="text-3xl font-bold mb-6">Create Question</h1>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="question" className="block text-sm font-medium text-gray-700 mb-2">
                Question
              </label>
              <textarea
                id="question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g., Will the next play result in a touchdown?"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={3}
                disabled={loading}
              />
            </div>

            <div className="bg-gray-50 p-4 rounded">
              <div className="text-sm text-gray-600 mb-2">
                <label className="block font-medium mb-1">Choices (comma separated)</label>
                <input
                  type="text"
                  value={choicesText}
                  onChange={(e) => setChoicesText(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loading}
                />
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded">
              <div className="text-sm text-gray-600">
                <strong>Type:</strong> Yes/No
              </div>
              <div className="text-sm text-gray-600 mt-1">
                <strong>Choices:</strong> {choicesText}
              </div>
              <div className="text-sm text-gray-600 mt-1">
                <strong>State:</strong> Open (users can answer immediately)
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:bg-gray-400"
              >
                {loading ? 'Creating...' : 'Create Question'}
              </button>
              <Link
                href={`/games/${gameId}`}
                className="bg-gray-200 text-gray-700 px-6 py-2 rounded hover:bg-gray-300 inline-block"
              >
                Cancel
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
