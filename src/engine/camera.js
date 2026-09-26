// Орбитальная камера с логарифмическим расстоянием: зум проходит 10 порядков величины плавно.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class OrbitCamera {
  constructor() {
    this.yaw = 0.4;
    this.pitch = 0.1;
    this.logDist = 1.5;
    this.fovY = (48 * Math.PI) / 180;
    this.aspect = 16 / 9;
    this.target = [0, 0, 0];
    this.vel = { yaw: 0, pitch: 0, log: 0 };
    this.minLog = Math.log10(5.5);
    this.maxLog = Math.log10(3.2e11);
  }
  get dist() { return Math.pow(10, this.logDist); }

  update(dt) {
    // инерция после перетаскивания
    const k = Math.exp(-dt * 5);
    this.yaw += this.vel.yaw * dt;
    this.pitch += this.vel.pitch * dt;
    this.logDist += this.vel.log * dt;
    this.vel.yaw *= k; this.vel.pitch *= k; this.vel.log *= Math.exp(-dt * 7);
    this.clamp();
  }
  clamp() {
    this.pitch = Math.max(-1.53, Math.min(1.53, this.pitch));
    this.logDist = Math.max(this.minLog, Math.min(this.maxLog, this.logDist));
  }

  /** Базис камеры; target — точка, вокруг которой вращаемся (обычно ЧД в начале координат) */
  basis() {
    const d = this.dist;
    const cp = Math.cos(this.pitch);
    const off = [d * cp * Math.sin(this.yaw), d * Math.sin(this.pitch), d * cp * Math.cos(this.yaw)];
    const pos = [this.target[0] + off[0], this.target[1] + off[1], this.target[2] + off[2]];
    const fwd = norm(sub(this.target, pos));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const tanY = Math.tan(this.fovY / 2);
    return { pos, fwd, right, up, tanY, tanX: tanY * this.aspect };
  }
}

/** Проекция мировой точки в CSS-пиксели (для HTML-подписей) */
export function projectToScreen(b, p, shift, w, h) {
  const rel = [p[0] - b.pos[0], p[1] - b.pos[1], p[2] - b.pos[2]];
  const z = rel[0] * b.fwd[0] + rel[1] * b.fwd[1] + rel[2] * b.fwd[2];
  if (z <= 0) return null;
  const x = (rel[0] * b.right[0] + rel[1] * b.right[1] + rel[2] * b.right[2]) / (z * b.tanX) + shift[0];
  const y = (rel[0] * b.up[0] + rel[1] * b.up[1] + rel[2] * b.up[2]) / (z * b.tanY) + shift[1];
  return { x: (x * 0.5 + 0.5) * w, y: (0.5 - y * 0.5) * h, z };
}
