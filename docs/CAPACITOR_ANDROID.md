# GhostMesh — Capacitor / Android bridging guide

This document covers everything needed to take the web bundle and run it as a
native Android app with real Bluetooth LE, Wi-Fi Direct, biometric and
notification access.

## 1. Prerequisites

| Tool | Version |
|------|---------|
| Node | ≥ 20 |
| Android Studio | Ladybug (2024.2) or newer |
| Android SDK | compileSdk 35, minSdk 26, targetSdk 35 |
| JDK | 17 |
| Capacitor | 8.x (already in `package.json`) |

## 2. Create the Android project

```bash
npm install
npm run build                 # produces dist/
npx cap add android           # generates ./android (git-ignored)
```

`capacitor.config.ts` already sets `appId: io.ghostmesh.app`, `webDir: dist`,
`androidScheme: https` and the plugin options.

## 3. Copy the native sources

The custom native code is versioned under `android-src/` so it survives
`cap add` regenerating the project. Copy it in:

```bash
cp -r android-src/app/src/main/java/io/ghostmesh/app/* \
      android/app/src/main/java/io/ghostmesh/app/
```

Then merge the `<uses-permission>`, `<uses-feature>` and `<service>` entries
from `android-src/app/src/main/AndroidManifest.xml` into
`android/app/src/main/AndroidManifest.xml`.

Set `minSdkVersion = 26` in `android/variables.gradle` (BLE advertising /
Wi-Fi P2P DNS-SD are stable from API 26).

## 4. Plugin map

| Feature | Plugin | Where used |
|---------|--------|-----------|
| BLE central (scan / connect / GATT) | `@capacitor-community/bluetooth-le` | `src/mesh/transports/BleTransport.ts` |
| BLE peripheral (advertise GhostMesh GATT service) | custom `GhostMeshBlePeripheral` (Kotlin) | `android-src/.../BlePeripheralPlugin.kt` |
| Wi-Fi Direct discovery + sockets | custom `GhostMeshWifiDirect` (Kotlin) | `src/native/WifiDirectPlugin.ts` ↔ `WifiDirectPlugin.kt` |
| Biometrics | `@aparajita/capacitor-biometric-auth` | `src/native/Biometric.ts` |
| High-priority alerts | `@capacitor/local-notifications` + `@capacitor/haptics` | `src/native/Notifications.ts` |
| App lifecycle (re-lock on resume) | `@capacitor/app` | `src/hooks/useAppLifecycle.ts` |

### 4.1 Runtime permissions

Android 12+ requires runtime grants. The transports request them lazily:

* **BLE** — `BLUETOOTH_SCAN` (with `neverForLocation`), `BLUETOOTH_CONNECT`,
  `BLUETOOTH_ADVERTISE`. `BleClient.initialize({ androidNeverForLocation: true })`
  keeps location out of the flow.
* **Wi-Fi Direct** — `NEARBY_WIFI_DEVICES` on API 33+, otherwise
  `ACCESS_FINE_LOCATION`. Requested through `WifiDirect.requestPermissions()`.
* **Notifications** — `POST_NOTIFICATIONS` on API 33+ via
  `LocalNotifications.requestPermissions()`.

### 4.2 Wire protocol on native links

Both radios carry the same `MeshPacket` JSON envelope defined in
`src/types/index.ts`:

* **Wi-Fi Direct** — newline-delimited JSON over a TCP socket on port `47337`
  (group owner hosts a `ServerSocket`).
* **BLE** — packets split into `[seq:1][total:1][data ≤180B]` frames written to
  the `INBOX` characteristic (write-without-response) and received through
  `OUTBOX` notifications. Reassembly is done in `BleTransport.onFrame`.

UUIDs (must match on both sides):

```
Service  0000a1b2-0000-1000-8000-00805f9b34fb
ADVERT   0000a1b3-…   read/write  JSON PeerAdvert (public keys only)
INBOX    0000a1b4-…   write       inbound frames
OUTBOX   0000a1b5-…   notify      outbound frames
```

### 4.3 Transport fallback order

`MeshService.bootMesh()` builds the chain `[WifiDirect, BLE, Simulated]` on
native and `[Simulated]` on the web. Every available transport is started;
`MeshManager` prefers the strongest link per peer and falls back
automatically when a radio drops (`peerLost` → route table purge).

## 5. Background relaying

Declare a foreground service of type `connectedDevice` (already in the manifest
snippet) and start it from `MainActivity` when the mesh comes online so BLE
scanning and Wi-Fi P2P sockets survive the screen turning off. A minimal
`MeshRelayService` only needs to hold a wake-lock and show the persistent
"GhostMesh relay active" notification — all routing logic remains in the
WebView's JavaScript.

## 6. Security hardening

* `FLAG_SECURE` is set in `MainActivity` — no screenshots / recents preview.
* `webContentsDebuggingEnabled: false` and `cleartext: false` in the config.
* Add to `android/app/build.gradle` release config:
  `minifyEnabled true`, `shrinkResources true`, and enable
  [Play Integrity](https://developer.android.com/google/play/integrity) if you
  distribute through Play.
* Network security config: block all cleartext traffic
  (`<base-config cleartextTrafficPermitted="false" />`).

## 7. Build & run

```bash
npm run cap:sync     # build web + copy into android/
npm run cap:open     # open in Android Studio
# or
npm run cap:run      # build, sync and deploy to a connected device
```

For live-reload during development, set in `capacitor.config.ts`:

```ts
server: { url: 'http://<your-lan-ip>:5173', cleartext: true }
```

then `npm run dev` and `npx cap run android`. Remove it before shipping.

## 8. Testing the radios without two phones

* **BLE** — use the nRF Connect app on a second device to host a GATT server
  with the UUIDs above; GhostMesh will discover it and read `ADVERT`.
* **Wi-Fi Direct** — Android emulators do not support Wi-Fi P2P; use two
  physical devices. `adb logcat -s Capacitor/Plugin GhostMeshWifiDirect`
  shows plugin-level logs.
