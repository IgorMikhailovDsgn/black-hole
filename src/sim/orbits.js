// Кеплеровы орбиты вокруг Стрельца A* с релятивистской прецессией Шварцшильда.
import { AU, YEAR, M_SUN_BH } from './units.js';

const DEG = Math.PI / 180;
const ARCSEC_AU = 8277; // 1″ на расстоянии 8,28 кпк ≈ 8277 а.е.

/** Решение уравнения Кеплера E − e·sinE = Mean */
export function solveKepler(Mean, e) {
  let M = Mean % (2 * Math.PI);
  if (M < -Math.PI) M += 2 * Math.PI;
  if (M > Math.PI) M -= 2 * Math.PI;
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let i = 0; i < 30; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

// Поворот «небесной» системы координат (x — восток, y — север, z — луч зрения) в мир сцены.
// Выбран так, чтобы галактическая плоскость и диск смотрелись естественно; это чистая условность.
const SKY = { a: 0.35, b: -0.9 };
function skyToWorld(x, y, z) {
  const ca = Math.cos(SKY.a), sa = Math.sin(SKY.a);
  const x1 = x * ca - z * sa, z1 = x * sa + z * ca;
  const cb = Math.cos(SKY.b), sb = Math.sin(SKY.b);
  const y2 = y * cb - z1 * sb, z2 = y * sb + z1 * cb;
  return [x1, y2, z2];
}

/**
 * Орбита с элементами: a (ед. M), e, i, Ω, ω (рад), tp (секунды модели), P (с).
 * precession — множитель прецессии (1 = реальная ОТО).
 */
export class Orbit {
  constructor({ name, aAU, e, i, Omega, omega, tpYear, color, px = 2.4, startYear = 2018 }) {
    this.name = name;
    this.a = aAU * AU;
    this.e = e;
    this.i = i * DEG;
    this.Omega = Omega * DEG;
    this.omega0 = omega * DEG;
    this.P = Math.sqrt(Math.pow(aAU, 3) / M_SUN_BH) * YEAR; // 3-й закон Кеплера
    this.tp = (tpYear - startYear) * YEAR;
    this.color = color;
    this.px = px;
    // смещение перицентра за один оборот, радиан: Δω = 6πGM / (c² a (1 − e²))
    this.dOmegaPerOrbit = (6 * Math.PI) / (this.a * (1 - e * e));
    this.precession = 1;
  }
  get periodYears() { return this.P / YEAR; }
  get pericenterAU() { return (this.a * (1 - this.e)) / AU; }

  omegaAt(t) {
    return this.omega0 + this.precession * this.dOmegaPerOrbit * ((t - this.tp) / this.P);
  }
  /** Положение в момент t (с) в мировых координатах */
  positionAt(t) {
    const Mean = (2 * Math.PI * (t - this.tp)) / this.P;
    const E = solveKepler(Mean, this.e);
    return this.pointAtE(E, this.omegaAt(t));
  }
  pointAtE(E, omega) {
    const { a, e, i, Omega } = this;
    const xo = a * (Math.cos(E) - e);
    const yo = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const r = Math.hypot(xo, yo);
    const nu = Math.atan2(yo, xo);
    const u = omega + nu;
    const cO = Math.cos(Omega), sO = Math.sin(Omega), ci = Math.cos(i), si = Math.sin(i);
    const X = r * (cO * Math.cos(u) - sO * Math.sin(u) * ci);
    const Y = r * (sO * Math.cos(u) + cO * Math.sin(u) * ci);
    const Z = r * Math.sin(u) * si;
    return skyToWorld(X, Y, Z);
  }
  /** Точки текущего (оскулирующего) эллипса для линии орбиты */
  ellipsePoints(t, n = 240) {
    const omega = this.omegaAt(t);
    const pts = [];
    for (let k = 0; k <= n; k++) {
      // равномерно по средней аномалии → больше точек у перицентра не нужно,
      // лучше равномерно по эксцентрической: E ∈ [0, 2π]
      const E = (k / n) * 2 * Math.PI;
      pts.push(this.pointAtE(E, omega));
    }
    return pts;
  }
}

// Элементы орбит: Gillessen et al. 2017, ApJ 837, 30 (округлено).
// a — в угловых секундах, переводим в а.е. для расстояния 8,28 кпк.
const RAW = [
  ['S2', 0.1255, 0.8839, 134.18, 228.07, 66.26, 2018.38, [0.72, 0.84, 1.0]],
  ['S38', 0.1416, 0.8201, 171.1, 101.06, 17.99, 2003.19, [0.85, 0.9, 1.0]],
  ['S55', 0.1078, 0.7209, 150.1, 325.5, 331.5, 2009.31, [0.8, 0.88, 1.0]],
  ['S14', 0.2863, 0.9761, 100.59, 226.38, 334.59, 2000.12, [0.9, 0.9, 1.0]],
  ['S12', 0.2987, 0.8883, 33.56, 230.1, 317.9, 1995.59, [1.0, 0.95, 0.9]],
  ['S13', 0.2641, 0.425, 24.7, 74.5, 245.2, 2004.86, [0.8, 0.86, 1.0]],
  ['S8', 0.4047, 0.8031, 74.37, 315.43, 346.7, 1983.64, [0.9, 0.92, 1.0]],
  ['S1', 0.595, 0.556, 119.14, 342.04, 122.3, 2001.8, [0.85, 0.9, 1.0]],
];

export function makeSStars() {
  return RAW.map(([name, aas, e, i, Om, om, tp, color]) =>
    new Orbit({ name, aAU: aas * ARCSEC_AU, e, i, Omega: Om, omega: om, tpYear: tp, color,
      px: name === 'S2' ? 3.2 : 2.3 }),
  );
}

/**
 * Выдуманная звезда солнечного типа с тремя планетами на орбите вокруг Стрельца A*.
 * Нужна, чтобы показать сферу Хилла: планеты выживают, пока их орбиты заметно меньше r_H.
 */
export class PlanetSystem {
  constructor() {
    this.host = new Orbit({ name: 'Звезда с планетами', aAU: 2600, e: 0.3, i: 60, Omega: 40,
      omega: 120, tpYear: 2034, color: [1.0, 0.86, 0.62], px: 3 });
    this.host.precession = 1;
    this.mStar = 1.0; // масс Солнца
    // планеты: радиус (а.е.), период (лет) по 3-му закону Кеплера для 1 M☉, наклон плоскости
    this.planets = [
      { name: 'b', aAU: 0.45, color: [0.95, 0.62, 0.42], phase: 0.3 },
      { name: 'c', aAU: 1.1, color: [0.5, 0.75, 1.0], phase: 2.1 },
      { name: 'd', aAU: 2.2, color: [0.9, 0.82, 0.6], phase: 4.0 },
    ].map((p) => ({ ...p, a: p.aAU * AU, P: Math.pow(p.aAU, 1.5) * YEAR }));
    // плоскость планетной системы
    const inc = 0.5, node = 0.8;
    this.ex = [Math.cos(node), 0, Math.sin(node)];
    this.ey = [-Math.sin(node) * Math.cos(inc), Math.sin(inc), Math.cos(node) * Math.cos(inc)];
  }
  hostPosition(t) { return this.host.positionAt(t); }
  /** Радиус Хилла на текущем расстоянии r от чёрной дыры: r·(m / 3M)^(1/3) */
  hillRadius(t) {
    const p = this.hostPosition(t);
    const r = Math.hypot(p[0], p[1], p[2]);
    return r * Math.cbrt(this.mStar / (3 * M_SUN_BH));
  }
  planetOffset(pl, t, angOverride) {
    const ang = angOverride ?? pl.phase + (2 * Math.PI * t) / pl.P;
    const c = Math.cos(ang) * pl.a, s = Math.sin(ang) * pl.a;
    return [this.ex[0] * c + this.ey[0] * s, this.ex[1] * c + this.ey[1] * s, this.ex[2] * c + this.ey[2] * s];
  }
  ringPoints(center, radius, n = 96) {
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * 2 * Math.PI;
      const c = Math.cos(a) * radius, s = Math.sin(a) * radius;
      pts.push([center[0] + this.ex[0] * c + this.ey[0] * s, center[1] + this.ex[1] * c + this.ey[1] * s,
        center[2] + this.ex[2] * c + this.ey[2] * s]);
    }
    return pts;
  }
}
