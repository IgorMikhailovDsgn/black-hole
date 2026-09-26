import { frameStruct, commonFns } from './common.js';

// Трассировка лучей в метрике Шварцшильда (M = 1, горизонт r = 2).
// Уравнение нулевой геодезической в декартовой форме: x'' = −(3/2)·h²·x / r⁵, h = |x × x'| = const.
// Это точный аналог уравнения Бине u'' + u = 3Mu² для фотонов.
// Вне сферы влияния используется аналитическое слабое отклонение 4M/b.
export const lensWGSL = frameStruct + commonFns + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var backTex: texture_2d<f32>;
@group(0) @binding(2) var envTex: texture_2d<f32>;
@group(0) @binding(3) var linS: sampler;
@group(0) @binding(4) var envS: sampler;

const FLOW_P = 80.0;

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// Поворот направления d к чёрной дыре (в начале координат) на угол delta.
fn deflect(d: vec3f, p: vec3f, delta: f32) -> vec3f {
  var perp = -p - d * dot(-p, d);
  let pl = length(perp);
  if (pl < 1e-12 * length(p) || delta == 0.0) { return d; }
  perp = perp / pl;
  return normalize(d * cos(delta) + perp * sin(delta));
}

// Накопленное слабое отклонение вдоль прямой: (2/b)·s/√(s² + b²); полное от −∞ до +∞ равно 4/b.
fn weakCum(s: f32, b: f32) -> f32 {
  return (2.0 / b) * s / sqrt(s * s + b * b);
}

fn accelPhoton(x: vec3f, h2: f32) -> vec3f {
  let r2 = dot(x, x);
  let r5 = r2 * r2 * sqrt(r2);
  return -1.5 * h2 * x / r5;
}

// ── шум для текстуры диска ──
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let s = 911u;
  let a = hash3f(i, s).x;
  let b = hash3f(i + vec3f(1.0, 0.0, 0.0), s).x;
  let c = hash3f(i + vec3f(0.0, 1.0, 0.0), s).x;
  let d = hash3f(i + vec3f(1.0, 1.0, 0.0), s).x;
  let e = hash3f(i + vec3f(0.0, 0.0, 1.0), s).x;
  let g = hash3f(i + vec3f(1.0, 0.0, 1.0), s).x;
  let h = hash3f(i + vec3f(0.0, 1.0, 1.0), s).x;
  let k = hash3f(i + vec3f(1.0, 1.0, 1.0), s).x;
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

fn diskNoise(r: f32, phi: f32, cyc: f32) -> f32 {
  // вытянуто по азимуту: турбулентность растягивается дифференциальным вращением
  var q = vec3f(cos(phi) * 2.4, sin(phi) * 2.4, log(r) * 11.0) + vec3f(cyc * 13.17, cyc * 7.31, cyc * 3.7);
  var sum = 0.0;
  var amp = 0.5;
  for (var o = 0; o < 5; o++) {
    sum += amp * vnoise(q);
    q = q * vec3f(2.03, 2.03, 1.9) + vec3f(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum / 0.97;
}

// Излучение и непрозрачность диска в точке пересечения экваториальной плоскости.
// Lz — момент импульса фотона (на единицу энергии) относительно оси вращения диска.
fn diskSample(p: vec3f, Lz: f32) -> vec4f {
  let r = length(p.xz);
  let rOut = F.misc.z;
  if (r < 6.0 || r > rOut) { return vec4f(0.0); }
  let phi = atan2(p.z, p.x);
  let Om = pow(r, -1.5); // кеплерова угловая скорость (точна и в ОТО для координатного времени)
  let nA = diskNoise(r, phi + Om * F.flow.x * FLOW_P, F.flow.z);
  let nB = diskNoise(r, phi + Om * F.flow.y * FLOW_P, F.flow.w);
  let wA = 1.0 - abs(2.0 * F.flow.x - 1.0);
  var dens = mix(nB, nA, wA);
  dens = smoothstep(0.22, 0.78, dens);
  dens = mix(dens, 0.5, F.time.w); // размытие при очень быстром времени
  let edge = smoothstep(6.0, 7.0, r) * (1.0 - smoothstep(rOut * 0.55, rOut, r));
  let tau = diskTau(r);
  // Частотный сдвиг g = ν_набл/ν_изл = √(1 − 3/r) / (1 − Ω·Lz):
  // гравитационное красное смещение + поперечный и продольный эффект Доплера.
  let g0 = sqrt(1.0 - 3.0 / r) / (1.0 - Om * Lz);
  let g = mix(1.0, g0, F.look.w);
  let Tobs = F.misc.y * tau * g;
  // болометрическая интенсивность I ∝ g⁴·T⁴
  let I = F.look.x * pow(g, 4.0) * pow(tau, 4.0);
  let col = bbColor(Tobs) * I * (0.25 + 1.1 * dens);
  let alpha = clamp(0.15 + 0.9 * dens, 0.0, 0.96) * edge;
  return vec4f(col * edge, alpha);
}

// Джеты: конус вдоль оси вращения; релятивистское усиление D^(2+α) у приближающегося джета.
fn jetEmission(x: vec3f, v: vec3f) -> vec3f {
  let y = abs(x.y);
  let rho = length(x.xz);
  let w = 0.8 + 0.1 * y;
  let core = exp(-2.2 * rho * rho / (w * w));
  let along = smoothstep(2.5, 9.0, y) * exp(-y / 480.0);
  let knots = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(y * 0.075 - F.time.y * 2.0 * PI), 3.0);
  let dens = core * along * knots * 9.0 / (w * w);
  let beta = 0.8;
  let gam = 1.0 / sqrt(1.0 - beta * beta);
  let cosT = dot(vec3f(0.0, sign(x.y), 0.0), -normalize(v));
  let D = 1.0 / (gam * (1.0 - beta * cosT));
  let D0 = 1.0 / gam;
  let boost = clamp(pow(D / D0, 2.5), 0.0, 14.0);
  return vec3f(0.55, 0.72, 1.0) * dens * boost;
}

// Процедурный звёздный фон (далёкие звёзды) — искажается линзой вместе с остальным фоном.
fn starLayer(d: vec3f, scale: f32, seed: u32, rad: f32, frac: f32, gain: f32) -> vec3f {
  let p = d * scale;
  let h = hash3f(p, seed);
  if (h.w > frac) { return vec3f(0.0); }
  let sp = floor(p) + 0.25 + 0.5 * h.xyz;
  let sd = normalize(sp);
  let ang = length(d - sd);
  let b = gain * (0.02 + 3.0 * pow(h.x, 7.0));
  return bbColor(2600.0 + 11000.0 * h.y * h.y) * b * exp(-(ang * ang) / (rad * rad));
}

fn background(d: vec3f) -> vec3f {
  var c = vec3f(0.0);
  let fz = dot(d, F.camFwd.xyz);
  if (fz > 1e-4) {
    let sx = dot(d, F.camRight.xyz) / (fz * F.camRight.w) + F.res.z;
    let sy = dot(d, F.camUp.xyz) / (fz * F.camUp.w) + F.res.w;
    if (abs(sx) <= 1.0 && abs(sy) <= 1.0) {
      c += textureSampleLevel(backTex, linS, vec2f(sx * 0.5 + 0.5, 0.5 - sy * 0.5), 0.0).rgb;
    }
  }
  if (F.look2.y > 0.5) {
    let lon = atan2(d.z, d.x);
    let lat = asin(clamp(d.y, -1.0, 1.0));
    c += textureSampleLevel(envTex, envS, vec2f(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI), 0.0).rgb;
  }
  if (F.look2.z > 0.0) {
    let rad = max(F.camFwd.w * 0.8, 1e-6);
    c += F.look2.z * (starLayer(d, 60.0, 17u, rad, 0.2, 1.0) + starLayer(d, 190.0, 91u, rad, 0.06, 0.3));
  }
  return c;
}

@fragment
fn fsLens(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / F.res.xy;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0) - F.res.zw;
  var d = normalize(F.camFwd.xyz + F.camRight.xyz * (ndc.x * F.camRight.w) + F.camUp.xyz * (ndc.y * F.camUp.w));
  let cam = F.camPos.xyz;
  let camD = F.camPos.w;
  let Rs = F.misc.w;
  let ls = F.look2.x;

  var col = vec3f(0.0);
  var trans = 1.0;

  // ── 1. Путь до сферы влияния: прямая + аналитическое слабое отклонение ──
  var x = cam;
  let b0 = max(length(cross(cam, d)), 1e-6);
  let s0 = dot(cam, d);
  if (camD > Rs) {
    let strongVisible = Rs / camD > F.camFwd.w * 0.25;
    if (!strongVisible || s0 >= 0.0 || b0 >= Rs) {
      let delta = ls * (2.0 / b0 - weakCum(s0, b0));
      d = deflect(d, cam, min(delta, 1.5));
      return vec4f(background(d), 1.0);
    }
    let tEnter = -s0 - sqrt(Rs * Rs - b0 * b0);
    x = cam + d * tEnter;
    let sE = dot(x, d);
    d = deflect(d, x, ls * (weakCum(sE, b0) - weakCum(s0, b0)));
  }

  // ── 2. Сильное поле: интегрирование геодезической методом Рунге–Кутты 4-го порядка ──
  var v = d;
  let hv = cross(x, v);
  let h2 = dot(hv, hv) * ls;
  let Lz = -hv.y; // физический фотон летит от диска к камере, т. е. против трассируемого луча
  var captured = false;
  let doJets = F.look.y > 0.0;
  for (var i = 0; i < 400; i++) {
    let r = length(x);
    if (r < 2.001) { captured = true; break; }
    if (r > Rs * 1.0005 && dot(x, v) > 0.0) { break; }
    if (trans < 0.004) { captured = true; break; }
    var h = 0.075 * r;
    if (r < 4.5) { h = 0.05 * r; }
    h = min(h, 0.25 * Rs);
    let k1x = v;                    let k1v = accelPhoton(x, h2);
    let k2x = v + 0.5 * h * k1v;    let k2v = accelPhoton(x + 0.5 * h * k1x, h2);
    let k3x = v + 0.5 * h * k2v;    let k3v = accelPhoton(x + 0.5 * h * k2x, h2);
    let k4x = v + h * k3v;          let k4v = accelPhoton(x + h * k3x, h2);
    let xn = x + (h / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
    let vn = v + (h / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);

    if (doJets) {
      let xm = 0.5 * (x + xn);
      col += trans * F.look.y * jetEmission(xm, v) * length(xn - x);
    }
    // пересечение плоскости диска y = 0
    if (x.y * xn.y < 0.0) {
      let f = x.y / (x.y - xn.y);
      let p = mix(x, xn, f);
      let ds = diskSample(p, Lz);
      if (ds.w > 0.0) {
        col += trans * ds.rgb * ds.w;
        trans *= 1.0 - ds.w;
      }
    }
    x = xn;
    v = vn;
  }

  if (!captured) {
    // ── 3. Хвост пути за сферой: снова слабое поле ──
    let vh = normalize(v);
    let bE = max(length(cross(x, vh)), 1e-6);
    let sX = dot(x, vh);
    let dF = deflect(vh, x, ls * (2.0 / bE - weakCum(sX, bE)));
    col += trans * background(dF);
  }
  return vec4f(col, 1.0);
}
`;

// ── Постобработка: свечение (bloom) и тональная компрессия ────────────────────────
export const postWGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> U: vec4f; // xy — texel источника, zw — texel цели

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn S(uv: vec2f) -> vec3f { return min(textureSampleLevel(src, samp, uv, 0.0).rgb, vec3f(400.0)); }

@fragment
fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy * U.zw;
  let t = U.xy;
  let a = S(uv + t * vec2f(-2.0, 2.0)); let b = S(uv + t * vec2f(0.0, 2.0)); let c = S(uv + t * vec2f(2.0, 2.0));
  let d = S(uv + t * vec2f(-2.0, 0.0)); let e = S(uv);                       let f = S(uv + t * vec2f(2.0, 0.0));
  let g = S(uv + t * vec2f(-2.0, -2.0)); let h = S(uv + t * vec2f(0.0, -2.0)); let i = S(uv + t * vec2f(2.0, -2.0));
  let j = S(uv + t * vec2f(-1.0, 1.0)); let k = S(uv + t * vec2f(1.0, 1.0));
  let l = S(uv + t * vec2f(-1.0, -1.0)); let m = S(uv + t * vec2f(1.0, -1.0));
  let o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4f(o, 1.0);
}

@fragment
fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy * U.zw;
  let t = U.xy;
  var s = S(uv) * 4.0;
  s += (S(uv + vec2f(t.x, 0.0)) + S(uv - vec2f(t.x, 0.0)) + S(uv + vec2f(0.0, t.y)) + S(uv - vec2f(0.0, t.y))) * 2.0;
  s += S(uv + t) + S(uv - t) + S(uv + vec2f(t.x, -t.y)) + S(uv + vec2f(-t.x, t.y));
  return vec4f(s / 16.0, 1.0);
}
`;

export const compositeWGSL = /* wgsl */ `
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> U: array<vec4f, 2>; // [exposure, bloom, vignette, seed], [outW, outH, srgbOut, -]

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn toSRGB(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
fn h12(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fsComposite(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / U[1].xy;
  var c = textureSampleLevel(scene, samp, uv, 0.0).rgb;
  c += textureSampleLevel(bloom, samp, uv, 0.0).rgb * U[0].y;
  c *= U[0].x;
  let q = (uv - 0.5) * vec2f(U[1].x / U[1].y, 1.0);
  c *= mix(1.0, smoothstep(1.25, 0.25, length(q)), U[0].z);
  c = aces(c);
  if (U[1].z > 0.5) { c = toSRGB(c); }
  c += (h12(fc.xy + U[0].w) - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;
