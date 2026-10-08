/*
 * Outcry agent recap: an animated, shareable replay of what an agent did.
 * Used by the terminal (modal) and by the public recap page.
 *
 *   const r = OutcryRecap.mount(canvas, data, { sound: true });
 *   r.play(); r.stop(); await r.record() -> Blob (video with sound)
 *
 * data = { name, kind, mode, startUsd, endUsd, from, to,
 *          history: [{ t, v }], trades: [{ t, side, symbol, usd, pnlUsd? }] }
 */
(function () {
  const W = 1080, H = 1350;
  const C = {
    bg: '#0E1030', bg2: '#161A40', line: '#262B57', text: '#F3EFE4', soft: '#C9CBE0', muted: '#9EA2C9',
    voice: '#2F3CFF', voiceText: '#8E95FF', up: '#3DDC97', down: '#FF6B6B', amber: '#F5B642',
  };
  const DISPLAY = "'Big Shoulders Display','Oswald','Arial Narrow',sans-serif";
  const MONO = "'JetBrains Mono',ui-monospace,Menlo,monospace";
  const SANS = "'Geist',system-ui,sans-serif";
  const INTRO = 1400, DRAW = 9500, OUTRO = 4600, TOTAL = INTRO + DRAW + OUTRO;

  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const back = (x) => { x = Math.min(1, Math.max(0, x)); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const usd = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sgn = (n) => (n >= 0 ? '+' : '−');

  function stats(d) {
    const sells = d.trades.filter((t) => t.side === 'sell' && t.pnlUsd != null);
    const withPct = sells.map((t) => ({ ...t, pnlPct: (t.pnlUsd / Math.max(1e-9, t.usd - t.pnlUsd)) * 100 }));
    const best = withPct.slice().sort((a, b) => b.pnlPct - a.pnlPct)[0];
    const worst = withPct.slice().sort((a, b) => a.pnlPct - b.pnlPct)[0];
    const wins = sells.filter((t) => t.pnlUsd > 0).length;
    const pnl = d.endUsd - d.startUsd;
    return { buys: d.trades.filter((t) => t.side === 'buy').length, sells: sells.length, wins, best, worst, pnl, pct: (pnl / Math.max(1e-9, d.startUsd)) * 100 };
  }

  // ---------------------------------------------------------------------------
  // Sound: tiny synth, no files. Everything goes through `out` so it can be recorded.
  // ---------------------------------------------------------------------------
  function makeAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(ctx.destination);
    const rec = ctx.createMediaStreamDestination ? ctx.createMediaStreamDestination() : null;
    if (rec) out.connect(rec);
    let last = 0;
    const tone = (freq, dur, { type = 'sine', vol = 0.25, slide = 0, delay = 0 } = {}) => {
      const t0 = ctx.currentTime + delay;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    };
    const throttle = () => {
      const now = performance.now();
      if (now - last < 80) return false;
      last = now;
      return true;
    };
    return {
      ctx,
      stream: rec ? rec.stream : null,
      resume: () => ctx.state === 'suspended' && ctx.resume(),
      buy: () => throttle() && tone(740, 0.09, { type: 'sine', vol: 0.18, slide: 1.25 }),
      win: (pct) => {
        if (!throttle()) return;
        const base = 660 + Math.min(600, Math.max(0, pct) * 6);
        tone(base, 0.16, { type: 'triangle', vol: 0.22 });
        tone(base * 1.26, 0.18, { type: 'triangle', vol: 0.2, delay: 0.07 });
        if (pct > 40) tone(base * 1.5, 0.28, { type: 'triangle', vol: 0.18, delay: 0.14 });
      },
      loss: () => throttle() && tone(200, 0.22, { type: 'sine', vol: 0.3, slide: 0.55 }),
      tick: () => tone(1900, 0.025, { type: 'square', vol: 0.025 }),
      finale: (up) => {
        const notes = up ? [523.25, 659.25, 783.99, 1046.5] : [440, 523.25, 622.25];
        notes.forEach((f, i) => tone(f, 1.1, { type: 'triangle', vol: 0.16, delay: i * 0.09 }));
      },
      whoosh: () => tone(140, 0.45, { type: 'sawtooth', vol: 0.05, slide: 3.2 }),
    };
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  function mount(canvas, data, opts = {}) {
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    const s = stats(data);
    const hist = data.history.length >= 2 ? data.history : [{ t: data.from, v: data.startUsd }, { t: data.to, v: data.endUsd }];
    const t0 = hist[0].t, t1 = Math.max(hist[hist.length - 1].t, t0 + 1);
    const vals = hist.map((p) => p.v);
    let lo = Math.min(data.startUsd, ...vals), hi = Math.max(data.startUsd, ...vals);
    const pad = Math.max((hi - lo) * 0.18, data.startUsd * 0.01, 0.5);
    lo -= pad; hi += pad;
    const box = { x: 90, y: 440, w: W - 180, h: 440 };
    const X = (t) => box.x + ((t - t0) / (t1 - t0)) * box.w;
    const Y = (v) => box.y + (1 - (v - lo) / (hi - lo)) * box.h;
    const valAt = (t) => { let v = hist[0].v; for (const p of hist) { if (p.t <= t) v = p.v; else break; } return v; };
    const trades = data.trades.filter((t) => t.t >= t0 - 1000).map((t) => ({ ...t, v: valAt(t.t), pct: t.pnlUsd != null ? (t.pnlUsd / Math.max(1e-9, t.usd - t.pnlUsd)) * 100 : null }));

    let audio = null, raf = 0, start = 0, played = new Set(), finaleDone = false, whooshDone = false, lastTick = 0;
    const sound = () => opts.sound !== false && audio;

    function bg() {
      g.fillStyle = C.bg;
      g.fillRect(0, 0, W, H);
      // soft cobalt glow
      const rg = g.createRadialGradient(W * 0.8, 160, 20, W * 0.8, 160, 700);
      rg.addColorStop(0, 'rgba(47,60,255,.35)');
      rg.addColorStop(1, 'rgba(47,60,255,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, W, H);
      // grid
      g.strokeStyle = 'rgba(58,64,122,.35)';
      g.lineWidth = 1;
      for (let x = 0; x <= W; x += 90) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (let y = 0; y <= H; y += 90) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    }

    function header(a) {
      g.globalAlpha = a;
      g.fillStyle = C.voiceText;
      g.font = `600 26px ${MONO}`;
      g.fillText('OUTCRY · AGENT RECAP', 90, 120);
      g.fillStyle = C.text;
      g.font = `900 110px ${DISPLAY}`;
      g.fillText(String(data.name).toUpperCase().slice(0, 18), 86, 228);
      const badge = data.mode === 'paper' ? 'PAPER TRADING · SIMULATED' : 'LIVE · REAL FUNDS';
      g.font = `600 24px ${MONO}`;
      const bw = g.measureText(badge).width + 36;
      g.fillStyle = data.mode === 'paper' ? 'rgba(245,182,66,.14)' : 'rgba(61,220,151,.14)';
      roundRect(90, 258, bw, 46, 23);
      g.fill();
      g.fillStyle = data.mode === 'paper' ? C.amber : C.up;
      g.fillText(badge, 108, 289);
      const span = Math.max(1, Math.round((t1 - t0) / 60000));
      g.fillStyle = C.muted;
      g.font = `500 24px ${MONO}`;
      g.fillText(`${data.kind === 'sniper' ? 'pump.fun sniper' : 'strategy agent'} · ${span >= 120 ? Math.round(span / 60) + ' h' : span + ' min'}`, 90 + bw + 20, 289);
      g.globalAlpha = 1;
    }

    function roundRect(x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }

    function counter(v, a) {
      const d = v - data.startUsd, up = d >= 0;
      g.globalAlpha = a;
      g.fillStyle = C.muted;
      g.font = `500 24px ${MONO}`;
      g.fillText('VALUE', 90, 340);
      g.fillStyle = C.text;
      g.font = `800 64px ${DISPLAY}`;
      g.fillText(usd(v), 90, 410);
      g.textAlign = 'right';
      g.fillStyle = up ? C.up : C.down;
      g.font = `800 64px ${DISPLAY}`;
      g.fillText(`${sgn(d)}${Math.abs((d / Math.max(1e-9, data.startUsd)) * 100).toFixed(1)}%`, W - 90, 410);
      g.textAlign = 'left';
      g.globalAlpha = 1;
    }

    function chart(p, now) {
      const tNow = t0 + (t1 - t0) * p;
      const base = Y(data.startUsd);
      // baseline
      g.setLineDash([8, 10]);
      g.strokeStyle = 'rgba(158,162,201,.5)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(box.x, base); g.lineTo(box.x + box.w, base); g.stroke();
      g.setLineDash([]);
      g.fillStyle = C.muted;
      g.font = `500 20px ${MONO}`;
      g.fillText(`start ${usd(data.startUsd)}`, box.x, base - 12);
      const pts = hist.filter((q) => q.t <= tNow);
      if (pts.length) pts.push({ t: tNow, v: valAt(tNow) });
      if (pts.length >= 2) {
        // area, colored above/below the start
        for (const [clipY, clipH, col] of [[0, base, C.up], [base, H - base, C.down]]) {
          g.save();
          g.beginPath(); g.rect(0, clipY, W, clipH); g.clip();
          const grad = g.createLinearGradient(0, box.y, 0, box.y + box.h);
          grad.addColorStop(0, col === C.up ? 'rgba(61,220,151,.30)' : 'rgba(255,107,107,.05)');
          grad.addColorStop(1, col === C.up ? 'rgba(61,220,151,.02)' : 'rgba(255,107,107,.30)');
          g.beginPath();
          g.moveTo(X(pts[0].t), base);
          pts.forEach((q) => g.lineTo(X(q.t), Y(q.v)));
          g.lineTo(X(pts[pts.length - 1].t), base);
          g.closePath();
          g.fillStyle = grad;
          g.fill();
          g.shadowColor = col;
          g.shadowBlur = 18;
          g.strokeStyle = col;
          g.lineWidth = 5;
          g.lineJoin = 'round';
          g.beginPath();
          pts.forEach((q, i) => (i ? g.lineTo(X(q.t), Y(q.v)) : g.moveTo(X(q.t), Y(q.v))));
          g.stroke();
          g.restore();
        }
        // head
        const h = pts[pts.length - 1];
        const up = h.v >= data.startUsd;
        g.fillStyle = up ? C.up : C.down;
        g.beginPath(); g.arc(X(h.t), Y(h.v), 10 + Math.sin(now / 120) * 2, 0, Math.PI * 2); g.fill();
      }
      // trade markers with pop-in, sounds and labels
      for (const [i, tr] of trades.entries()) {
        if (tr.t > tNow) continue;
        const age = Math.min(1, (now - (tr._at ??= now)) / 380);
        if (!played.has(i)) {
          played.add(i);
          if (sound()) tr.side === 'buy' ? audio.buy() : (tr.pnlUsd ?? 0) >= 0 ? audio.win(tr.pct ?? 0) : audio.loss();
        }
        const x = X(tr.t), y = Y(tr.v), k = back(age);
        g.save();
        g.translate(x, y);
        g.scale(k, k);
        if (tr.side === 'buy') {
          g.fillStyle = C.voiceText;
          g.beginPath(); g.moveTo(0, -16); g.lineTo(12, 6); g.lineTo(-12, 6); g.closePath(); g.fill();
        } else {
          const good = (tr.pnlUsd ?? 0) >= 0;
          g.fillStyle = good ? C.up : C.down;
          g.strokeStyle = C.bg;
          g.lineWidth = 4;
          g.beginPath(); g.arc(0, 0, 12, 0, Math.PI * 2); g.fill(); g.stroke();
        }
        g.restore();
        // floating label for notable sells
        if (tr.side === 'sell' && tr.pct != null && Math.abs(tr.pct) >= 15 && age < 1) {
          const up = tr.pct >= 0, rise = ease(age) * 40;
          g.globalAlpha = 1 - age * 0.35;
          g.fillStyle = up ? C.up : C.down;
          g.font = `700 28px ${MONO}`;
          g.textAlign = 'center';
          g.fillText(`$${tr.symbol} ${sgn(tr.pct)}${Math.abs(tr.pct).toFixed(0)}%`, x, y - 30 - rise);
          g.textAlign = 'left';
          g.globalAlpha = 1;
        }
      }
      return valAt(tNow);
    }

    function card(x, y, w, h, label, value, color, a) {
      g.globalAlpha = a;
      g.fillStyle = 'rgba(28,33,80,.92)';
      roundRect(x, y + (1 - a) * 40, w, h, 22);
      g.fill();
      g.strokeStyle = C.line;
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = C.muted;
      g.font = `500 22px ${MONO}`;
      g.fillText(label, x + 28, y + 46 + (1 - a) * 40);
      g.fillStyle = color;
      let size = 54;
      g.font = `800 ${size}px ${DISPLAY}`;
      while (g.measureText(value).width > w - 56 && size > 26) g.font = `800 ${(size -= 2)}px ${DISPLAY}`;
      g.fillText(value, x + 28, y + 110 + (1 - a) * 40);
      g.globalAlpha = 1;
    }

    function outro(e) {
      const up = s.pnl >= 0;
      const top = 920;
      const cw = (W - 180 - 30) / 2;
      card(90, top, cw, 140, 'RESULT', `${sgn(s.pnl)}${usd(Math.abs(s.pnl)).replace('−', '')}`, up ? C.up : C.down, ease(e * 2.2));
      card(90 + cw + 30, top, cw, 140, 'WIN RATE', s.sells ? `${Math.round((s.wins / s.sells) * 100)}% · ${s.wins}/${s.sells}` : '—', C.text, ease(e * 2.2 - 0.25));
      const bestTxt = s.best ? `$${s.best.symbol} ${sgn(s.best.pnlPct)}${Math.abs(s.best.pnlPct).toFixed(0)}%` : '—';
      card(90, top + 160, cw, 140, 'BEST TRADE', bestTxt.length > 16 ? bestTxt.slice(0, 16) : bestTxt, s.best && s.best.pnlPct >= 0 ? C.up : C.text, ease(e * 2.2 - 0.5));
      card(90 + cw + 30, top + 160, cw, 140, 'TRADES', `${s.buys} buys · ${s.sells} sells`, C.text, ease(e * 2.2 - 0.75));
    }

    function footer() {
      g.strokeStyle = C.line;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(90, H - 110); g.lineTo(W - 90, H - 110); g.stroke();
      g.fillStyle = C.text;
      g.font = `900 46px ${DISPLAY}`;
      g.fillText('OUTCRY', 90, H - 52);
      g.fillStyle = C.muted;
      g.font = `500 20px ${MONO}`;
      g.textAlign = 'right';
      g.fillText(data.mode === 'paper' ? 'Paper money · real market prices' : 'Real funds · past results', W - 90, H - 70);
      g.fillText('Not investment advice', W - 90, H - 42);
      g.textAlign = 'left';
    }

    function frame(now) {
      const t = now - start;
      bg();
      const intro = ease(t / 600);
      header(intro);
      if (t > INTRO * 0.6 && !whooshDone) { whooshDone = true; if (sound()) audio.whoosh(); }
      const p = ease((t - INTRO) / DRAW);
      const v = chart(Math.max(0, p), now);
      counter(t < INTRO ? data.startUsd : v, ease((t - INTRO * 0.5) / 600));
      if (t > INTRO && p < 1 && now - lastTick > 160) { lastTick = now; if (sound()) audio.tick(); }
      if (t > INTRO + DRAW) {
        if (!finaleDone) { finaleDone = true; if (sound()) audio.finale(s.pnl >= 0); }
        outro((t - INTRO - DRAW) / 1600);
      }
      footer();
      if (t < TOTAL) raf = requestAnimationFrame(frame);
      else opts.onEnd && opts.onEnd();
    }

    function reset() {
      played = new Set();
      finaleDone = false;
      whooshDone = false;
      trades.forEach((tr) => delete tr._at);
    }

    const api = {
      duration: TOTAL,
      async play() {
        if (document.fonts && document.fonts.load) {
          await Promise.race([Promise.all([document.fonts.load(`900 110px ${DISPLAY}`), document.fonts.load(`600 26px ${MONO}`)]), new Promise((r) => setTimeout(r, 1500))]);
        }
        cancelAnimationFrame(raf);
        if (opts.sound !== false) { audio ??= makeAudio(); audio && audio.resume(); }
        reset();
        start = performance.now();
        raf = requestAnimationFrame(frame);
      },
      stop() { cancelAnimationFrame(raf); },
      setSound(on) { opts.sound = on; if (on) { audio ??= makeAudio(); audio && audio.resume(); } },
      /** Plays the recap once and returns it as a video (with sound when available). */
      async record() {
        audio ??= makeAudio();
        audio && audio.resume();
        const vs = canvas.captureStream(30);
        const tracks = [...vs.getVideoTracks(), ...(audio && audio.stream && opts.sound !== false ? audio.stream.getAudioTracks() : [])];
        const stream = new MediaStream(tracks);
        const types = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
        const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
        const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const done = new Promise((r) => (rec.onstop = r));
        const prevEnd = opts.onEnd;
        const ended = new Promise((r) => (opts.onEnd = r));
        await api.play();
        rec.start(250);
        await ended;
        opts.onEnd = prevEnd;
        await new Promise((r) => setTimeout(r, 400));
        rec.stop();
        await done;
        return new Blob(chunks, { type: (mimeType || 'video/webm').split(';')[0] });
      },
    };
    // First frame (static) so the canvas isn't empty before Play.
    start = performance.now() - INTRO * 0.4;
    bg(); header(1); footer();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!raf) { bg(); header(1); footer(); } });
    return api;
  }

  window.OutcryRecap = { mount, stats };
})();
