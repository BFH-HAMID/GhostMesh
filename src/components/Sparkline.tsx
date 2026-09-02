/** Tiny dependency-free SVG line graph for the diagnostics dashboard. */
interface Props {
  values: number[]
  color: string
  height?: number
  max?: number
  fill?: boolean
  label: string
  unit?: string
  format?: (v: number) => string
}

export default function Sparkline({ values, color, height = 56, max, fill = true, label, unit = '', format }: Props) {
  const w = 240
  const m = max ?? Math.max(1, ...values)
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (Math.min(v, m) / m) * (height - 4) - 2).toFixed(1)}`)
  const last = values[values.length - 1] ?? 0
  const fmt = format ?? ((v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 ? 1 : 0)))
  return (
    <div className="hud-panel p-2">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="hud-title">{label}</span>
        <span className="text-sm" style={{ color, textShadow: `0 0 6px ${color}88` }}>
          {fmt(last)}
          <span className="ml-0.5 text-[10px] opacity-70">{unit}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${height}`} className="h-14 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`g-${label}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={w} y1={height * f} y2={height * f} stroke={color} strokeOpacity="0.08" />
        ))}
        {pts.length > 1 && (
          <>
            {fill && <polygon points={`0,${height} ${pts.join(' ')} ${w},${height}`} fill={`url(#g-${label})`} />}
            <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
    </div>
  )
}
