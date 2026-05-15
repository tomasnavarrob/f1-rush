/* ============================================================
   F1 RUSH — Motor de audio procedural (Web Audio API)
   ============================================================
   Sintetiza el sonido de un V6 turbo híbrido moderno usando
   oscilladores apilados con armónicos, un filtro pasa banda
   y modulación de frecuencia ligada al RPM virtual del coche.

   No hay archivos de audio externos. Todo es síntesis.
   ============================================================ */

class EngineSound {
  constructor() {
    this.ctx = null;
    this.oscs = [];
    this.gain = null;
    this.filter = null;
    this.noise = null;
    this.noiseGain = null;
    this.started = false;
    this.targetRpm = 0;
    this.rpm = 0;
    this.muted = false;
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    const ctx = this.ctx;

    // Master gain
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(ctx.destination);

    // Filtro pasa banda — moldea el "color" del motor
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 800;
    this.filter.Q.value = 1.2;
    this.filter.connect(this.gain);

    // 4 osciladores apilados para armónicos (motor V6 ~ múltiples explosiones)
    const harmonics = [1, 2, 3, 4.5];
    const gains = [0.5, 0.35, 0.2, 0.12];
    for (let i = 0; i < harmonics.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : 'square';
      osc.frequency.value = 60 * harmonics[i];
      const g = ctx.createGain();
      g.gain.value = gains[i];
      osc.connect(g);
      g.connect(this.filter);
      osc.start();
      this.oscs.push({ osc, gain: g, harmonic: harmonics[i] });
    }

    // Ruido blanco para el "soplido" del turbo / aire
    const bufferSize = 2 * ctx.sampleRate;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuffer;
    this.noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 1800;
    noiseFilter.Q.value = 0.6;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noise.connect(noiseFilter);
    noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.gain);
    this.noise.start();

    this.started = true;
  }

  // rpm: 0..1 normalizado (0 = ralentí, 1 = corte de revoluciones)
  setRpm(target) {
    this.targetRpm = Math.max(0, Math.min(1, target));
  }

  setMuted(m) {
    this.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : this._lastGain || 0;
  }

  update(dt) {
    if (!this.started || this.muted) return;

    // Suavizado del RPM
    this.rpm += (this.targetRpm - this.rpm) * Math.min(1, dt * 4);

    // Frecuencia base: 80 Hz ralentí → 280 Hz tope
    const baseFreq = 80 + this.rpm * 200;

    for (const o of this.oscs) {
      // Pequeño wobble random para realismo
      const wobble = 1 + (Math.sin(this.ctx.currentTime * 30) * 0.005);
      o.osc.frequency.setTargetAtTime(baseFreq * o.harmonic * wobble, this.ctx.currentTime, 0.04);
    }

    // Filtro abre con RPM
    const cutoff = 400 + this.rpm * 2400;
    this.filter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.04);

    // Volumen general
    const targetGain = 0.05 + this.rpm * 0.18;
    this._lastGain = targetGain;
    this.gain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.05);

    // Turbo whoosh con RPM alto
    const noiseAmt = this.rpm > 0.5 ? (this.rpm - 0.5) * 0.18 : 0;
    this.noiseGain.gain.setTargetAtTime(noiseAmt, this.ctx.currentTime, 0.05);
  }

  // Un golpe corto (cambio de marcha)
  blip() {
    if (!this.started) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = 1200;
    o.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.12);
    g.gain.value = 0.18;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.2);
  }

  // Sonido de derrape / off-track (ruido filtrado breve)
  scrape(intensity = 1) {
    if (!this.started) return;
    const ctx = this.ctx;
    const bufSize = ctx.sampleRate * 0.25;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2200;
    f.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.value = 0.08 * intensity;
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start();
  }

  // Tono de "nueva vuelta rápida"
  jingle(purple = false) {
    if (!this.started) return;
    const ctx = this.ctx;
    const notes = purple ? [880, 1175, 1568, 1760] : [659, 880, 1175];
    notes.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = freq;
      const t = ctx.currentTime + i * 0.08;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(g); g.connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.45);
    });
  }
}

window.EngineSound = EngineSound;

/* ============================================================
   Música 8-bit / chiptune (estilo NES / arcade)
   ============================================================
   Usa ondas cuadradas para melodía + armonía (Pulse 1 + Pulse 2),
   triangular para el bajo, y ruido filtrado para la batería.
   Sin reverb — sonido seco y crujiente como un arcade clásico.
   ============================================================ */
class MenuMusic {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.playing = false;
    this.tickHandle = null;
  }

  setEnabled(on) { this.enabled = !!on; if (!on) this.stop(); }
  isOn() { return this.enabled; }
  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) this.start();
    else this.stop();
  }

  _ensureCtx() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    // Filtro pasa altos suave para quitar muddiness del bajo
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 50;
    this.master.connect(hp);
    hp.connect(this.ctx.destination);
  }

  start() {
    if (!this.enabled || this.playing) return;
    this._ensureCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.playing = true;
    this._nextLoopAt = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(this.master.gain.value, this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0.28, this.ctx.currentTime + 0.6);
    this._scheduleLoop();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this.tickHandle) clearTimeout(this.tickHandle);
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.4);
    }
  }

  _midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  _scheduleLoop() {
    if (!this.playing) return;
    const ctx = this.ctx;
    const bpm = 138;
    const beat = 60 / bpm;
    const six = beat / 4;                  // dieciseisava

    // Melodía: 4 compases con transposición por acorde
    // Patrón base (modo mayor, 16 dieciseisavas):
    const pattern = [
       0, 4, 7,12, 7, 4, 0, 7,    // ascending arp + alt
       9, 7, 4, 0, 4, 7,12, 7,
    ];
    // Acordes (raíces MIDI) — C, G, Am(=A), F → muy clásico
    const chordRoots = [60, 67, 57, 65];
    const bassRoots  = [36, 43, 33, 41];

    const t0 = Math.max(this._nextLoopAt, ctx.currentTime);

    chordRoots.forEach((root, ci) => {
      const tBar = t0 + ci * 16 * six;
      const bassR = bassRoots[ci];

      // Pulse 1 — melodía principal (square)
      pattern.forEach((semi, i) => {
        const note = root + semi;
        this._pulse(this._midiHz(note), tBar + i * six, six * 0.85, 0.12);
      });

      // Pulse 2 — armonía (5ª por encima, square, levemente más bajo)
      pattern.forEach((semi, i) => {
        if (i % 2 !== 0) return; // sólo en ocho corcheas para no saturar
        const note = root + semi + 7;
        this._pulse(this._midiHz(note), tBar + i * six, six * 1.7, 0.06);
      });

      // Bajo — triangular (raíz dos octavas abajo, pulso staccato)
      for (let i = 0; i < 8; i++) {
        const t = tBar + i * (six * 2);
        const semi = (i % 4 === 2) ? 7 : 0;   // alterna entre raíz y 5ª
        this._tri(this._midiHz(bassR + semi), t, six * 1.6, 0.18);
      }

      // Batería: kick en 1 y 3, snare en 2 y 4
      for (let b = 0; b < 4; b++) {
        const t = tBar + b * beat;
        if (b % 2 === 0) this._kick(t);
        else this._snare(t);
        // Hi-hat en cada corchea
        this._hihat(t + 0.0);
        this._hihat(t + beat * 0.5);
      }
    });

    const totalDur = 4 * 16 * six;
    this._nextLoopAt = t0 + totalDur;
    // Reprograma con ~250ms de antelación; los nuevos notes se anclan a _nextLoopAt
    this.tickHandle = setTimeout(() => this._scheduleLoop(), totalDur * 1000 - 250);
  }

  // Pulse (square wave) — Pulse 1/Pulse 2 del NES
  _pulse(freq, when, dur, amp) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.003);     // ataque rápido
    g.gain.setValueAtTime(amp * 0.95, when + dur * 0.6);
    g.gain.linearRampToValueAtTime(0, when + dur);          // release corto
    o.connect(g); g.connect(this.master);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  // Triangular (canal del bajo del NES)
  _tri(freq, when, dur, amp) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(amp, when + 0.005);
    g.gain.linearRampToValueAtTime(0, when + dur);
    o.connect(g); g.connect(this.master);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  // Kick — onda de seno con frecuencia decayente rápida
  _kick(when) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, when);
    o.frequency.exponentialRampToValueAtTime(45, when + 0.10);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.32, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.15);
    o.connect(g); g.connect(this.master);
    o.start(when);
    o.stop(when + 0.18);
  }

  // Snare — burst de ruido filtrado
  _snare(when) {
    const ctx = this.ctx;
    const bufSize = ctx.sampleRate * 0.18;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.16, when + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.13);
    src.connect(hp); hp.connect(g); g.connect(this.master);
    src.start(when);
    src.stop(when + 0.15);
  }

  // Hi-hat — burst muy corto de ruido agudo
  _hihat(when) {
    const ctx = this.ctx;
    const bufSize = Math.floor(ctx.sampleRate * 0.04);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.05, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
    src.connect(hp); hp.connect(g); g.connect(this.master);
    src.start(when);
    src.stop(when + 0.05);
  }
}

window.MenuMusic = MenuMusic;
