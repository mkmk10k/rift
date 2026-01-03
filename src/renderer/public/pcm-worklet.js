/**
 * AudioWorklet Processor for real-time PCM audio capture
 * Runs on a separate audio thread for stable, low-latency capture
 * 
 * This replaces ScriptProcessorNode which was deprecated and caused crashes
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.sampleCount = 0;
    this.isActive = true;
    
    // Listen for control messages from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        this.isActive = false;
        // Flush any remaining audio
        if (this.sampleCount > 0) {
          this.port.postMessage({
            type: 'audio',
            buffer: this.flush(),
            sampleRate: sampleRate  // Global from AudioWorkletGlobalScope
          });
        }
        this.port.postMessage({ type: 'stopped' });
      } else if (event.data.type === 'flush') {
        // Force flush current buffer
        if (this.sampleCount > 0) {
          this.port.postMessage({
            type: 'audio',
            buffer: this.flush(),
            sampleRate: sampleRate
          });
        }
      }
    };
  }

  flush() {
    // Concatenate all buffered chunks into single Float32Array
    const totalLength = this.buffer.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.buffer) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.buffer = [];
    this.sampleCount = 0;
    return combined;
  }

  process(inputs, outputs, parameters) {
    // Don't process if stopped
    if (!this.isActive) {
      return false; // Return false to stop processing
    }

    const input = inputs[0];
    
    if (input && input.length > 0) {
      // Get mono channel (first channel)
      const channelData = input[0];
      
      if (channelData && channelData.length > 0) {
        // Copy the input data (important: input buffers are recycled)
        const chunk = new Float32Array(channelData.length);
        chunk.set(channelData);
        this.buffer.push(chunk);
        this.sampleCount += channelData.length;

        // Emit every ~1 second of audio
        // At 48kHz (common sample rate), 1 second = 48000 samples
        // At 44.1kHz, 1 second = 44100 samples
        // We use 44100 as the threshold since it's the lower common rate
        const SAMPLES_PER_SECOND = 44100;
        
        if (this.sampleCount >= SAMPLES_PER_SECOND) {
          // Send accumulated audio to main thread
          this.port.postMessage({
            type: 'audio',
            buffer: this.flush(),
            sampleRate: sampleRate
          });
        }
      }
    }

    // Return true to keep the processor alive
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);

