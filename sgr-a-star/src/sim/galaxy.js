// Генерация звёздных «облаков» Млечного Пути. Каждая частица — это не одна звезда,
// а скопление размером в десятки парсек. Движение вычисляется на GPU (см. shaders/galaxy.js).
//
// Модель:
//  • диск: плоская кривая вращения v ≈ 220 км/с; спиральные рукава — волна плотности,
//    вращающаяся с угловой скоростью узора Ωp (звёзды проходят сквозь рукава);
//  • молодые звёзды и области H II вспыхивают, проходя гребень волны, и гаснут ниже по течению;
//  • бар и балдж вращаются как целое вместе с узором.

export const GSTAR_FLOATS = 8; // a, phase, z, size, lum, p1, p2, color(u32)
export const KIND = { OLD: 0, YOUNG: 1, BAR: 2, HII: 3, THICK: 4 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateGalaxy(count = 320000, seed = 7) {
  const rnd = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const laplace = (s) => (rnd() < 0.5 ? -1 : 1) * -Math.log(Math.max(rnd(), 1e-9)) * s;
  // экспоненциальный диск: поверхностная плотность ∝ exp(−R/h) → R ~ Gamma(2, h)
  const expDisk = (h, rmin, rmax) => {
    for (;;) {
      const r = -h * Math.log(Math.max(rnd() * rnd(), 1e-12));
      if (r > rmin && r < rmax) return r;
    }
  };

  const buf = new ArrayBuffer(count * GSTAR_FLOATS * 4);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  const pack = (r, g, b, kind) => {
    const c = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
    return (c(r) | (c(g) << 8) | (c(b) << 16) | ((kind & 255) << 24)) >>> 0;
  };

  const shares = [
    [KIND.OLD, 0.5],
    [KIND.THICK, 0.1],
    [KIND.BAR, 0.18],
    [KIND.YOUNG, 0.16],
    [KIND.HII, 0.06],
  ];
  let idx = 0;
  for (const [kind, share] of shares) {
    const n = kind === KIND.HII ? count - idx : Math.floor(count * share);
    for (let k = 0; k < n && idx < count; k++, idx++) {
      let a, z, size, lum, p1 = 0, p2 = 0, col;
      const phase = rnd() * Math.PI * 2;
      switch (kind) {
        case KIND.OLD: {
          a = expDisk(2.7, 0.6, 17);
          z = laplace(0.17 * (0.7 + a / 12));
          size = 0.18 + 0.22 * rnd();
          lum = 0.5 + 0.3 * rnd();
          p1 = 0.62; // амплитуда волны плотности
          const w = rnd();
          col = [1.0, 0.72 + 0.1 * w, 0.48 + 0.16 * w];
          break;
        }
        case KIND.THICK: {
          a = expDisk(3.4, 0.4, 19);
          z = laplace(0.7);
          size = 0.5 + 0.4 * rnd();
          lum = 0.12;
          p1 = 0.15;
          col = [1.0, 0.8, 0.6];
          break;
        }
        case KIND.BAR: {
          const isBar = rnd() < 0.62;
          if (isBar) {
            a = 0.15 + Math.pow(rnd(), 0.8) * 4.6;
            p1 = 0.36; // отношение осей бара
          } else {
            const s = Math.sqrt(rnd() * 0.97);
            a = 0.15 + (0.55 * s) / (1 - s); // профиль Хернквиста
            if (a > 3.2) a = 0.3 + rnd() * 2;
            p1 = 0.85 + 0.15 * rnd();
          }
          z = gauss() * (0.12 + 0.28 * Math.min(a, 2.5)) * (isBar ? 0.55 : 0.8);
          size = 0.14 + 0.16 * rnd();
          lum = 0.55 + 0.25 * rnd();
          p2 = isBar ? 1 : 0;
          col = [1.0, 0.66 + 0.08 * rnd(), 0.38 + 0.1 * rnd()];
          break;
        }
        case KIND.YOUNG: {
          a = expDisk(3.6, 2.6, 16.5);
          z = laplace(0.06);
          size = 0.03 + 0.05 * rnd();
          lum = 9.0 + 8.0 * rnd();
          p1 = 0.55;
          p2 = rnd() < 0.5 ? 0 : 1; // 4 рукава: два главных, два второстепенных
          const w = rnd();
          col = [0.42 + 0.2 * w, 0.6 + 0.15 * w, 1.0];
          break;
        }
        default: { // HII
          a = expDisk(3.8, 3.0, 15.5);
          z = laplace(0.05);
          size = 0.1 + 0.15 * rnd();
          lum = 2.0 + 1.5 * rnd();
          p1 = 0.6;
          p2 = rnd() < 0.5 ? 0 : 1;
          col = [1.0, 0.36, 0.52];
        }
      }
      const o = idx * GSTAR_FLOATS;
      f[o] = a; f[o + 1] = phase; f[o + 2] = z; f[o + 3] = size;
      f[o + 4] = lum; f[o + 5] = p1; f[o + 6] = p2;
      u[o + 7] = pack(col[0], col[1], col[2], kind);
    }
  }
  return { data: f, count };
}

// Поворот плоскости галактики относительно оси вращения чёрной дыры (ось y).
// Ориентация диска Стрельца A* относительно Галактики неизвестна; берём наклон для красоты кадра.
export function galaxyRotation() {
  const tilt = 0.52; // ~30°
  const c = Math.cos(tilt), s = Math.sin(tilt);
  // вращение вокруг оси x: столбцы матрицы 3×3
  return [
    [1, 0, 0],
    [0, c, s],
    [0, -s, c],
  ];
}

// Кинематика, дублирующая шейдер, — для метки Солнца на CPU.
export const V0_KPC_MYR = 0.2248; // 220 км/с в кпк/млн лет
export function vcirc(a) { return V0_KPC_MYR * (1 - Math.exp(-a / 0.9)); }
