import { Ionicons } from '@expo/vector-icons'
import { router, Stack } from 'expo-router'
import {
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

type RuleSection = {
  title: string
  paragraphs: string[]
  bullets?: string[]
}

const RULES: RuleSection[] = [
  {
    title: '1. Sponsor',
    paragraphs: ['Configure your own competition sponsor and contact details.'],
  },
  {
    title: '2. Eligibility',
    paragraphs: ['The Competition is open to individuals who:'],
    bullets: [
      'Are at least 18 years old;',
      'Have a valid Whistle account;',
      'Reside in eligible countries as permitted by law.',
      'Employees, contractors, affiliates, and immediate family members of Finnternet LLC are not eligible.',
      'Participation is void where prohibited by law.',
    ],
  },
  {
    title: '3. No Purchase Necessary',
    paragraphs: [
      'No purchase, payment, or subscription is required to participate in or to win this Competition. Participation is free.',
    ],
  },
  {
    title: '4. Competition Period',
    paragraphs: [
      'Each Competition Period begins at 12:00 AM EST on Monday and ends at 11:59 PM EST on Sunday of the same week.',
      'Finnternet LLC reserves the right to modify Competition dates or times at its discretion.',
    ],
  },
  {
    title: '5. How to Enter',
    paragraphs: ['To enter the Competition, users must:'],
    bullets: [
      'Participate in prediction games within the Whistle app during the Competition Period.',
      'Submit predictions for at least 50% of eligible game questions in a session to qualify.',
      'There is no random drawing or chance-based selection for prizes. Winners are determined solely on skill-based performance.',
    ],
  },
  {
    title: '6. Competition Format (Skill-Based)',
    paragraphs: [
      'Participants earn points based on the accuracy of their predictions, as calculated by the Whistle app.',
      'At the end of the Competition Period, the participant(s) with the highest total points will be declared the Competition winner(s).',
      'If two or more participants are tied for the highest score, the total prize will be equally divided among all tied winners.',
      'No luck or chance component is involved. All results are based on in-app performance.',
    ],
  },
  {
    title: '7. Prize',
    paragraphs: [
      'A total prize of $50 USD will be awarded per Competition Period.',
    ],
    bullets: [
      'If there is a single winner, they will receive the full amount.',
      'If multiple winners are tied for first place, the prize will be split evenly among them.',
      'Prizes will be delivered via [payment method - e.g., PayPal, Venmo, bank transfer].',
      'Prizes are non-transferable. Winners are responsible for any applicable taxes or reporting requirements.',
    ],
  },
  {
    title: '8. Winner Notification',
    paragraphs: [
      'Winners will be notified within 72 hours after the Competition Period ends via:',
    ],
    bullets: [
      'An in-app notification;',
      'Email, if provided.',
      'If a winner does not respond within 7 days, Finnternet LLC may award the prize to the next highest scorer.',
    ],
  },
  {
    title: '9. Disqualification',
    paragraphs: ['Finnternet LLC may disqualify any participant who:'],
    bullets: [
      'Uses automation, bots, or cheating tools;',
      'Attempts to manipulate results;',
      'Violates the Whistle Terms of Service or these Official Rules.',
      'Decisions by Finnternet LLC are final.',
    ],
  },
  {
    title: '10. Limitation of Liability',
    paragraphs: [
      'Finnternet LLC is not responsible for technical failures, service outages, delayed entries, lost data, or other issues that may prevent participation.',
    ],
  },
  {
    title: '11. Publicity',
    paragraphs: [
      'By participating, users consent to the publication of their username and rank by the Sponsor only as necessary to administer the Competition.',
    ],
  },
  {
    title: '12. Governing Law',
    paragraphs: [
      'These Official Rules are governed by the laws of the United States of America. Any dispute arising from this Competition will be resolved under those laws.',
    ],
  },
]

export default function CompetitionRulesScreen() {
  const insets = useSafeAreaInsets()

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
              Competition Rules
            </Text>
          </View>
        </View>
        <ScrollView
          className="flex-1 px-4"
          contentContainerStyle={{
            paddingVertical: 16,
            paddingBottom: insets.bottom + 24,
          }}
          showsVerticalScrollIndicator={false}
        >
          <Text className="text-base font-semibold text-foreground mb-4">
            Whistle Weekly Skill Competition - Official Rules
          </Text>
          {RULES.map((section) => (
            <View key={section.title} className="mb-5">
              <Text className="text-base font-semibold text-foreground mb-2">
                {section.title}
              </Text>
              {section.paragraphs.map((paragraph) => (
                <Text
                  key={`${section.title}-${paragraph}`}
                  className="text-sm text-muted-foreground mb-2"
                >
                  {paragraph}
                </Text>
              ))}
              {section.bullets?.map((bullet) => (
                <Text
                  key={`${section.title}-${bullet}`}
                  className="text-sm text-muted-foreground mb-1"
                >
                  - {bullet}
                </Text>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </>
  )
}
