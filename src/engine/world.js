// Мир: собирает состояние кадра из моделей (S-звёзды, планетная система, Солнце, газ).
import { makeSStars, PlanetSystem } from '../sim/orbits.js';
import { galaxyRotation, vcirc } from '../sim/galaxy.js';
import { KPC, T_M, MYR } from '../sim/units.js';
import { MAX_SPRITES, MAX_LINE_PTS } from './renderer.js';

const FLOW_P = 80;
const frac = (x) => ((x % 1) + 1) % 1;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lg = Math.log10;

export const DEFAULT_LOOK = {
  disk: 0.6, jets: 0, gas: 0.25, doppler: 1, lens: 1, stars: 1, galaxy: 0.022, sprites: 1, orbits: 1,
  tde: 1, galaxyNear: 0.02, diskTemp: 5800, diskOuter: 26, influence: 3000, exposure: 1, labels: 1,
};

export class World {
  constructor() {
    this.sstars = makeSStars();
    this.system = new PlanetSystem();
    this.galRot = galaxyRotation();
    this.look = { ...DEFAULT_LOOK };
    this.sprites = new Float32Array(MAX_SPRITES * 8);
    this.lines = new Float32Array(MAX_LINE_PTS * 8);
    this.sunA = 8.2;
    this.sunPhase0 = 2.2;
    this.highlight = null; // имя объекта для подсветки
  }

  galToWorld(x, y, z) {
    const R = this.galRot; // столбцы
    return [
      (R[0][0] * x + R[1][0] * y + R[2][0] * z) * KPC,
      (R[0][1] * x + R[1][1] * y + R[2][1] * z) * KPC,
      (R[0][2] * x + R[1][2] * y + R[2][2] * z) * KPC,
    ];
  }
  sunPosition(t) {
    const tm = t / MYR;
    const th = this.sunPhase0 + (vcirc(this.sunA) / this.sunA) * tm;
    return this.galToWorld(this.sunA * Math.cos(th), 0.02, this.sunA * Math.sin(th));
  }
  targetPosition(key, t) {
    if (key === 'system') return this.system.hostPosition(t);
    if (key === 'sun') return this.sunPosition(t);
    const s = this.sstars.find((x) => x.name === key);
    if (s) return s.positionAt(t);
    return [0, 0, 0];
  }

  /** Видимость групп объектов в зависимости от расстояния камеры до ЧД */
  visibility(camD, camToHost) {
    const l = lg(camD);
    return {
      sstars: smooth(lg(400), lg(4000), l) * (1 - smooth(lg(4e6), lg(6e7), l)),
      system: 1 - smooth(lg(3e4), lg(3e5), camToHost),
      sun: smooth(lg(3e9), lg(2e10), l),
    };
  }

  /** Список объектов с подписями: {name, pos, vis} */
  labels(t, camD, camToHost) {
    const v = this.visibility(camD, lg(Math.max(camToHost, 1)));
    const out = [];
    if (v.sstars > 0.2) for (const s of this.sstars) out.push({ name: s.name, pos: s.positionAt(t), vis: v.sstars, kind: 'star' });
    const host = this.system.hostPosition(t);
    const hostVis = Math.max(v.sstars, v.system);
    if (hostVis > 0.2) out.push({ name: 'Звезда с планетами', pos: host, vis: hostVis, kind: 'host' });
    if (v.sun > 0.2) out.push({ name: 'Солнце', pos: this.sunPosition(t), vis: v.sun, kind: 'sun' });
    if (camD > 3e3 && camD < 3e9) out.push({ name: 'Стрелец A*', pos: [0, 0, 0], vis: 1, kind: 'bh' });
    return out;
  }

  buildSprites(t, camPos) {
    const f = this.sprites;
    let n = 0;
    const push = (p, size, rgb, I) => {
      if (n >= MAX_SPRITES) return;
      const o = n * 8;
      f[o] = p[0]; f[o + 1] = p[1]; f[o + 2] = p[2]; f[o + 3] = size;
      f[o + 4] = rgb[0]; f[o + 5] = rgb[1]; f[o + 6] = rgb[2]; f[o + 7] = I;
      n++;
    };
    const camD = Math.hypot(...camPos);
    const host = this.system.hostPosition(t);
    const camToHost = Math.hypot(camPos[0] - host[0], camPos[1] - host[1], camPos[2] - host[2]);
    const v = this.visibility(camD, lg(camToHost));
    for (const s of this.sstars) {
      const I = (s.name === this.highlight ? 9 : 5) * Math.max(v.sstars, 0.25);
      push(s.positionAt(t), -s.px, s.color, I);
    }
    push(host, -3, this.system.host.color, 6);
    if (v.system > 0.01) {
      for (const pl of this.system.planets) {
        const o = this.system.planetOffset(pl, t);
        push([host[0] + o[0], host[1] + o[1], host[2] + o[2]], -1.7, pl.color, 3.5 * v.system);
      }
    }
    if (v.sun > 0.01) push(this.sunPosition(t), -3, [1, 0.9, 0.7], 8 * v.sun);
    return n;
  }

  buildLines(t, camPos) {
    const f = this.lines;
    let n = 0;
    const camD = Math.hypot(...camPos);
    const host = this.system.hostPosition(t);
    const camToHost = Math.hypot(camPos[0] - host[0], camPos[1] - host[1], camPos[2] - host[2]);
    const v = this.visibility(camD, lg(camToHost));
    const strip = (pts, rgb, a) => {
      if (a <= 0.003) return;
      for (let i = 0; i < pts.length && n < MAX_LINE_PTS; i++, n++) {
        const o = n * 8, p = pts[i];
        f[o] = p[0]; f[o + 1] = p[1]; f[o + 2] = p[2]; f[o + 3] = i < pts.length - 1 ? 1 : 0;
        f[o + 4] = rgb[0]; f[o + 5] = rgb[1]; f[o + 6] = rgb[2]; f[o + 7] = a;
      }
    };
    for (const s of this.sstars) {
      const hi = s.name === this.highlight;
      strip(s.ellipsePoints(t), hi ? [1.0, 0.72, 0.38] : [0.55, 0.72, 1.0], (hi ? 0.9 : 0.32) * v.sstars * (1 - 0.9 * v.system));
    }
    const hostVis = Math.max(v.sstars, v.system);
    strip(this.system.host.ellipsePoints(t), [1.0, 0.8, 0.55], 0.28 * hostVis);
    if (v.system > 0.01) {
      for (const pl of this.system.planets) {
        const pts = [];
        for (let k = 0; k <= 96; k++) {
          const o = this.system.planetOffset(pl, t, (k / 96) * Math.PI * 2);
          pts.push([host[0] + o[0], host[1] + o[1], host[2] + o[2]]);
        }
        strip(pts, pl.color, 0.45 * v.system);
      }
      strip(this.system.ringPoints(host, this.system.hillRadius(t)), [0.55, 0.72, 1.0], 0.5 * v.system);
    }
    if (v.sun > 0.01) {
      const pts = [];
      for (let k = 0; k <= 360; k++) {
        const a = (k / 360) * Math.PI * 2;
        pts.push(this.galToWorld(this.sunA * Math.cos(a), 0.02, this.sunA * Math.sin(a)));
      }
      strip(pts, [1.0, 0.8, 0.55], 0.16 * v.sun);
    }
    return n;
  }

  /** Автоматическая экспозиция: от горизонта до галактики яркости различаются на порядки */
  autoExposure(camD) {
    const l = lg(camD);
    // опорные точки (log10 расстояния → экспозиция), подобраны по тестовым кадрам
    const pts = [[1, 0.9], [1.6, 1.0], [2.5, 1.6], [3.5, 2.4], [5, 3.2], [7, 3.6], [9, 3.4], [10.5, 2.6], [11.5, 2.2]];
    if (l <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (l <= pts[i][0]) {
        const [a, ea] = pts[i - 1], [b, eb] = pts[i];
        return ea + ((eb - ea) * (l - a)) / (b - a);
      }
    }
    return pts[pts.length - 1][1];
  }

  /** Полное состояние для Renderer.render */
  frameState({ cam, shift, pixelRatio, clock, seed, envDirty }) {
    const t = clock.t;
    const tM = clock.tM;
    const dtM = clock.lastDt / T_M;
    const camD = Math.hypot(...cam.pos);
    const L = this.look;
    const spriteCount = this.buildSprites(t, cam.pos);
    const lineCount = L.orbits > 0 ? this.buildLines(t, cam.pos) : 0;
    const stars = L.stars * (1 - smooth(9, 10.3, lg(camD)));
    // Вблизи центра галактика окружает камеру со всех сторон и её поверхностная яркость огромна;
    // плавно приглушаем её, чтобы она оставалась фоном, а не засветкой.
    const galaxy = L.galaxy * (L.galaxyNear + (1 - L.galaxyNear) * smooth(6, 9.5, lg(camD)));
    return {
      cam, shift, pixelRatio,
      tMyr: clock.tMyr,
      jetPhase: frac(tM * 0.8 * 0.075 / (2 * Math.PI)),
      dtM,
      blur: smooth(0.12, 1.0, 0.068 * Math.abs(dtM)),
      flow: [frac(tM / FLOW_P), frac(tM / FLOW_P + 0.5), Math.floor(tM / FLOW_P) % 64, Math.floor(tM / FLOW_P + 0.5) % 64],
      look: { ...L, stars, galaxy },
      galRot: this.galRot,
      seed,
      nearMode: camD < 2e7,
      envDirty,
      sprites: this.sprites, spriteCount,
      lines: this.lines, lineCount,
      exposure: this.autoExposure(camD) * L.exposure,
      bloom: 0.045,
      vignette: 0.35,
    };
  }
}
