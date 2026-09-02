/**
 * AnalyticsEngine — live network telemetry aggregator.
 *
 * MeshManager feeds raw events (bytes in/out, ping RTTs, delivered/lost
 * packets, hop counts). Once per second the engine folds them into a
 * NetworkSample and pushes it onto a bounded ring buffer that the dashboard
 * graphs read from.
 */
import type { NetworkSample } from '@/types'

const RING = 120 // 2 minutes at 1 Hz

export class AnalyticsEngine {
  samples: NetworkSample[] = []
  private rx = 0
  private tx = 0
  private sent = 0
  private lost = 0
  private rtts: number[] = []
  private hops: number[] = []
  private activeNodes = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(s: NetworkSample) => void>()

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  onSample(cb: (s: NetworkSample) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  recordRx(bytes: number) {
    this.rx += bytes
  }
  recordTx(bytes: number) {
    this.tx += bytes
    this.sent++
  }
  recordLoss() {
    this.lost++
  }
  recordRtt(ms: number) {
    this.rtts.push(ms)
  }
  recordHops(n: number) {
    this.hops.push(n)
  }
  setActiveNodes(n: number) {
    this.activeNodes = n
  }

  latest(): NetworkSample | undefined {
    return this.samples[this.samples.length - 1]
  }

  private flush() {
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
    const prev = this.latest()
    const sample: NetworkSample = {
      t: Date.now(),
      rxBps: this.rx,
      txBps: this.tx,
      packetLoss: this.sent ? Math.min(1, this.lost / this.sent) : (prev?.packetLoss ?? 0) * 0.8,
      latencyMs: this.rtts.length ? avg(this.rtts) : (prev?.latencyMs ?? 0),
      avgHops: this.hops.length ? avg(this.hops) : (prev?.avgHops ?? 0),
      activeNodes: this.activeNodes,
    }
    this.samples.push(sample)
    if (this.samples.length > RING) this.samples.shift()
    this.rx = this.tx = this.sent = this.lost = 0
    this.rtts = []
    this.hops = []
    this.listeners.forEach((cb) => cb(sample))
  }
}
