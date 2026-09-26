import { frameStruct, commonFns, spriteFns, frameBindings } from './common.js';

// ── Галактика: орбиты вычисляются прямо в вершинном шейдере ──────────────────────────
export const galaxyWGSL = frameStruct + frameBindings + commonFns + spriteFns + /* wgsl */ `
struct GStar { a: f32, phase: f32, z: f32, size: f32, lum: f32, p1: f32, p2: f32, col: u32 }
@group(1) @binding(0) var<storage, read> G: array<GStar>;

const KPC = 4.8598e9;       // единиц GM/c² в килопарсеке
const V0 = 0.2248;          // 220 км/с в кпк/млн лет
const OMEGA_P = 0.0262;     // угловая скорость спирального узора, рад/млн лет (≈ 25,6 км/с/кпк)
const PITCH = 4.33;         // 1/tan(13°): закрутка рукавов
const BAR_ANGLE = 0.45;

fn vcirc(a: f32) -> f32 { return V0 * (1.0 - exp(-a / 0.9)); }

@vertex
fn vsGalaxy(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SpriteOut {
  let n = arrayLength(&G);
  var idx = ii;
  var dup = false;
  if (idx >= n) { idx = idx - n; dup = true; }
  let s = G[idx];
  let c = unpack4x8unorm(s.col);
  let kind = u32(round(c.w * 255.0));
  let t = F.time.x;
  let a = s.a;
  let omega = vcirc(a) / a;
  var bright = 1.0;
  var xy: vec2f;
  if (kind == 2u) {
    // бар и балдж: вращаются с узором, внутри — циркуляция по эллипсам
    let th = s.phase + (omega - OMEGA_P) * t;
    let barAng = select(0.0, BAR_ANGLE, s.p2 > 0.5) + OMEGA_P * t;
    let lx = a * cos(th);
    let ly = a * sin(th) * s.p1;
    let cb = cos(barAng); let sb = sin(barAng);
    xy = vec2f(lx * cb - ly * sb, lx * sb + ly * cb);
  } else {
    // диск: звезда движется со скоростью v(a), рукав — с угловой скоростью узора
    var m = 2.0;
    if (kind == 1u || kind == 3u) { m = 4.0; }
    let th = s.phase + omega * t;
    let armAng = -log(max(a, 0.4)) * PITCH + OMEGA_P * t + s.p2 * PI * 0.5 + 0.3;
    let psi = th - armAng;
    // звёзды «задерживаются» в гребне волны: ψ' = ψ − (A/m)·sin(mψ) → плотность ∝ 1/(1 − A cos mψ)
    let thf = armAng + psi - (s.p1 / m) * sin(m * psi);
    xy = a * vec2f(cos(thf), sin(thf));
    if (kind == 1u || kind == 3u) {
      // молодые звёзды вспыхивают у гребня и гаснут ниже по течению
      let u = fract(m * psi / (2.0 * PI));
      let age = select(1.0 - u, u, omega > OMEGA_P);
      let tau = select(0.16, 0.09, kind == 3u);
      bright = exp(-age / tau) + 0.03 * exp(-(1.0 - age) / 0.05);
    }
  }
  let local = vec3f(xy.x, s.z, xy.y) * KPC;
  let R = mat3x3f(F.galRot0.xyz, F.galRot1.xyz, F.galRot2.xyz);
  let p = R * local;
  let color = c.rgb * s.lum * bright * F.look2.w;
  return projectSprite(p, s.size * KPC, cornerOf(vi), color, dup);
}
`;

// ── Спрайты с CPU: S-звёзды, планеты, Солнце ─────────────────────────────────────────
export const spritesWGSL = frameStruct + frameBindings + commonFns + spriteFns + /* wgsl */ `
struct Sprite { pos: vec4f, col: vec4f }
@group(1) @binding(0) var<storage, read> S: array<Sprite>;

@vertex
fn vsSprite(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SpriteOut {
  let s = S[ii];
  if (s.col.w <= 0.0) { return cullOut(); }
  return projectSprite(s.pos.xyz, s.pos.w, cornerOf(vi), s.col.rgb * s.col.w * F.look3.x, false);
}
`;

// ── Газ и вещество разрушенной звезды: состояния считает compute-шейдер ─────────────
export const dynWGSL = frameStruct + frameBindings + commonFns + spriteFns + /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f }
@group(1) @binding(0) var<storage, read> P: array<Particle>;

@vertex
fn vsDyn(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SpriteOut {
  let p = P[ii];
  let kind = p.pos.w;
  if (kind < -0.5) { return cullOut(); }
  let x = p.pos.xyz;
  let r = length(x);
  let Tpk = F.misc.y;
  // температура падающего газа следует профилю диска, дальше ~ r^(−3/4)
  let tau = select(diskTau(r), 1.25 * pow(max(r, 6.0) / 8.17, -0.75), r > 12.0);
  var col: vec3f;
  var size: f32;
  if (kind < 0.5) {
    let fadeIn = smoothstep(14.0, 42.0, r);
    let I = F.look.z * (0.02 + 0.5 * tau * tau) * fadeIn;
    col = bbColor(Tpk * max(tau, 0.3)) * I;
    size = 0.1 + 0.014 * r;
  } else {
    // вещество звезды: сначала звёздный свет, у перицентра — нагрев в ударных волнах
    let heat = smoothstep(90.0, 14.0, r) * smoothstep(0.0, 400.0, p.vel.w);
    let starCol = vec3f(1.0, 0.88, 0.72);
    let hotCol = bbColor(Tpk * max(tau, 0.35) * 1.1);
    col = mix(starCol * 0.3, hotCol * (0.5 + 2.0 * tau * tau), heat) * F.misc2.x;
    size = 0.06 + 0.012 * r;
  }
  return projectSprite(x, size, cornerOf(vi), col, false);
}
`;

// ── Линии орбит: отрезки, расширенные до полос в экранных пикселях ─────────────────
export const linesWGSL = frameStruct + frameBindings + commonFns + /* wgsl */ `
struct LinePt { pos: vec4f, col: vec4f }
@group(1) @binding(0) var<storage, read> LP: array<LinePt>;

struct LineOut {
  @builtin(position) pos: vec4f,
  @location(0) side: f32,
  @location(1) color: vec4f,
}

fn toClip(rel: vec3f) -> vec4f {
  let w = dot(rel, F.camFwd.xyz);
  return vec4f(dot(rel, F.camRight.xyz) / F.camRight.w + F.res.z * w,
               dot(rel, F.camUp.xyz) / F.camUp.w + F.res.w * w, 0.5 * w, w);
}

@vertex
fn vsLine(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
  var o: LineOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.side = 0.0;
  o.color = vec4f(0.0);
  let n = arrayLength(&LP);
  if (ii + 1u >= n) { return o; }
  let A = LP[ii];
  let B = LP[ii + 1u];
  if (A.pos.w < 0.5 || A.col.w <= 0.0) { return o; }
  let mid = 0.5 * (A.pos.xyz + B.pos.xyz);
  let s = L.mode.x;
  let d = dot(mid, F.lensN.xyz);
  if ((s > 0.0 && d <= 0.0) || (s < 0.0 && d > 0.0)) { return o; }
  var ra = A.pos.xyz - F.camPos.xyz;
  var rb = B.pos.xyz - F.camPos.xyz;
  let near = 1e-3 * F.camPos.w;
  var wa = dot(ra, F.camFwd.xyz);
  var wb = dot(rb, F.camFwd.xyz);
  if (wa < near && wb < near) { return o; }
  if (wa < near) { ra = mix(ra, rb, (near - wa) / (wb - wa)); }
  if (wb < near) { rb = mix(rb, ra, (near - wb) / (wa - wb)); }
  let ca = toClip(ra);
  let cb = toClip(rb);
  let res = L.mode.zw;
  let pa = ca.xy / ca.w * res * 0.5;
  let pb = cb.xy / cb.w * res * 0.5;
  var dir = pb - pa;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / len, len > 1e-4);
  let nrm = vec2f(-dir.y, dir.x);
  let hw = 0.9 * F.lensN.w;
  var t = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
  var sd = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let useB = t[vi] > 0.5;
  let c = select(ca, cb, useB);
  let px = select(pa, pb, useB) + nrm * sd[vi] * (hw + 1.0);
  o.pos = vec4f(px / (res * 0.5) * c.w, c.z, c.w);
  o.side = sd[vi] * (hw + 1.0);
  o.color = select(A.col, B.col, useB);
  o.color.a = o.color.a * F.look3.y;
  return o;
}

@fragment
fn fsLine(i: LineOut) -> @location(0) vec4f {
  let hw = 0.9 * F.lensN.w;
  let a = clamp(hw + 0.5 - abs(i.side), 0.0, 1.0);
  return vec4f(i.color.rgb * i.color.a * a, 0.0);
}
`;

// ── Compute: газ (вязкое падение по спирали) и приливное разрушение звезды ─────────
export const computeWGSL = frameStruct + commonFns + /* wgsl */ `
struct Particle { pos: vec4f, vel: vec4f }
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read_write> P: array<Particle>;

// Псевдоньютоновский потенциал Пачинского–Вииты Φ = −1/(r − 2):
// воспроизводит последнюю устойчивую орбиту r = 6 и захват при r < 4 (для ненулевого момента).
fn accel(x: vec3f, v: vec3f, kind: f32) -> vec3f {
  let r = length(x);
  let rr = max(r - 2.0, 0.05);
  var a = -x / (r * rr * rr);
  let up = vec3f(0.0, 1.0, 0.0);
  let tdir = normalize(cross(up, x) + vec3f(1e-7, 0.0, 0.0));
  let vc = sqrt(r) / rr;
  let omega = vc / r;
  if (kind < 0.5) {
    // вязкость: газ теряет момент импульса и оседает к плоскости диска
    a += (tdir * vc * 0.96 - v) * (0.006 * omega);
  } else {
    // обломки звезды: диссипация у перицентра (ударные волны при самопересечении потока)
    // круговая скорость — в собственной плоскости орбиты частицы (а не в плоскости диска)
    let e = 0.5 * dot(v, v) - 1.0 / rr;
    if (e < 0.0) {
      let Lh = normalize(cross(x, v) + vec3f(0.0, 1e-9, 0.0));
      let own = normalize(cross(Lh, x));
      a += (own * vc - v) * (0.02 * omega * exp(-r / 25.0));
    }
  }
  return a;
}

fn rnd(s: ptr<function, u32>) -> f32 {
  *s = hashU(*s);
  return f32(*s & 0xffffffu) / 16777216.0;
}

fn respawnGas(i: u32) -> Particle {
  var s = hashU(i * 747796405u ^ bitcast<u32>(F.misc.x));
  // газ приходит тремя потоками от звёздных ветров ядерного скопления
  let k = f32(u32(rnd(&s) * 3.0));
  let ang0 = k * 2.1 + 0.7 + F.time.x * 0.0;
  let ang = ang0 + (rnd(&s) - 0.5) * 0.9;
  let r = 110.0 + 260.0 * rnd(&s);
  let tilt = (k - 1.0) * 0.35;
  var x = vec3f(r * cos(ang), 0.0, r * sin(ang));
  x.y = x.x * sin(tilt) * 0.4 + (rnd(&s) - 0.5) * 0.08 * r;
  let rr = r - 2.0;
  let vc = sqrt(r) / rr;
  let tdir = normalize(cross(vec3f(0.0, 1.0, 0.0), x));
  let v = tdir * vc * (0.75 + 0.2 * rnd(&s)) - normalize(x) * vc * 0.15;
  var p: Particle;
  p.pos = vec4f(x, 0.0);
  p.vel = vec4f(v, 0.0);
  return p;
}

@compute @workgroup_size(64)
fn csMain(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&P)) { return; }
  var p = P[i];
  let kind = p.pos.w;
  if (kind < -0.5) { return; }
  let dt = F.time.z;
  if (dt == 0.0) { return; }
  var x = p.pos.xyz;
  var v = p.vel.xyz;
  var remaining = abs(dt);
  let sgn = sign(dt);
  var r = length(x);
  var dead = false;
  for (var s = 0; s < 64; s++) {
    if (remaining <= 0.0) { break; }
    let rr = max(r - 2.0, 0.2);
    let hmax = 0.045 * r * rr / sqrt(r); // ~1/140 периода обращения
    let h = min(hmax, remaining);
    remaining -= h;
    let hs = h * sgn;
    v += 0.5 * hs * accel(x, v, kind);
    x += hs * v;
    v += 0.5 * hs * accel(x, v, kind);
    r = length(x);
    if (r < 2.2) { dead = true; break; }
  }
  if (r > 6000.0 || x.x != x.x) { dead = true; }
  if (dead) {
    if (kind < 0.5) { P[i] = respawnGas(i + u32(abs(F.time.y) * 1e6)); }
    else { p.pos.w = -1.0; P[i] = p; }
    return;
  }
  p.pos = vec4f(x, kind);
  p.vel = vec4f(v, p.vel.w + dt);
  P[i] = p;
}
`;
