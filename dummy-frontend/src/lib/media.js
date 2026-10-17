// Camera, files and microphone: photo compression, base64, WAV recording, barcode scanning, CSV export.
export function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result); // data URL; the Edge Functions strip the prefix
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Downscale photos before upload (bills stay readable at 1600px, for Gemini and OCR alike). */
export async function compressImage(file, maxSide = 1600, quality = 0.85) {
  if (!file.type.startsWith("image/")) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

/** Record audio; resolves stop() -> 16 kHz mono WAV blob (MediaRecorder's WebM is not accepted by Gemini). */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start();
  return () => new Promise((resolve) => {
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(await toWav(new Blob(chunks, { type: rec.mimeType })));
    };
    rec.stop();
  });
}

async function toWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  ctx.close();
  return new Blob([buf], { type: "audio/wav" });
}

/** Read a barcode from a <video> element: native BarcodeDetector, ZXing fallback. */
export async function detectBarcode(video, signal) {
  if ("BarcodeDetector" in window) {
    const det = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"] });
    while (!signal.aborted) {
      const codes = await det.detect(video).catch(() => []);
      if (codes.length) return codes[0].rawValue;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  return await new Promise((resolve) => {
    new BrowserMultiFormatReader().decodeFromVideoElement(video, (res, _err, controls) => {
      if (res) { controls.stop(); resolve(res.getText()); }
      if (signal.aborted) { controls.stop(); resolve(null); }
    });
  });
}

export function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
