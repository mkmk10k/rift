import { useMemo } from 'react'

interface WaveformProps {
  mode: 'idle' | 'recording' | 'playing'
  barCount?: number
  className?: string
}

export function Waveform({ mode, barCount = 14, className = '' }: WaveformProps) {
  const bars = useMemo(() => {
    const amplitudeRanges = {
      idle: { min: 20, max: 60 },
      recording: { min: 40, max: 100 },
      playing: { min: 35, max: 85 }
    }

    const range = amplitudeRanges[mode]

    return Array.from({ length: barCount }, (_, i) => {
      // Use deterministic pattern instead of Math.random for consistent animation
      const phase = (i / barCount) * Math.PI * 2
      const amplitude = range.min + (Math.sin(phase) * 0.5 + 0.5) * (range.max - range.min)
      return Math.round(amplitude)
    })
  }, [mode, barCount])

  return (
    <div className={`flex items-center gap-1 h-8 w-32 ${className}`}>
      {bars.map((height, i) => (
        <div
          key={i}
          className={`
            w-1.5 rounded-full transition-all duration-300 ease-apple
            ${mode === 'idle' ? 'bg-white/20 hover:bg-white/30' : ''}
            ${mode === 'recording' ? 'bg-gradient-to-t from-blue-500/80 to-blue-400/60 animate-waveform-pulse' : ''}
            ${mode === 'playing' ? 'bg-gradient-to-t from-purple-500/80 to-purple-400/60 animate-waveform-pulse' : ''}
          `}
          style={{
            height: `${height}%`,
            animationDelay: `${i * 0.05}s`,
            animationDuration: mode === 'idle' ? '0s' : '0.8s'
          }}
        />
      ))}
    </div>
  )
}

