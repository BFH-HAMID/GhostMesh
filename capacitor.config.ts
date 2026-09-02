import type { CapacitorConfig } from '@capacitor/cli'

/**
 * GhostMesh Capacitor configuration.
 *
 * The web bundle (dist/) is embedded in the Android shell. Mesh transports
 * (BLE / Wi-Fi Direct) are exposed through native plugins declared in
 * android/ — see docs/CAPACITOR_ANDROID.md for the full bridging guide.
 */
const config: CapacitorConfig = {
  appId: 'io.ghostmesh.app',
  appName: 'GhostMesh',
  webDir: 'dist',
  backgroundColor: '#050a10',
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    // Local-only bundle; no remote server is ever loaded.
  },
  server: {
    androidScheme: 'https',
    cleartext: false,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_ghostmesh',
      iconColor: '#00f3ff',
      sound: 'ghost_alert.wav',
    },
    BluetoothLe: {
      displayStrings: {
        scanning: 'Scanning mesh radio range…',
        cancel: 'Abort',
        availableDevices: 'Nearby ghost nodes',
        noDeviceFound: 'No nodes in range',
      },
    },
    BiometricAuthNative: {
      allowDeviceCredential: true,
    },
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#050a10',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
  },
}

export default config
