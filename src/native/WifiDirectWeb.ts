/** Web stub: Wi-Fi Direct is not exposed to browsers. Every method reports unavailable. */
import { WebPlugin } from '@capacitor/core'
import type { WifiDirectPlugin } from './WifiDirectPlugin'

export class WifiDirectWeb extends WebPlugin implements WifiDirectPlugin {
  async isAvailable() {
    return { available: false }
  }
  async requestPermissions() {
    return { granted: false }
  }
  async startDiscovery() {
    throw this.unavailable('Wi-Fi Direct is only available on Android')
  }
  async stopDiscovery() {}
  async connect(): Promise<{ groupOwner: boolean; host: string; port: number }> {
    throw this.unavailable('Wi-Fi Direct is only available on Android')
  }
  async disconnect() {}
  async send(): Promise<{ bytes: number }> {
    throw this.unavailable('Wi-Fi Direct is only available on Android')
  }
}
