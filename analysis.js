/* ============================================================
   BIOL2005 — Analysis: CSV parsing, psychometric function
   fitting, and SVG plotting.
   
   No external dependencies; everything runs from local disk.
   ============================================================ */

const ANALYSIS = (function () {
  'use strict';

  // ---------------------------------------------------------------
  // CSV parsing
  //
  // Accepts our experiment's CSV format:
  //   # key: value   (metadata lines)
  //   header_row
  //   data_rows...
  // Returns { meta, rows, columns } or throws.
  // ---------------------------------------------------------------
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    const meta = {};
    let i = 0;
    while (i < lines.length && lines[i].startsWith('#')) {
      const m = lines[i].match(/^#\s*([^:]+):\s*(.*)$/);
      if (m) meta[m[1].trim()] = m[2].trim();
      i++;
    }
    if (i >= lines.length) throw new Error('No header row found');
    const columns = splitCSVLine(lines[i]);
    i++;
    const rows = [];
    for (; i < lines.length; i++) {
      const vals = splitCSVLine(lines[i]);
      const r = {};
      for (let c = 0; c < columns.length; c++) {
        r[columns[c]] = vals[c];
      }
      rows.push(r);
    }
    return { meta, rows, columns };
  }

  function splitCSVLine(line) {
    // Simple CSV splitter handling quoted fields
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i+1] === '"') { cur += '"'; i++; }
          else { inQuotes = false; }
        } else cur += ch;
      } else {
        if (ch === ',') { out.push(cur); cur = ''; }
        else if (ch === '"') inQuotes = true;
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  // ---------------------------------------------------------------
  // Aggregation: from per-trial rows -> proportion correct per
  // coherence level.
  // ---------------------------------------------------------------
  function aggregateByCoherence(rows) {
    const groups = new Map();
    for (const r of rows) {
      const coh = parseFloat(r.coherence);
      if (isNaN(coh)) continue;
      const correct = r.correct === '1' ? 1 : (r.correct === '0' ? 0 : null);
      if (correct === null) continue;  // skip timeouts
      if (!groups.has(coh)) groups.set(coh, { n: 0, k: 0 });
      const g = groups.get(coh);
      g.n++;
      g.k += correct;
    }
    const out = [];
    for (const [coh, g] of groups) {
      const p = g.n > 0 ? g.k / g.n : null;
      // Binomial standard error
      const se = (p !== null && g.n > 0) ? Math.sqrt(p * (1 - p) / g.n) : 0;
      out.push({ coherence: coh, n: g.n, k: g.k, p, se });
    }
    out.sort((a, b) => a.coherence - b.coherence);
    return out;
  }

  function pooledFromMany(rowsArray) {
    // Concatenate per-trial rows from many CSV files, then aggregate
    const all = [];
    for (const rows of rowsArray) for (const r of rows) all.push(r);
    return aggregateByCoherence(all);
  }

  // ---------------------------------------------------------------
  // Psychometric function fitting
  //
  // For 2AFC, we use a Weibull-like form:
  //    f(c) = 0.5 + 0.5 * (1 - exp(-(c/alpha)^beta))
  //
  // alpha is the scale (threshold-ish), beta is the slope.
  // Fitted by maximum binomial likelihood via grid search +
  // a small Nelder-Mead refinement.
  // ---------------------------------------------------------------
  function psychometric(c, alpha, beta) {
    // Clamp c to >= 0 to avoid numerical issues at c=0
    const cc = Math.max(c, 1e-9);
    return 0.5 + 0.5 * (1 - Math.exp(-Math.pow(cc / alpha, beta)));
  }

  // Negative log-likelihood for a fit of [alpha, beta] to aggregated data
  function negLogLik(params, agg) {
    const [alpha, beta] = params;
    if (alpha <= 0 || beta <= 0 || !isFinite(alpha) || !isFinite(beta)) return 1e9;
    let nll = 0;
    for (const d of agg) {
      const p = psychometric(d.coherence, alpha, beta);
      const pSafe = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
      // Binomial NLL (omit factorial; constant w.r.t. params)
      nll -= d.k * Math.log(pSafe) + (d.n - d.k) * Math.log(1 - pSafe);
    }
    return nll;
  }

  function fitPsychometric(agg) {
    // 1) Grid search to get a reasonable starting point
    let best = { alpha: 0.2, beta: 2.0, nll: Infinity };
    const alphaGrid = [0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8];
    const betaGrid = [0.8, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
    for (const a of alphaGrid) {
      for (const b of betaGrid) {
        const nll = negLogLik([a, b], agg);
        if (nll < best.nll) best = { alpha: a, beta: b, nll };
      }
    }

    // 2) Nelder-Mead simplex refinement
    const result = nelderMead(
      (p) => negLogLik(p, agg),
      [best.alpha, best.beta],
      { stepFractions: [0.2, 0.2], maxIter: 400, tol: 1e-7 }
    );

    const alpha = result.x[0];
    const beta = result.x[1];
    return { alpha, beta, nll: result.fx, converged: result.iter < 400 };
  }

  // Threshold: coherence at which f(c) = targetProportion
  // For our Weibull: solving 0.5 + 0.5*(1 - exp(-(c/alpha)^beta)) = p
  // => exp(-(c/alpha)^beta) = 1 - 2*(p - 0.5) = 2 - 2p
  // => (c/alpha)^beta = -ln(2 - 2p)
  // => c = alpha * (-ln(2 - 2p))^(1/beta)
  function thresholdAt(targetP, alpha, beta) {
    if (targetP <= 0.5 || targetP >= 1) return null;
    const arg = -Math.log(2 - 2 * targetP);
    if (arg <= 0) return null;
    return alpha * Math.pow(arg, 1 / beta);
  }

  // ---------------------------------------------------------------
  // Nelder-Mead simplex (2D, minimal implementation)
  // ---------------------------------------------------------------
  function nelderMead(f, x0, opts) {
    opts = opts || {};
    const stepFractions = opts.stepFractions || x0.map(() => 0.1);
    const maxIter = opts.maxIter || 200;
    const tol = opts.tol || 1e-6;

    const n = x0.length;
    // Initialise simplex
    const simplex = [x0.slice()];
    for (let i = 0; i < n; i++) {
      const v = x0.slice();
      const delta = Math.max(Math.abs(v[i]) * stepFractions[i], 1e-3);
      v[i] += delta;
      simplex.push(v);
    }
    let fvals = simplex.map(v => f(v));

    function sortSimplex() {
      const order = simplex.map((_, i) => i).sort((a, b) => fvals[a] - fvals[b]);
      const sSorted = order.map(i => simplex[i]);
      const fSorted = order.map(i => fvals[i]);
      for (let i = 0; i < simplex.length; i++) {
        simplex[i] = sSorted[i];
        fvals[i] = fSorted[i];
      }
    }

    let iter = 0;
    for (; iter < maxIter; iter++) {
      sortSimplex();
      // Convergence: range of f-values
      if (Math.abs(fvals[fvals.length - 1] - fvals[0]) < tol) break;

      // Centroid of all but worst
      const centroid = new Array(n).fill(0);
      for (let i = 0; i < simplex.length - 1; i++)
        for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
      for (let j = 0; j < n; j++) centroid[j] /= (simplex.length - 1);

      const worst = simplex[simplex.length - 1];

      // Reflection
      const xr = centroid.map((c, j) => c + 1.0 * (c - worst[j]));
      const fr = f(xr);
      if (fr < fvals[0]) {
        // Expansion
        const xe = centroid.map((c, j) => c + 2.0 * (xr[j] - c));
        const fe = f(xe);
        if (fe < fr) { simplex[simplex.length - 1] = xe; fvals[fvals.length - 1] = fe; }
        else { simplex[simplex.length - 1] = xr; fvals[fvals.length - 1] = fr; }
      } else if (fr < fvals[fvals.length - 2]) {
        simplex[simplex.length - 1] = xr;
        fvals[fvals.length - 1] = fr;
      } else {
        // Contraction
        const xc = centroid.map((c, j) => c + 0.5 * (worst[j] - c));
        const fc = f(xc);
        if (fc < fvals[fvals.length - 1]) {
          simplex[simplex.length - 1] = xc;
          fvals[fvals.length - 1] = fc;
        } else {
          // Shrink toward best
          const best = simplex[0];
          for (let i = 1; i < simplex.length; i++) {
            for (let j = 0; j < n; j++)
              simplex[i][j] = best[j] + 0.5 * (simplex[i][j] - best[j]);
            fvals[i] = f(simplex[i]);
          }
        }
      }
    }
    sortSimplex();
    return { x: simplex[0], fx: fvals[0], iter };
  }

  // ---------------------------------------------------------------
  // SVG plotting
  //
  // Renders into a target <svg> element. Draws axes, ticks, points
  // with error bars, fitted curves, and 75% threshold lines for
  // each visible trace.
  // ---------------------------------------------------------------
  function plot(svg, traces, opts) {
    opts = opts || {};
    const title = opts.title || '';
    const W = opts.width || 720;
    // Reserve extra top space when a title is present
    const titleHeight = title ? 36 : 0;
    const H = opts.height || (480 + titleHeight);
    const m = { top: 30 + titleHeight, right: 30, bottom: 60, left: 70 };
    const innerW = W - m.left - m.right;
    const innerH = H - m.top - m.bottom;

    // Clear
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.display = 'block';
    svg.style.width = '100%';
    svg.style.height = 'auto';

    // White background (for PNG export)
    rect(svg, 0, 0, W, H, '#ffffff', null);

    // Title
    if (title) {
      text(svg, W / 2, 26, title, {
        anchor: 'middle', size: 16, family: 'serif', fill: '#111'
      });
    }

    // Scales
    const xMax = 1.0;  // coherence 0..1
    const yMin = 0.4, yMax = 1.0;
    function xs(c) { return m.left + (c / xMax) * innerW; }
    function ys(p) { return m.top + (1 - (p - yMin) / (yMax - yMin)) * innerH; }

    // Plot area background
    rect(svg, m.left, m.top, innerW, innerH, '#fcfbf7', '#d8d6cf');

    // Axes
    drawAxes(svg, m, innerW, innerH, xs, ys, yMin, yMax);

    // Reference horizontal lines: chance (0.5) and 75%
    dashed(svg, m.left, ys(0.5), m.left + innerW, ys(0.5), '#bfbfbf');
    text(svg, m.left + innerW - 6, ys(0.5) - 4, 'chance (0.5)', { anchor: 'end', fill: '#888', size: 11 });
    dashed(svg, m.left, ys(0.75), m.left + innerW, ys(0.75), '#bfbfbf');
    text(svg, m.left + innerW - 6, ys(0.75) - 4, '75% correct', { anchor: 'end', fill: '#888', size: 11 });

    // Draw each visible trace
    for (const t of traces) {
      if (!t.visible) continue;
      drawTrace(svg, t, xs, ys, yMin, yMax, m, innerW, innerH);
    }

    // Axis labels
    text(svg, m.left + innerW / 2, H - 18, 'Coherence', { anchor: 'middle', size: 13, family: 'serif', italic: true });
    text(svg, 18, m.top + innerH / 2, 'Proportion correct',
         { anchor: 'middle', size: 13, family: 'serif', italic: true, rotate: -90, rx: 18, ry: m.top + innerH / 2 });
  }

  function drawTrace(svg, t, xs, ys, yMin, yMax, m, innerW, innerH) {
    const color = t.color;
    const isCombined = t.kind === 'combined';
    const lineWidth = isCombined ? 2.6 : 1.6;
    const opacity = isCombined ? 1.0 : 0.85;

    // Fitted curve
    if (t.fit && t.fit.alpha) {
      const path = [];
      const N = 220;
      for (let i = 0; i <= N; i++) {
        const c = i / N;
        const p = psychometric(c, t.fit.alpha, t.fit.beta);
        path.push(`${i === 0 ? 'M' : 'L'} ${xs(c).toFixed(2)} ${ys(p).toFixed(2)}`);
      }
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', path.join(' '));
      el.setAttribute('stroke', color);
      el.setAttribute('stroke-width', lineWidth);
      el.setAttribute('fill', 'none');
      el.setAttribute('opacity', opacity);
      svg.appendChild(el);
    }

    // 75% threshold vertical line
    if (t.fit && t.fit.alpha) {
      const thr75 = thresholdAt(0.75, t.fit.alpha, t.fit.beta);
      if (thr75 !== null && thr75 >= 0 && thr75 <= 1) {
        const x = xs(thr75);
        const yBase = ys(0.4);
        const yTop = ys(0.75);
        const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('x1', x); ln.setAttribute('x2', x);
        ln.setAttribute('y1', yTop); ln.setAttribute('y2', yBase);
        ln.setAttribute('stroke', color);
        ln.setAttribute('stroke-width', isCombined ? 1.4 : 1.0);
        ln.setAttribute('stroke-dasharray', '4 3');
        ln.setAttribute('opacity', opacity);
        svg.appendChild(ln);
        // Only label thresholds for combined curves (keeps the
        // x-axis area clean when many individuals are overlaid)
        if (isCombined) {
          text(svg, x, yBase + 14, thr75.toFixed(3), {
            anchor: 'middle', size: 11, family: 'mono', fill: color
          });
        }
      }
    }

    // Data points with error bars
    for (const d of t.agg) {
      if (d.p === null) continue;
      const x = xs(d.coherence);
      const y = ys(d.p);
      // Error bar
      const y1 = ys(Math.min(yMax, d.p + d.se));
      const y2 = ys(Math.max(yMin, d.p - d.se));
      const eb = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      eb.setAttribute('x1', x); eb.setAttribute('x2', x);
      eb.setAttribute('y1', y1); eb.setAttribute('y2', y2);
      eb.setAttribute('stroke', color);
      eb.setAttribute('stroke-width', 1.0);
      eb.setAttribute('opacity', opacity * 0.65);
      svg.appendChild(eb);
      // Caps
      const cap = 3;
      [y1, y2].forEach(yy => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        c.setAttribute('x1', x - cap); c.setAttribute('x2', x + cap);
        c.setAttribute('y1', yy); c.setAttribute('y2', yy);
        c.setAttribute('stroke', color);
        c.setAttribute('stroke-width', 1.0);
        c.setAttribute('opacity', opacity * 0.65);
        svg.appendChild(c);
      });
      // Point
      const r = isCombined ? 5 : 3.5;
      const pt = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      pt.setAttribute('cx', x); pt.setAttribute('cy', y); pt.setAttribute('r', r);
      pt.setAttribute('fill', isCombined ? color : '#ffffff');
      pt.setAttribute('stroke', color);
      pt.setAttribute('stroke-width', 1.4);
      pt.setAttribute('opacity', opacity);
      svg.appendChild(pt);
    }
  }

  function drawAxes(svg, m, innerW, innerH, xs, ys, yMin, yMax) {
    // X axis
    const xAxisY = m.top + innerH;
    line(svg, m.left, xAxisY, m.left + innerW, xAxisY, '#444', 1);
    const xTicks = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (const t of xTicks) {
      const x = xs(t);
      line(svg, x, xAxisY, x, xAxisY + 5, '#444', 1);
      text(svg, x, xAxisY + 22, t.toFixed(1), { anchor: 'middle', size: 11, family: 'mono', fill: '#444' });
    }
    // Y axis
    line(svg, m.left, m.top, m.left, m.top + innerH, '#444', 1);
    const yTicks = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (const t of yTicks) {
      const y = ys(t);
      line(svg, m.left - 5, y, m.left, y, '#444', 1);
      text(svg, m.left - 9, y + 4, t.toFixed(1), { anchor: 'end', size: 11, family: 'mono', fill: '#444' });
    }
  }

  function line(svg, x1, y1, x2, y2, stroke, w) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    el.setAttribute('x1', x1); el.setAttribute('y1', y1);
    el.setAttribute('x2', x2); el.setAttribute('y2', y2);
    el.setAttribute('stroke', stroke);
    el.setAttribute('stroke-width', w);
    svg.appendChild(el);
  }
  function dashed(svg, x1, y1, x2, y2, stroke) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    el.setAttribute('x1', x1); el.setAttribute('y1', y1);
    el.setAttribute('x2', x2); el.setAttribute('y2', y2);
    el.setAttribute('stroke', stroke);
    el.setAttribute('stroke-width', 1);
    el.setAttribute('stroke-dasharray', '3 4');
    svg.appendChild(el);
  }
  function rect(svg, x, y, w, h, fill, stroke) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    el.setAttribute('x', x); el.setAttribute('y', y);
    el.setAttribute('width', w); el.setAttribute('height', h);
    if (fill) el.setAttribute('fill', fill);
    if (stroke) { el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', 1); }
    else el.setAttribute('stroke', 'none');
    svg.appendChild(el);
  }
  function text(svg, x, y, str, opts) {
    opts = opts || {};
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    el.setAttribute('x', x); el.setAttribute('y', y);
    el.setAttribute('text-anchor', opts.anchor || 'start');
    el.setAttribute('font-size', opts.size || 12);
    el.setAttribute('fill', opts.fill || '#222');
    const fam = opts.family === 'mono'
      ? '"JetBrains Mono", ui-monospace, monospace'
      : opts.family === 'serif'
        ? '"Source Serif 4", Georgia, serif'
        : '"Inter Tight", system-ui, sans-serif';
    el.setAttribute('font-family', fam);
    if (opts.italic) el.setAttribute('font-style', 'italic');
    if (opts.rotate) {
      el.setAttribute('transform', `rotate(${opts.rotate} ${opts.rx} ${opts.ry})`);
    }
    el.textContent = str;
    svg.appendChild(el);
  }

  // ---------------------------------------------------------------
  // SVG -> PNG export
  // ---------------------------------------------------------------
  function exportPNG(svg, filename, scale) {
    scale = scale || 2;
    const xml = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const vb = svg.viewBox.baseVal;
    const w = vb.width, h = vb.height;

    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, 'image/png');
    };
    img.onerror = (e) => { console.error('PNG export failed:', e); URL.revokeObjectURL(url); };
    img.src = url;
  }

  // ---------------------------------------------------------------
  // Statistical tests
  //
  // We use simple, transparent t-tests. The Student's t CDF is
  // approximated numerically (no external dependencies).
  // ---------------------------------------------------------------

  // Two-tailed p-value from a t-statistic and degrees of freedom.
  // Uses the regularised incomplete beta function via continued
  // fraction expansion (Abramowitz & Stegun 26.5.8 form).
  function tCdfTwoTailed(t, df) {
    if (!isFinite(t) || !isFinite(df) || df <= 0) return NaN;
    // P(|T| > |t|) = I_x(df/2, 1/2) where x = df / (df + t^2)
    const x = df / (df + t * t);
    return betaIncReg(x, df / 2, 0.5);
  }

  // Regularised incomplete beta function I_x(a, b).
  // Uses the Lentz method with the standard symmetry trick to
  // ensure fast convergence. Returns values within 1e-6 of R's pbeta().
  function betaIncReg(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Symmetry: I_x(a,b) = 1 - I_(1-x)(b,a). Converges faster when
    // x < (a+1)/(a+b+2), so flip if needed.
    if (x > (a + 1) / (a + b + 2)) {
      return 1 - betaIncReg(1 - x, b, a);
    }
    const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
    // Modified Lentz continued fraction
    const eps = 1e-15;
    const maxIter = 200;
    let f = 1, c = 1, d = 0;
    for (let m = 0; m < maxIter; m++) {
      let aa;
      if (m === 0) aa = 1;
      else if (m % 2 === 1) {
        const k = (m - 1) / 2;
        aa = -((a + k) * (a + b + k)) * x / ((a + 2*k) * (a + 2*k + 1));
      } else {
        const k = m / 2;
        aa = (k * (b - k)) * x / ((a + 2*k - 1) * (a + 2*k));
      }
      d = 1 + aa * d;
      if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c;
      if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const delta = c * d;
      f *= delta;
      if (Math.abs(delta - 1) < eps) break;
    }
    return front * (f - 1);
  }

  // Lanczos approximation for log Γ(z)
  function logGamma(z) {
    const g = 7;
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (z < 0.5) {
      return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    }
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  // Paired t-test: tests whether mean(x - y) differs from 0.
  // pairs is an array of {a, b} pairs.
  function pairedTTest(pairs) {
    const n = pairs.length;
    if (n < 2) return { ok: false, reason: 'Need at least 2 paired observations' };
    const diffs = pairs.map(p => p.a - p.b);
    const mean = diffs.reduce((s, d) => s + d, 0) / n;
    const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    const se = sd / Math.sqrt(n);
    const t = mean / se;
    const df = n - 1;
    const p = tCdfTwoTailed(t, df);
    // 95% CI on the mean difference — use t critical for df
    const tcrit = invertTCdf(0.025, df);  // two-tailed alpha=0.05
    const ciLow = mean - tcrit * se;
    const ciHigh = mean + tcrit * se;
    return { ok: true, kind: 'paired', t, df, p, mean, sd, se, ciLow, ciHigh, n };
  }

  // Welch's two-sample t-test
  function welchTTest(xs, ys) {
    const nx = xs.length, ny = ys.length;
    if (nx < 2 || ny < 2) return { ok: false, reason: 'Need at least 2 observations per group' };
    const mx = xs.reduce((s, v) => s + v, 0) / nx;
    const my = ys.reduce((s, v) => s + v, 0) / ny;
    const vx = xs.reduce((s, v) => s + (v - mx) ** 2, 0) / (nx - 1);
    const vy = ys.reduce((s, v) => s + (v - my) ** 2, 0) / (ny - 1);
    const se = Math.sqrt(vx / nx + vy / ny);
    const meanDiff = mx - my;
    const t = meanDiff / se;
    // Welch-Satterthwaite df
    const df = (vx / nx + vy / ny) ** 2 /
               ((vx / nx) ** 2 / (nx - 1) + (vy / ny) ** 2 / (ny - 1));
    const p = tCdfTwoTailed(t, df);
    const tcrit = invertTCdf(0.025, df);
    const ciLow = meanDiff - tcrit * se;
    const ciHigh = meanDiff + tcrit * se;
    return { ok: true, kind: 'welch', t, df, p, meanDiff, mx, my, nx, ny, se, ciLow, ciHigh };
  }

  // Inverse t CDF for the two-tailed alpha (returns t such that
  // P(T > t) = alpha for given df). Uses bisection — slow but simple
  // and we only need a couple of calls per analysis.
  function invertTCdf(alpha, df) {
    // For two-tailed alpha=0.025, t≈2.0 for moderate df; use as start
    let lo = 0, hi = 50;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      // tCdfTwoTailed returns 2 * P(T > |mid|), so divide by 2 for one-tail
      const oneTail = tCdfTwoTailed(mid, df) / 2;
      if (oneTail < alpha) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }

  // Format p-value for display
  function formatP(p) {
    if (!isFinite(p) || isNaN(p)) return '—';
    if (p < 0.001) return 'p < 0.001';
    if (p < 0.01)  return `p = ${p.toFixed(3)}`;
    return `p = ${p.toFixed(3)}`;
  }

  return {
    parseCSV,
    aggregateByCoherence,
    pooledFromMany,
    psychometric,
    fitPsychometric,
    thresholdAt,
    plot,
    exportPNG,
    pairedTTest,
    welchTTest,
    formatP,
  };
})();
