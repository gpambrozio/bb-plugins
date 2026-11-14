// Measures what the person hears, the same way on both paths: an analyser on
// the microphone and one on the reply audio, read every 20 ms. A turn's
// latency is the time from the last moment the microphone heard speech to the
// first sound of the reply (an onset after 400 ms of quiet). The microphone
// only counts while the reply is quiet, so an echo of the reply is not speech.

export const LOCAL_THRESHOLD = 0.015;
export const REMOTE_THRESHOLD = 0.01;
const QUIET_BEFORE_ONSET_MS = 400;

export function rms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

export type Turn = {
  /** ms from the page's start of the run. */
  speechEndAt: number;
  replyOnsetAt: number;
  /** What the person waits: last speech heard → first reply sound. */
  latencyMs: number;
};

export type Onset = { at: number; afterSpeech: boolean };

export class TurnMeter {
  readonly turns: Turn[] = [];
  readonly onsets: Onset[] = [];
  private lastSpeechAt: number | null = null;
  private awaitingReply = false;
  private remoteQuietSince = 0;
  private remoteLoud = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  peakLocal = 0;
  peakRemote = 0;

  constructor(
    private readonly local: AnalyserNode,
    private readonly remote: AnalyserNode,
    private readonly now: () => number,
  ) {}

  start() {
    const localBuffer = new Float32Array(this.local.fftSize);
    const remoteBuffer = new Float32Array(this.remote.fftSize);
    this.remoteQuietSince = this.now();
    this.timer = setInterval(() => this.sample(rms(this.local, localBuffer), rms(this.remote, remoteBuffer)), 20);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One 20 ms reading; public for tests. */
  sample(localLevel: number, remoteLevel: number) {
    const t = this.now();
    this.peakLocal = Math.max(this.peakLocal, localLevel);
    this.peakRemote = Math.max(this.peakRemote, remoteLevel);
    if (remoteLevel >= REMOTE_THRESHOLD) {
      if (!this.remoteLoud && t - this.remoteQuietSince >= QUIET_BEFORE_ONSET_MS) {
        this.onsets.push({ at: t, afterSpeech: this.awaitingReply });
        if (this.awaitingReply && this.lastSpeechAt !== null) {
          this.turns.push({ speechEndAt: this.lastSpeechAt, replyOnsetAt: t, latencyMs: Math.round(t - this.lastSpeechAt) });
        }
        this.awaitingReply = false;
      }
      this.remoteLoud = true;
      return;
    }
    if (this.remoteLoud) {
      this.remoteLoud = false;
      this.remoteQuietSince = t;
    }
    if (localLevel >= LOCAL_THRESHOLD && t - this.remoteQuietSince >= 200) {
      this.lastSpeechAt = t;
      this.awaitingReply = true;
    }
  }
}

export function analyser(context: AudioContext, source: AudioNode): AnalyserNode {
  const node = context.createAnalyser();
  node.fftSize = 1024;
  source.connect(node);
  // Some engines (WebKit) only run a node that reaches the destination; a muted one is enough.
  const sink = context.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(context.destination);
  return node;
}
