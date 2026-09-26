// Общие структуры и функции WGSL. Шейдеры собираются конкатенацией строк.

export const FRAME_FLOATS = 64;

export const frameStruct = /* wgsl */ `
struct Frame {
  camPos:   vec4f, // xyz — камера (чёрная дыра в начале координат), w — расстояние до ЧД
  camRight: vec4f, // xyz, w = tan(fovX/2)
  camUp:    vec4f, // xyz, w = tan(fovY/2)
  camFwd:   vec4f, // xyz, w = угловой размер пикселя (рад)
  res:      vec4f, // ширина, высота внутреннего кадра, сдвиг оптического центра x, y (NDC)
  lensN:    vec4f, // xyz = направление камера→ЧД, w = pixelRatio
  time:     vec4f, // t [млн лет], фаза джета, шаг кадра [M], размытие движения диска
  flow:     vec4f, // фазы и номера циклов двух слоёв «потока» текстуры диска
  look:     vec4f, // яркость диска, джетов, газа, доля эффекта Доплера
  look2:    vec4f, // сила линзирования, режим «рядом», звёздный фон, яркость галактики
  look3:    vec4f, // яркость спрайтов, прозрачность орбит, ширина и высота панорамы
  galRot0:  vec4f,
  galRot1:  vec4f,
  galRot2:  vec4f,
  misc:     vec4f, // seed, T пика диска [K], внешний радиус диска, радиус сферы влияния
  misc2:    vec4f, // яркость TDE, толщина короны, -, -
}
struct Layer { mode: vec4f } // x: +1 за ЧД / −1 перед / 0 всё; y: 0 экран, 1 панорама; z,w — размер цели
`;

export const commonFns = /* wgsl */ `
const PI = 3.14159265358979;

fn hashU(n: u32) -> u32 {
  var x = n;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
fn hash3f(p: vec3f, seed: u32) -> vec4f {
  let q = vec3i(floor(p));
  var h = hashU(bitcast<u32>(q.x) * 73856093u ^ bitcast<u32>(q.y) * 19349663u ^ bitcast<u32>(q.z) * 83492791u ^ seed);
  let a = f32(h & 0xffffu) / 65535.0; h = hashU(h);
  let b = f32(h & 0xffffu) / 65535.0; h = hashU(h);
  let c = f32(h & 0xffffu) / 65535.0; h = hashU(h);
  let d = f32(h & 0xffffu) / 65535.0;
  return vec4f(a, b, c, d);
}

// Излучение абсолютно чёрного тела: спектр Планка в трёх длинах волн (мкм),
// нормированный так, что 6500 K — белый.
fn planck3(T: f32) -> vec3f {
  let l = vec3f(0.610, 0.550, 0.465);
  let x = min(14388.0 / (l * max(T, 300.0)), vec3f(80.0));
  return 1.0 / (l * l * l * l * l * (exp(x) - 1.0));
}
fn bbColor(T: f32) -> vec3f {
  let w = planck3(6500.0);
  let c = planck3(T) / w;
  return c / max(max(c.x, c.y), c.z);
}

// Профиль температуры тонкого диска (Шакура–Сюняев / Новиков–Торн, без спина):
// T ∝ r^(−3/4) · (1 − √(6/r))^(1/4), нормировано на максимум при r = 49/6.
fn diskTau(r: f32) -> f32 {
  if (r <= 6.0) { return 0.0; }
  return pow(r, -0.75) * pow(1.0 - sqrt(6.0 / r), 0.25) / 0.12743;
}
`;

// Проекция спрайта на экран или в панораму (для гравитационного линзирования фона).
export const spriteFns = /* wgsl */ `
struct SpriteOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
}

fn cullOut() -> SpriteOut {
  var o: SpriteOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.uv = vec2f(0.0);
  o.color = vec3f(0.0);
  return o;
}

fn cornerOf(vi: u32) -> vec2f {
  var c = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                          vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  return c[vi];
}

// За ЧД или перед ней? Плоскость через ЧД перпендикулярна лучу зрения.
fn layerKeep(p: vec3f) -> bool {
  let s = L.mode.x;
  if (s == 0.0) { return true; }
  let d = dot(p, F.lensN.xyz);
  if (s > 0.0) { return d > 0.0; }
  return d <= 0.0;
}

// size > 0 — радиус в мировых единицах (яркость сохраняет поверхностную яркость),
// size < 0 — фиксированный радиус в CSS-пикселях.
fn projectSprite(p: vec3f, size: f32, corner: vec2f, color: vec3f, dup: bool) -> SpriteOut {
  var o: SpriteOut;
  let rel = p - F.camPos.xyz;
  let tw = L.mode.z;
  let th = L.mode.w;
  var k = 1.0;
  if (L.mode.y < 0.5) {
    if (dup || !layerKeep(p)) { return cullOut(); }
    let w = dot(rel, F.camFwd.xyz);
    if (w <= 0.0) { return cullOut(); }
    let cx = dot(rel, F.camRight.xyz) / F.camRight.w + F.res.z * w;
    let cy = dot(rel, F.camUp.xyz) / F.camUp.w + F.res.w * w;
    var pr: f32;
    if (size < 0.0) {
      pr = -size * F.lensN.w;
    } else {
      let focal = 0.5 * th / F.camUp.w;
      pr = size / w * focal;
      let pmin = 0.85 * F.lensN.w;
      if (pr < pmin) { k = (pr / pmin) * (pr / pmin); pr = pmin; }
      pr = min(pr, 110.0 * F.lensN.w);
    }
    if (k < 2e-5) { return cullOut(); }
    let m = 2.0 * pr / vec2f(tw, th);
    if (abs(cx) > w * (1.0 + m.x) || abs(cy) > w * (1.0 + m.y)) { return cullOut(); }
    o.pos = vec4f(cx + corner.x * m.x * w, cy + corner.y * m.y * w, 0.5 * w, w);
  } else {
    let dist = length(rel);
    let d = rel / dist;
    let lon = atan2(d.z, d.x);
    let lat = asin(clamp(d.y, -1.0, 1.0));
    var ang = abs(size) / dist;
    if (size < 0.0) { ang = 0.0; }
    let amin = 1.1 * 2.0 * PI / tw;
    if (ang < amin) { k = (ang / amin) * (ang / amin); ang = amin; }
    ang = min(ang, 0.3);
    if (k < 2e-5) { return cullOut(); }
    let cl = max(cos(lat), 0.03);
    let hx = ang / PI / cl;
    var nx = lon / PI;
    if (dup) {
      if (abs(nx) < 1.0 - hx) { return cullOut(); }
      nx = nx - 2.0 * sign(nx);
    }
    o.pos = vec4f(nx + corner.x * hx, lat / (0.5 * PI) + corner.y * ang / (0.5 * PI), 0.5, 1.0);
  }
  o.uv = corner;
  o.color = color * k;
  return o;
}

@fragment
fn fsSprite(i: SpriteOut) -> @location(0) vec4f {
  let r2 = dot(i.uv, i.uv);
  if (r2 > 1.0) { discard; }
  let g = exp(-r2 * 4.5);
  return vec4f(i.color * g, 0.0);
}
`;

export const frameBindings = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> L: Layer;
`;
