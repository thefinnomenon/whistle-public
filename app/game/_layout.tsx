import { Stack } from 'expo-router'

import { GameProvider } from '@/lib/contexts/GameContext'

export default function GameLayout() {
  return (
    <GameProvider>
      <Stack>
        <Stack.Screen name="lobby" options={{ headerShown: false }} />
        <Stack.Screen
          name="leaderboard"
          options={{ title: 'Leaderboard', presentation: 'modal' }}
        />
        <Stack.Screen
          name="index"
          options={{ headerShown: false, gestureEnabled: false }}
        />
      </Stack>
    </GameProvider>
  )
}
