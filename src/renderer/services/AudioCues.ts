/**
 * AudioCues - Subtle audio feedback for state changes
 * 
 * Simple synthesized tones using Web Audio API.
 * Recording start: soft ascending tone (breath in)
 * Recording stop: gentle descending resolution (breath out)
 * 
 * These should feel inevitable — part of the experience, not notifications.
 */

class AudioCuesService {
  private audioContext: AudioContext | null = null
  private enabled = true
  
  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext()
    }
    return this.audioContext
  }
  
  /**
   * Enable or disable audio cues
   */
  setEnabled(enabled: boolean) {
    this.enabled = enabled
  }
  
  /**
   * Recording start - soft ascending tone
   * Like a breath in. Single note rising slightly.
   */
  async playRecordStart() {
    if (!this.enabled) return
    
    try {
      const ctx = this.getContext()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      
      const oscillator = ctx.createOscillator()
      const gainNode = ctx.createGain()
      
      oscillator.connect(gainNode)
      gainNode.connect(ctx.destination)
      
      // Soft sine wave
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(440, ctx.currentTime) // A4
      oscillator.frequency.linearRampToValueAtTime(494, ctx.currentTime + 0.08) // Rise to B4
      
      // Very gentle volume envelope
      gainNode.gain.setValueAtTime(0, ctx.currentTime)
      gainNode.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.02) // Fade in
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08) // Fade out
      
      oscillator.start(ctx.currentTime)
      oscillator.stop(ctx.currentTime + 0.1)
    } catch (error) {
      console.warn('[AudioCues] Failed to play record start:', error)
    }
  }
  
  /**
   * Recording stop - gentle descending resolution
   * Like a breath out. Two notes descending.
   */
  async playRecordStop() {
    if (!this.enabled) return
    
    try {
      const ctx = this.getContext()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      
      const oscillator = ctx.createOscillator()
      const gainNode = ctx.createGain()
      
      oscillator.connect(gainNode)
      gainNode.connect(ctx.destination)
      
      // Soft sine wave, descending
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(494, ctx.currentTime) // B4
      oscillator.frequency.linearRampToValueAtTime(392, ctx.currentTime + 0.12) // Descend to G4
      
      // Gentle volume envelope
      gainNode.gain.setValueAtTime(0, ctx.currentTime)
      gainNode.gain.linearRampToValueAtTime(0.07, ctx.currentTime + 0.02) // Fade in
      gainNode.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.08)
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12) // Fade out
      
      oscillator.start(ctx.currentTime)
      oscillator.stop(ctx.currentTime + 0.15)
    } catch (error) {
      console.warn('[AudioCues] Failed to play record stop:', error)
    }
  }
  
  /**
   * Success - very subtle high note
   * Brief, almost subliminal confirmation.
   */
  async playSuccess() {
    if (!this.enabled) return
    
    try {
      const ctx = this.getContext()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      
      const oscillator = ctx.createOscillator()
      const gainNode = ctx.createGain()
      
      oscillator.connect(gainNode)
      gainNode.connect(ctx.destination)
      
      // Higher, brighter note
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(659, ctx.currentTime) // E5
      
      // Very brief and quiet
      gainNode.gain.setValueAtTime(0, ctx.currentTime)
      gainNode.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.01)
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.06)
      
      oscillator.start(ctx.currentTime)
      oscillator.stop(ctx.currentTime + 0.08)
    } catch (error) {
      console.warn('[AudioCues] Failed to play success:', error)
    }
  }
  
  /**
   * Error - low muted tone
   * Subtle indication something went wrong.
   */
  async playError() {
    if (!this.enabled) return
    
    try {
      const ctx = this.getContext()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      
      const oscillator = ctx.createOscillator()
      const gainNode = ctx.createGain()
      
      oscillator.connect(gainNode)
      gainNode.connect(ctx.destination)
      
      // Lower, muted
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(220, ctx.currentTime) // A3
      oscillator.frequency.linearRampToValueAtTime(196, ctx.currentTime + 0.1) // Down to G3
      
      gainNode.gain.setValueAtTime(0, ctx.currentTime)
      gainNode.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.02)
      gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1)
      
      oscillator.start(ctx.currentTime)
      oscillator.stop(ctx.currentTime + 0.12)
    } catch (error) {
      console.warn('[AudioCues] Failed to play error:', error)
    }
  }
  
  /**
   * Clean up audio context
   */
  dispose() {
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
  }
}

// Singleton instance
export const audioCues = new AudioCuesService()
