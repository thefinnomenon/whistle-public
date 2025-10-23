import { Ionicons } from '@expo/vector-icons'
import { getApp } from '@react-native-firebase/app'
import { getFunctions, httpsCallable } from '@react-native-firebase/functions'
import * as Linking from 'expo-linking'
import { router } from 'expo-router'
import { Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useAuth } from '@/lib/contexts/AuthContext'
import { useTheme } from '@/lib/contexts/ThemeContext'

export default function SettingsScreen() {
  const { user } = useAuth()
  const { theme, setTheme, colorScheme } = useTheme()
  const insets = useSafeAreaInsets()

  const winnings = user?.winnings || 0
  const canWithdraw = winnings >= 10

  const handleWithdraw = async () => {
    const subject = encodeURIComponent('Withdrawal Request - Whistle')
    const body = encodeURIComponent(
      `Hi,

I would like to withdraw my winnings from Whistle.

Username: ${user?.username}
Email: ${user?.email}
Amount: $${winnings.toFixed(2)}

Payment Information:
[Please provide your preferred payment method and details here]

Thank you!`
    )
    const email = 'configure@example.com'
    const mailtoUrl = `mailto:${email}?subject=${subject}&body=${body}`

    try {
      const canOpen = await Linking.canOpenURL(mailtoUrl)
      if (canOpen) {
        await Linking.openURL(mailtoUrl)
      } else {
        Alert.alert(
          'Email Not Available',
          `Please send a withdrawal request to ${email} with the following details:\n\nUsername: ${user?.username}\nEmail: ${user?.email}\nAmount: $${winnings.toFixed(2)}`
        )
      }
    } catch {
      Alert.alert(
        'Email Not Available',
        `Please send a withdrawal request to ${email} with the following details:\n\nUsername: ${user?.username}\nEmail: ${user?.email}\nAmount: $${winnings.toFixed(2)}`
      )
    }
  }

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      {
        text: 'Cancel',
        style: 'cancel',
      },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          router.replace('/signout')
        },
      },
    ])
  }

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'Are you sure you want to delete your account? This action cannot be undone. Your account and all associated data will be permanently deleted, and any winnings that you have not withdrawn will be forfeited.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: () => {
            router.replace('/signout?deleteAccount=true')
          },
        },
      ]
    )
  }

  const handleTestNotification = async () => {
    try {
      const app = getApp()
      const functions = getFunctions(app, 'us-east1')
      const testPush = httpsCallable(functions, 'testPushNotification')
      await testPush()
      Alert.alert('Success', 'Test notification sent! Check your device.')
    } catch (error) {
      console.error('Failed to send test notification:', error)
      Alert.alert('Error', 'Failed to send test notification')
    }
  }

  return (
    <View className="flex-1 bg-white dark:bg-black">
      {/* Header */}
      <View
        className="flex flex-row items-center justify-between border-b border-gray-300 dark:border-gray-800 px-4"
        style={{ paddingTop: insets.top, height: 64 + insets.top }}
      >
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="slategray" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-gray-900 dark:text-white">
          Settings
        </Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Content */}
      <ScrollView
        className="flex-1 px-4"
        contentContainerStyle={{
          paddingVertical: 24,
          paddingBottom: insets.bottom + 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Account Section */}
        <View className="mb-6">
          <Text className="text-sm font-semibold text-muted-foreground mb-3">
            ACCOUNT
          </Text>
          <View className="bg-card rounded-lg overflow-hidden border border-border">
            <View className="px-4 py-3 border-b border-border">
              <Text className="text-xs text-muted-foreground">Username</Text>
              <Text className="text-base text-foreground mt-1">
                {user?.username || 'Not set'}
              </Text>
            </View>
            <View className="px-4 py-3">
              <Text className="text-xs text-muted-foreground">Email</Text>
              <Text className="text-base text-foreground mt-1">
                {user?.email || 'Not set'}
              </Text>
            </View>
          </View>
        </View>

        {/* Winnings Section */}
        <View className="mb-6">
          <Text className="text-sm font-semibold text-muted-foreground mb-3">
            WINNINGS
          </Text>
          <View className="bg-card rounded-lg p-4 border border-border">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-sm text-muted-foreground">
                Total Winnings
              </Text>
              <Text className="text-3xl font-bold text-foreground">
                ${winnings.toFixed(2)}
              </Text>
            </View>
            <TouchableOpacity
              onPress={handleWithdraw}
              disabled={!canWithdraw}
              className={`rounded-lg px-4 py-3 flex-row items-center justify-center ${
                canWithdraw
                  ? 'bg-green-600 dark:bg-green-500'
                  : 'bg-gray-300 dark:bg-gray-700'
              }`}
            >
              <Text
                className={`text-base font-semibold ${
                  canWithdraw
                    ? 'text-white'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {canWithdraw ? 'Withdraw' : 'Minimum $10 to Withdraw'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Preferences Section */}
        <View className="mb-6">
          <Text className="text-sm font-semibold text-muted-foreground mb-3">
            PREFERENCES
          </Text>
          <View className="bg-card rounded-lg overflow-hidden border border-border">
            <TouchableOpacity
              onPress={() => {
                if (theme === 'light') setTheme('dark')
                else if (theme === 'dark') setTheme('system')
                else setTheme('light')
              }}
              className="px-4 py-4 flex-row items-center justify-between"
            >
              <View className="flex-row items-center gap-3">
                <Ionicons
                  name={
                    colorScheme === 'dark' ? 'moon-outline' : 'sunny-outline'
                  }
                  size={20}
                  color="slategray"
                />
                <Text className="text-base text-foreground">Appearance</Text>
              </View>
              <View className="flex-row items-center gap-2">
                <Text className="text-sm text-muted-foreground">
                  {theme === 'system'
                    ? 'Auto'
                    : theme === 'dark'
                      ? 'Dark'
                      : 'Light'}
                </Text>
                <Ionicons name="chevron-forward" size={20} color="slategray" />
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Actions Section */}
        <View className="mb-6">
          <Text className="text-sm font-semibold text-muted-foreground mb-3">
            ACTIONS
          </Text>
          <TouchableOpacity
            onPress={handleSignOut}
            className="bg-card rounded-lg px-4 py-4 flex-row items-center justify-between border border-border"
          >
            <Text className="text-base text-foreground">Sign Out</Text>
            <Ionicons name="log-out-outline" size={20} color="slategray" />
          </TouchableOpacity>
        </View>

        {/* Danger Zone */}
        <View className="mb-6">
          <Text className="text-sm font-semibold text-muted-foreground mb-3">
            DANGER ZONE
          </Text>
          <TouchableOpacity
            onPress={handleDeleteAccount}
            className="border border-red-600 dark:border-red-400 rounded-lg px-4 py-4 flex-row items-center justify-center"
          >
            <Text className="text-base text-red-600 dark:text-red-400">
              Delete Account
            </Text>
          </TouchableOpacity>
        </View>

        {/* App Info */}
        <View className="items-center">
          <Text className="text-xs text-muted-foreground">Whistle v1.0.0</Text>
        </View>
      </ScrollView>
    </View>
  )
}
