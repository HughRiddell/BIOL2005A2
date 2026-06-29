/* ============================================================
   BIOL2005 — Random Dot Kinematogram (RDK) engine
   
   Implements a Newsome-style RDK with:
   - Circular aperture (optionally offset from canvas centre)
   - Configurable coherence (proportion of signal dots)
   - Limited dot lifetime (re-randomised position after N frames)
   - Signal dots move in the signal direction; noise dots move
     in independent random directions ("random direction" rule)
   - 2AFC left/right judgement via arrow keys
   - Method of constant stimuli: trials are interleaved across
     coherence levels and pre-shuffled before the block
   - Optional attentional load: a digit string is shown before
     each trial, then recalled after every N trials.
   ============================================================ */

const RDK = (function () {
  'use strict';

  // ------------------------------------------------------------
  // Default parameters (baseline). These define the standard
  // condition; the experimental page overrides them per-block.
  // ------------------------------------------------------------
  const DEFAULTS = {
    apertureRadiusPx: 200,      // ~10 deg visual angle at typical viewing
    nDots: 100,
    dotRadiusPx: 2,
    dotSpeedPxPerFrame: 2.5,    // ~5 deg/sec at 60 Hz
    dotLifetimeFrames: 4,       // dots respawn after this many frames
    durationMs: 500,            // stimulus duration per trial
    coherences: [0, 0.05, 0.10, 0.20, 0.40, 0.80],
    trialsPerCoherence: 20,
    fixationMs: 600,
    responseWindowMs: 4000,
    iti_minMs: 400,
    iti_maxMs: 700,
    dotColor: '#ffffff',
    bgColor: '#000000',
    fixationColor: '#ffffff',
    // Attentional load (optional)
    digitMs: 400,               // duration the digit string is shown
    digitColor: '#ffffff',
    // Eccentricity (optional)
    apertureOffsetPx: 0,        // 0 = centred; >0 = offset by this many px
  };

  // ------------------------------------------------------------
  // Stage — handles canvas rendering. The aperture position is
  // recomputed per trial when eccentricity is enabled.
  // ------------------------------------------------------------
  function createStage(canvas, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const canvasCx = canvas.width / 2;
    const canvasCy = canvas.height / 2;
    const r = p.apertureRadiusPx;

    // Aperture centre — updated per trial when eccentricity is enabled
    let apertureCx = canvasCx;
    let apertureCy = canvasCy;

    let dots = [];
    let dotAges = [];
    let signalDirection = 0;
    let coherence = 0;
    let rafId = null;
    let running = false;

    function setApertureOffset(offsetPx) {
      // offsetPx > 0 means aperture moves right; < 0 means left
      apertureCx = canvasCx + offsetPx;
      apertureCy = canvasCy;
    }

    function initDots() {
      dots = [];
      dotAges = [];
      for (let i = 0; i < p.nDots; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.sqrt(Math.random()) * r;
        dots.push({
          x: apertureCx + Math.cos(angle) * radius,
          y: apertureCy + Math.sin(angle) * radius,
          noiseDir: Math.random() * Math.PI * 2,
          isSignal: false,
        });
        dotAges.push(Math.floor(Math.random() * p.dotLifetimeFrames));
      }
    }

    function assignSignalDots() {
      const nSignal = Math.round(coherence * p.nDots);
      const indices = [];
      for (let i = 0; i < p.nDots; i++) indices.push(i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      for (let i = 0; i < p.nDots; i++) dots[i].isSignal = false;
      for (let i = 0; i < nSignal; i++) dots[indices[i]].isSignal = true;
    }

    function stepDots() {
      const signalDx = Math.cos(signalDirection) * p.dotSpeedPxPerFrame;
      const signalDy = Math.sin(signalDirection) * p.dotSpeedPxPerFrame;

      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        if (d.isSignal) {
          d.x += signalDx;
          d.y += signalDy;
        } else {
          d.x += Math.cos(d.noiseDir) * p.dotSpeedPxPerFrame;
          d.y += Math.sin(d.noiseDir) * p.dotSpeedPxPerFrame;
        }

        dotAges[i]++;
        const dx = d.x - apertureCx, dy = d.y - apertureCy;
        const outside = (dx * dx + dy * dy) > (r * r);
        if (dotAges[i] >= p.dotLifetimeFrames || outside) {
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.sqrt(Math.random()) * r;
          d.x = apertureCx + Math.cos(angle) * radius;
          d.y = apertureCy + Math.sin(angle) * radius;
          d.noiseDir = Math.random() * Math.PI * 2;
          dotAges[i] = 0;
        }
      }
    }

    function drawFrame() {
      ctx.fillStyle = p.bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Fixation cross stays at canvas centre even when aperture is offset
      drawFixationCross();

      // Clip to aperture (which may be offset)
      ctx.save();
      ctx.beginPath();
      ctx.arc(apertureCx, apertureCy, r, 0, Math.PI * 2);
      ctx.clip();

      ctx.fillStyle = p.dotColor;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        ctx.beginPath();
        ctx.arc(d.x, d.y, p.dotRadiusPx, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // Subtle aperture outline
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(apertureCx, apertureCy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    function drawFixationCross() {
      ctx.strokeStyle = p.fixationColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(canvasCx - 8, canvasCy);
      ctx.lineTo(canvasCx + 8, canvasCy);
      ctx.moveTo(canvasCx, canvasCy - 8);
      ctx.lineTo(canvasCx, canvasCy + 8);
      ctx.stroke();
    }

    function drawFixation() {
      ctx.fillStyle = p.bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawFixationCross();
    }

    function drawBlank() {
      ctx.fillStyle = p.bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    function drawDigit(digitStr) {
      ctx.fillStyle = p.bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = p.digitColor;
      ctx.font = '600 56px "JetBrains Mono", ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(digitStr), canvasCx, canvasCy);
    }

    function startStimulus(direction, coh) {
      signalDirection = (direction === 'left') ? Math.PI : 0;
      coherence = coh;
      initDots();
      running = true;

      function loop() {
        if (!running) return;
        assignSignalDots();
        stepDots();
        drawFrame();
        rafId = requestAnimationFrame(loop);
      }
      loop();
    }

    function stopStimulus() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    }

    return {
      setApertureOffset,
      drawFixation,
      drawBlank,
      drawDigit,
      startStimulus,
      stopStimulus,
      params: p,
    };
  }

  // ------------------------------------------------------------
  // Trial sequence builder
  // Optionally assigns a random eccentricity side per trial
  // and a random digit string for the attentional-load task.
  // ------------------------------------------------------------
  function buildTrialSequence(coherences, trialsPerCoherence, options) {
    const opts = options || {};
    const eccentricityPx = opts.eccentricityPx || 0;  // magnitude (always positive)
    const nDigits = opts.nDigits || 0;                // 0 = no digit task

    const trials = [];
    for (const coh of coherences) {
      const nLeft = Math.floor(trialsPerCoherence / 2);
      const nRight = trialsPerCoherence - nLeft;
      for (let i = 0; i < nLeft; i++) trials.push({ coherence: coh, direction: 'left' });
      for (let i = 0; i < nRight; i++) trials.push({ coherence: coh, direction: 'right' });
    }
    // Fisher-Yates shuffle
    for (let i = trials.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [trials[i], trials[j]] = [trials[j], trials[i]];
    }
    // Assign trial numbers, eccentricity side, and digit string
    trials.forEach((t, i) => {
      t.trialNumber = i + 1;
      // Random left/right per trial when eccentricity is on
      t.apertureOffsetPx = (eccentricityPx === 0)
        ? 0
        : (Math.random() < 0.5 ? -eccentricityPx : eccentricityPx);
      // Random digit string for attentional load
      if (nDigits > 0) {
        let s = '';
        for (let d = 0; d < nDigits; d++) s += Math.floor(Math.random() * 10);
        t.digitString = s;
      } else {
        t.digitString = null;
      }
    });
    return trials;
  }

  // ------------------------------------------------------------
  // Block runner. Phases per trial:
  //   (optional digit display) -> fixation -> stimulus -> blank+respond -> ITI
  //
  // If callbacks.onDigitRecall is supplied (and trials carry
  // digitStrings), at the end of the block the caller is asked
  // to display a recall prompt; the resolved recall string is
  // attached to the data array as a separate field.
  // ------------------------------------------------------------
  function runBlock(stage, trials, callbacks) {
    const cb = callbacks || {};
    const data = [];
    let trialIndex = 0;
    let waitingForResponse = false;
    let trialStartTime = 0;
    let currentTrial = null;
    let responseTimer = null;
    let phaseTimer = null;
    let keyHandler = null;
    let aborted = false;

    function nextTrial() {
      if (aborted) return;
      if (trialIndex >= trials.length) {
        cleanup();
        if (cb.onComplete) cb.onComplete(data);
        return;
      }

      currentTrial = trials[trialIndex];

      // Apply per-trial aperture offset
      if (stage.setApertureOffset) {
        stage.setApertureOffset(currentTrial.apertureOffsetPx || 0);
      }

      if (cb.onTrialStart) {
        cb.onTrialStart(trialIndex + 1, trials.length, currentTrial);
      }

      // Phase 0 (optional): digit display
      const hasDigit = currentTrial.digitString != null;
      if (hasDigit) {
        stage.drawDigit(currentTrial.digitString);
        phaseTimer = setTimeout(startFixation, stage.params.digitMs);
      } else {
        startFixation();
      }
    }

    function startFixation() {
      // Phase 1: fixation
      stage.drawFixation();
      phaseTimer = setTimeout(() => {
        // Phase 2: stimulus
        stage.startStimulus(currentTrial.direction, currentTrial.coherence);
        trialStartTime = performance.now();
        waitingForResponse = false;

        phaseTimer = setTimeout(() => {
          // Phase 3: blank, wait for response
          stage.stopStimulus();
          stage.drawBlank();
          waitingForResponse = true;

          responseTimer = setTimeout(() => {
            if (waitingForResponse) recordResponse(null, null);
          }, stage.params.responseWindowMs);
        }, stage.params.durationMs);
      }, stage.params.fixationMs);
    }

    function recordResponse(response, rt) {
      if (!waitingForResponse) return;
      waitingForResponse = false;
      if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }

      const row = {
        trial_number: currentTrial.trialNumber,
        coherence: currentTrial.coherence,
        signal_direction: currentTrial.direction,
        aperture_offset_px: currentTrial.apertureOffsetPx || 0,
        response: response,
        correct: response === null ? null : (response === currentTrial.direction ? 1 : 0),
        rt_ms: rt,
      };
      // Only carry digit column when digits are actually in use
      if (currentTrial.digitString != null) {
        row.digit_shown = currentTrial.digitString;
      }
      data.push(row);
      trialIndex++;

      const iti = stage.params.iti_minMs +
                  Math.random() * (stage.params.iti_maxMs - stage.params.iti_minMs);
      stage.drawBlank();
      phaseTimer = setTimeout(nextTrial, iti);
    }

    function handleKey(e) {
      if (!waitingForResponse) return;
      let resp = null;
      if (e.key === 'ArrowLeft') resp = 'left';
      else if (e.key === 'ArrowRight') resp = 'right';
      if (resp) {
        e.preventDefault();
        const rt = performance.now() - trialStartTime;
        recordResponse(resp, Math.round(rt));
      }
    }

    function cleanup() {
      if (keyHandler) {
        window.removeEventListener('keydown', keyHandler);
        keyHandler = null;
      }
      if (phaseTimer) clearTimeout(phaseTimer);
      if (responseTimer) clearTimeout(responseTimer);
      stage.stopStimulus();
    }

    function abort() {
      aborted = true;
      cleanup();
    }

    keyHandler = handleKey;
    window.addEventListener('keydown', keyHandler);
    nextTrial();

    return { abort };
  }

  // ------------------------------------------------------------
  // CSV export
  // ------------------------------------------------------------
  function toCSV(data, meta) {
    const lines = [];
    if (meta) {
      for (const k in meta) {
        if (Object.prototype.hasOwnProperty.call(meta, k)) {
          lines.push(`# ${k}: ${meta[k]}`);
        }
      }
    }
    if (data.length === 0) {
      lines.push('trial_number,coherence,signal_direction,response,correct,rt_ms');
      return lines.join('\n');
    }
    const keys = Object.keys(data[0]);
    lines.push(keys.join(','));
    for (const row of data) {
      lines.push(keys.map(k => csvField(row[k])).join(','));
    }
    return lines.join('\n');
  }

  function csvField(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function downloadCSV(csvText, filename) {
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return {
    DEFAULTS,
    createStage,
    buildTrialSequence,
    runBlock,
    toCSV,
    downloadCSV,
  };
})();
