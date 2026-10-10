/**
 * MeshMap — real-time interactive 3D globe of the mesh (React Three Fiber).
 *
 *  • Wireframe holographic Earth + faint atmosphere shell
 *  • Every MeshNode is placed at its lat/lon; the local node is purple,
 *    trusted peers cyan, handshaking amber, blocked red.
 *  • New peers get an expanding neon "ping" ring for ~3 s.
 *  • Routing topology is drawn as great-circle arcs (self ➜ neighbour and
 *    relay ➜ destination for multi-hop routes).
 *  • Click a node to open its conversation.
 *
 * Power: in AMOLED mode we cap DPR to 1, drop the stars and slow auto-rotate.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Html, Line, OrbitControls, Stars } from '@react-three/drei'
import * as THREE from 'three'
import { useGhostStore, selectPeers, useShallow } from '@/store/useGhostStore'
import type { MeshNode } from '@/types'

const R = 2
const CYAN = '#00f3ff'
const PURPLE = '#b000ff'
const AMBER = '#ffb300'
const RED = '#ff2e4d'

function latLonToVec3(lat: number, lon: number, r = R): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - lat)
  const theta = THREE.MathUtils.degToRad(lon + 180)
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
}

/** Points along a great-circle arc lifted above the surface. */
function arcPoints(a: THREE.Vector3, b: THREE.Vector3, segments = 32): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  const angle = a.angleTo(b)
  const lift = 0.15 + angle * 0.35
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const p = new THREE.Vector3().copy(a).lerp(b, t).normalize()
    const h = R + Math.sin(Math.PI * t) * lift
    pts.push(p.multiplyScalar(h))
  }
  return pts
}

const SIM = '#6b7f96'

const nodeColor = (n: MeshNode) =>
  n.isSelf ? PURPLE : n.status === 'blocked' ? RED : n.transport === 'simulated' ? SIM : n.status === 'trusted' ? CYAN : AMBER

/** Short tag shown next to a node so fake/demo nodes can never pass as real ones. */
const nodeTag = (n: MeshNode) => (n.isSelf ? 'YOU' : n.transport === 'simulated' ? 'SIM' : n.transport === 'local' ? 'TAB' : n.transport.toUpperCase())

/* ------------------------------------------------------------------------ */

/**
 * The globe itself does NOT spin. Markers are positioned in fixed lat/lon
 * space, so if the sphere rotated they would drift away from their real
 * locations. The camera orbits instead (OrbitControls autoRotate).
 */
function Globe({ lowPower }: { lowPower: boolean }) {
  return (
    <group>
      <mesh>
        <sphereGeometry args={[R - 0.01, 48, 48]} />
        <meshBasicMaterial color="#03070c" transparent opacity={0.92} />
      </mesh>
      <mesh>
        <sphereGeometry args={[R, lowPower ? 24 : 40, lowPower ? 24 : 40]} />
        <meshBasicMaterial color={CYAN} wireframe transparent opacity={lowPower ? 0.2 : 0.25} />
      </mesh>
      {!lowPower && (
        <mesh>
          <sphereGeometry args={[R + 0.12, 32, 32]} />
          <meshBasicMaterial color={PURPLE} transparent opacity={0.05} side={THREE.BackSide} />
        </mesh>
      )}
      {/* Equator + meridian rings for HUD feel */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[R + 0.002, 0.004, 4, 128]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.35} />
      </mesh>
    </group>
  )
}

function PingRing({ position, bornAt, color }: { position: THREE.Vector3; bornAt: number; color: string }) {
  const ref = useRef<THREE.Mesh>(null)
  const mat = useRef<THREE.MeshBasicMaterial>(null)
  const quat = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), position.clone().normalize())
    return q
  }, [position])
  useFrame(() => {
    const age = (Date.now() - bornAt) / 1000
    const cycle = age % 1.5
    const s = 1 + cycle * 6
    if (ref.current) ref.current.scale.set(s, s, s)
    if (mat.current) mat.current.opacity = Math.max(0, 0.9 - cycle / 1.5)
  })
  return (
    <mesh ref={ref} position={position} quaternion={quat}>
      <ringGeometry args={[0.03, 0.04, 32]} />
      <meshBasicMaterial ref={mat} color={color} transparent side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

function NodeMarker({ node, fresh, onSelect }: { node: MeshNode; fresh: boolean; onSelect: (n: MeshNode) => void }) {
  const pos = useMemo(() => latLonToVec3(node.coord.lat, node.coord.lon, R + 0.02), [node.coord.lat, node.coord.lon])
  const [hover, setHover] = useState(false)
  const color = nodeColor(node)
  const core = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (core.current && node.isSelf) {
      const s = 1 + Math.sin(clock.elapsedTime * 4) * 0.15
      core.current.scale.set(s, s, s)
    }
  })
  return (
    <group>
      <mesh
        ref={core}
        position={pos}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(node)
        }}
        onPointerOver={() => setHover(true)}
        onPointerOut={() => setHover(false)}
      >
        <sphereGeometry args={[node.isSelf ? 0.05 : 0.035, 12, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {/* Halo */}
      <mesh position={pos}>
        <sphereGeometry args={[node.isSelf ? 0.09 : 0.065, 12, 12]} />
        <meshBasicMaterial color={color} transparent opacity={hover ? 0.45 : 0.18} depthWrite={false} />
      </mesh>
      {fresh && <PingRing position={pos} bornAt={node.firstSeen} color={color} />}
      <Html position={pos} distanceFactor={6} style={{ pointerEvents: 'none' }}>
        {hover || node.isSelf ? (
          <div
            className="px-2 py-1 text-[10px] whitespace-nowrap border font-mono"
            style={{ background: 'rgba(5,10,16,0.85)', borderColor: color, color, boxShadow: `0 0 8px ${color}55` }}
          >
            <div className="font-bold tracking-widest">
              {node.isSelf ? 'YOU' : node.alias.toUpperCase()} <span className="opacity-70">[{nodeTag(node)}]</span>
            </div>
            <div className="opacity-70">
              ID {node.id.slice(0, 8)} · {node.isSelf ? `${node.coord.lat.toFixed(2)}, ${node.coord.lon.toFixed(2)}` : `${node.hops}h ${node.latencyMs}ms`}
            </div>
          </div>
        ) : (
          <div className="whitespace-nowrap font-mono text-[9px] tracking-wider" style={{ color, textShadow: '0 0 4px #000' }}>
            {nodeTag(node)} {node.isSelf ? '' : node.alias}
          </div>
        )}
      </Html>
    </group>
  )
}

function RouteArc({ a, b, active }: { a: THREE.Vector3; b: THREE.Vector3; active: boolean }) {
  const pts = useMemo(() => arcPoints(a, b), [a, b])
  return (
    <Line
      points={pts}
      color={active ? CYAN : PURPLE}
      lineWidth={active ? 1.4 : 0.8}
      transparent
      opacity={active ? 0.75 : 0.4}
      dashed={!active}
      dashSize={0.08}
      gapSize={0.05}
    />
  )
}

function Scene({ lowPower }: { lowPower: boolean }) {
  const nodes = useGhostStore((s) => s.nodes)
  const peers = useGhostStore(useShallow(selectPeers))
  const fresh = useGhostStore((s) => s.freshNodes)
  const edges = useGhostStore((s) => s.edges)
  const setActive = useGhostStore((s) => s.setActiveConversation)
  // Tick once per second so "fresh" ping rings expire without per-node timers
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const positions = useMemo(() => {
    const m = new Map<string, THREE.Vector3>()
    for (const n of Object.values(nodes)) m.set(n.id, latLonToVec3(n.coord.lat, n.coord.lon, R + 0.02))
    return m
  }, [nodes])

  const self = Object.values(nodes).find((n) => n.isSelf)

  return (
    <>
      <ambientLight intensity={0.6} />
      {!lowPower && <Stars radius={40} depth={20} count={900} factor={2} fade speed={0.4} />}
      <Globe lowPower={lowPower} />
      {self && <NodeMarker node={self} fresh={false} onSelect={() => {}} />}
      {peers.map((n) => (
        <NodeMarker
          key={n.id}
          node={n}
          fresh={!!fresh[n.id] && now - (fresh[n.id] ?? 0) < 4500}
          onSelect={(node) => node.status === 'trusted' && setActive(node.id)}
        />
      ))}
      {edges.map(([a, b]) => {
        const pa = positions.get(a)
        const pb = positions.get(b)
        if (!pa || !pb) return null
        return <RouteArc key={`${a}-${b}`} a={pa} b={pb} active={a === self?.id} />
      })}
      <OrbitControls
        enablePan={false}
        minDistance={3}
        maxDistance={9}
        autoRotate
        autoRotateSpeed={lowPower ? 0.15 : 0.4}
        enableDamping
        dampingFactor={0.08}
      />
    </>
  )
}

export default function MeshMap() {
  const theme = useGhostStore((s) => s.theme)
  const lowPower = theme === 'amoled'
  const peers = useGhostStore(useShallow(selectPeers))
  const transports = useGhostStore((s) => s.transports)
  const trusted = peers.filter((p) => p.status === 'trusted').length

  return (
    <div className="relative h-full w-full">
      <Canvas
        dpr={lowPower ? 1 : [1, 2]}
        camera={{ position: [0, 1.2, 5.2], fov: 45 }}
        gl={{ antialias: !lowPower, alpha: true, powerPreference: lowPower ? 'low-power' : 'high-performance' }}
        frameloop="always"
        style={{ background: 'transparent' }}
      >
        <Suspense fallback={null}>
          <Scene lowPower={lowPower} />
        </Suspense>
      </Canvas>

      {peers.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-16 text-center text-[11px] tracking-widest text-ghost">
          <span className="animate-blink">WAITING FOR NODES IN RANGE…</span>
          <div className="mt-1 text-[10px] normal-case tracking-normal text-ghost-dim">
            Open GhostMesh in another tab of this browser to test real encrypted chat.
          </div>
        </div>
      )}

      {/* HUD overlay */}
      <div className="pointer-events-none absolute left-3 top-3 hud-panel px-3 py-2 text-[10px] leading-relaxed">
        <div className="hud-title mb-1">Mesh topology</div>
        <div>
          NODES <span className="neon-text-cyan">{peers.length}</span> · TRUSTED{' '}
          <span className="neon-text-cyan">{trusted}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 opacity-80">
          {(['local', 'wifi-direct', 'ble', 'internet', 'simulated'] as const).map((k) => {
            const st = transports[k]
            if (!st) return null
            const c = st === 'active' ? 'text-ok' : st === 'unavailable' ? 'text-ghost-dim' : 'text-warn'
            return (
              <span key={k} className={c}>
                ● {k}
              </span>
            )
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 hud-panel px-3 py-2 text-[10px]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-purple" /> you</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-cyan" /> trusted</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-warn" /> handshake</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-danger" /> blocked</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full" style={{ background: SIM }} /> SIM (fake demo)</span>
        </div>
        <div className="mt-1 opacity-60">drag to orbit · scroll to zoom · click a trusted node to chat</div>
      </div>
    </div>
  )
}
