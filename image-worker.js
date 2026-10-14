'use strict';

// Decodes a photo off the main thread and returns it shrunk to maxEdge as a JPEG.
self.onmessage = async (e) => {
  const { file, maxEdge, quality } = e.data;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const w = bitmap.width;
    const h = bitmap.height;
    const s = Math.min(1, maxEdge / Math.max(w, h));
    const ow = Math.max(1, Math.round(w * s));
    const oh = Math.max(1, Math.round(h * s));

    const canvas = new OffscreenCanvas(ow, oh);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, ow, oh);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, ow, oh);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    self.postMessage({ blob, w, h });
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
