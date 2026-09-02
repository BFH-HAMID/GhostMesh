/**
 * Biometric gate — wraps @aparajita/capacitor-biometric-auth.
 * On web (no biometric hardware bridge) it falls back to a passphrase prompt
 * handled by the LockScreen component.
 */
import { isNative } from './platform'

export type BiometryResult =
  | { ok: true; method: 'biometric' | 'device-credential' | 'web-fallback' }
  | { ok: false; reason: string }

export async function biometricAvailable(): Promise<boolean> {
  if (!isNative()) return false
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth')
    const info = await BiometricAuth.checkBiometry()
    return info.isAvailable
  } catch {
    return false
  }
}

export async function authenticateBiometric(): Promise<BiometryResult> {
  if (!isNative()) return { ok: false, reason: 'no-native-bridge' }
  try {
    const { BiometricAuth, AndroidBiometryStrength } = await import('@aparajita/capacitor-biometric-auth')
    await BiometricAuth.authenticate({
      reason: 'Unlock GhostMesh',
      cancelTitle: 'Abort',
      allowDeviceCredential: true,
      androidTitle: 'GhostMesh // Identity check',
      androidSubtitle: 'Biometric required to decrypt local vault',
      androidConfirmationRequired: false,
      androidBiometryStrength: AndroidBiometryStrength.strong,
    })
    return { ok: true, method: 'biometric' }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'biometric-failed' }
  }
}
