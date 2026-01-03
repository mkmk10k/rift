import { useRef, useEffect, useCallback, memo } from 'react'

/**
 * ParticleOrb - A luminous, living orb
 * 
 * Inspired by bioluminescence, breath, and presence.
 * A glowing core surrounded by orbiting particles in layers.
 * This should feel alive - like holding light in your hand.
 */

interface Particle {
  x: number
  y: number
  angle: number
  orbitRadius: number
  orbitSpeed: number
  size: number
  opacity: number
  layer: number // 0 = inner, 1 = mid, 2 = outer
  phase: number
  wobbleSpeed: number
  wobbleAmount: number
}

export type OrbState = 'idle' | 'listening' | 'processing' | 'playing' | 'paused' | 'success'

interface ParticleOrbProps {
  state: OrbState
  audioLevel: number
  size?: number
  onTap?: () => void
  onLongPress?: () => void
  className?: string
}

const PARTICLE_COUNT = 40
const LONG_PRESS_DURATION = 500

// Rich color palette with depth
const PALETTES = {
  idle: {
    core: { r: 100, g: 180, b: 255 },      // Soft sky blue
    mid: { r: 80, g: 160, b: 255 },        // Azure
    outer: { r: 60, g: 140, b: 240 },      // Deeper blue
    glow: { r: 120, g: 200, b: 255 },      // Bright accent
  },
  listening: {
    core: { r: 255, g: 120, b: 100 },      // Warm coral
    mid: { r: 255, g: 100, b: 80 },        // Vibrant coral
    outer: { r: 255, g: 80, b: 60 },       // Deep coral
    glow: { r: 255, g: 160, b: 140 },      // Soft pink
  },
  processing: {
    core: { r: 180, g: 140, b: 255 },      // Lavender
    mid: { r: 160, g: 120, b: 240 },       // Purple
    outer: { r: 140, g: 100, b: 220 },     // Deep purple
    glow: { r: 200, g: 160, b: 255 },      // Light lavender
  },
  playing: {
    core: { r: 255, g: 180, b: 80 },       // Warm amber
    mid: { r: 255, g: 160, b: 60 },        // Golden
    outer: { r: 240, g: 140, b: 40 },      // Deep gold
    glow: { r: 255, g: 200, b: 120 },      // Light gold
  },
  success: {
    core: { r: 100, g: 230, b: 140 },      // Fresh green
    mid: { r: 80, g: 210, b: 120 },        // Emerald
    outer: { r: 60, g: 190, b: 100 },      // Deep green
    glow: { r: 140, g: 255, b: 180 },      // Bright mint
  },
}

function createParticles(center: number): Particle[] {
  const particles: Particle[] = []
  
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Distribute across 3 layers
    const layer = i < 12 ? 0 : i < 28 ? 1 : 2
    
    // Layer-specific orbit radius
    const baseRadius = layer === 0 ? 18 : layer === 1 ? 32 : 46
    const radiusVariation = layer === 0 ? 6 : layer === 1 ? 8 : 10
    const orbitRadius = baseRadius + (Math.random() - 0.5) * radiusVariation
    
    // Layer-specific size (inner particles are smaller)
    const baseSize = layer === 0 ? 2.5 : layer === 1 ? 3.5 : 4.5
    const size = baseSize + Math.random() * 1.5
    
    // Vary speeds - inner moves faster
    const baseSpeed = layer === 0 ? 0.6 : layer === 1 ? 0.4 : 0.25
    const orbitSpeed = baseSpeed + (Math.random() - 0.5) * 0.2
    
    particles.push({
      x: center,
      y: center,
      angle: (i / PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.5,
      orbitRadius,
      orbitSpeed,
      size,
      opacity: 0.6 + Math.random() * 0.3,
      layer,
      phase: Math.random() * Math.PI * 2,
      wobbleSpeed: 1 + Math.random() * 2,
      wobbleAmount: 2 + Math.random() * 3,
    })
  }
  
  return particles
}

function lerpValue(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

export const ParticleOrb = memo(function ParticleOrb({
  state,
  audioLevel,
  size = 120,
  onTap,
  onLongPress,
  className = '',
}: ParticleOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<Particle[]>([])
  const animationRef = useRef<number>(0)
  const timeRef = useRef<number>(0)
  const currentPaletteRef = useRef(PALETTES.idle)
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isPressedRef = useRef(false)
  const smoothAudioRef = useRef(0)
  
  // Initialize particles
  useEffect(() => {
    particlesRef.current = createParticles(size / 2)
  }, [size])
  
  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    const center = size / 2
    const targetPalette = PALETTES[state] || PALETTES.idle
    let lastTime = performance.now()
    
    const animate = (currentTime: number) => {
      if (document.hidden) {
        animationRef.current = requestAnimationFrame(animate)
        return
      }
      
      const deltaTime = (currentTime - lastTime) / 1000
      lastTime = currentTime
      timeRef.current += deltaTime
      const time = timeRef.current
      
      // Smooth audio level (less jittery)
      smoothAudioRef.current = lerpValue(smoothAudioRef.current, audioLevel, deltaTime * 8)
      const audio = smoothAudioRef.current
      
      // Lerp palette colors
      const palette = currentPaletteRef.current
      const lerpSpeed = deltaTime * 4
      for (const key of ['core', 'mid', 'outer', 'glow'] as const) {
        palette[key].r = lerpValue(palette[key].r, targetPalette[key].r, lerpSpeed)
        palette[key].g = lerpValue(palette[key].g, targetPalette[key].g, lerpSpeed)
        palette[key].b = lerpValue(palette[key].b, targetPalette[key].b, lerpSpeed)
      }
      
      // Clear with slight fade for motion blur effect
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)'
      ctx.fillRect(0, 0, size, size)
      ctx.clearRect(0, 0, size, size)
      
      const isActive = state === 'listening' || state === 'playing'
      const breathe = Math.sin(time * 0.8) * 0.08 + 1 // Subtle breathing
      const pulse = isActive ? 1 + audio * 0.15 : breathe
      
      // ===== OUTER HALO (ambient glow against the screen) =====
      // This creates the "floating on glass" effect
      const haloRadius = 65 * pulse
      const haloGrad = ctx.createRadialGradient(center, center, 0, center, center, haloRadius)
      haloGrad.addColorStop(0, `rgba(${palette.glow.r}, ${palette.glow.g}, ${palette.glow.b}, ${0.15 + audio * 0.1})`)
      haloGrad.addColorStop(0.4, `rgba(${palette.outer.r}, ${palette.outer.g}, ${palette.outer.b}, ${0.08 + audio * 0.05})`)
      haloGrad.addColorStop(0.7, `rgba(${palette.outer.r}, ${palette.outer.g}, ${palette.outer.b}, ${0.03 + audio * 0.02})`)
      haloGrad.addColorStop(1, `rgba(${palette.outer.r}, ${palette.outer.g}, ${palette.outer.b}, 0)`)
      ctx.beginPath()
      ctx.arc(center, center, haloRadius, 0, Math.PI * 2)
      ctx.fillStyle = haloGrad
      ctx.fill()
      
      // ===== PARTICLES (drawn in layers for depth) =====
      const particles = particlesRef.current
      
      // Sort by layer for proper depth
      const sortedParticles = [...particles].sort((a, b) => b.layer - a.layer)
      
      for (const particle of sortedParticles) {
        // Calculate position based on state
        let radius = particle.orbitRadius
        let speed = particle.orbitSpeed
        let wobble = Math.sin(time * particle.wobbleSpeed + particle.phase) * particle.wobbleAmount
        
        if (state === 'idle') {
          radius = particle.orbitRadius * breathe + wobble
        } else if (state === 'listening') {
          // Expand with audio, more chaotic movement
          const expansion = audio * 15
          const jitter = audio * (Math.sin(time * 10 + particle.phase) * 4)
          radius = particle.orbitRadius + expansion + jitter
          speed = particle.orbitSpeed * (1 + audio * 0.5)
        } else if (state === 'processing') {
          // Spiral inward, then out
          const spiral = Math.sin(time * 2) * 8
          radius = particle.orbitRadius * 0.7 + spiral
          speed = particle.orbitSpeed * 1.5
        } else if (state === 'playing') {
          // Gentle wave motion
          const wave = Math.sin(time * 1.5 + particle.angle * 2) * 6
          radius = particle.orbitRadius * 0.85 + wave + audio * 8
        } else if (state === 'success') {
          // Burst outward
          radius = particle.orbitRadius * 1.2 + 10
        }
        
        // Update angle
        particle.angle += speed * deltaTime
        
        // Calculate position
        particle.x = center + Math.cos(particle.angle) * radius
        particle.y = center + Math.sin(particle.angle) * radius
        
        // Layer-specific color
        const layerColor = particle.layer === 0 ? palette.core : 
                          particle.layer === 1 ? palette.mid : palette.outer
        
        // Calculate opacity based on state and audio
        let opacity = particle.opacity
        if (isActive) {
          opacity = Math.min(1, particle.opacity + audio * 0.4)
        }
        
        // Particle size responds to audio
        const pSize = particle.size * (1 + (isActive ? audio * 0.4 : 0))
        
        // Draw glow
        const glowRadius = pSize * 3
        const glowGrad = ctx.createRadialGradient(
          particle.x, particle.y, 0,
          particle.x, particle.y, glowRadius
        )
        glowGrad.addColorStop(0, `rgba(${layerColor.r}, ${layerColor.g}, ${layerColor.b}, ${opacity * 0.6})`)
        glowGrad.addColorStop(0.4, `rgba(${layerColor.r}, ${layerColor.g}, ${layerColor.b}, ${opacity * 0.2})`)
        glowGrad.addColorStop(1, `rgba(${layerColor.r}, ${layerColor.g}, ${layerColor.b}, 0)`)
        
        ctx.beginPath()
        ctx.arc(particle.x, particle.y, glowRadius, 0, Math.PI * 2)
        ctx.fillStyle = glowGrad
        ctx.fill()
        
        // Draw core (bright center)
        ctx.beginPath()
        ctx.arc(particle.x, particle.y, pSize, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${Math.min(255, layerColor.r + 60)}, ${Math.min(255, layerColor.g + 60)}, ${Math.min(255, layerColor.b + 60)}, ${opacity})`
        ctx.fill()
      }
      
      // ===== CENTRAL ORB =====
      const coreRadius = 16 * pulse
      
      // Outer glow
      const outerGlow = ctx.createRadialGradient(center, center, 0, center, center, coreRadius * 2.5)
      outerGlow.addColorStop(0, `rgba(${palette.glow.r}, ${palette.glow.g}, ${palette.glow.b}, ${0.4 + audio * 0.2})`)
      outerGlow.addColorStop(0.4, `rgba(${palette.core.r}, ${palette.core.g}, ${palette.core.b}, ${0.2 + audio * 0.1})`)
      outerGlow.addColorStop(1, `rgba(${palette.core.r}, ${palette.core.g}, ${palette.core.b}, 0)`)
      ctx.beginPath()
      ctx.arc(center, center, coreRadius * 2.5, 0, Math.PI * 2)
      ctx.fillStyle = outerGlow
      ctx.fill()
      
      // Main core orb
      const coreGrad = ctx.createRadialGradient(
        center - coreRadius * 0.3, center - coreRadius * 0.3, 0,
        center, center, coreRadius
      )
      coreGrad.addColorStop(0, `rgba(255, 255, 255, ${0.95 + audio * 0.05})`) // Bright highlight
      coreGrad.addColorStop(0.3, `rgba(${palette.glow.r}, ${palette.glow.g}, ${palette.glow.b}, 0.9)`)
      coreGrad.addColorStop(0.7, `rgba(${palette.core.r}, ${palette.core.g}, ${palette.core.b}, 0.85)`)
      coreGrad.addColorStop(1, `rgba(${palette.mid.r}, ${palette.mid.g}, ${palette.mid.b}, 0.7)`)
      
      ctx.beginPath()
      ctx.arc(center, center, coreRadius, 0, Math.PI * 2)
      ctx.fillStyle = coreGrad
      ctx.fill()
      
      // Inner highlight (makes it look 3D/spherical)
      const highlightGrad = ctx.createRadialGradient(
        center - coreRadius * 0.4, center - coreRadius * 0.4, 0,
        center - coreRadius * 0.2, center - coreRadius * 0.2, coreRadius * 0.6
      )
      highlightGrad.addColorStop(0, `rgba(255, 255, 255, ${0.7 + audio * 0.2})`)
      highlightGrad.addColorStop(1, 'rgba(255, 255, 255, 0)')
      ctx.beginPath()
      ctx.arc(center, center, coreRadius, 0, Math.PI * 2)
      ctx.fillStyle = highlightGrad
      ctx.fill()
      
      animationRef.current = requestAnimationFrame(animate)
    }
    
    animationRef.current = requestAnimationFrame(animate)
    
    return () => cancelAnimationFrame(animationRef.current)
  }, [size, state, audioLevel])
  
  // Drag state refs
  const isDraggingRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const hasDraggedRef = useRef(false)
  const DRAG_THRESHOLD = 5 // pixels before it's considered a drag
  
  // Touch handlers with drag support
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isPressedRef.current = true
    hasDraggedRef.current = false
    // Use screenX/screenY - these don't change when window moves
    dragStartRef.current = { x: e.screenX, y: e.screenY }
    
    // Capture pointer for tracking outside canvas
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    
    longPressTimerRef.current = setTimeout(() => {
      if (isPressedRef.current && !hasDraggedRef.current && onLongPress) {
        onLongPress()
        isPressedRef.current = false
      }
    }, LONG_PRESS_DURATION)
  }, [onLongPress])
  
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPressedRef.current || !dragStartRef.current) return
    
    // Use screenX/screenY for stable coordinates that don't change when window moves
    const deltaX = e.screenX - dragStartRef.current.x
    const deltaY = e.screenY - dragStartRef.current.y
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)
    
    // Start dragging if threshold exceeded
    if (distance > DRAG_THRESHOLD && !isDraggingRef.current) {
      isDraggingRef.current = true
      hasDraggedRef.current = true
      
      // Cancel long press if we start dragging
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    }
    
    // Move window if dragging
    if (isDraggingRef.current) {
      // Round to integers for Electron's setPosition
      window.outloud?.window?.dragMove?.(Math.round(deltaX), Math.round(deltaY))
      // Reset start position to current screen position for continuous dragging
      dragStartRef.current = { x: e.screenX, y: e.screenY }
    }
  }, [])
  
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    // Release pointer capture
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    
    // Only trigger tap if we didn't drag
    if (isPressedRef.current && !hasDraggedRef.current && onTap) {
      onTap()
    }
    
    isPressedRef.current = false
    isDraggingRef.current = false
    dragStartRef.current = null
  }, [onTap])
  
  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    isPressedRef.current = false
    isDraggingRef.current = false
    dragStartRef.current = null
  }, [])
  
  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={className}
      style={{
        width: size,
        height: size,
        cursor: isDraggingRef.current ? 'grabbing' : 'pointer',
        touchAction: 'none',
        // Explicitly set no-drag - we handle dragging programmatically
        WebkitAppRegion: 'no-drag',
        position: 'relative',
      } as React.CSSProperties}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerCancel}
    />
  )
})

export default ParticleOrb
