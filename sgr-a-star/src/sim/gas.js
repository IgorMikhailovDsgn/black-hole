// Начальные условия для частиц газа и для звезды, разрушаемой приливными силами.
// Формат частицы (8 float): x, y, z, kind | vx, vy, vz, age. kind: 0 — газ, 1 — вещество звезды, −1 — нет.

export const PARTICLE_FLOATS = 8;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
}

/** Газ, уже распределённый по орбитам 10…370 M, как будто поток идёт давно */
export function makeGas(count, seed = 3) {
  const r = rng(seed);
  const f = new Float32Array(count * PARTICLE_FLOATS);
  for (let i = 0; i < count; i++) {
    const k = Math.floor(r() * 3);
    const R = 10 + 360 * Math.pow(r(), 0.8);
    const spread = 0.35 + (R / 370) * 0.6;
    const ang = k * 2.1 + 0.7 + (r() - 0.5) * spread * 2.2 - Math.log(R) * 0.8;
    const tilt = (k - 1) * 0.35 * Math.min(1, R / 150);
    const x = R * Math.cos(ang), z = R * Math.sin(ang);
    const y = x * Math.sin(tilt) * 0.4 + (r() - 0.5) * 0.06 * R;
    const vc = Math.sqrt(R) / (R - 2);
    // касательное направление: cross(ось y, x) = (z, 0, −x)/R
    const tx = z / R, tz = -x / R;
    const o = i * PARTICLE_FLOATS;
    f[o] = x; f[o + 1] = y; f[o + 2] = z; f[o + 3] = 0;
    const fac = 0.92 + 0.06 * r();
    f[o + 4] = tx * vc * fac; f[o + 5] = 0; f[o + 6] = tz * vc * fac; f[o + 7] = 0;
  }
  return f;
}

export function emptyParticles(count) {
  const f = new Float32Array(count * PARTICLE_FLOATS);
  for (let i = 0; i < count; i++) f[i * PARTICLE_FLOATS + 3] = -1;
  return f;
}

/**
 * Звезда солнечного типа на параболической орбите с перицентром rp.
 *
 * У настоящей звезды самогравитация держит её целой, пока она не войдёт в приливный радиус
 * r_t = R★·(M/m)^(1/3). Там разброс удельных энергий вещества «замораживается»:
 * ΔE ≈ GM·R★ / r_t². Половина вещества оказывается связанной, половина улетает.
 * Самогравитацию мы не считаем, поэтому поступаем так: задаём звезду твёрдым шаром
 * в момент входа в r_t и интегрируем каждую частицу назад во времени до стартовой точки r0.
 * Двигаясь вперёд, частицы собираются в тот же шар ровно на r_t и дальше разлетаются правильно.
 * Радиус звезды увеличен в 3 раза, чтобы её было видно; r_t увеличен так же.
 */
export function makeTDE(count, { r0 = 420, rp = 10, incl = 0.45, node = 2.4, starR = 0.34, seed = 11 } = {}) {
  const r = rng(seed);
  const f = new Float32Array(count * PARTICLE_FLOATS);
  const rt = starR * Math.cbrt(4.3e6); // приливный радиус для увеличенной звезды, ≈ 55 M
  // Параболическая орбита (E = 0) в потенциале Пачинского–Вииты Φ = −1/(r − 2);
  // момент импульса для перицентра rp: L = rp·√(2 / (rp − 2)).
  const L = rp * Math.sqrt(2 / (rp - 2));
  const v2 = 2 / (rt - 2);
  const vt = L / rt;
  const vr = -Math.sqrt(Math.max(v2 - vt * vt, 0));
  const acc = (x, y, z) => {
    const R = Math.hypot(x, y, z), rr = R - 2;
    const k = -1 / (R * rr * rr);
    return [x * k, y * k, z * k];
  };
  // шаги назад во времени по центру масс — до r0; одинаковое расписание шагов для всех частиц
  const steps = [];
  {
    let x = [rt, 0, 0], v = [vr, vt, 0];
    for (let i = 0; i < 20000; i++) {
      const R = Math.hypot(...x);
      if (R >= r0) break;
      const h = -0.035 * R * (R - 2) / Math.sqrt(R);
      steps.push(h);
      let a = acc(...x); v = v.map((c, j) => c + 0.5 * h * a[j]);
      x = x.map((c, j) => c + h * v[j]);
      a = acc(...x); v = v.map((c, j) => c + 0.5 * h * a[j]);
    }
  }
  const ci = Math.cos(incl), si = Math.sin(incl), cn = Math.cos(node), sn = Math.sin(node);
  const rot = ([X, Y, Z]) => {
    // орбита лежит в плоскости XY; переводим в плоскость XZ, наклоняем и поворачиваем
    const y1 = 0, z1 = Y;
    const Y2 = y1 * ci - z1 * si, Z2 = y1 * si + z1 * ci;
    return [X * cn - Z2 * sn, Y2 + Z * ci, X * sn + Z2 * cn];
  };
  let center = null, velocity = null;
  for (let i = 0; i < count; i++) {
    let dx, dy, dz;
    do { dx = r() * 2 - 1; dy = r() * 2 - 1; dz = r() * 2 - 1; } while (dx * dx + dy * dy + dz * dz > 1);
    let x = [rt + dx * starR, dy * starR, dz * starR], v = [vr, vt, 0];
    for (const h of steps) {
      let a = acc(...x); v = v.map((c, j) => c + 0.5 * h * a[j]);
      x = x.map((c, j) => c + h * v[j]);
      a = acc(...x); v = v.map((c, j) => c + 0.5 * h * a[j]);
    }
    const P = rot(x), V = rot(v);
    if (i === 0) { center = P; velocity = V; }
    const o = i * PARTICLE_FLOATS;
    f[o] = P[0]; f[o + 1] = P[1]; f[o + 2] = P[2]; f[o + 3] = 1;
    f[o + 4] = V[0]; f[o + 5] = V[1]; f[o + 6] = V[2]; f[o + 7] = 0;
  }
  return { data: f, center, velocity, rt };
}
