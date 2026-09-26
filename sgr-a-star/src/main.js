import './styles.css';
import { gsap } from 'gsap';
import { Renderer } from './engine/renderer.js';
import { World } from './engine/world.js';
import { OrbitCamera, projectToScreen } from './engine/camera.js';
import { SimClock, LOG_RATE_MIN, LOG_RATE_MAX } from './sim/clock.js';
import { generateGalaxy } from './sim/galaxy.js';
import { makeGas, makeTDE, PARTICLE_FLOATS } from './sim/gas.js';
import { CARDS } from './ui/cards.js';
import { Panel } from './ui/panel.js';
import { Hud } from './ui/hud.js';
import { Labels } from './ui/labels.js';

const GAS_COUNT = 40000;
const TDE_COUNT = 16000;
const GALAXY_COUNT = 320000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (s) => document.querySelector(s);
const canvas = $('#scene');

function fail(title, text) {
  $('#loader')?.remove();
  const el = $('#fallback');
  el.querySelector('h2').textContent = title;
  el.querySelector('p').innerHTML = text;
  el.hidden = false;
}

async function start() {
  if (!('gpu' in navigator)) {
    fail('Этот браузер не поддерживает WebGPU',
      'Откройте страницу в свежей версии Firefox, Safari или Chrome. В Firefox можно проверить ' +
      'настройку <code>dom.webgpu.enabled</code> на странице <code>about:config</code>.');
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    fail('Видеокарта недоступна для WebGPU', 'Браузер поддерживает WebGPU, но не выдал адаптер. ' +
      'Обновите браузер и драйверы или попробуйте другой браузер.');
    return;
  }
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') fail('Видеокарта сбросила контекст', 'Перезагрузите страницу. ' + (info.message || ''));
  });

  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const renderer = new Renderer(device, format);
  const galaxy = generateGalaxy(GALAXY_COUNT);
  try {
    await renderer.init({ galaxy, dynCount: GAS_COUNT + TDE_COUNT });
  } catch (e) {
    console.error(e);
    fail('Не удалось собрать шейдеры', String(e.message || e));
    return;
  }
  const dyn = new Float32Array((GAS_COUNT + TDE_COUNT) * PARTICLE_FLOATS);
  dyn.set(makeGas(GAS_COUNT));
  for (let i = GAS_COUNT; i < GAS_COUNT + TDE_COUNT; i++) dyn[i * PARTICLE_FLOATS + 3] = -1;
  renderer.writeDyn(dyn);

  const world = new World();
  const camera = new OrbitCamera();
  const clock = new SimClock();

  // ── сцена: куда смотрим ────────────────────────────────────────────────
  const aim = { from: 'bh', to: 'bh', blend: 1 };
  let flight = null;
  let activeCard = null;

  function updateTarget() {
    const a = world.targetPosition(aim.from, clock.t);
    if (aim.blend >= 1 || aim.from === aim.to) { camera.target = world.targetPosition(aim.to, clock.t); return; }
    const b = world.targetPosition(aim.to, clock.t);
    const k = aim.blend;
    camera.target = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }

  function launchTDE() {
    renderer.writeDyn(makeTDE(TDE_COUNT, { seed: (Math.random() * 1e9) | 0 }).data, GAS_COUNT);
    clock.direction = 1;
    hud.sync();
  }

  function setLook(values, duration) {
    gsap.to(world.look, { ...values, duration, ease: 'power2.inOut', overwrite: 'auto', onUpdate: () => hud.syncToggles() });
  }

  /** Перелёт к карточке: расстояние интерполируется в логарифме — 10 порядков за несколько секунд */
  function flyTo(card, { duration } = {}) {
    const v = card.view;
    flight?.kill();
    const dLog = Math.abs(Math.log10(v.dist) - camera.logDist);
    const dur = reducedMotion ? 0.5 : duration ?? Math.min(7.5, 1.6 + 0.42 * dLog);
    let dyaw = (v.yaw - camera.yaw) % (Math.PI * 2);
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    if (dyaw < -Math.PI) dyaw += Math.PI * 2;

    // прежняя цель становится точкой «откуда», новая — «куда»
    aim.from = aim.to;
    aim.to = v.target;
    aim.blend = aim.from === aim.to ? 1 : 0;

    const proxy = { logDist: camera.logDist, yaw: camera.yaw, pitch: camera.pitch, logRate: clock.logRate, blend: aim.blend };
    flight = gsap.timeline({ onComplete: () => { flight = null; if (card.onEnter === 'tde') launchTDE(); } });
    flight.to(proxy, {
      logDist: Math.log10(v.dist), yaw: camera.yaw + dyaw, pitch: v.pitch, logRate: v.logRate,
      duration: dur, ease: 'power2.inOut',
      onUpdate: () => {
        camera.logDist = proxy.logDist; camera.yaw = proxy.yaw; camera.pitch = proxy.pitch;
        clock.logRate = proxy.logRate;
        camera.vel.yaw = camera.vel.pitch = camera.vel.log = 0;
        hud.sync();
      },
    }, 0);
    if (aim.blend < 1) {
      flight.to(proxy, { blend: 1, duration: dur * 0.75, ease: 'power3.out', onUpdate: () => { aim.blend = proxy.blend; } }, 0);
    }
    setLook({ jets: 0, gas: 0.25, orbits: 1, tde: 1, ...card.look }, dur * 0.8);
    world.highlight = card.highlight || null;
    clock.paused = false;
  }

  function activate(card, opts) {
    activeCard = card;
    panel.setActive(card.id);
    flyTo(card, opts);
  }

  function cancelFlight() {
    if (flight) { flight.kill(); flight = null; aim.blend = 1; aim.from = aim.to; }
    intro.cancel();
  }

  // ── интерфейс ───────────────────────────────────────────────────────────
  const panel = new Panel($('#cards'), CARDS, {
    onSelect: (card) => { intro.cancel(); activate(card); },
    onAction: (id) => {
      if (id === 'tde') launchTDE();
      if (id === 'doppler') hud.toggle('doppler');
      if (id === 'lensing') hud.toggle('lens');
    },
    isOn: (id) => (id === 'doppler' ? world.look.doppler > 0.5 : id === 'lensing' ? world.look.lens > 0.5 : false),
  });
  const hud = new Hud($('#hud'), {
    clock, world, camera,
    logRateRange: [LOG_RATE_MIN, LOG_RATE_MAX],
    onToggle: (key, on) => {
      const map = { doppler: 'doppler', lens: 'lens', jets: 'jets', orbits: 'orbits', labels: 'labels' };
      setLook({ [map[key]]: on ? 1 : 0 }, reducedMotion ? 0.01 : 0.8);
      panel.refreshToggles();
    },
    onUserTime: () => intro.cancel(),
  });
  const labels = new Labels($('#labels'));

  // ── стартовый пролёт: от всей галактики к горизонту ──────────────────────
  const intro = {
    active: false, timer: 0,
    run() {
      const g = CARDS[0];
      camera.logDist = Math.log10(g.view.dist); camera.yaw = g.view.yaw; camera.pitch = g.view.pitch;
      clock.logRate = g.view.logRate;
      Object.assign(world.look, g.look);
      const lens = CARDS.find((c) => c.id === 'lens');
      if (reducedMotion) { activate(lens, { duration: 0.01 }); return; }
      panel.setActive('galaxy');
      this.active = true;
      $('#intro-hint').hidden = false;
      this.timer = setTimeout(() => {
        activate(lens, { duration: 9.5 });
        flight.eventCallback('onComplete', () => { flight = null; this.finish(); });
      }, 1800);
    },
    cancel() {
      if (!this.active) return;
      clearTimeout(this.timer);
      this.finish();
    },
    finish() {
      this.active = false;
      const h = $('#intro-hint');
      h.classList.add('is-leaving');
      setTimeout(() => (h.hidden = true), 600);
    },
  };

  // ── ввод ───────────────────────────────────────────────────────────────
  const pointers = new Map();
  let pinchDist = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelFlight();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1) {
      camera.yaw -= dx * 0.0045;
      camera.pitch += dy * 0.0045;
      camera.vel.yaw = -dx * 0.25; camera.vel.pitch = dy * 0.25;
      camera.clamp();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) camera.logDist -= Math.log10(d / pinchDist) * 1.6;
      pinchDist = d;
      camera.clamp();
    }
  });
  const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchDist = 0; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelFlight();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    camera.vel.log += e.deltaY * unit * 0.0022;
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    const step = { ArrowLeft: [0.08, 0], ArrowRight: [-0.08, 0], ArrowUp: [0, 0.06], ArrowDown: [0, -0.06] }[e.key];
    if (step && !e.target.closest('button, [role="slider"]')) {
      cancelFlight(); camera.yaw += step[0]; camera.pitch += step[1]; camera.clamp(); e.preventDefault();
    } else if (e.key === '+' || e.key === '=') { cancelFlight(); camera.vel.log -= 1.2; }
    else if (e.key === '-' || e.key === '_') { cancelFlight(); camera.vel.log += 1.2; }
    else if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); hud.togglePause(); }
  });

  // ── размеры и адаптивное качество ─────────────────────────────────────
  let quality = 0.85;
  let cssW = 0, cssH = 0;
  let shift = [0, 0];
  function layout() {
    cssW = window.innerWidth; cssH = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const inner = Math.min(dpr, 1.5) * quality;
    renderer.resize(cssW * inner, cssH * inner, canvas.width, canvas.height);
    camera.aspect = cssW / cssH;
    // сдвигаем оптический центр в свободную от панели часть экрана
    const pr = $('#panel').getBoundingClientRect();
    const mobile = cssW < 760;
    shift = mobile ? [0, Math.min(pr.height, cssH * 0.6) / cssH] : [-pr.width / cssW, 0];
    panel.layoutRail();
  }
  window.addEventListener('resize', layout);
  layout();

  let ema = 1 / 60, lastQ = 0;
  function adaptQuality(dt, now) {
    ema += (dt - ema) * 0.05;
    if (now - lastQ < 1500) return;
    lastQ = now;
    const prev = quality;
    if (ema > 1 / 38 && quality > 0.5) quality = Math.max(0.5, quality - 0.1);
    else if (ema < 1 / 57 && quality < 1) quality = Math.min(1, quality + 0.05);
    if (quality !== prev) layout();
  }

  // ── цикл ───────────────────────────────────────────────────────────────
  const env = { valid: false, pos: [0, 0, 0], tMyr: 0 };
  let last = performance.now();
  let seed = 1;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    adaptQuality(dt, now);
    clock.tick(dt);
    camera.update(dt);
    updateTarget();
    const b = camera.basis();
    const camD = Math.hypot(...b.pos);
    const near = camD < 2e7;
    let envDirty = false;
    if (near) {
      const moved = Math.hypot(b.pos[0] - env.pos[0], b.pos[1] - env.pos[1], b.pos[2] - env.pos[2]);
      if (!env.valid || moved > 1e6 || Math.abs(clock.tMyr - env.tMyr) > 0.01) {
        envDirty = true; env.valid = true; env.pos = b.pos; env.tMyr = clock.tMyr;
      }
    } else env.valid = false;

    const state = world.frameState({ cam: b, shift, pixelRatio: renderer.w / cssW, clock, seed: seed++, envDirty });
    renderer.render(context.getCurrentTexture().createView(), state);

    hud.update(b, camD);
    panel.updateMarker(camera.logDist);
    labels.update(world.look.labels > 0.5 ? world.labels(clock.t, camD, dist3(b.pos, world.system.hostPosition(clock.t))) : [],
      (p) => projectToScreen(b, p, shift, cssW, cssH), cssW, cssH);
    requestAnimationFrame(frame);
  }
  const dist3 = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);

  $('#loader').classList.add('is-done');
  setTimeout(() => $('#loader')?.remove(), 900);
  hud.sync();
  intro.run();
  requestAnimationFrame((t) => { last = t; frame(t); });
}

start().catch((e) => {
  console.error(e);
  fail('Что-то пошло не так', String(e && e.message ? e.message : e));
});
