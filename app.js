'use strict';

const MAX_SIDE = 4096;
const MAX_AREA = 16000000;
const SRC_MAX = 1600;
const THUMB_MAX = 480;
const DRAG_THRESHOLD = 8;
const MAX_ZOOM = 6;

const $ = (sel) => document.querySelector(sel);
const el = {
  rows: $('#rows'), cols: $('#cols'), total: $('#total'),
  pick: $('#pick'), clear: $('#clear'), file: $('#file'), fileOne: $('#fileOne'),
  status: $('#status'), note: $('#note'), warn: $('#warn'),
  gridWrap: $('#gridWrap'), grid: $('#grid'), build: $('#build'),
  modal: $('#modal'), result: $('#result'), resultInfo: $('#resultInfo'),
  save: $('#save'), download: $('#download'), close: $('#close'), modalHint: $('#modalHint'),
  editor: $('#editor'), frame: $('#frame'), frameImg: $('#frameImg'), zoom: $('#zoom'),
  shuffle: $('#shuffle'), editReplace: $('#editReplace'), editReset: $('#editReset'), editDone: $('#editDone'),
  pickLabel: $('#pickLabel'), meterFill: $('#meterFill'), outSize: $('#outSize'),
  orientField: $('#orientField'), oriPortraitRatio: $('#oriPortraitRatio'), oriLandscapeRatio: $('#oriLandscapeRatio'),
  dockCount: $('#dockCount'), dockTotal: $('#dockTotal'), zoomVal: $('#zoomVal'),
};

const RATIOS = { '3:4': [3, 4], '1:1': [1, 1], '9:16': [9, 16] };
const state = { ratio: '3:4', orientation: 'landscape', rows: 3, cols: 3, items: [], busy: false };
let nextId = 1;
let targetIndex = null;
let resultUrl = null;
let resultFile = null;
const cellPx = { w: 0, h: 0 };
const editor = { index: null, url: null, fw: 0, fh: 0 };

// Cell shape as integer units [w, h]; orientation only matters for non-square ratios.
function cellUnits() {
  const [a, b] = RATIOS[state.ratio];
  return state.orientation === 'portrait' || a === b ? [a, b] : [b, a];
}
const cellCount = () => state.rows * state.cols;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const filledItems = () => Array.from({ length: cellCount() }, (_, i) => state.items[i]).filter(Boolean);

function isMismatch(item) {
  const [uw, uh] = cellUnits();
  if (uw === uh) return false;
  return uw < uh ? item.w > item.h : item.h > item.w;
}

function setNote(text, isError = false) {
  el.note.textContent = text;
  el.note.classList.toggle('error', isError && text !== '');
}

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/* ---------- crop model ----------
   item.zoom (>= 1) is relative to the "cover" scale, item.fx / item.fy (0..1) place the
   visible window inside the slack of the image, so the frame is always completely filled. */

function cropGeom(item, fw, fh) {
  const s = Math.max(fw / item.w, fh / item.h) * item.zoom;
  const sw = fw / s;
  const sh = fh / s;
  const sx = item.fx * Math.max(0, item.w - sw);
  const sy = item.fy * Math.max(0, item.h - sh);
  return { s, sw, sh, sx, sy, w: item.w * s, h: item.h * s, x: -sx * s, y: -sy * s };
}

function setWindow(item, fw, fh, sx, sy) {
  const s = Math.max(fw / item.w, fh / item.h) * item.zoom;
  const rx = item.w - fw / s;
  const ry = item.h - fh / s;
  item.fx = rx > 1e-6 ? clamp(sx / rx, 0, 1) : 0.5;
  item.fy = ry > 1e-6 ? clamp(sy / ry, 0, 1) : 0.5;
}

function applyCrop(img, item, fw, fh) {
  const g = cropGeom(item, fw, fh);
  img.style.width = `${g.w}px`;
  img.style.height = `${g.h}px`;
  img.style.transform = `translate(${g.x}px, ${g.y}px)`;
}

function zoomAt(item, zoom, fw, fh, ax, ay) {
  const g = cropGeom(item, fw, fh);
  const px = g.sx + ax / g.s;
  const py = g.sy + ay / g.s;
  item.zoom = clamp(zoom, 1, MAX_ZOOM);
  const s2 = Math.max(fw / item.w, fh / item.h) * item.zoom;
  setWindow(item, fw, fh, px - ax / s2, py - ay / s2);
}

/* ---------- image import ---------- */

async function decodeImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { img, url };
}

// Small pool of Web Workers. Idle workers are shut down after a moment to give the memory back.
function createWorkerPool(url, size) {
  let workers = [];
  let idle = [];
  const queue = [];
  let timer = 0;

  function terminate() {
    clearTimeout(timer);
    workers.forEach((w) => w.terminate());
    workers = [];
    idle = [];
  }

  function fail(worker, err) {
    const job = worker.job;
    worker.job = null;
    worker.terminate();
    workers = workers.filter((w) => w !== worker);
    idle = idle.filter((w) => w !== worker);
    if (job) job.reject(err);
    pump();
  }

  function spawn() {
    const worker = new Worker(url);
    worker.job = null;
    worker.onmessage = (e) => {
      const job = worker.job;
      worker.job = null;
      idle.push(worker);
      if (job) (e.data.error ? job.reject(new Error(e.data.error)) : job.resolve(e.data));
      pump();
    };
    worker.onerror = () => fail(worker, new Error('worker failed'));
    workers.push(worker);
    return worker;
  }

  function pump() {
    clearTimeout(timer);
    while (queue.length) {
      let worker = idle.pop();
      if (!worker) {
        if (workers.length >= size) return;
        worker = spawn();
      }
      const job = queue.shift();
      worker.job = job;
      try {
        worker.postMessage(job.message, job.transfer || []);
      } catch (err) {
        fail(worker, err);
      }
    }
    if (workers.length > 0 && idle.length === workers.length) timer = setTimeout(terminate, 2000);
  }

  return {
    run: (message, transfer) => new Promise((resolve, reject) => { queue.push({ message, transfer, resolve, reject }); pump(); }),
    terminate,
    count: () => workers.length,
  };
}

const cores = navigator.hardwareConcurrency || 4;
const imagePool = createWorkerPool('image-worker.js', Math.min(3, Math.max(2, cores >> 1)));
const heicPool = createWorkerPool('heic-worker.js', Math.min(3, Math.max(2, cores >> 1)));
const IMPORT_CONCURRENCY = Math.min(3, Math.max(2, cores >> 1)) + 1;

// HEIC that the browser cannot decode itself is decoded by libheif in the workers.
async function heicConvert(file, maxEdge) {
  const buffer = await file.arrayBuffer();
  return heicPool.run({ buffer, maxEdge }, [buffer]);
}

// Shrunk JPEG of a photo made in a worker. Rejects where workers / OffscreenCanvas are not available.
function workerImage(file, maxEdge, quality) {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return Promise.reject(new Error('no worker support'));
  return imagePool.run({ file, maxEdge, quality });
}

function scaleToBlob(img, w, h, maxEdge, quality) {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の変換に失敗しました'))), 'image/jpeg', quality);
  });
}

// item.srcBlob is the 1600px working copy (used by the editor and the final render).
// It is expensive, so for normal photos it is made lazily (see getSource / warmSources).
function newItem(file, w, h, thumb, srcBlob = null) {
  return { id: nextId++, name: file.name, file, w, h, srcBlob, srcPromise: null, thumbUrl: URL.createObjectURL(thumb), zoom: 1, fx: 0.5, fy: 0.5 };
}

async function importHeic(file) {
  const r = await heicConvert(file, SRC_MAX);
  const canvas = document.createElement('canvas');
  canvas.width = r.outW;
  canvas.height = r.outH;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.outW, r.outH), 0, 0);
  // the pixels are already decoded here, so the working copy is cheap to keep
  const srcBlob = await scaleToBlob(canvas, r.outW, r.outH, SRC_MAX, 0.92);
  const thumb = await scaleToBlob(canvas, r.outW, r.outH, THUMB_MAX, 0.8);
  return newItem(file, r.w, r.h, thumb, srcBlob);
}

async function importFile(file) {
  try {
    const r = await workerImage(file, THUMB_MAX, 0.8);
    return newItem(file, r.w, r.h, r.blob);
  } catch (e) { /* not decodable in a worker here: try the main thread */ }

  let opened = null;
  try {
    opened = await decodeImage(file);
  } catch (e) {
    if (!isHeic(file)) throw e;
  }
  if (!opened) return importHeic(file);

  try {
    const w = opened.img.naturalWidth;
    const h = opened.img.naturalHeight;
    const thumb = await scaleToBlob(opened.img, w, h, THUMB_MAX, 0.8);
    return newItem(file, w, h, thumb);
  } finally {
    URL.revokeObjectURL(opened.url);
  }
}

function getSource(item) {
  if (item.srcBlob) return Promise.resolve(item.srcBlob);
  if (!item.srcPromise) {
    item.srcPromise = (async () => {
      try {
        item.srcBlob = (await workerImage(item.file, SRC_MAX, 0.92)).blob;
        return item.srcBlob;
      } catch (e) { /* fall back to the main thread */ }
      const { img, url } = await decodeImage(item.file);
      try {
        item.srcBlob = await scaleToBlob(img, img.naturalWidth, img.naturalHeight, SRC_MAX, 0.92);
        return item.srcBlob;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
  }
  return item.srcPromise;
}

// Prepares the working copies in the background while the user arranges the photos.
let warming = false;
async function warmSources() {
  if (warming) return;
  warming = true;
  try {
    for (;;) {
      const pending = state.items.filter((it) => it && !it.srcBlob && !it.srcPromise);
      if (pending.length === 0) break;
      while (drag || editorOpen() || state.busy) await new Promise((r) => setTimeout(r, 150));
      await Promise.all(pending.slice(0, 2).map((it) => getSource(it).catch(() => {})));
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    warming = false;
  }
}

async function addFiles(files) {
  const empties = [];
  for (let i = 0; i < cellCount(); i++) if (!state.items[i]) empties.push(i);
  if (empties.length === 0 || files.length === 0) return;
  const use = files.slice(0, empties.length);
  const skipped = files.length - use.length;
  const failed = [];

  setBusy(true);
  let next = 0;
  let done = 0;
  setNote(`読み込み中… 0 / ${use.length}`);
  const lane = async () => {
    while (next < use.length) {
      const k = next++;
      try {
        state.items[empties[k]] = await importFile(use[k]);
      } catch (e) {
        failed.push(use[k].name);
      }
      done++;
      setNote(`読み込み中… ${done} / ${use.length}`);
      renderGrid();
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, use.length) }, lane));
  setBusy(false);
  warmSources();

  const msgs = [];
  if (skipped > 0) msgs.push(`枠を超えた ${skipped} 枚は追加されませんでした。`);
  if (failed.length) msgs.push(`読み込めなかった画像: ${failed.join(', ')}`);
  setNote(msgs.join('\n'), failed.length > 0);
  updateStatus();
}

async function replaceImage(file) {
  const i = targetIndex;
  targetIndex = null;
  if (!file || i === null) return;

  setBusy(true);
  setNote('読み込み中…');
  try {
    const item = await importFile(file);
    if (state.items[i]) URL.revokeObjectURL(state.items[i].thumbUrl);
    state.items[i] = item;
    setNote('');
  } catch (e) {
    setNote(`読み込めなかった画像: ${file.name}`, true);
  }
  setBusy(false);
  warmSources();
  renderGrid();
  if (editorOpen() && editor.index === i) showEditorImage();
}

/* ---------- grid ---------- */

function layoutGrid() {
  const { cols } = state;
  const [uw, uh] = cellUnits();
  const cap = Math.floor(160 * Math.min(1, uw / uh));
  cellPx.w = Math.max(8, Math.min(Math.floor(el.gridWrap.clientWidth / cols), cap));
  cellPx.h = Math.round(cellPx.w * uh / uw);
  el.grid.style.gridTemplateColumns = `repeat(${cols}, ${cellPx.w}px)`;
  el.grid.style.gridAutoRows = `${cellPx.h}px`;
}

function renderGrid() {
  layoutGrid();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < cellCount(); i++) {
    const item = state.items[i];
    const cell = document.createElement('div');
    cell.dataset.i = i;
    cell.className = 'cell';
    if (!item) {
      cell.classList.add('empty');
    } else {
      if (isMismatch(item)) cell.classList.add('mismatch');
      const img = new Image();
      img.src = item.thumbUrl;
      img.alt = '';
      img.draggable = false;
      applyCrop(img, item, cellPx.w, cellPx.h);
      cell.appendChild(img);
    }
    frag.appendChild(cell);
  }
  el.grid.replaceChildren(frag);
  updateStatus();
}

function updateStatus() {
  const n = cellCount();
  const filled = filledItems();
  const mismatches = filled.filter(isMismatch).length;

  const { cw, ch } = computeCellSize();
  el.total.textContent = n;
  el.outSize.textContent = `${cw * state.cols}×${ch * state.rows}px`;
  el.status.textContent = `${filled.length} / ${n} 枚を選択中` + (filled.length > 0 && filled.length < n ? '（空の枠は白で保存されます）' : '');
  el.pickLabel.textContent = filled.length === 0 ? '画像を選ぶ' : '画像を追加';
  el.pick.classList.toggle('solid', filled.length === 0);
  el.meterFill.style.width = `${(filled.length / n) * 100}%`;
  el.dockCount.textContent = filled.length;
  el.dockTotal.textContent = `/ ${n}`;
  document.querySelectorAll('.step').forEach((b) => {
    const v = Number(document.getElementById(b.dataset.target).value);
    b.disabled = (Number(b.dataset.delta) < 0 && v <= 1) || (Number(b.dataset.delta) > 0 && v >= 10);
  });
  el.pick.disabled = state.busy || filled.length >= n;
  el.clear.disabled = state.busy || !state.items.some(Boolean);
  el.build.disabled = state.busy || filled.length === 0;
  el.editReplace.disabled = state.busy;
  el.shuffle.disabled = state.busy || filled.length < 2;

  const [cu, cv] = cellUnits();
  const dir = cu < cv ? '横向き' : '縦向き';

  const square = cu === cv;
  document.querySelectorAll('input[name="orientation"]').forEach((r) => { r.disabled = square; });
  el.orientField.classList.toggle('off', square);
  el.oriPortraitRatio.textContent = RATIOS[state.ratio].join(':');
  el.oriLandscapeRatio.textContent = [...RATIOS[state.ratio]].reverse().join(':');
  el.warn.textContent = mismatches > 0
    ? `${dir}の画像が ${mismatches} 枚あります。枠に合わせて切り取られます。タップで位置を調整できます。`
    : '';
}

function setBusy(flag) {
  state.busy = flag;
  updateStatus();
}

function swapItems(a, b) {
  [state.items[a], state.items[b]] = [state.items[b], state.items[a]];
}

// Random new order for the photos that are placed; empty cells stay where they are.
function shuffleItems() {
  const slots = [];
  for (let i = 0; i < cellCount(); i++) if (state.items[i]) slots.push(i);
  if (slots.length < 2) return;

  const before = slots.map((i) => state.items[i]);
  let after = before;
  for (let attempt = 0; attempt < 20 && after.every((it, k) => it === before[k]); attempt++) {
    after = before.slice();
    for (let k = after.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [after[k], after[j]] = [after[j], after[k]];
    }
  }
  slots.forEach((slot, k) => { state.items[slot] = after[k]; });
  renderGrid();
  el.grid.classList.remove('shuffled');
  void el.grid.offsetWidth;
  el.grid.classList.add('shuffled');
}

function clearAll() {
  state.items.forEach((it) => it && URL.revokeObjectURL(it.thumbUrl));
  state.items = [];
  setNote('');
  renderGrid();
}

/* ---------- drag & tap on the grid ---------- */

let drag = null;
let scrollSpeed = 0;

function autoScrollLoop() {
  if (!drag || !drag.active) return;
  if (scrollSpeed) window.scrollBy(0, scrollSpeed);
  requestAnimationFrame(autoScrollLoop);
}

function onPointerDown(e) {
  if (state.busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const cell = e.target.closest('.cell');
  if (!cell || drag) return;
  drag = { id: e.pointerId, from: Number(cell.dataset.i), x: e.clientX, y: e.clientY, active: false, ghost: null, over: null, cell };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

function startDrag() {
  const rect = drag.cell.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.appendChild(drag.cell.querySelector('img').cloneNode());
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  drag.w = rect.width;
  drag.h = rect.height;
  drag.active = true;
  drag.cell.classList.add('dragging');
  requestAnimationFrame(autoScrollLoop);
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.active) {
    if (!state.items[drag.from]) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
    startDrag();
  }
  drag.ghost.style.transform = `translate(${e.clientX - drag.w / 2}px, ${e.clientY - drag.h / 2}px)`;

  const edge = 70;
  const vh = window.innerHeight;
  scrollSpeed = e.clientY < edge ? -Math.ceil((edge - e.clientY) / 6) : e.clientY > vh - edge ? Math.ceil((e.clientY - (vh - edge)) / 6) : 0;

  const target = document.elementFromPoint(e.clientX, e.clientY);
  const over = target && target.closest ? target.closest('#grid .cell') : null;
  const valid = over && Number(over.dataset.i) !== drag.from ? over : null;
  if (drag.over !== valid) {
    if (drag.over) drag.over.classList.remove('over');
    if (valid) valid.classList.add('over');
    drag.over = valid;
  }
}

function endDrag() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  if (drag && drag.ghost) drag.ghost.remove();
  drag = null;
  scrollSpeed = 0;
}

function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { active, from, over } = drag;
  endDrag();

  if (active) {
    if (over) swapItems(from, Number(over.dataset.i));
    renderGrid();
    return;
  }

  if (state.items[from]) {
    openEditor(from);
  } else {
    targetIndex = from;
    el.fileOne.click();
  }
}

function onPointerCancel(e) {
  if (!drag || e.pointerId !== drag.id) return;
  endDrag();
  renderGrid();
}

/* ---------- crop editor ---------- */

const editorOpen = () => !el.editor.hidden;
const editorItem = () => (editor.index === null ? null : state.items[editor.index]);

function openEditor(index) {
  editor.index = index;
  el.editor.hidden = false;
  layoutEditor();
  showEditorImage();
}

function layoutEditor() {
  const [uw, uh] = cellUnits();
  const sheet = el.editor.querySelector('.sheet');
  const pad = parseFloat(getComputedStyle(sheet).paddingLeft) * 2;
  const availW = Math.min(sheet.clientWidth - pad, 440);
  const availH = Math.max(200, window.innerHeight - 360);
  const u = Math.max(1, Math.floor(Math.min(availW / uw, availH / uh)));
  editor.fw = u * uw;
  editor.fh = u * uh;
  el.frame.style.width = `${editor.fw}px`;
  el.frame.style.height = `${editor.fh}px`;
  paintEditor();
}

async function showEditorImage() {
  const item = editorItem();
  if (!item) { closeEditor(); return; }
  if (editor.url) URL.revokeObjectURL(editor.url);
  editor.url = null;
  el.frameImg.src = item.thumbUrl;
  paintEditor();
  try {
    const blob = await getSource(item);
    if (editorItem() !== item) return;
    editor.url = URL.createObjectURL(blob);
    el.frameImg.src = editor.url;
    await el.frameImg.decode();
  } catch (e) { /* the thumbnail stays */ }
  paintEditor();
}

function paintEditor() {
  const item = editorItem();
  if (!item) return;
  applyCrop(el.frameImg, item, editor.fw, editor.fh);
  el.zoom.value = item.zoom;
  el.zoomVal.textContent = `${item.zoom.toFixed(1)}×`;
}

function closeEditor() {
  el.editor.hidden = true;
  touches.clear();
  gesture = null;
  if (editor.url) URL.revokeObjectURL(editor.url);
  editor.url = null;
  el.frameImg.removeAttribute('src');
  editor.index = null;
  renderGrid();
}

const touches = new Map();
let gesture = null;

function framePoint(e) {
  const r = el.frame.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function beginGesture() {
  const item = editorItem();
  const pts = [...touches.values()];
  if (!item || pts.length === 0) { gesture = null; return; }
  const g = cropGeom(item, editor.fw, editor.fh);
  if (pts.length === 1) {
    gesture = { type: 'pan', x: pts[0].x, y: pts[0].y, sx: g.sx, sy: g.sy, s: g.s };
  } else {
    const [a, b] = pts;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: item.zoom, px: g.sx + mx / g.s, py: g.sy + my / g.s };
  }
}

function applyGesture() {
  const item = editorItem();
  if (!item || !gesture) return;
  const pts = [...touches.values()];
  const { fw, fh } = editor;
  if (gesture.type === 'pan') {
    const p = pts[0];
    setWindow(item, fw, fh, gesture.sx - (p.x - gesture.x) / gesture.s, gesture.sy - (p.y - gesture.y) / gesture.s);
  } else if (pts.length >= 2) {
    const [a, b] = pts;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    item.zoom = clamp(gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d, 1, MAX_ZOOM);
    const s2 = Math.max(fw / item.w, fh / item.h) * item.zoom;
    setWindow(item, fw, fh, gesture.px - mx / s2, gesture.py - my / s2);
  }
  paintEditor();
}

el.frame.addEventListener('pointerdown', (e) => {
  if (touches.size >= 2) return;
  touches.set(e.pointerId, framePoint(e));
  el.frame.setPointerCapture(e.pointerId);
  beginGesture();
});
el.frame.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, framePoint(e));
  applyGesture();
});
const releasePointer = (e) => {
  if (!touches.delete(e.pointerId)) return;
  beginGesture();
};
el.frame.addEventListener('pointerup', releasePointer);
el.frame.addEventListener('pointercancel', releasePointer);
el.frame.addEventListener('wheel', (e) => {
  e.preventDefault();
  const item = editorItem();
  if (!item) return;
  const p = framePoint(e);
  zoomAt(item, item.zoom * Math.exp(-e.deltaY * 0.002), editor.fw, editor.fh, p.x, p.y);
  paintEditor();
}, { passive: false });

el.zoom.addEventListener('input', () => {
  const item = editorItem();
  if (!item) return;
  zoomAt(item, Number(el.zoom.value), editor.fw, editor.fh, editor.fw / 2, editor.fh / 2);
  paintEditor();
});
el.editReset.addEventListener('click', () => {
  const item = editorItem();
  if (!item) return;
  item.zoom = 1;
  item.fx = 0.5;
  item.fy = 0.5;
  paintEditor();
});
el.editReplace.addEventListener('click', () => {
  if (editor.index === null) return;
  targetIndex = editor.index;
  el.fileOne.click();
});
el.editDone.addEventListener('click', closeEditor);
el.editor.addEventListener('click', (e) => { if (e.target === el.editor) closeEditor(); });

/* ---------- collage output ---------- */

function computeCellSize() {
  const [uw, uh] = cellUnits();
  const { rows, cols } = state;
  const u = Math.max(1, Math.min(
    Math.floor(MAX_SIDE / (uw * cols)),
    Math.floor(MAX_SIDE / (uh * rows)),
    Math.floor(Math.sqrt(MAX_AREA / (uw * uh * rows * cols))),
    Math.floor(SRC_MAX / Math.max(uw, uh)),
  ));
  return { cw: uw * u, ch: uh * u };
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

async function buildCollage() {
  const { rows, cols } = state;
  const { cw, ch } = computeCellSize();

  const canvas = document.createElement('canvas');
  canvas.width = cw * cols;
  canvas.height = ch * rows;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';

  const total = rows * cols;
  for (let i = 0; i < total; i++) {
    const item = state.items[i];
    if (!item) continue;
    setNote(`作成中… ${i + 1} / ${total}`);
    const { img, url } = await decodeImage(await getSource(item));
    try {
      const g = cropGeom({ w: img.naturalWidth, h: img.naturalHeight, zoom: item.zoom, fx: item.fx, fy: item.fy }, cw, ch);
      ctx.drawImage(img, g.sx, g.sy, g.sw, g.sh, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
    } finally {
      URL.revokeObjectURL(url);
    }
    await nextFrame();
  }

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の書き出しに失敗しました'))), 'image/jpeg', 0.92);
  });
  return { blob, width: canvas.width, height: canvas.height };
}

// grid_collage_YYYY_MMDD_HHMM_mmmm.jpg — the last block is the milliseconds (zero-padded to 4 digits).
function nextFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}_${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  return `grid_collage_${stamp}_${String(d.getMilliseconds()).padStart(4, '0')}.jpg`;
}

async function onBuild() {
  setBusy(true);
  try {
    const { blob, width, height } = await buildCollage();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    const name = nextFileName();
    resultFile = new File([blob], name, { type: 'image/jpeg' });

    el.result.src = resultUrl;
    el.download.href = resultUrl;
    el.download.download = name;
    el.resultInfo.textContent = `${width} × ${height}px / ${(blob.size / 1048576).toFixed(1)}MB`;

    const canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [resultFile] }));
    el.save.hidden = !canShare;
    el.modalHint.textContent = canShare
      ? '「カメラロールに保存」を押して、共有メニューから「画像を保存」を選んでください。'
      : '画像を長押しして「写真に追加」などを選ぶか、ダウンロードしてください。';

    setNote('');
    el.modal.hidden = false;
  } catch (e) {
    setNote(`作成に失敗しました: ${e.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function onSave() {
  if (!resultFile) return;
  try {
    await navigator.share({ files: [resultFile] });
  } catch (e) {
    if (e.name !== 'AbortError') {
      el.modalHint.textContent = '共有に失敗しました。画像を長押しするか、ダウンロードしてください。';
    }
  }
}

/* ---------- wiring ---------- */

function fillSelect(select, value) {
  for (let n = 1; n <= 10; n++) select.add(new Option(String(n), String(n)));
  select.value = String(value);
}
fillSelect(el.rows, state.rows);
fillSelect(el.cols, state.cols);

document.querySelectorAll('input[name="ratio"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    state.ratio = radio.value;
    setNote('');
    renderGrid();
    if (editorOpen()) layoutEditor();
  });
});
document.querySelectorAll('input[name="orientation"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    state.orientation = radio.value;
    setNote('');
    renderGrid();
  });
});
el.rows.addEventListener('change', () => { state.rows = Number(el.rows.value); setNote(''); renderGrid(); });
el.cols.addEventListener('change', () => { state.cols = Number(el.cols.value); setNote(''); renderGrid(); });

document.querySelectorAll('.step').forEach((btn) => {
  btn.addEventListener('click', () => {
    const select = document.getElementById(btn.dataset.target);
    const next = clamp(Number(select.value) + Number(btn.dataset.delta), 1, 10);
    if (String(next) === select.value) return;
    select.value = String(next);
    select.dispatchEvent(new Event('change'));
  });
});

el.pick.addEventListener('click', () => el.file.click());
el.clear.addEventListener('click', clearAll);
el.shuffle.addEventListener('click', shuffleItems);
el.file.addEventListener('change', () => {
  const files = Array.from(el.file.files);
  el.file.value = '';
  addFiles(files);
});
el.fileOne.addEventListener('change', () => {
  const file = el.fileOne.files[0];
  el.fileOne.value = '';
  replaceImage(file);
});
el.build.addEventListener('click', onBuild);
el.save.addEventListener('click', onSave);
el.close.addEventListener('click', () => { el.modal.hidden = true; });
el.modal.addEventListener('click', (e) => { if (e.target === el.modal) el.modal.hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (editorOpen()) closeEditor();
  else el.modal.hidden = true;
});

el.grid.addEventListener('pointerdown', onPointerDown);
el.grid.addEventListener('dragstart', (e) => e.preventDefault());
el.grid.addEventListener('contextmenu', (e) => e.preventDefault());

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (editorOpen()) layoutEditor();
    else if (!drag) renderGrid();
  }, 100);
});

renderGrid();
