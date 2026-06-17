// app.js — PinRange live range finder.
// Point the camera, frame the pin between the A/B brackets (drag, nudge, or
// auto-aim), read yardage live. Lock to freeze a steady reading. Digital zoom
// magnifies the view for precise placement WITHOUT changing the image-pixel
// coordinates the math runs on (so distance is unaffected by zoom).
import {
  REFERENCES, DEFAULT_FOCAL_RATIO, M_PER_YARD,
  distanceFromTaps, detectPin, slopeAdjust,
  focalRatioToRadPerPx, calibrateFocalRatio, focalRatioToFovDeg,
  containTransform, imageToView, viewToImage,
  refineEdgeY, measurementUncertaintyYards,
} from './rangefinder.js';

// ---------- persisted device constants ----------
const LS = {
  get focalRatio() { return parseFloat(localStorage.getItem('pinrange.focalRatio')) || DEFAULT_FOCAL_RATIO; },
  set focalRatio(v) { localStorage.setItem('pinrange.focalRatio', String(v)); },
  get metersPrimary() { return localStorage.getItem('pinrange.meters') === '1'; },
  set metersPrimary(v) { localStorage.setItem('pinrange.meters', v ? '1' : '0'); },
  get calibrated() { return localStorage.getItem('pinrange.calibrated') === '1'; },
  set calibrated(v) { localStorage.setItem('pinrange.calibrated', v ? '1' : '0'); },
  get tournament() { return localStorage.getItem('pinrange.tournament') === '1'; },
  set tournament(v) { localStorage.setItem('pinrange.tournament', v ? '1' : '0'); },
};

const $ = (id) => document.getElementById(id);
const video = $('video'), frame = $('frame'), fctx = frame.getContext('2d');
const overlay = $('overlay'), octx = overlay.getContext('2d');
const loupe = $('loupe'), loupeCanvas = $('loupeCanvas'), lctx = loupeCanvas.getContext('2d');
const stage = $('stage');
const refSelect = $('refSelect'), customWrap = $('customWrap'), customFeet = $('customFeet');
const lockBtn = $('lockBtn'), autoBtn = $('autoBtn'), slopeBtn = $('slopeBtn'), photoBtn = $('photoBtn'), photoInput = $('photoInput'), calibBtn = $('calibBtn');
const zoomRange = $('zoomRange'), zoomLabel = $('zoomLabel');
const distMain = $('distMain'), distSub = $('distSub'), distSlope = $('distSlope'), distWarn = $('distWarn');
const tournamentToggle = $('tournamentToggle');
const liveHint = $('liveHint'), statline = $('statline'), autoState = $('autoState');
const nudgeAup = $('nudgeAup'), nudgeAdn = $('nudgeAdn'), nudgeBup = $('nudgeBup'), nudgeBdn = $('nudgeBdn');
const snapBtn = $('snapBtn'), laserInput = $('laserInput'), logBtn = $('logBtn'), csvBtn = $('csvBtn');
const refinePad = $('refinePad'), refineActive = $('refineActive');
const moreBtn = $('moreBtn'), sheetClose = $('sheetClose'), sheet = $('sheet');
const calibModal = $('calibModal'), calFeet = $('calFeet'), calYards = $('calYards');
const calState = $('calState'), calCurrent = $('calCurrent');
const calSaveBtn = $('calSaveBtn'), calResetBtn = $('calResetBtn'), calCloseBtn = $('calCloseBtn');
const unitToggle = $('unitToggle');

// ---------- state ----------
let mode = 'live';        // 'live' (camera) | 'locked' (still frame)
let frozen = null;        // {bitmap, iw, ih} when locked or photo loaded
let A = null, B = null;   // markers in SOURCE image pixels
let dragging = null;
let autoAim = false, lastDetect = 0;
let zoom = 1;
let slopeOn = false, motionReady = false, pitchDeg = 0;
let videoTrack = null;        // live camera track, for sensor diagnostics
let active = 'A';             // bracket the refine-pad controls: 'A'=TOP, 'B'=BOTTOM
let refined = false;          // were the current markers sub-pixel edge-snapped?
let lastReading = null;       // latest computed reading, for validation logging
const logRows = [];           // validation log
const colCanvas = document.createElement('canvas');
const colCtx = colCanvas.getContext('2d', { willReadFrequently: true });
let curT = null;          // current containTransform, refreshed each render
const detCanvas = document.createElement('canvas');
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

// ---------- reference dropdown ----------
for (const r of REFERENCES) {
  const o = document.createElement('option');
  o.value = r.id; o.textContent = r.label; refSelect.appendChild(o);
}
function currentRefFeet() {
  const r = REFERENCES.find((x) => x.id === refSelect.value);
  return r && r.feet != null ? r.feet : (parseFloat(customFeet.value) || 0);
}
refSelect.addEventListener('change', () => {
  customWrap.classList.toggle('hidden', refSelect.value !== 'custom');
  render();
});

// ---------- source + transform ----------
function srcDims() {
  return mode === 'live'
    ? { iw: video.videoWidth, ih: video.videoHeight }
    : { iw: frozen.iw, ih: frozen.ih };
}
function srcBitmap() { return mode === 'live' ? video : frozen.bitmap; }
function focusPoint() {
  const { iw, ih } = srcDims();
  if (mode === 'locked' && A && B) return { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  return { x: iw / 2, y: ih / 2 };
}
function transform() {
  const { iw, ih } = srcDims();
  return containTransform(overlay.clientWidth, overlay.clientHeight, iw, ih, zoom, focusPoint());
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function ensureMarkers() {
  const { iw, ih } = srcDims();
  if (!iw || !ih) return false;
  if (!A) A = { x: iw / 2, y: ih * 0.30 };
  if (!B) B = { x: iw / 2, y: ih * 0.70 };
  return true;
}

// ---------- camera ----------
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    statline.textContent = 'Camera API unavailable — open over https:// or localhost.'; return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
    });
    video.srcObject = stream;
    videoTrack = stream.getVideoTracks()[0] || null;
    await video.play();
    statline.textContent = `Camera ${video.videoWidth}×${video.videoHeight} · ` +
      (LS.calibrated ? 'calibrated ✓' : 'default FOV — calibrate ⚙︎ for accuracy');
  } catch (err) {
    statline.textContent = 'Camera blocked: ' + err.message + ' — needs https:// (or localhost) + permission. Use 📁 to test with a photo.';
  }
}
video.addEventListener('loadedmetadata', () => { ensureMarkers(); resizeCanvases(); });

// Sensor diagnostics: did iOS silently switch lens / crop (EIS) / change zoom
// between shots? Logged per reading so the lamp-anomaly hypothesis is testable.
function camInfo() {
  try {
    const s = (videoTrack && videoTrack.getSettings && videoTrack.getSettings()) || {};
    return { camW: s.width || '', camH: s.height || '', camZoom: s.zoom ?? '', facing: s.facingMode || '' };
  } catch { return { camW: '', camH: '', camZoom: '', facing: '' }; }
}

// ---------- canvas sizing ----------
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  for (const [c, ctx] of [[overlay, octx], [frame, fctx]]) {
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
window.addEventListener('resize', resizeCanvases);

// ---------- render loop ----------
function tick(now) {
  if (mode === 'live' && video.videoWidth) {
    ensureMarkers();
    if (autoAim && now - lastDetect > 90) { lastDetect = now; runAutoAim(); }
  }
  render();
  requestAnimationFrame(tick);
}
// compute + draw together; also called directly after each interaction so the
// view updates instantly even if rAF is throttled (e.g. backgrounded tab).
function render() {
  if (!srcDims().iw) return;
  curT = transform();
  drawView();
  compute();
  drawOverlay();
}

function drawView() {
  const W = overlay.clientWidth, H = overlay.clientHeight;
  fctx.clearRect(0, 0, W, H);
  fctx.fillStyle = '#000'; fctx.fillRect(0, 0, W, H); // hide the <video> behind
  const { iw, ih } = srcDims();
  fctx.drawImage(srcBitmap(), curT.ox, curT.oy, iw * curT.scale, ih * curT.scale);
}

function drawOverlay() {
  const W = overlay.clientWidth, H = overlay.clientHeight;
  octx.clearRect(0, 0, W, H);
  if (!A || !B) return;
  const a = imageToView(A, curT), b = imageToView(B, curT);
  const half = Math.max(36, W * 0.16);
  if (mode === 'live') {
    octx.strokeStyle = 'rgba(124,252,0,.35)'; octx.lineWidth = 1; octx.setLineDash([6, 6]);
    octx.beginPath(); octx.moveTo(W / 2, 0); octx.lineTo(W / 2, H); octx.stroke();
    octx.setLineDash([]);
  }
  octx.strokeStyle = 'rgba(124,252,0,.85)'; octx.lineWidth = 2;
  octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  bracket(a, '#ffd23f', 'TOP', half); bracket(b, '#3fd0ff', 'BOTTOM', half);
}
function bracket(p, color, label, half) {
  octx.strokeStyle = color; octx.fillStyle = color; octx.lineWidth = 3;
  octx.beginPath(); octx.moveTo(p.x - half, p.y); octx.lineTo(p.x + half, p.y); octx.stroke();
  octx.beginPath();
  octx.moveTo(p.x - half, p.y - 8); octx.lineTo(p.x - half, p.y + 8);
  octx.moveTo(p.x + half, p.y - 8); octx.lineTo(p.x + half, p.y + 8);
  octx.stroke();
  octx.font = 'bold 16px system-ui'; octx.fillText(label, p.x + half + 6, p.y + 5);
}

// ---------- auto-aim detection ----------
function runAutoAim() {
  const { iw, ih } = srcDims(); if (!iw) return;
  const dw = 120, dh = Math.max(8, Math.round((dw * ih) / iw));
  detCanvas.width = dw; detCanvas.height = dh;
  detCtx.drawImage(srcBitmap(), 0, 0, dw, dh);
  const img = detCtx.getImageData(0, 0, dw, dh).data;
  const det = detectPin(img, dw, dh, { band: 0.6 });
  // only move the brackets when the flag-anchored detector is actually confident
  if (det && det.confidence >= 0.4) {
    const sx = iw / dw, sy = ih / dh;
    A = { x: det.xCol * sx, y: det.yTop * sy };
    B = { x: det.xCol * sx, y: det.yBottom * sy };
    refined = false;
    autoState.textContent = `🎯 pin ${Math.round(det.confidence * 100)}%`;
  } else {
    autoState.textContent = '🎯 searching for a flag…';
  }
}

// ---------- pointer drag ----------
function localXY(e) { const r = overlay.getBoundingClientRect(); return { cx: e.clientX - r.left, cy: e.clientY - r.top }; }
overlay.addEventListener('pointerdown', (e) => {
  if (!ensureMarkers()) return;
  overlay.setPointerCapture(e.pointerId);
  autoAim = false; autoBtn.classList.remove('on'); autoState.textContent = '';
  const { cx, cy } = localXY(e);
  const a = imageToView(A, curT), b = imageToView(B, curT);
  dragging = Math.abs(cy - a.y) <= Math.abs(cy - b.y) ? 'A' : 'B';
  moveMarker(cx, cy); showLoupe(cx, cy);
});
overlay.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const { cx, cy } = localXY(e); moveMarker(cx, cy); showLoupe(cx, cy);
});
function endDrag() { dragging = null; loupe.style.display = 'none'; }
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);
function moveMarker(cx, cy) {
  const { iw, ih } = srcDims();
  const p = viewToImage(cx, cy, curT, iw, ih);
  if (dragging === 'A') A = p; else B = p;
  refined = false;            // manual placement
  render();
}

// ---------- nudge ----------
function step() { return Math.max(1, srcDims().ih * 0.004); }
function nudge(which, dir) {
  if (!ensureMarkers()) return;
  autoAim = false; autoBtn.classList.remove('on');
  const m = which === 'A' ? A : B;
  m.y = clamp(m.y + dir * step(), 0, srcDims().ih);
  refined = false;            // manual move: no longer a snapped edge
  render();
}
nudgeAup.onclick = () => nudge('A', -1);
nudgeAdn.onclick = () => nudge('A', 1);
nudgeBup.onclick = () => nudge('B', -1);
nudgeBdn.onclick = () => nudge('B', 1);

// ---------- sub-pixel edge snapping ----------
// Sample a 1-px-wide luminance column down the source at the marker's x and snap
// the marker to the true tip/base edge. Removes finger-placement error.
function columnLuma(x) {
  const { ih } = srcDims();
  colCanvas.width = 1; colCanvas.height = ih;
  colCtx.drawImage(srcBitmap(), Math.round(clamp(x, 0, srcDims().iw - 1)), 0, 1, ih, 0, 0, 1, ih);
  const d = colCtx.getImageData(0, 0, 1, ih).data;
  const lum = new Float32Array(ih);
  for (let y = 0, j = 0; y < ih; y++, j += 4) lum[y] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return lum;
}
function snapEdges() {
  if (!ensureMarkers()) return;
  const half = Math.max(6, Math.round(srcDims().ih * 0.012));
  A.y = refineEdgeY(columnLuma(A.x), A.y, half);
  B.y = refineEdgeY(columnLuma(B.x), B.y, half);
  refined = true;
  render();
}
snapBtn.addEventListener('click', snapEdges);

// ---------- detached fine-tune trackpad (frozen mode) ----------
// Control space is separated from display space: you drag in the bottom zone,
// your finger never covers the pin. Velocity-based gain = sub-pixel precision.
function setActive(which) {
  active = which;
  refineActive.textContent = which === 'A' ? 'TOP' : 'BOTTOM';
  refineActive.classList.toggle('bot', which === 'B');
}
let padLastY = null, padMoved = 0;
refinePad.addEventListener('pointerdown', (e) => {
  if (mode !== 'locked' || !ensureMarkers()) return;
  refinePad.setPointerCapture(e.pointerId);
  padLastY = e.clientY; padMoved = 0;
  showActiveLoupe();
});
refinePad.addEventListener('pointermove', (e) => {
  if (padLastY == null || !curT || !(curT.scale > 1e-4)) return;
  const dy = e.clientY - padLastY; padLastY = e.clientY;
  padMoved += Math.abs(dy);
  const speed = Math.abs(dy);
  const gain = speed < 4 ? 0.2 : speed < 12 ? 0.55 : 0.9;   // slow = fine (5:1)
  const m = active === 'A' ? A : B;
  m.y = clamp(m.y + (dy / curT.scale) * gain, 0, srcDims().ih);
  refined = false;
  showActiveLoupe(); render();
});
function endPad() {
  if (padLastY == null) return;
  padLastY = null; loupe.style.display = 'none';
  if (padMoved < 6) setActive(active === 'A' ? 'B' : 'A');  // tap toggles bracket
}
refinePad.addEventListener('pointerup', endPad);
refinePad.addEventListener('pointercancel', endPad);
function showActiveLoupe() {
  const m = active === 'A' ? A : B;
  if (!m || !srcDims().iw) return;
  const v = imageToView(m, curT);
  showLoupe(v.x, v.y);   // loupe sits at the bracket (upper frame), away from the thumb
}

// ---------- zoom ----------
zoomRange.addEventListener('input', () => {
  zoom = parseFloat(zoomRange.value);
  zoomLabel.textContent = zoom.toFixed(1) + '×';
  render();
});

// ---------- slope / pitch (IMU — no GPS) ----------
// Camera elevation above horizontal from the gravity vector: the back camera
// points along device -z, so elevation = atan2(-z, |(x,y)|). Orientation-robust
// (portrait or landscape). Exponentially smoothed to reject hand jitter — a full
// Kalman filter is unnecessary for a quasi-static reading.
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const p = Math.atan2(-a.z, Math.hypot(a.x, a.y)) * (180 / Math.PI);
  pitchDeg += 0.2 * (p - pitchDeg);
}
async function enableMotion() {
  try {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      const res = await DME.requestPermission();        // iOS 13+ gesture prompt
      if (res !== 'granted') return false;
    }
    window.addEventListener('devicemotion', onMotion);
    motionReady = true;
    return true;
  } catch { return false; }
}
slopeBtn.addEventListener('click', async () => {
  if (LS.tournament) { statline.textContent = 'Slope is disabled in tournament mode (⚙︎).'; return; }
  if (!slopeOn) {
    if (!motionReady && !(await enableMotion())) { statline.textContent = 'Motion sensor unavailable / blocked.'; return; }
    slopeOn = true; slopeBtn.classList.add('on');
  } else {
    slopeOn = false; slopeBtn.classList.remove('on');
  }
  render();
});
function applyTournament() {
  if (LS.tournament) { slopeOn = false; slopeBtn.classList.remove('on'); slopeBtn.disabled = true; }
  else { slopeBtn.disabled = false; }
}

// ---------- lock / auto / photo ----------
lockBtn.addEventListener('click', () => {
  if (mode === 'live') {
    if (!video.videoWidth) { statline.textContent = 'No camera frame to lock.'; return; }
    const iw = video.videoWidth, ih = video.videoHeight;
    const off = document.createElement('canvas'); off.width = iw; off.height = ih;
    off.getContext('2d').drawImage(video, 0, 0, iw, ih);
    frozen = { bitmap: off, iw, ih };
    mode = 'locked'; autoAim = false; autoBtn.classList.remove('on'); autoState.textContent = '';
    lockBtn.textContent = '▶ Live'; autoBtn.disabled = true;
    liveHint.classList.add('hidden');
    snapEdges();                 // auto sub-pixel snap on the steady frame
    setActive('A'); refinePad.classList.remove('hidden');
  } else {
    mode = 'live'; frozen = null; refined = false;
    lockBtn.textContent = '🔒 Lock reading'; autoBtn.disabled = false;
    liveHint.classList.remove('hidden');
    liveHint.textContent = 'Aim the center line at the flag · Lock, then fine-tune below';
    refinePad.classList.add('hidden');
  }
  render();
});

autoBtn.addEventListener('click', () => {
  if (mode !== 'live') return;
  autoAim = !autoAim; autoBtn.classList.toggle('on', autoAim);
  autoState.textContent = autoAim ? '🎯 searching…' : '';
});

photoBtn.addEventListener('click', () => photoInput.click());
photoInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  const img = new Image();
  img.onload = () => {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const off = document.createElement('canvas'); off.width = iw; off.height = ih;
    off.getContext('2d').drawImage(img, 0, 0);
    frozen = { bitmap: off, iw, ih };
    mode = 'locked'; A = B = null; ensureMarkers();
    lockBtn.textContent = '▶ Live'; autoBtn.disabled = true;
    setActive('A'); refinePad.classList.remove('hidden');
    liveHint.classList.add('hidden');
    URL.revokeObjectURL(img.src); render();
  };
  img.onerror = () => { statline.textContent = 'Could not read that image.'; };
  img.src = URL.createObjectURL(file); photoInput.value = '';
});

// ---------- loupe ----------
function showLoupe(cx, cy) {
  const { iw } = srcDims(); if (!iw) return;
  const p = viewToImage(cx, cy, curT, iw, srcDims().ih);
  const sz = 132 / 4;
  lctx.clearRect(0, 0, 132, 132); lctx.imageSmoothingEnabled = false;
  lctx.drawImage(srcBitmap(), p.x - sz / 2, p.y - sz / 2, sz, sz, 0, 0, 132, 132);
  const sr = stage.getBoundingClientRect();
  let lx = cx - 66, ly = cy - 160; if (ly < 6) ly = cy + 28;
  loupe.style.left = clamp(lx, 6, sr.width - 138) + 'px';
  loupe.style.top = clamp(ly, 6, sr.height - 138) + 'px';
  loupe.style.display = 'block';
}

// ---------- compute & display ----------
function compute() {
  if (!A || !B || !srcDims().iw) return;
  const refFeet = currentRefFeet();
  if (!(refFeet > 0)) { distMain.textContent = '—'; distSub.textContent = 'set a reference length'; return; }
  const longSide = Math.max(srcDims().iw, srcDims().ih);
  const radPerPx = focalRatioToRadPerPx(LS.focalRatio, longSide);
  const out = distanceFromTaps({ topPoint: A, bottomPoint: B, refFeet, radPerPx });

  const meters = LS.metersPrimary;
  const U = meters ? 'm' : 'yd';
  const conv = (yd) => meters ? yd * M_PER_YARD : yd;

  // honest refusal: below the resolution floor, 1 px = many yards (error ∝ 1/L²),
  // so a number here would be a lie. Refuse instead of guessing.
  const minPx = Math.max(34, Math.max(srcDims().iw, srcDims().ih) * 0.009);
  if (out.pixelLength < minPx) {
    distMain.innerHTML = `—<small>${U}</small>`;
    distSub.textContent = `${out.pixelLength.toFixed(0)} px — too small to range`;
    distSlope.classList.add('hidden');
    distWarn.textContent = '⚠︎ Target too far to range — get closer (or telephoto, native build).';
    distWarn.classList.remove('hidden');
    lastReading = null;
    return;
  }

  // ± uncertainty from pixel-placement error (tighter once edges are snapped)
  const errPx = refined ? 0.7 : 2.5;
  const uncYd = measurementUncertaintyYards({ yards: out.yards, pixelLength: out.pixelLength, errPx });
  const unc = conv(uncYd);
  const tag = refined ? '◎' : '○'; // snapped vs hand-placed

  const adj = slopeAdjust({ rawYards: out.yards, pitchDeg });
  if (slopeOn && !LS.tournament) {
    distMain.innerHTML = `${conv(adj.playsLikeYards).toFixed(0)}<small>${U} plays ±${unc.toFixed(1)}</small>`;
    const e = conv(adj.elevationYards);
    distSlope.textContent = `actual ${conv(adj.horizontalYards).toFixed(0)} ${U} · ${e >= 0 ? '↑' : '↓'}${Math.abs(e).toFixed(0)} ${U} · pitch ${pitchDeg.toFixed(0)}°`;
    distSlope.classList.remove('hidden');
    distSub.textContent = `${tag} line-of-sight ${conv(out.yards).toFixed(0)} ${U} · ${out.pixelLength.toFixed(0)} px · tilt ${out.tiltDeg.toFixed(1)}°`;
  } else {
    distMain.innerHTML = `${conv(out.yards).toFixed(0)}<small>${U} ±${unc.toFixed(1)}</small>`;
    const alt = meters ? out.yards : out.meters;
    distSub.textContent = `${tag} ${alt.toFixed(0)} ${meters ? 'yd' : 'm'} · ${out.pixelLength.toFixed(0)} px · tilt ${out.tiltDeg.toFixed(1)}°`;
    distSlope.classList.add('hidden');
  }

  lastReading = {
    ts: new Date().toISOString(),
    mode, reference: refSelect.value, refFeet,
    pixelLength: +out.pixelLength.toFixed(2), tiltDeg: +out.tiltDeg.toFixed(2),
    edgeSnapped: refined, slopeOn: slopeOn && !LS.tournament, pitchDeg: +pitchDeg.toFixed(2),
    lineOfSightYards: +out.yards.toFixed(2),
    horizontalYards: +adj.horizontalYards.toFixed(2),
    playsLikeYards: +adj.playsLikeYards.toFixed(2),
    elevationYards: +adj.elevationYards.toFixed(2),
    uncertaintyYards: +uncYd.toFixed(2),
    calibrated: LS.calibrated, fovDeg: +focalRatioToFovDeg(LS.focalRatio).toFixed(3),
    imgW: srcDims().iw, imgH: srcDims().ih, ...camInfo(),
  };

  let warn = '';
  if (out.tiltDeg > 18) warn = '⚠︎ Tilted — put TOP & BOTTOM on the true ends of the pin.';
  else if (out.pixelLength < 40) warn = '⚠︎ Reference tiny (<40 px) — get closer or zoom the optical camera for a reliable read.';
  else if (!LS.calibrated) warn = 'Default FOV — tap ⚙︎ to calibrate this phone for accurate yardage.';
  distWarn.textContent = warn; distWarn.classList.toggle('hidden', !warn);
  calState.textContent = `Marked length: ${out.pixelLength.toFixed(1)} px`;
}

// ---------- calibration ----------
calibBtn.addEventListener('click', () => {
  sheet.classList.add('hidden');
  unitToggle.checked = LS.metersPrimary;
  tournamentToggle.checked = LS.tournament;
  calCurrent.textContent = `Current: ${focalRatioToFovDeg(LS.focalRatio).toFixed(2)}° long-side FOV` + (LS.calibrated ? ' (calibrated)' : ' (default)');
  calibModal.classList.remove('hidden');
});
calCloseBtn.addEventListener('click', () => calibModal.classList.add('hidden'));
calResetBtn.addEventListener('click', () => { LS.focalRatio = DEFAULT_FOCAL_RATIO; LS.calibrated = false; calCurrent.textContent = `Reset to default (${focalRatioToFovDeg(DEFAULT_FOCAL_RATIO).toFixed(1)}°).`; render(); });
calSaveBtn.addEventListener('click', () => {
  if (!(A && B && srcDims().iw)) { calCurrent.textContent = 'Aim/mark a known target first.'; return; }
  const refFeet = parseFloat(calFeet.value), distYards = parseFloat(calYards.value);
  if (!(refFeet > 0) || !(distYards > 0)) { calCurrent.textContent = 'Enter positive height and distance.'; return; }
  const pixelLength = Math.hypot(B.x - A.x, B.y - A.y);
  const longSide = Math.max(srcDims().iw, srcDims().ih);
  LS.focalRatio = calibrateFocalRatio({ pixelLength, refFeet, distanceYards: distYards, longSide });
  LS.calibrated = true;
  calCurrent.textContent = `Saved ✓  ${focalRatioToFovDeg(LS.focalRatio).toFixed(2)}° long-side FOV.`;
  render();
});
unitToggle.addEventListener('change', () => { LS.metersPrimary = unitToggle.checked; render(); });
tournamentToggle.addEventListener('change', () => { LS.tournament = tournamentToggle.checked; applyTournament(); render(); });

// ---------- validation logging (for the laser ground-truth test) ----------
function updateCsvCount() { csvBtn.textContent = `⤓ CSV${logRows.length ? ' (' + logRows.length + ')' : ''}`; }
logBtn.addEventListener('click', () => {
  if (!lastReading) { statline.textContent = 'Nothing to log yet — get a reading first.'; return; }
  const laser = parseFloat(laserInput.value);
  logRows.push({ ...lastReading, laserYards: Number.isFinite(laser) ? laser : '' });
  laserInput.value = '';
  updateCsvCount();
  statline.textContent = `Logged #${logRows.length}` + (Number.isFinite(laser) ? ` (laser ${laser} yd)` : '');
});
csvBtn.addEventListener('click', () => {
  if (!logRows.length) { statline.textContent = 'Log some readings first.'; return; }
  const cols = ['ts', 'mode', 'reference', 'refFeet', 'pixelLength', 'tiltDeg', 'edgeSnapped',
    'slopeOn', 'pitchDeg', 'lineOfSightYards', 'horizontalYards', 'playsLikeYards', 'elevationYards',
    'uncertaintyYards', 'laserYards', 'calibrated', 'fovDeg', 'imgW', 'imgH',
    'camW', 'camH', 'camZoom', 'facing'];
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...logRows.map((r) => cols.map((c) => esc(r[c] ?? '')).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'pinrange-validation.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  statline.textContent = `Exported ${logRows.length} readings to CSV.`;
});

// ---------- tools sheet ----------
moreBtn.addEventListener('click', () => sheet.classList.toggle('hidden'));
sheetClose.addEventListener('click', () => sheet.classList.add('hidden'));

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- go ----------
applyTournament();
resizeCanvases();
startCamera();
requestAnimationFrame(tick);
