import {
  encodeAvifBytesFromRgba,
  primeCompiledWasmModule,
  warmupAvifEncoder,
} from '../processing/avif-encoder.js';

async function handleMessage(msg, reply) {
  if (!msg) return;

  if (msg.type === 'warmup') {
    if (msg.wasmModule) {
      primeCompiledWasmModule(msg.wasmModule);
    }
    warmupAvifEncoder({ forceWasm: true }).catch(() => {});
    return;
  }

  if (msg.type === 'encode-tile') {
    const { jobId, tileIndex, rgbaBuffer, width, height, options } = msg;
    try {
      const encoded = await encodeAvifBytesFromRgba(rgbaBuffer, width, height, options);
      reply(
        {
          type: 'tile-result',
          jobId,
          tileIndex,
          ok: true,
          avifBuffer: encoded.buffer,
        },
        [encoded.buffer]
      );
    } catch (err) {
      reply({
        type: 'tile-result',
        jobId,
        tileIndex,
        ok: false,
        error: err?.message || String(err),
      });
    }
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'attach-port' && msg.port) {
    const port = msg.port;
    port.addEventListener('message', (portEvent) => {
      handleMessage(portEvent.data, (data, transfer) => port.postMessage(data, transfer || []));
    });
    port.start();
    if (msg.wasmModule) {
      primeCompiledWasmModule(msg.wasmModule);
      warmupAvifEncoder({ forceWasm: true }).catch(() => {});
    }
    return;
  }

  handleMessage(msg, (data, transfer) => self.postMessage(data, transfer || []));
});
