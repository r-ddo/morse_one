import workletUrl from "./capture-worklet.js?url";
import type { AudioSessionNavigator } from "./player";

/** ブラウザ（OS）側の音声処理。トーンの検出には全部オフが望ましい */
export interface MicProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/** マイク入力を AudioWorklet で生のサンプルとして受け取る */
export class MicCapture {
  private constructor(
    readonly ctx: AudioContext,
    readonly stream: MediaStream,
    readonly analyser: AnalyserNode,
    private readonly capture: AudioWorkletNode,
    private readonly nodes: AudioNode[],
  ) {}

  get track(): MediaStreamTrack {
    return this.stream.getAudioTracks()[0];
  }

  /** ユーザー操作のハンドラ内で呼ぶこと（iOS の自動再生制限のため） */
  static async open(processing: MicProcessing, onSamples: (samples: Float32Array) => void): Promise<MicCapture> {
    setSessionType("play-and-record");
    // await より前に作って resume し、タップの中で起動したことにする
    const ctx = new AudioContext();
    const resumed = ctx.resume();
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...processing, channelCount: 1 } });
      await resumed;
      await ctx.audioWorklet.addModule(workletUrl);
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.5;
      const capture = new AudioWorkletNode(ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      capture.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
      // 出力につながっていないと処理されないことがあるので、無音で出力へつなぐ
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(analyser);
      source.connect(capture).connect(mute).connect(ctx.destination);
      return new MicCapture(ctx, stream, analyser, capture, [source, analyser, capture, mute]);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
      setSessionType("playback");
      throw e;
    }
  }

  close(): void {
    for (const n of this.nodes) n.disconnect();
    this.capture.port.onmessage = null;
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => {});
    setSessionType("playback");
  }
}

function setSessionType(type: string): void {
  const session = (navigator as AudioSessionNavigator).audioSession;
  if (session) session.type = type;
}
