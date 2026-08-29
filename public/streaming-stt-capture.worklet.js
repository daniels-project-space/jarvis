const TARGET_SAMPLE_RATE = 16_000;
const PCM_FRAME_SAMPLES = TARGET_SAMPLE_RATE / 10;

class JarvisStreamingSttCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSamplesSeen = 0;
    this.outputSamplesMade = 0;
    this.lastSample = 0;
    this.hasLastSample = false;
    this.frame = [];
    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush") return;
      this.flushFrame();
      this.port.postMessage({ type: "flushed" });
    };
  }

  flushFrame() {
    if (!this.frame.length) return;
    const frame = Int16Array.from(this.frame);
    this.frame = [];
    this.port.postMessage(frame.buffer, [frame.buffer]);
  }

  append(sample) {
    this.frame.push(Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff));
    if (this.frame.length === PCM_FRAME_SAMPLES) this.flushFrame();
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples?.length) return true;

    const start = this.inputSamplesSeen;
    const end = start + samples.length;
    const sourceSamplesPerOutput = sampleRate / TARGET_SAMPLE_RATE;
    // Preserve a single resampling timeline across each 128-frame render
    // quantum. Independent rounding per quantum makes a 44.1/48 kHz browser
    // lie about the sample rate sent to the 16 kHz recognizer.
    while (true) {
      const sourcePosition = this.outputSamplesMade * sourceSamplesPerOutput;
      const leftIndex = Math.floor(sourcePosition);
      if (leftIndex >= end) break;
      const fraction = sourcePosition - leftIndex;
      // Interpolation needs the following source sample, except at an exact
      // source position where the final sample is already authoritative.
      if (leftIndex + 1 >= end && fraction !== 0) break;
      const left = leftIndex === start - 1 && this.hasLastSample
        ? this.lastSample
        : samples[leftIndex - start];
      const right = leftIndex + 1 < end ? samples[leftIndex + 1 - start] : left;
      this.append(left * (1 - fraction) + right * fraction);
      this.outputSamplesMade += 1;
    }
    this.lastSample = samples[samples.length - 1];
    this.hasLastSample = true;
    this.inputSamplesSeen = end;
    return true;
  }
}

registerProcessor("jarvis-streaming-stt-capture", JarvisStreamingSttCaptureProcessor);
