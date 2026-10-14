'use strict';

// Decodes one HEIC/HEIF file off the main thread and returns it already shrunk (RGBA).
importScripts('vendor/libheif/libheif-bundle.js');

const heif = libheif();

// Area-average downscale, so the full-size pixels never have to be re-encoded.
function downscale(src, w, h, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * s));
  const oh = Math.max(1, Math.round(h * s));
  if (ow === w && oh === h) return { w: ow, h: oh, data: src };

  const out = new Uint8ClampedArray(ow * oh * 4);
  const xs = new Int32Array(ow + 1);
  for (let i = 0; i <= ow; i++) xs[i] = Math.round((i * w) / ow);

  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.round((oy * h) / oh);
    const y1 = Math.max(y0 + 1, Math.round(((oy + 1) * h) / oh));
    for (let ox = 0; ox < ow; ox++) {
      const x0 = xs[ox];
      const x1 = Math.max(x0 + 1, xs[ox + 1]);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) {
        let p = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) {
          r += src[p]; g += src[p + 1]; b += src[p + 2]; a += src[p + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (oy * ow + ox) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { w: ow, h: oh, data: out };
}

self.onmessage = (e) => {
  const { buffer, maxEdge } = e.data;
  try {
    const images = new heif.HeifDecoder().decode(new Uint8Array(buffer));
    if (!images || images.length === 0) throw new Error('HEIC: no image found');
    const image = images[0];
    const w = image.get_width();
    const h = image.get_height();
    const rgba = new Uint8ClampedArray(w * h * 4);

    image.display({ data: rgba, width: w, height: h }, (done) => {
      if (!done) {
        self.postMessage({ error: 'HEIC: could not decode the image' });
        return;
      }
      const small = downscale(rgba, w, h, maxEdge);
      self.postMessage({ w, h, outW: small.w, outH: small.h, buffer: small.data.buffer }, [small.data.buffer]);
    });
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
