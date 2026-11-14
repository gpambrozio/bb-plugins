/**
 * One WebRTC leg to OpenAI: the microphone track out, the reply track in, and the `oai-events` data channel,
 * read only to show whether the captain or the voice is speaking. The SDP exchange is the bb server's
 * (`session.start`, `session.renew`), so the page never holds a credential. A renewal makes a second leg on
 * the same microphone stream.
 */
export type SpeakingState = { captain: boolean; voice: boolean };

export interface Leg {
  offer: string;
  accept(answerSdp: string): Promise<void>;
  /** Resolves once the peer has connected, or rejects when it fails. */
  connected(): Promise<void>;
  close(): void;
}

export async function openLeg(options: {
  stream: MediaStream;
  audio: HTMLAudioElement;
  onSpeaking(state: Partial<SpeakingState>): void;
  onFailed(): void;
}): Promise<Leg> {
  const pc = new RTCPeerConnection();
  for (const track of options.stream.getAudioTracks()) pc.addTrack(track, options.stream);
  const channel = pc.createDataChannel("oai-events");
  channel.onmessage = (message) => {
    let type = "";
    try {
      type = String((JSON.parse(String(message.data)) as { type?: unknown }).type ?? "");
    } catch {
      return;
    }
    if (type === "input_audio_buffer.speech_started") options.onSpeaking({ captain: true });
    if (type === "input_audio_buffer.speech_stopped") options.onSpeaking({ captain: false });
    if (type === "output_audio_buffer.started") options.onSpeaking({ voice: true });
    if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") options.onSpeaking({ voice: false });
  };
  pc.ontrack = (event) => {
    options.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void options.audio.play().catch(() => undefined);
  };
  let failed = false;
  const waiters: { resolve(): void; reject(error: Error): void }[] = [];
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") for (const waiter of waiters.splice(0)) waiter.resolve();
    if ((pc.connectionState === "failed" || pc.connectionState === "closed") && !failed) {
      failed = true;
      for (const waiter of waiters.splice(0)) waiter.reject(new Error("The audio connection to OpenAI failed."));
      options.onFailed();
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return {
    offer: offer.sdp ?? "",
    accept: (answerSdp) => pc.setRemoteDescription({ type: "answer", sdp: answerSdp }),
    connected: () =>
      pc.connectionState === "connected"
        ? Promise.resolve()
        : new Promise((resolve, reject) => waiters.push({ resolve, reject })),
    close: () => {
      failed = true;
      pc.onconnectionstatechange = null;
      channel.close();
      pc.close();
    },
  };
}
