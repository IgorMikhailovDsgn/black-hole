// Нижняя панель: масштаб кадра, дата модели, замедление времени, скорость времени, переключатели.
import { formatLength, formatDuration, YEAR } from '../sim/units.js';

const nf = (v, d) => v.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });

export class Hud {
  constructor(root, { clock, world, camera, logRateRange, onToggle, onUserTime }) {
    this.root = root;
    this.clock = clock;
    this.world = world;
    this.camera = camera;
    this.onToggle = onToggle;
    this.onUserTime = onUserTime;
    this.el = {
      scale: root.querySelector('#r-scale'),
      date: root.querySelector('#r-date'),
      dil: root.querySelector('#r-dil'),
      dilRow: root.querySelector('.r-dil'),
      rate: root.querySelector('#s-rate'),
      rateOut: root.querySelector('#o-rate'),
      pause: root.querySelector('#b-pause'),
      rev: root.querySelector('#b-rev'),
    };
    this.el.rate.min = logRateRange[0];
    this.el.rate.max = logRateRange[1];
    this.el.rate.addEventListener('input', () => {
      clock.logRate = parseFloat(this.el.rate.value);
      clock.paused = false;
      onUserTime();
      this.sync();
    });
    this.el.pause.addEventListener('click', () => this.togglePause());
    this.el.rev.addEventListener('click', () => {
      clock.direction *= -1;
      onUserTime();
      this.sync();
    });
    for (const b of root.querySelectorAll('[data-toggle]')) {
      b.addEventListener('click', () => this.toggle(b.dataset.toggle));
    }
    this.lastText = 0;
    this.syncToggles();
  }

  isOn(key) {
    const L = this.world.look;
    return (L[key] ?? 0) > 0.5;
  }
  toggle(key) {
    const on = !this.isOn(key);
    this.onToggle(key, on);
    const b = this.root.querySelector(`[data-toggle="${key}"]`);
    b?.setAttribute('aria-pressed', String(on));
  }
  togglePause() {
    this.clock.paused = !this.clock.paused;
    this.onUserTime();
    this.sync();
  }
  syncToggles() {
    for (const b of this.root.querySelectorAll('[data-toggle]')) {
      b.setAttribute('aria-pressed', String(this.isOn(b.dataset.toggle)));
    }
  }
  sync() {
    const c = this.clock;
    this.el.rate.value = c.logRate;
    const r = Math.pow(10, c.logRate);
    const dir = c.direction < 0 ? 'назад: ' : '';
    this.el.rateOut.textContent = c.paused ? 'пауза' : `${dir}1 с = ${formatDuration(r)}`;
    this.el.pause.setAttribute('aria-pressed', String(c.paused));
    this.el.pause.setAttribute('aria-label', c.paused ? 'Продолжить' : 'Пауза');
    this.el.rev.setAttribute('aria-pressed', String(c.direction < 0));
    this.el.rate.setAttribute('aria-valuetext', this.el.rateOut.textContent);
  }

  update(basis, camD) {
    const now = performance.now();
    if (now - this.lastText < 120) return;
    this.lastText = now;
    const h = 2 * this.camera.dist * basis.tanY;
    this.el.scale.textContent = formatLength(h);
    const t = this.clock.t;
    if (Math.abs(t) < 3000 * YEAR) {
      this.el.date.textContent = `${nf(this.clock.year, 1)} год`;
    } else {
      this.el.date.textContent = `${t < 0 ? '−' : '+'}${formatDuration(t)}`;
    }
    // замедление времени для неподвижных часов на расстоянии камеры: √(1 − 2GM/rc²)
    if (camD < 2000) {
      const k = Math.sqrt(Math.max(0, 1 - 2 / camD));
      this.el.dil.textContent = `${nf(k, k > 0.995 ? 3 : 2)} с за 1 с вдали`;
      this.el.dilRow.hidden = false;
    } else {
      this.el.dilRow.hidden = true;
    }
  }
}
