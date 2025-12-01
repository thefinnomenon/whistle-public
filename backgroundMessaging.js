// Handle Notifee background events (action presses, dismissals) in headless mode
// if (!global.__notifeeBackgroundHandlerRegistered) {
//   global.__notifeeBackgroundHandlerRegistered = true

//   notifee.onBackgroundEvent(async ({ type, detail }) => {
//     console.log(
//       `[Notifee Background] Event type ${type} for notification ${detail.notification?.id}`
//     )

//     if (type === EventType.PRESS) {
//       // User tapped the body while app is not active; let foreground flow handle navigation on next launch.
//       return
//     }

//     // ACTION_PRESS / DISMISSED
//     try {
//       await handleNotificationEvent(type, detail, analytics, 'Background')
//     } catch (error) {
//       console.log('[Notifee Background] Failed to handle event', error)
//     }
//   })
// }
