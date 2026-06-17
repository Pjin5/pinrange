// rangefinder.js — core distance math for the golf pin range finder.
//
// This is a faithful port of the distance computation in pin_dist0.py, the
// only difference being WHERE the pixel length comes from:
//   - pin_dist0.py auto-detects the flagstick and measures its VERTICAL pixel
//     extent, then divides the angular size by cos(tilt) to recover the true
//     (foreshortened) on-image length.
//   - Here the two endpoints come from user taps, so the straight-line
//     (Euclidean) distance between them IS the true on-image length already —
//     no cos correction needed. We still surface the in-image tilt for info.
//
// Physics — the EXACT pinhole relationship (see MATH.md for the full derivation):
//   A pinhole/rectilinear camera with focal length f (in pixels) images a point
//   (X,Y,Z) to pixel (f·X/Z, f·Y/Z). A vertical pole of real height H standing at
//   distance D (perpendicular to a level optical axis) therefore spans
//       L = f · H / D            pixels        (exact — similar triangles)
//   Solving for distance:
//       D = f · H / L            (= H / (L · radPerPx), with radPerPx = 1/f)
//   This is EXACT: no small-angle assumption, and independent of where the pole
//   sits in the frame. The assumptions are only: (1) level camera (optical axis
//   horizontal, so the pole is perpendicular to it), and (2) a rectilinear lens
//   (phone main cameras are corrected to this; stay clear of the extreme edges
//   where residual distortion lives). See MATH.md for the error analysis of
//   camera pitch and lens distortion.
//
//   We carry the device constant as `radPerPx = 1/f` (radians per pixel on the
//   optical axis). distanceFromPixels() below is `D = H / (L · radPerPx)`, which
//   is the exact formula above. Small-angle never enters.
//
// Works both as an ES module (browser) and via `import` in Node tests.

// --- unit constants -------------------------------------------------------
export const FT_PER_YARD = 3;
export const M_PER_YARD = 0.9144; // exact: 1 international yard = 0.9144 m
export const DEG2RAD = Math.PI / 180;

// The device constant is a resolution-INDEPENDENT focal ratio: f_px / longSide.
// (f_px scales with resolution for a fixed lens, so the ratio is invariant.)
// Default seeds ~68° long-side FOV — a typical phone main (1×) camera — so the
// FIRST, uncalibrated reading is in the right ballpark instead of ~4× too high.
// It is still only a ballpark; calibrate() replaces it with the exact value.
export const DEFAULT_FOV_DEG = 68;
export const DEFAULT_FOCAL_RATIO = 0.5 / Math.tan((DEFAULT_FOV_DEG * DEG2RAD) / 2); // ≈ 0.741
export const DEFAULT_RAD_PER_PX = 1 / (DEFAULT_FOCAL_RATIO * 4032);

// Standard reference heights a golfer can pick from, in FEET.
// Use whichever feature is fully visible in the frame.
export const REFERENCES = [
  { id: 'pin', label: 'Full flagstick', feet: 7.0, hint: 'Tip of stick → ground (USGA standard 7 ft / 2.13 m)' },
  { id: 'flag', label: 'Flag (cloth height)', feet: 14 / 12, hint: 'Top → bottom of the flag cloth (standard 14 in)' },
  { id: 'pin-to-flag', label: 'Tip → bottom of flag', feet: 20 / 12, hint: 'When the base is hidden on a hill — tip of stick to bottom of flag (~20 in on a standard pin)' },
  { id: 'custom', label: 'Custom length', feet: null, hint: 'Any two points whose real separation you know' },
];

/**
 * Euclidean pixel distance between two {x, y} points.
 */
export function pixelDistance(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy);
}

/**
 * In-image tilt of the line a→b, in degrees away from vertical.
 * 0° = perfectly vertical pin, positive = leaning.
 */
export function tiltDegrees(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // angle from the vertical axis
  return Math.abs(Math.atan2(dx, dy)) / DEG2RAD;
}

/**
 * Core conversion: pixel length of a known-height reference -> distance.
 *
 * @param {object} o
 * @param {number} o.pixelLength    on-image length of the reference, in pixels
 * @param {number} o.refFeet        real height of the reference, in feet
 * @param {number} o.radPerPx       camera resolution, radians per pixel
 * @param {number} [o.tiltDeg=0]    optional extra foreshortening correction.
 *        Leave 0 when pixelLength is the true (Euclidean) tap-to-tap length.
 *        Pass the tilt when pixelLength is a VERTICAL extent (script-parity mode).
 * @returns {{yards:number, meters:number, feet:number, angleRad:number}}
 */
export function distanceFromPixels({ pixelLength, refFeet, radPerPx, tiltDeg = 0 }) {
  if (!(pixelLength > 0)) throw new Error('pixelLength must be > 0');
  if (!(refFeet > 0)) throw new Error('refFeet must be > 0');
  if (!(radPerPx > 0)) throw new Error('radPerPx must be > 0');

  let angleRad = pixelLength * radPerPx;
  // Script-parity foreshortening correction (no-op when tiltDeg === 0).
  angleRad /= Math.cos(tiltDeg * DEG2RAD);

  const refYards = refFeet / FT_PER_YARD;
  const yards = refYards / angleRad;
  return {
    yards,
    meters: yards * M_PER_YARD,
    feet: yards * FT_PER_YARD,
    angleRad,
  };
}

/**
 * One-time calibration: solve the phone's true radians-per-pixel from a shot of
 * an object of known height at a known distance.
 *
 * @param {object} o
 * @param {number} o.pixelLength      measured on-image length, pixels
 * @param {number} o.refFeet          real height of the calibration object, feet
 * @param {number} o.distanceYards    true distance to it, yards
 * @returns {number} radPerPx
 */
export function calibrateRadPerPx({ pixelLength, refFeet, distanceYards }) {
  if (!(pixelLength > 0)) throw new Error('pixelLength must be > 0');
  if (!(refFeet > 0)) throw new Error('refFeet must be > 0');
  if (!(distanceYards > 0)) throw new Error('distanceYards must be > 0');
  const refYards = refFeet / FT_PER_YARD;
  const angleRad = refYards / distanceYards;
  return angleRad / pixelLength;
}

// ===========================================================================
// Focal-ratio device model (the canonical, exact parametrization)
// ===========================================================================
// focalRatio = f_px / longSide, resolution-independent. radPerPx = 1/f_px.

/** On-axis radians-per-pixel from the stored focal ratio at this resolution. */
export function focalRatioToRadPerPx(focalRatio, longSide) {
  if (!(focalRatio > 0) || !(longSide > 0)) throw new Error('focalRatio and longSide must be > 0');
  return 1 / (focalRatio * longSide); // = 1 / f_px
}

/** On-axis focal length f, in pixels, at this resolution. */
export function focalRatioToPixels(focalRatio, longSide) { return focalRatio * longSide; }

/**
 * Calibrate the focal ratio from one shot of a known-height object at a known
 * distance. Inverts D = f·H/L exactly:  f = D·L/H  ->  ratio = f/longSide.
 * @returns {number} focalRatio (= f_px / longSide), resolution-independent.
 */
export function calibrateFocalRatio({ pixelLength, refFeet, distanceYards, longSide }) {
  if (!(pixelLength > 0)) throw new Error('pixelLength must be > 0');
  if (!(refFeet > 0)) throw new Error('refFeet must be > 0');
  if (!(distanceYards > 0)) throw new Error('distanceYards must be > 0');
  if (!(longSide > 0)) throw new Error('longSide must be > 0');
  const refYards = refFeet / FT_PER_YARD;
  const focalPx = (distanceYards * pixelLength) / refYards; // f = D·L/H
  return focalPx / longSide;
}

/** Implied long-side field of view (degrees) for a focal ratio — display only. */
export function focalRatioToFovDeg(focalRatio) {
  return (2 * Math.atan(0.5 / focalRatio)) / DEG2RAD;
}
/** Inverse of the above, for seeding a ratio from a known camera FOV. */
export function fovDegToFocalRatio(fovDeg) {
  return 0.5 / Math.tan((fovDeg * DEG2RAD) / 2);
}

// ===========================================================================
// Accuracy: sub-pixel edge snapping + uncertainty
// ===========================================================================

/**
 * Refine a marker to the true sub-pixel edge of the pin. Given a 1-D luminance
 * column sampled down the image at the marker's x, search ±half rows around the
 * marker for the strongest vertical gradient (the tip/base edge), then parabola-
 * interpolate the gradient peak for sub-pixel position. Removes finger-placement
 * error — the dominant noise source — taking ~±2 px human placement down to ~±0.3.
 *
 * @param {Float32Array|number[]} col  luminance down the column, index = row
 * @param {number} y0    initial (finger) row
 * @param {number} [half=6]  search radius in rows
 * @returns {number} refined sub-pixel row
 */
export function refineEdgeY(col, y0, half = 6) {
  const n = col.length;
  const lo = Math.max(1, Math.round(y0) - half);
  const hi = Math.min(n - 2, Math.round(y0) + half);
  if (hi <= lo) return y0;
  const g = (y) => Math.abs(col[y + 1] - col[y - 1]);
  let peak = lo, gmax = -1;
  for (let y = lo; y <= hi; y++) { const v = g(y); if (v > gmax) { gmax = v; peak = y; } }
  if (gmax <= 0 || peak <= 0 || peak >= n - 1) return y0;
  const gm1 = g(peak - 1), g0 = g(peak), gp1 = g(peak + 1);
  const denom = gm1 - 2 * g0 + gp1;
  let delta = denom !== 0 ? (0.5 * (gm1 - gp1)) / denom : 0;
  if (!(delta > -1 && delta < 1)) delta = 0; // reject ill-conditioned interp
  return peak + delta;
}

/**
 * Distance uncertainty from pixel-placement error. Since D = k / L,
 * dD/D = dL/L, so ±yards = D · (errPx / L). `errPx` is the combined error on the
 * pixel LENGTH (both ends): ~0.7 px after sub-pixel refine, ~2.5 px by finger.
 */
export function measurementUncertaintyYards({ yards, pixelLength, errPx = 0.7 }) {
  if (!(pixelLength > 0)) return Infinity;
  return yards * (errPx / pixelLength);
}

// ===========================================================================
// Slope / elevation — the uphill & downhill case
// ===========================================================================
// The angular-size method measures distance along the LINE OF SIGHT. When you
// pitch the phone up/down to aim at an elevated/sunken pin, a vertical pin of
// height H, viewed along a line of sight at elevation θ, projects to only
//     L = f · H · cos θ / S      (the pin foreshortens by cos θ off-axis)
// so the naive level-assumption distance  D_raw = f·H/L  actually equals
//     D_raw = S / cos θ.
// Given the phone's pitch θ (from the accelerometer / DeviceOrientation — NO GPS
// needed), we recover the full geometry:
//     slant       S  = D_raw · cos θ
//     horizontal  Dh = S · cos θ = D_raw · cos²θ
//     elevation   Δh = S · sin θ = D_raw · cos θ · sin θ
//     plays-like  ≈ Dh + Δh   (common 1:1 elevation rule, casual play only)
//
// NOTE: elevation/"plays-like" is a SLOPE feature. Under USGA Rule 4.3a, reading
// slope is NOT allowed in competition unless a Local Rule permits it — keep it
// toggle-off for tournament rounds, like a laser's "tournament mode".

/**
 * @param {object} o
 * @param {number} o.rawYards   level-assumption distance, D_raw = f·H/L (yards)
 * @param {number} o.pitchDeg   camera elevation angle to the pin, deg (+ uphill)
 * @returns {{slantYards:number, horizontalYards:number, elevationYards:number, playsLikeYards:number}}
 */
export function slopeAdjust({ rawYards, pitchDeg }) {
  if (!(rawYards > 0)) throw new Error('rawYards must be > 0');
  const t = pitchDeg * DEG2RAD;
  const slant = rawYards * Math.cos(t);
  const horizontal = slant * Math.cos(t);
  const elevation = slant * Math.sin(t);
  return {
    slantYards: slant,
    horizontalYards: horizontal,
    elevationYards: elevation,
    playsLikeYards: horizontal + elevation,
  };
}

// ===========================================================================
// object-fit: contain coordinate mapping (display px  <->  image px)
// ===========================================================================
// Critical for on-device accuracy: every tap/drag is converted through these,
// so a bug here corrupts every measurement. Pure + unit-tested for exact
// round-trip. `zoom` (>=1) and `focus` (image-px point kept at view center)
// support digital zoom as a VIEW-ONLY transform that never alters image-px
// coordinates, so the distance math is unaffected by zoom.

function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Compute the transform placing an (imgW × imgH) image into a (viewW × viewH)
 * view with object-fit: contain, optionally zoomed about a focus point.
 * @returns {{scale:number, ox:number, oy:number}}  view = img*scale + (ox,oy)
 */
export function containTransform(viewW, viewH, imgW, imgH, zoom = 1, focus = null) {
  const base = Math.min(viewW / imgW, viewH / imgH);
  const scale = base * Math.max(1, zoom);
  if (zoom > 1 && focus) {
    // keep `focus` (image px) pinned to the view center
    return { scale, ox: viewW / 2 - focus.x * scale, oy: viewH / 2 - focus.y * scale };
  }
  return { scale, ox: (viewW - imgW * scale) / 2, oy: (viewH - imgH * scale) / 2 };
}

/** Image-px point -> view-px point. */
export function imageToView(p, t) { return { x: t.ox + p.x * t.scale, y: t.oy + p.y * t.scale }; }

/** View-px point -> image-px point, clamped to the image bounds. */
export function viewToImage(vx, vy, t, imgW, imgH) {
  return {
    x: clampNum((vx - t.ox) / t.scale, 0, imgW),
    y: clampNum((vy - t.oy) / t.scale, 0, imgH),
  };
}

/**
 * Auto-detect the vertical span of a thin near-vertical object (the flagstick)
 * inside a central band of a grayscale frame. Lightweight enough to run on every
 * live video frame after downscaling to ~120 px wide.
 *
 * Strategy (a fast cousin of pin_dist0.py's diffh/argmax): find the column in
 * the central band with the strongest vertical edge energy (the pin's side),
 * then walk that column to find the longest contiguous run where a horizontal
 * gradient is present — that run is the visible pin.
 *
 * @param {Float32Array|number[]} lum  luminance 0..255, length w*h, row-major
 * @param {number} w  width
 * @param {number} h  height
 * @param {object} [opts]
 * @param {number} [opts.band=0.5]     fraction of width searched, centered
 * @param {number} [opts.edgeFrac=0.33] gradient threshold as fraction of column max
 * @param {number} [opts.minRun=0.12]  reject spans shorter than this fraction of h
 * @returns {{xCol:number, yTop:number, yBottom:number, score:number}|null}
 *          coordinates are in the (w,h) grid passed in; scale to image px yourself.
 */
export function detectVerticalSpan(lum, w, h, opts = {}) {
  const { band = 0.5, edgeFrac = 0.33, minRun = 0.12 } = opts;
  if (w < 3 || h < 3) return null;
  const x0 = Math.max(1, Math.floor((w * (1 - band)) / 2));
  const x1 = Math.min(w - 2, Math.ceil((w * (1 + band)) / 2));

  // 1) column with the most vertical-edge energy
  let bestX = -1, bestE = -1;
  for (let x = x0; x <= x1; x++) {
    let e = 0;
    for (let y = 0; y < h; y++) e += Math.abs(lum[y * w + x + 1] - lum[y * w + x - 1]);
    if (e > bestE) { bestE = e; bestX = x; }
  }
  if (bestX < 0) return null;

  // 2) per-row edge strength along that column
  let emax = 0;
  const e = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const g = Math.abs(lum[y * w + bestX + 1] - lum[y * w + bestX - 1]);
    e[y] = g; if (g > emax) emax = g;
  }
  if (emax <= 0) return null;

  // 3) longest contiguous run above threshold (tolerating small gaps)
  const thr = emax * edgeFrac;
  const maxGap = Math.max(2, Math.floor(h * 0.04));
  let best = null, start = -1, gap = 0;
  const closeRun = (end) => {
    if (start < 0) return;
    const len = end - start;
    if (!best || len > best.len) best = { start, end, len };
    start = -1; gap = 0;
  };
  for (let y = 0; y < h; y++) {
    if (e[y] > thr) { if (start < 0) start = y; gap = 0; }
    else if (start >= 0) { if (++gap > maxGap) closeRun(y - gap); }
  }
  closeRun(h - 1);
  if (!best || best.len < h * minRun) return null;
  return { xCol: bestX, yTop: best.start, yBottom: best.end, score: bestE };
}

/**
 * Trace the vertical edge run along one image column (the stick).
 * @returns {{yTop,yBottom,len,emax}|null}
 */
export function traceColumn(lum, w, h, x, edgeFrac = 0.33, minRun = 0.12) {
  if (x < 1 || x >= w - 1) return null;
  let emax = 0;
  const e = new Float32Array(h);
  for (let y = 0; y < h; y++) { const g = Math.abs(lum[y * w + x + 1] - lum[y * w + x - 1]); e[y] = g; if (g > emax) emax = g; }
  if (emax <= 0) return null;
  const thr = emax * edgeFrac, maxGap = Math.max(2, Math.floor(h * 0.04));
  let best = null, start = -1, gap = 0;
  const close = (end) => { if (start < 0) return; const len = end - start; if (!best || len > best.len) best = { start, end, len }; start = -1; gap = 0; };
  for (let y = 0; y < h; y++) { if (e[y] > thr) { if (start < 0) start = y; gap = 0; } else if (start >= 0) { if (++gap > maxGap) close(y - gap); } }
  close(h - 1);
  if (!best || best.len < h * minRun) return null;
  return { yTop: best.start, yBottom: best.end, len: best.len, emax };
}

/**
 * Flag-anchored pin detector. Where detectVerticalSpan latches onto ANY strong
 * vertical edge (so it locks onto buildings/door-frames), this first finds the
 * FLAG by colour saturation in the central band, then traces the stick directly
 * below it — and returns a confidence so the caller can refuse a weak guess.
 * On-device, no model, runs every frame on a downscaled (~120px) RGBA frame.
 *
 * @param {Uint8ClampedArray|number[]} data  RGBA, length w*h*4
 * @param {number} w
 * @param {number} h
 * @param {object} [opts]  band (search width frac), minConfidence
 * @returns {{xCol,yTop,yBottom,confidence,flagStrength}|null}
 */
export function detectPin(data, w, h, opts = {}) {
  const { band = 0.6 } = opts;
  if (w < 3 || h < 3) return null;
  const x0 = Math.max(1, Math.floor((w * (1 - band)) / 2));
  const x1 = Math.min(w - 2, Math.ceil((w * (1 + band)) / 2));

  const lum = new Float32Array(w * h);
  const colSat = new Float32Array(w);               // summed colourfulness per column
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      lum[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      if (x >= x0 && x <= x1) colSat[x] += (mx > 0 ? (mx - mn) / mx : 0) * (mx / 255);
    }
  }
  // the flag is the most colourful column; require real colour or bail (we'd
  // rather return nothing than lock onto a grey building edge)
  let satMax = -1;
  for (let x = x0; x <= x1; x++) if (colSat[x] > satMax) satMax = colSat[x];
  const flagStrength = satMax / h;                   // ~avg saturation down the column
  if (flagStrength < 0.02) return null;              // no coloured flag → no guess

  // the flag's x-extent (columns within half of peak colourfulness)
  let fxmin = x1, fxmax = x0;
  for (let x = x0; x <= x1; x++) if (colSat[x] >= 0.5 * satMax) { if (x < fxmin) fxmin = x; if (x > fxmax) fxmax = x; }

  // the stick = strongest vertical edge under/beside the flag, scored by
  // length × contrast so faint background texture can't win
  let best = null, bestX = -1;
  for (let x = Math.max(1, fxmin - 3); x <= Math.min(w - 2, fxmax + 3); x++) {
    const t = traceColumn(lum, w, h, x);
    if (!t) continue;
    if (!best || t.len * t.emax > best.len * best.emax) { best = t; bestX = x; }
  }
  if (!best) return null;

  // width check: a flagstick is THIN. Measure the object's horizontal width in
  // the lower (stick, below-flag) part of the span; a fat object is a wall/tree.
  const ySample = Math.min(h - 2, Math.max(1, Math.round(best.yTop + 0.72 * (best.yBottom - best.yTop))));
  const widthPx = objectWidthAt(lum, w, h, bestX, ySample);
  const thinComp = widthPx <= 4 ? 1 : Math.max(0, 1 - (widthPx - 4) / 12); // 1 at ≤4px → 0 by ~16px

  const flagComp = Math.min(1, flagStrength / 0.05);
  const runFrac = best.len / h;
  const confidence = Math.max(0, Math.min(1, flagComp * Math.min(1, runFrac * 1.6) * thinComp));
  return { xCol: bestX, yTop: best.yTop, yBottom: best.yBottom, confidence, flagStrength: +flagStrength.toFixed(4), widthPx };
}

/** Horizontal width (px) of the high-contrast object crossing row y near column xc. */
function objectWidthAt(lum, w, h, xc, y) {
  const bg = (lum[y * w + Math.max(0, xc - 15)] + lum[y * w + Math.min(w - 1, xc + 15)]) / 2;
  const thr = Math.max(20, Math.abs(lum[y * w + xc] - bg) * 0.5);
  let l = xc, r = xc;
  while (l > 0 && Math.abs(lum[y * w + l - 1] - bg) > thr) l--;
  while (r < w - 1 && Math.abs(lum[y * w + r + 1] - bg) > thr) r++;
  return r - l + 1;
}

/**
 * Convenience wrapper used by the UI: two taps + reference + device constant.
 */
export function distanceFromTaps({ topPoint, bottomPoint, refFeet, radPerPx }) {
  const pixelLength = pixelDistance(topPoint, bottomPoint);
  const tilt = tiltDegrees(topPoint, bottomPoint);
  const result = distanceFromPixels({ pixelLength, refFeet, radPerPx });
  return { ...result, pixelLength, tiltDeg: tilt };
}
