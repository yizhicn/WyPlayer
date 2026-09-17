/**
 * WyPlayer 封面播放特效（桌面 + 手机共用）
 * modes: off | crystal | orbit
 * 叠在唱片转动 / ColorThief 之上；画布可超出容器，并以唱片为圆心向外渐隐。
 */
export const PLAY_EFFECT_OPTIONS = [
  { id: 'off', name: '无特效', desc: '唱片转动与封面取色' },
  { id: 'crystal', name: '水晶音波', desc: '三角向外扩散' },
  { id: 'orbit', name: '星环粒子', desc: ' 环绕唱片渐隐' },
];

const STORAGE_KEY = 'cp_play_effect';
/** 画布相对唱片容器的放大倍数，让粒子能飞出原来的方块 */
const CANVAS_SCALE = 2.15;
/** 渐隐外沿相对封面半径的倍数 */
const FADE_OUTER_MUL = 2.35;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function parseCssColor(css) {
  const c = String(css || '#ffffff').trim();
  if (c.startsWith('#') && (c.length === 7 || c.length === 4)) {
    const hex = c.length === 4
      ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`
      : c;
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }
  const m = c.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return { r: 255, g: 255, b: 255 };
}

function rgba(rgb, a) {
  return `rgba(${rgb.r | 0},${rgb.g | 0},${rgb.b | 0},${a})`;
}

/** 以封面边缘为起点、外沿为终点：越远越透明（1→0） */
function radialFade(dist, coverR, fadeOuter) {
  if (dist <= coverR * 0.92) return 0.15; // 略压低盖在碟上的部分
  if (dist >= fadeOuter) return 0;
  const t = (dist - coverR * 0.92) / (fadeOuter - coverR * 0.92);
  return clamp(1 - t * t, 0, 1); // 二次曲线，外缘更柔
}

export function getStoredPlayEffect() {
  let id = localStorage.getItem(STORAGE_KEY) || 'crystal';
  // 旧版 pulse / ring 迁移
  if (id === 'pulse' || id === 'ring') id = 'crystal';
  return PLAY_EFFECT_OPTIONS.some((o) => o.id === id) ? id : 'crystal';
}

export function setStoredPlayEffect(id) {
  if (!PLAY_EFFECT_OPTIONS.some((o) => o.id === id)) return getStoredPlayEffect();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

export class PlayEffectsEngine {
  constructor() {
    this.mode = getStoredPlayEffect();
    this.playing = false;
    this.targets = [];
    this.raf = 0;
    this.rgb = { r: 255, g: 255, b: 255 };
    this.t0 = performance.now();
    this.last = this.t0;
    this._colorTick = 0;
    this.energy = 0.35;
    this.audio = null;
    this.audioCtx = null;
    this.analyser = null;
    this.freqData = null;
    this._audioWired = false;
    this._ro = null;
    this._albumColorLocked = false;
  }

  attach(container) {
    if (!container) return;
    if (this.targets.some((t) => t.container === container)) return;
    let canvas = container.querySelector('.play-effect-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'play-effect-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      container.insertBefore(canvas, container.firstChild);
    }
    const ctx = canvas.getContext('2d', { alpha: true });
    const target = {
      container,
      canvas,
      ctx,
      w: 0,
      h: 0,
      coverR: 0,
      fadeOuter: 0,
      triangles: [],
      stars: [],
    };
    this.targets.push(target);
    this._resizeTarget(target);
    if (!this._ro) {
      this._ro = new ResizeObserver(() => this.resizeAll());
    }
    this._ro.observe(container);
    const vinyl = container.querySelector('.album-art-wrapper');
    if (vinyl) this._ro.observe(vinyl);
    this._applyVisibility();
    this._ensureLoop();
  }

  bindAudio(audioEl) {
    this.audio = audioEl || null;
  }

  setMode(id) {
    this.mode = setStoredPlayEffect(id);
    this.targets.forEach((t) => {
      t.triangles = [];
      t.stars = [];
      t.ctx.clearRect(0, 0, t.w, t.h);
    });
    // 以真实音频状态为准，避免切换特效时误开
    if (this.audio) this.playing = !this.audio.paused && !this.audio.ended;
    this._applyVisibility();
    this._ensureLoop();
  }

  setPlaying(playing) {
    this.playing = Boolean(playing);
    if (this.playing) {
      this._tryWireAudio();
      this.audioCtx?.resume?.().catch(() => {});
    } else {
      // 暂停 / 未播放：立刻清粒子并隐藏
      this.targets.forEach((t) => {
        t.triangles = [];
        t.stars = [];
        t.ctx.clearRect(0, 0, t.w, t.h);
      });
    }
    this._applyVisibility();
    this._ensureLoop();
  }

  setPrimaryColor(cssColor) {
    this.rgb = parseCssColor(cssColor);
    this._albumColorLocked = true;
  }

  clearAlbumColor() {
    this._albumColorLocked = false;
  }

  resizeAll() {
    this.targets.forEach((t) => this._resizeTarget(t));
  }

  _applyVisibility() {
    // 仅「选了特效且正在播放」时显示
    const on = this.mode !== 'off' && this.playing;
    this.targets.forEach((t) => {
      t.canvas.style.opacity = on ? '1' : '0';
      t.canvas.style.visibility = on ? 'visible' : 'hidden';
    });
  }

  _resizeTarget(t) {
    const rect = t.container.getBoundingClientRect();
    const vinyl = t.container.querySelector('.album-art-wrapper');
    const vRect = vinyl ? vinyl.getBoundingClientRect() : rect;
    const coverR = Math.max(40, vRect.width / 2);
    const fadeOuter = coverR * FADE_OUTER_MUL;
    // 画布至少覆盖渐隐外沿 + 一点余量
    const need = Math.ceil(fadeOuter * 2 * 1.08);
    const base = Math.max(rect.width, rect.height, 1);
    const size = Math.max(need, Math.floor(base * CANVAS_SCALE));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    t.w = size;
    t.h = size;
    t.coverR = coverR;
    t.fadeOuter = fadeOuter;
    t.canvas.width = Math.floor(size * dpr);
    t.canvas.height = Math.floor(size * dpr);
    t.canvas.style.width = `${size}px`;
    t.canvas.style.height = `${size}px`;
    t.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _tryWireAudio() {
    if (this._audioWired || !this.audio) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.audioCtx = this.audioCtx || new AC();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.78;
      const src = this.audioCtx.createMediaElementSource(this.audio);
      src.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this._audioWired = true;
    } catch (_) {
      this._audioWired = false;
    }
  }

  _sampleEnergy(now) {
    this._colorTick = (this._colorTick || 0) + 1;
    if (!this._albumColorLocked && this._colorTick % 45 === 0) {
      try {
        if (!this._colorProbe) {
          this._colorProbe = document.createElement('span');
          this._colorProbe.setAttribute('aria-hidden', 'true');
          this._colorProbe.style.cssText = 'position:absolute;left:-9999px;top:0;pointer-events:none;color:var(--primary-color)';
          document.body.appendChild(this._colorProbe);
        }
        const css = getComputedStyle(this._colorProbe).color;
        if (css) this.rgb = parseCssColor(css);
      } catch (_) { /* ignore */ }
    }
    if (this.analyser && this.freqData && this.playing) {
      try {
        this.analyser.getByteFrequencyData(this.freqData);
        let sum = 0;
        const n = Math.min(32, this.freqData.length);
        for (let i = 0; i < n; i++) sum += this.freqData[i];
        const avg = sum / (n * 255);
        this.energy = clamp(avg * 1.6, 0.12, 1);
        return this.energy;
      } catch (_) { /* fallthrough */ }
    }
    if (!this.playing) {
      this.energy += (0.12 - this.energy) * 0.08;
      return this.energy;
    }
    const t = (now - this.t0) / 1000;
    const pulse = 0.45 + 0.35 * Math.sin(t * 2.2) + 0.15 * Math.sin(t * 5.1);
    this.energy += (clamp(pulse, 0.2, 1) - this.energy) * 0.12;
    return this.energy;
  }

  _ensureLoop() {
    // 无特效或未播放：停掉循环
    if (this.mode === 'off' || !this.playing) {
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      this.targets.forEach((t) => t.ctx.clearRect(0, 0, t.w, t.h));
      return;
    }
    if (!this.raf) {
      this.last = performance.now();
      const tick = (now) => {
        this.raf = requestAnimationFrame(tick);
        this._frame(now);
      };
      this.raf = requestAnimationFrame(tick);
    }
  }

  _budget(coverR) {
    if (coverR < 110) return { tri: 22, star: 32 };
    if (coverR < 160) return { tri: 30, star: 44 };
    return { tri: 40, star: 58 };
  }

  /** 圆形渐隐遮罩：以唱片为圆心，越远越透明 */
  _applyCircularFade(t, cx, cy) {
    const ctx = t.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    const g = ctx.createRadialGradient(cx, cy, t.coverR * 0.85, cx, cy, t.fadeOuter);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.75)');
    g.addColorStop(0.78, 'rgba(0,0,0,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, t.fadeOuter, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _frame(now) {
    // 双保险：水晶 / 星环都只在真正播放时画
    if (!this.playing || this.mode === 'off') return;
    if (this.audio && (this.audio.paused || this.audio.ended)) {
      this.setPlaying(false);
      return;
    }

    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const energy = this._sampleEnergy(now);

    for (const t of this.targets) {
      if (!t.w || !t.h) continue;
      if (getComputedStyle(t.container).display === 'none'
          || getComputedStyle(t.container.closest('#desktopLayout, #mobileLayout') || t.container).display === 'none') {
        continue;
      }
      t.ctx.clearRect(0, 0, t.w, t.h);
      const cx = t.w / 2;
      const cy = t.h / 2;
      const coverR = t.coverR;
      const budget = this._budget(coverR);

      if (this.mode === 'crystal') this._drawCrystal(t, cx, cy, coverR, dt, energy, budget);
      else if (this.mode === 'orbit') this._drawOrbit(t, cx, cy, coverR, dt, energy, budget, now);

      this._applyCircularFade(t, cx, cy);
    }
  }

  _spawnTriangle(cx, cy, coverR) {
    const ang = Math.random() * Math.PI * 2;
    const dist = coverR * (0.72 + Math.random() * 0.18);
    const size = 4 + Math.random() * 10;
    const speed = 22 + Math.random() * 48;
    const rot = Math.random() * Math.PI * 2;
    return {
      x: cx + Math.cos(ang) * dist,
      y: cy + Math.sin(ang) * dist,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      size,
      rot,
      spin: (Math.random() - 0.5) * 3,
      life: 1,
      decay: 0.28 + Math.random() * 0.4,
    };
  }

  _drawCrystal(t, cx, cy, coverR, dt, energy, budget) {
    if (!this.playing) return;
    const max = budget.tri;
    const spawnRate = 0.7 + energy * 2.4;
    if (t.triangles.length < max && Math.random() < spawnRate * dt * 60) {
      t.triangles.push(this._spawnTriangle(cx, cy, coverR));
    }
    const ctx = t.ctx;
    const killR = t.fadeOuter * 1.02;
    for (let i = t.triangles.length - 1; i >= 0; i--) {
      const p = t.triangles[i];
      p.x += p.vx * dt * (0.75 + energy);
      p.y += p.vy * dt * (0.75 + energy);
      p.rot += p.spin * dt;
      p.life -= p.decay * dt;
      const dist = Math.hypot(p.x - cx, p.y - cy);
      if (p.life <= 0 || dist > killR) {
        t.triangles.splice(i, 1);
        continue;
      }
      const fade = radialFade(dist, coverR, t.fadeOuter);
      const a = clamp(p.life, 0, 1) * (0.3 + energy * 0.55) * fade;
      if (a < 0.02) continue;
      const s = p.size * (0.65 + (1 - p.life) * 0.75);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.9, s * 0.7);
      ctx.lineTo(-s * 0.9, s * 0.7);
      ctx.closePath();
      ctx.fillStyle = rgba(this.rgb, a);
      ctx.fill();
      ctx.restore();
    }
  }

  _ensureStars(t, coverR, count) {
    while (t.stars.length < count) {
      const ang = Math.random() * Math.PI * 2;
      // 分布在封面外到渐隐外沿之间
      const orbit = coverR * (1.08 + Math.random() * (FADE_OUTER_MUL - 1.15));
      t.stars.push({
        ang,
        orbit,
        speed: (0.12 + Math.random() * 0.5) * (Math.random() < 0.5 ? 1 : -1),
        r: 1 + Math.random() * 2.4,
        phase: Math.random() * Math.PI * 2,
      });
    }
    if (t.stars.length > count) t.stars.length = count;
  }

  _drawOrbit(t, cx, cy, coverR, dt, energy, budget, now) {
    if (!this.playing) return;
    this._ensureStars(t, coverR, budget.star);
    const ctx = t.ctx;
    const time = (now - this.t0) / 1000;
    for (const s of t.stars) {
      s.ang += s.speed * dt * (0.55 + energy * 1.35);
      const wobble = Math.sin(time * 2 + s.phase) * 5 * energy;
      const orbit = s.orbit + wobble;
      const x = cx + Math.cos(s.ang) * orbit;
      const y = cy + Math.sin(s.ang) * orbit;
      const fade = radialFade(orbit, coverR, t.fadeOuter);
      const twinkle = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * 3 + s.phase));
      const a = twinkle * 0.9 * fade;
      if (a < 0.02) continue;
      ctx.beginPath();
      ctx.arc(x, y, s.r * (0.85 + energy * 0.55), 0, Math.PI * 2);
      ctx.fillStyle = rgba(this.rgb, a);
      ctx.fill();
    }
  }
}
