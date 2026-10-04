// マイク入力をまとめてメインスレッドへ送る AudioWorklet。
// 時刻はサンプル数で数えるので、入力が途切れたときも無音で埋めて送る
const CHUNK = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const len = ch ? ch.length : 128;
    for (let i = 0; i < len; i++) {
      this.buf[this.n++] = ch ? ch[i] : 0;
      if (this.n === CHUNK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(CHUNK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
