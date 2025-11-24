import { useEffect } from 'react'
import { router } from 'expo-router'
import { View } from 'react-native'

export default function Index() {
  useEffect(() => {
    // The AuthGate in _layout.tsx will handle all redirects
    // This component should never actually be visible
  }, [])

  return <View />
}
