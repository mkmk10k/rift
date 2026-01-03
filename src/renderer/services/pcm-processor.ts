/**
 * AudioWorklet Processor for real-time PCM audio capture
 * This runs in a separate audio thread for low-latency capture
 */

// This file needs to be bundled separately and loaded as a module
// The registerProcessor call must be at the top level

class PCMProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array[] = [];
  private sampleCount = 0;
  private readonly SAMPLES_PER_CHUNK = 4096; // ~93ms at 44.1kHz

  constructor() {
    super();
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0];
    
    if (input && input.length > 0) {
      // Get mono channel (first channel)
      const channelData = input[0];
      
      if (channelData && channelData.length > 0) {
        // Copy the input data
        const chunk = new Float32Array(channelData.length);
        chunk.set(channelData);
        this.buffer.push(chunk);
        this.sampleCount += channelData.length;

        // When we have enough samples, send them to the main thread
        if (this.sampleCount >= this.SAMPLES_PER_CHUNK) {
          // Concatenate all buffered chunks
          const totalLength = this.buffer.reduce((sum, buf) => sum + buf.length, 0);
          const combined = new Float32Array(totalLength);
          let offset = 0;
          for (const buf of this.buffer) {
            combined.set(buf, offset);
            offset += buf.length;
          }

          // Send to main thread
          this.port.postMessage({
            type: 'pcm',
            data: combined,
            sampleRate: sampleRate // Global from AudioWorkletGlobalScope
          });

          // Reset buffer
          this.buffer = [];
          this.sampleCount = 0;
        }
      }
    }

    // Return true to keep the processor alive
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);


