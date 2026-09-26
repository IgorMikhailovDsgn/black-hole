// WebGPU-рендерер сцены. Не зависит от DOM: цель вывода передаётся снаружи,
// поэтому тот же код работает в браузере и в headless-тестах.
import { FRAME_FLOATS } from '../shaders/common.js';
import { galaxyWGSL, spritesWGSL, dynWGSL, linesWGSL, computeWGSL } from '../shaders/particles.js';
import { lensWGSL, postWGSL, compositeWGSL } from '../shaders/lens.js';

const HDR = 'rgba16float';
const U = GPUBufferUsage;
const T = GPUTextureUsage;
const S = GPUShaderStage;
const ADD = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};
export const MAX_SPRITES = 512;
export const MAX_LINE_PTS = 6144;
export const BLOOM_LEVELS = 6;
export const ENV_W = 3072, ENV_H = 1536;

export class Renderer {
  constructor(device, outFormat) {
    this.device = device;
    this.outFormat = outFormat;
    this.srgbOut = !outFormat.endsWith('-srgb');
    this.frameData = new Float32Array(FRAME_FLOATS);
    this.galaxyCount = 0;
    this.dynCount = 0;
    this.spriteCount = 0;
    this.linePtCount = 0;
    this.errors = [];
  }

  async init({ galaxy, dynCount }) {
    const d = this.device;
    d.pushErrorScope('validation');
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST });
    this.layerBufs = {
      back: d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }),
      front: d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }),
      env: d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }),
    };
    d.queue.writeBuffer(this.layerBufs.env, 0, new Float32Array([0, 1, ENV_W, ENV_H]));

    this.bglFrame = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } },
    ] });
    this.bglStore = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
    ] });
    this.bglCompute = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: S.COMPUTE, buffer: { type: 'storage' } },
    ] });
    this.bglLens = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
    ] });
    this.bglPost = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: S.FRAGMENT, buffer: { type: 'uniform' } },
    ] });
    this.bglComp = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: S.FRAGMENT, buffer: { type: 'uniform' } },
    ] });

    const mod = (code, label) => d.createShaderModule({ code, label });
    const mGalaxy = mod(galaxyWGSL, 'galaxy');
    const mSprites = mod(spritesWGSL, 'sprites');
    const mDyn = mod(dynWGSL, 'dyn');
    const mLines = mod(linesWGSL, 'lines');
    const mCompute = mod(computeWGSL, 'compute');
    const mLens = mod(lensWGSL, 'lens');
    const mPost = mod(postWGSL, 'post');
    const mComp = mod(compositeWGSL, 'composite');
    this.modules = { mGalaxy, mSprites, mDyn, mLines, mCompute, mLens, mPost, mComp };

    // асинхронное создание пайплайнов (не блокирует главный поток); синхронный запасной путь
    const renderPipe = async (desc) => {
      try { return await d.createRenderPipelineAsync(desc); } catch { return d.createRenderPipeline(desc); }
    };
    const computePipe = async (desc) => {
      try { return await d.createComputePipelineAsync(desc); } catch { return d.createComputePipeline(desc); }
    };
    const plSprite = d.createPipelineLayout({ bindGroupLayouts: [this.bglFrame, this.bglStore] });
    const additive = (module, vs, fs) => renderPipe({
      layout: plSprite,
      vertex: { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format: HDR, blend: ADD }] },
      primitive: { topology: 'triangle-list' },
    });
    const full = (module, fs, layout, format, blend) => renderPipe({
      layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vsFull' },
      fragment: { module, entryPoint: fs, targets: [blend ? { format, blend } : { format }] },
      primitive: { topology: 'triangle-list' },
    });
    [this.pGalaxy, this.pSprite, this.pDyn, this.pLine, this.pLens, this.pDown, this.pUp, this.pComp,
      this.pCompute] = await Promise.all([
      additive(mGalaxy, 'vsGalaxy', 'fsSprite'),
      additive(mSprites, 'vsSprite', 'fsSprite'),
      additive(mDyn, 'vsDyn', 'fsSprite'),
      additive(mLines, 'vsLine', 'fsLine'),
      full(mLens, 'fsLens', this.bglLens, HDR),
      full(mPost, 'fsDown', this.bglPost, HDR),
      full(mPost, 'fsUp', this.bglPost, HDR, ADD),
      full(mComp, 'fsComposite', this.bglComp, this.outFormat),
      computePipe({
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.bglCompute] }),
        compute: { module: mCompute, entryPoint: 'csMain' },
      }),
    ]);

    // данные
    this.galaxyCount = galaxy.count;
    this.galaxyBuf = d.createBuffer({ size: galaxy.data.byteLength, usage: U.STORAGE | U.COPY_DST });
    d.queue.writeBuffer(this.galaxyBuf, 0, galaxy.data);
    this.spriteBuf = d.createBuffer({ size: MAX_SPRITES * 32, usage: U.STORAGE | U.COPY_DST });
    this.lineBuf = d.createBuffer({ size: MAX_LINE_PTS * 32, usage: U.STORAGE | U.COPY_DST });
    this.dynCount = dynCount;
    this.dynBuf = d.createBuffer({ size: dynCount * 32, usage: U.STORAGE | U.COPY_DST });

    const store = (buffer) => d.createBindGroup({ layout: this.bglStore, entries: [{ binding: 0, resource: { buffer } }] });
    this.bgGalaxy = store(this.galaxyBuf);
    this.bgSprites = store(this.spriteBuf);
    this.bgLines = store(this.lineBuf);
    this.bgDyn = store(this.dynBuf);
    this.bgCompute = d.createBindGroup({ layout: this.bglCompute, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } },
      { binding: 1, resource: { buffer: this.dynBuf } },
    ] });
    const frameBG = (layer) => d.createBindGroup({ layout: this.bglFrame, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } },
      { binding: 1, resource: { buffer: layer } },
    ] });
    this.bgBack = frameBG(this.layerBufs.back);
    this.bgFront = frameBG(this.layerBufs.front);
    this.bgEnv = frameBG(this.layerBufs.env);

    this.linS = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.envS = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
    this.envTex = d.createTexture({ size: [ENV_W, ENV_H], format: HDR, usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
    this.envView = this.envTex.createView();
    this.compU = d.createBuffer({ size: 32, usage: U.UNIFORM | U.COPY_DST });

    const err = await d.popErrorScope();
    if (err) throw new Error('WebGPU validation: ' + err.message);
  }

  writeDyn(data, offsetParticles = 0) {
    this.device.queue.writeBuffer(this.dynBuf, offsetParticles * 32, data);
  }

  resize(w, h, outW, outH) {
    const d = this.device;
    w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
    if (this.w === w && this.h === h && this.outW === outW && this.outH === outH) return;
    this.w = w; this.h = h; this.outW = outW; this.outH = outH;
    for (const t of [this.backTex, this.sceneTex, ...(this.bloomTex || [])]) t?.destroy();
    const mk = (W, H) => d.createTexture({ size: [W, H], format: HDR, usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
    this.backTex = mk(w, h);
    this.sceneTex = mk(w, h);
    this.backView = this.backTex.createView();
    this.sceneView = this.sceneTex.createView();
    d.queue.writeBuffer(this.layerBufs.back, 0, new Float32Array([1, 0, w, h]));
    d.queue.writeBuffer(this.layerBufs.front, 0, new Float32Array([-1, 0, w, h]));

    this.bloomTex = [];
    this.bloomSize = [];
    let bw = w, bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      this.bloomTex.push(mk(bw, bh));
      this.bloomSize.push([bw, bh]);
    }
    this.bloomViews = this.bloomTex.map((t) => t.createView());
    // down: scene→b0, b0→b1, …; up: b(i+1)→b(i)
    const postBG = (srcView, srcSize, dstSize) => {
      const buf = d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
      d.queue.writeBuffer(buf, 0, new Float32Array([1 / srcSize[0], 1 / srcSize[1], 1 / dstSize[0], 1 / dstSize[1]]));
      return d.createBindGroup({ layout: this.bglPost, entries: [
        { binding: 0, resource: srcView }, { binding: 1, resource: this.linS }, { binding: 2, resource: { buffer: buf } },
      ] });
    };
    this.downBG = [];
    this.upBG = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const srcView = i === 0 ? this.sceneView : this.bloomViews[i - 1];
      const srcSize = i === 0 ? [w, h] : this.bloomSize[i - 1];
      this.downBG.push(postBG(srcView, srcSize, this.bloomSize[i]));
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      this.upBG[i] = postBG(this.bloomViews[i], this.bloomSize[i], this.bloomSize[i - 1]);
    }
    this.lensBG = d.createBindGroup({ layout: this.bglLens, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } },
      { binding: 1, resource: this.backView },
      { binding: 2, resource: this.envView },
      { binding: 3, resource: this.linS },
      { binding: 4, resource: this.envS },
    ] });
    this.compBG = d.createBindGroup({ layout: this.bglComp, entries: [
      { binding: 0, resource: this.sceneView },
      { binding: 1, resource: this.bloomViews[0] },
      { binding: 2, resource: this.linS },
      { binding: 3, resource: { buffer: this.compU } },
    ] });
  }

  /**
   * s: { cam: {pos, right, up, fwd, tanX, tanY}, shift:[x,y], pixelRatio, tMyr, jetPhase, dtM, blur,
   *      flow:[4], look:{...}, galRot, seed, nearMode, envDirty, sprites:Float32Array, spriteCount,
   *      lines:Float32Array, lineCount, exposure, bloom, vignette }
   */
  render(outView, s) {
    const d = this.device;
    const f = this.frameData;
    const c = s.cam;
    const camD = Math.hypot(c.pos[0], c.pos[1], c.pos[2]);
    const pixAng = (2 * c.tanY) / this.h;
    f.set([c.pos[0], c.pos[1], c.pos[2], camD], 0);
    f.set([...c.right, c.tanX], 4);
    f.set([...c.up, c.tanY], 8);
    f.set([...c.fwd, pixAng], 12);
    f.set([this.w, this.h, s.shift[0], s.shift[1]], 16);
    f.set([-c.pos[0] / camD, -c.pos[1] / camD, -c.pos[2] / camD, s.pixelRatio], 20);
    f.set([s.tMyr, s.jetPhase, s.dtM, s.blur], 24);
    f.set(s.flow, 28);
    const L = s.look;
    f.set([L.disk, L.jets, L.gas, L.doppler], 32);
    f.set([L.lens, s.nearMode ? 1 : 0, L.stars, L.galaxy], 36);
    f.set([L.sprites, L.orbits, ENV_W, ENV_H], 40);
    const R = s.galRot;
    f.set([...R[0], 0], 44); f.set([...R[1], 0], 48); f.set([...R[2], 0], 52);
    f.set([s.seed, L.diskTemp, L.diskOuter, L.influence], 56);
    f.set([L.tde, 0, 0, 0], 60);
    d.queue.writeBuffer(this.frameBuf, 0, f);
    if (s.spriteCount) d.queue.writeBuffer(this.spriteBuf, 0, s.sprites.subarray(0, s.spriteCount * 8));
    if (s.lineCount) d.queue.writeBuffer(this.lineBuf, 0, s.lines.subarray(0, s.lineCount * 8));
    d.queue.writeBuffer(this.compU, 0, new Float32Array([s.exposure, s.bloom, s.vignette, (s.seed % 97) * 1.37,
      this.outW, this.outH, this.srgbOut ? 1 : 0, 0]));

    const enc = d.createCommandEncoder();
    if (s.dtM !== 0 && this.dynCount) {
      const cp = enc.beginComputePass();
      cp.setPipeline(this.pCompute);
      cp.setBindGroup(0, this.bgCompute);
      cp.dispatchWorkgroups(Math.ceil(this.dynCount / 64));
      cp.end();
    }
    const clear = (view, load = false) => ({
      colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    if (s.nearMode && s.envDirty) {
      const p = enc.beginRenderPass(clear(this.envView));
      p.setPipeline(this.pGalaxy);
      p.setBindGroup(0, this.bgEnv);
      p.setBindGroup(1, this.bgGalaxy);
      p.draw(6, this.galaxyCount * 2);
      p.end();
    }
    const drawLayer = (pass, bg) => {
      if (!s.nearMode && L.galaxy > 0) {
        pass.setPipeline(this.pGalaxy); pass.setBindGroup(0, bg); pass.setBindGroup(1, this.bgGalaxy);
        pass.draw(6, this.galaxyCount);
      }
      if (L.gas > 0 || L.tde > 0) {
        pass.setPipeline(this.pDyn); pass.setBindGroup(0, bg); pass.setBindGroup(1, this.bgDyn);
        pass.draw(6, this.dynCount);
      }
      if (s.lineCount > 1 && L.orbits > 0) {
        pass.setPipeline(this.pLine); pass.setBindGroup(0, bg); pass.setBindGroup(1, this.bgLines);
        pass.draw(6, s.lineCount - 1);
      }
      if (s.spriteCount) {
        pass.setPipeline(this.pSprite); pass.setBindGroup(0, bg); pass.setBindGroup(1, this.bgSprites);
        pass.draw(6, s.spriteCount);
      }
    };
    let p = enc.beginRenderPass(clear(this.backView));
    drawLayer(p, this.bgBack);
    p.end();

    p = enc.beginRenderPass(clear(this.sceneView));
    p.setPipeline(this.pLens);
    p.setBindGroup(0, this.lensBG);
    p.draw(3);
    p.end();

    p = enc.beginRenderPass(clear(this.sceneView, true));
    drawLayer(p, this.bgFront);
    p.end();

    for (let i = 0; i < BLOOM_LEVELS; i++) {
      p = enc.beginRenderPass(clear(this.bloomViews[i]));
      p.setPipeline(this.pDown); p.setBindGroup(0, this.downBG[i]); p.draw(3); p.end();
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      p = enc.beginRenderPass(clear(this.bloomViews[i - 1], true));
      p.setPipeline(this.pUp); p.setBindGroup(0, this.upBG[i]); p.draw(3); p.end();
    }
    p = enc.beginRenderPass(clear(outView));
    p.setPipeline(this.pComp);
    p.setBindGroup(0, this.compBG);
    p.draw(3);
    p.end();
    d.queue.submit([enc.finish()]);
  }
}
