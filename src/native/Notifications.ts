/**
 * High-priority system notifications for the Security Bot.
 * Native: Capacitor LocalNotifications (Android channel with IMPORTANCE_HIGH).
 * Web:    Notification API when permitted; otherwise no-op (HUD panel still logs).
 */
import { isNative } from './platform'

let channelReady = false

export async function requestNotificationPermission(): Promise<boolean> {
  if (isNative()) {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    const r = await LocalNotifications.requestPermissions()
    if (!channelReady) {
      await LocalNotifications.createChannel({
        id: 'ghostmesh-security',
        name: 'Security alerts',
        description: 'Intrusion / tamper detection',
        importance: 5,
        visibility: 0, // secret on lock screen — never leak content
        vibration: true,
        lights: true,
        lightColor: '#ff2e4d',
      })
      channelReady = true
    }
    return r.display === 'granted'
  }
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return (await Notification.requestPermission()) === 'granted'
}

export async function fireSecurityNotification(title: string, body: string): Promise<void> {
  try {
    if (isNative()) {
      const { LocalNotifications } = await import('@capacitor/local-notifications')
      const { Haptics, NotificationType } = await import('@capacitor/haptics')
      await Haptics.notification({ type: NotificationType.Error }).catch(() => {})
      await LocalNotifications.schedule({
        notifications: [
          {
            id: Math.floor(Math.random() * 2 ** 31),
            title,
            body,
            channelId: 'ghostmesh-security',
            ongoing: false,
            autoCancel: true,
            smallIcon: 'ic_stat_ghostmesh',
          },
        ],
      })
      return
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/ghost.svg', tag: 'ghostmesh-security' })
    }
  } catch (e) {
    console.warn('[notify] failed', e)
  }
}
