import { Capacitor } from '@capacitor/core'

export const isNative = (): boolean => Capacitor.isNativePlatform()
export const platform = (): 'android' | 'ios' | 'web' => Capacitor.getPlatform() as 'android' | 'ios' | 'web'
export const hasPlugin = (name: string): boolean => Capacitor.isPluginAvailable(name)
