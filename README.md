# GhostMesh

**Decentralized stealth mesh messenger** — end-to-end encrypted, self-destructing
messaging over an opportunistic peer-to-peer mesh (Internet ➜ Wi-Fi Direct ➜
Bluetooth LE), wrapped in a cyberpunk holographic HUD with a live 3D globe of
the network. Runs in the browser (React + Vite) and on Android (Capacitor).

```
 ┌────────────────────────────────────────────────────────────────┐
 │  React 19 · TypeScript (strict) · Tailwind v4 · R3F/Three.js   │
 │  Zustand · Web Crypto + tweetnacl · Web Workers · IndexedDB    │
 │  Capacitor 8 (BLE · Wi-Fi Direct · Biometrics · Notifications) │
 └────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173  (simulated mesh swarm)
npm test           # vitest — crypto, security bot, mesh routing
npm run build      # type-check + production bundle
```

Enter any callsign + passphrase (≥ 6 chars) on the lock screen. On the web the
mesh is populated by a **simulated swarm** of peers with real Ed25519/X25519
keys so every code path (handshake, signing, routing, ACKs, threat detection)
runs for real. On Android the radio transports come first.

## Feature map

| Module | Implementation |
|--------|----------------|
| **A · E2EE** | `src/crypto/E2EECore.ts` — Ed25519 identity & packet signatures, X25519 → HKDF-SHA256 → **AES-256-GCM** sessions, RSA-4096-OAEP key wrapping. `E2EEWorker.ts` keeps all secrets inside a dedicated Web Worker; `E2EEClient.ts` is the typed facade. |
| **A · Self-destruct** | `hooks/useSelfDestruct.ts` + `components/SelfDestructChat.tsx` — per-message TTL fuse bars; expiry purges React state, Zustand and the encrypted IndexedDB vault (`services/VaultStorage.ts`). TTL travels inside the ciphertext so the receiver burns on the same schedule. |
| **A · Biometrics** | `native/Biometric.ts` + `components/LockScreen.tsx` — fingerprint/face via Capacitor on Android, passphrase fallback on web, auto re-lock on background (`hooks/useAppLifecycle.ts`). |
| **B · Hybrid mesh** | `mesh/Transport.ts` abstraction; `transports/WifiDirectTransport.ts`, `BleTransport.ts` (GATT framing/reassembly), `SimulatedTransport.ts`. `mesh/MeshManager.ts` does discovery, handshakes, next-hop routing, relaying with loop/TTL guards, ACK tracking. |
| **B · Node discovery → globe** | `components/MeshMap.tsx` — R3F wireframe Earth, nodes at lat/lon, expanding neon **ping rings** for new peers, great-circle route arcs, click-to-chat. |
| **C · Security bot** | `services/SecurityBot.ts` — sliding-window heuristics: invalid signature, replay, brute-force handshakes, floods, GCM tamper, TTL abuse, key substitution (MITM). Auto block/rate-limit, redacted HUD log (`components/SecurityPanel.tsx`), OS notifications (`native/Notifications.ts`). Red-team buttons let you trigger attacks live. |
| **C · Analytics** | `services/AnalyticsEngine.ts` — 1 Hz samples of RX/TX bytes, loss, RTT, avg hops, node count; rendered as live SVG graphs in `components/DiagnosticsDashboard.tsx`. |
| **D · Chunked files** | `MeshManager.sendFile()` — file → 32 KiB `Uint8Array` chunks, each AES-256-GCM encrypted with a per-file key and AAD-bound to `(transferId, index)`; chunks striped across up to 4 relay paths; per-file key delivered only over the E2EE channel. |
| **D · AMOLED / Neon HUD** | `styles/index.css` — `data-theme="amoled"` (pure `#000000`, no glow, low DPR, slow rotation) vs `data-theme="neon-hud"` (holographic panels, scanlines, glow). Toggle in the header. |

## Project layout

```
src/
├── components/   MeshMap · SelfDestructChat · HudShell · LockScreen · SecurityPanel
│                 DiagnosticsDashboard · NodeList · Sparkline
├── crypto/       E2EECore · E2EEWorker · E2EEClient · encoding
├── mesh/         MeshManager · Transport · transports/{Simulated,Ble,WifiDirect}
├── services/     MeshService (wiring) · SecurityBot · AnalyticsEngine · VaultStorage
├── native/       Biometric · Notifications · WifiDirectPlugin(+Web) · platform
├── store/        useGhostStore (Zustand)
├── hooks/        useSelfDestruct · useTheme · useAppLifecycle
├── styles/       index.css (Tailwind v4 theme)
└── types/        shared domain types
android-src/      Kotlin plugins (Wi-Fi Direct, BLE peripheral) + manifest additions
docs/             CAPACITOR_ANDROID.md — full Android bridging guide
```

## Android

See **[docs/CAPACITOR_ANDROID.md](docs/CAPACITOR_ANDROID.md)** for the
step-by-step: `npx cap add android`, copying the Kotlin plugins from
`android-src/`, permissions, GATT UUIDs, the Wi-Fi Direct socket protocol,
foreground relay service and hardening flags.

```bash
npm run cap:sync   # build + sync
npm run cap:open   # open Android Studio
```

## Security notes

* Private keys never leave the E2EE worker; `PANIC` wipes keys, sessions and the vault.
* Packet signatures cover `id|type|from|to|timestamp|iv|payload`; mutable routing
  fields (`ttl`, `hopCount`, `path`) are excluded so relays can forward without
  re-signing but cannot alter content.
* Ciphertext AAD binds each message to `(id, from, to)` — spliced packets fail GCM.
* Coordinates are fuzzed before being advertised; only coarse location is used.
* This is a reference architecture, not an audited product. Do not rely on it for
  life-safety communications without an independent review.

## License

GPL-3.0 — see [LICENSE](LICENSE).
