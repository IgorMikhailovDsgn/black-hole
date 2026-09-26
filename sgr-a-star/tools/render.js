// Headless-рендер кадров для проверки: deno run -A --unstable-webgpu tools/render.js '<json>'
import { Renderer } from '../src/engine/renderer.js';
import { World } from '../src/engine/world.js';
import { OrbitCamera } from '../src/engine/camera.js';
import { SimClock } from '../src/sim/clock.js';
import { generateGalaxy } from '../src/sim/galaxy.js';
import { makeGas, makeTDE } from '../src/sim/gas.js';
import { T_M } from '../src/sim/units.js';

const shots = JSON.parse(Deno.args[0]);
const W = shots.w ?? 800, H = shots.h ?? 450;
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const GAS = 40000, TDE = 20000;
const galaxy = generateGalaxy(shots.galaxyCount ?? 200000);
const r = new Renderer(device, 'rgba8unorm');
await r.init({ galaxy, dynCount: GAS + TDE });
const dyn = new Float32Array((GAS + TDE) * 8);
dyn.set(makeGas(GAS));
for (let i = GAS; i < GAS + TDE; i++) dyn[i * 8 + 3] = -1;
r.writeDyn(dyn);
r.resize(W, H, W, H);
const out = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const bpr = Math.ceil((W * 4) / 256) * 256;
const rb = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

for (const s of shots.list) {
  const world = new World();
  Object.assign(world.look, s.look || {});
  world.highlight = s.highlight || null;
  const cam = new OrbitCamera();
  cam.aspect = W / H;
  cam.yaw = s.yaw ?? 0.4; cam.pitch = s.pitch ?? 0.1; cam.logDist = Math.log10(s.dist ?? 30);
  const clock = new SimClock();
  clock.t = s.t ?? 0;
  clock.logRate = s.logRate ?? 2;
  if (s.tde) {
    const tde = makeTDE(TDE, s.tde === true ? {} : s.tde);
    r.writeDyn(tde.data, GAS);
  }
  const frames = s.frames ?? 1;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    const last = i === frames - 1;
    clock.tick(i === 0 ? 0 : (s.dtReal ?? 1 / 60));
    if (s.target) cam.target = world.targetPosition(s.target, clock.t);
    const b = cam.basis();
    const st = world.frameState({ cam: b, shift: s.shift ?? [0, 0], pixelRatio: 1, clock, seed: i, envDirty: i === 0 || last });
    device.pushErrorScope('validation');
    r.render(out.createView(), st);
    const e = await device.popErrorScope();
    if (e) { console.error('VALIDATION', e.message); Deno.exit(1); }

    if (s.verbose) console.log("frame", i, ((performance.now() - t0) / 1000).toFixed(2));
  }
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: out }, { buffer: rb, bytesPerRow: bpr }, [W, H]);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(rb.getMappedRange());
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) px.set(src.subarray(y * bpr, y * bpr + W * 4), y * W * 4);
  rb.unmap();
  await Deno.writeFile(`/tmp/shots/${s.name}.rgba`, px);
  console.log(s.name, 'ok', ((performance.now() - t0) / 1000).toFixed(1) + 's', 'year', clock.year.toFixed(2), 'tM', clock.tM.toFixed(0));
}
