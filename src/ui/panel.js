// Панель карточек и логарифмическая линейка масштаба.
// Точка каждой карточки стоит на линейке; живой маркер показывает, где сейчас камера
// между галактикой (10¹¹ GM/c²) и горизонтом (≈ 10 GM/c²).
import { formatLength } from '../sim/units.js';

const FOV_TAN = Math.tan((48 * Math.PI) / 360);

export class Panel {
  constructor(list, cards, { onSelect, onAction, isOn }) {
    this.list = list;
    this.cards = cards;
    this.onAction = onAction;
    this.isOn = isOn;
    this.track = list.parentElement;
    this.rail = this.track.querySelector('.rail');
    this.marker = this.track.querySelector('.rail-marker');
    this.items = new Map();
    this.logs = cards.map((c) => Math.log10(c.view.dist));

    for (const card of cards) {
      const li = document.createElement('li');
      li.className = 'card';
      li.dataset.id = card.id;
      const bodyId = `card-body-${card.id}`;
      li.innerHTML = `
        <span class="card-dot" aria-hidden="true"></span>
        <button class="card-head" type="button" aria-expanded="false" aria-controls="${bodyId}">
          <span class="card-title">${card.title}</span>
          <span class="card-scale">кадр ≈ ${formatLength(2 * card.view.dist * FOV_TAN)}</span>
        </button>
        <p class="card-lede">${card.lede}</p>
        <div class="card-body" id="${bodyId}" hidden>
          <div class="card-text">${card.body}</div>
          ${card.facts?.length ? `<dl class="card-facts">${card.facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
          ${card.actions?.length ? `<div class="card-actions">${card.actions.map((a) =>
            `<button type="button" class="${a.toggle ? 'chip' : 'action'}" data-action="${a.id}" ${a.toggle ? 'aria-pressed="true"' : ''}>${a.label}</button>`).join('')}</div>` : ''}
        </div>`;
      li.querySelector('.card-head').addEventListener('click', () => onSelect(card));
      li.querySelector('.card-lede').addEventListener('click', () => onSelect(card));
      for (const b of li.querySelectorAll('[data-action]')) {
        b.addEventListener('click', () => { onAction(b.dataset.action); this.refreshToggles(); });
      }
      list.appendChild(li);
      this.items.set(card.id, li);
    }
    this.dots = [];
    window.addEventListener('resize', () => this.layoutRail());
    new ResizeObserver(() => this.layoutRail()).observe(list);
  }

  setActive(id) {
    for (const [cid, li] of this.items) {
      const on = cid === id;
      li.classList.toggle('is-active', on);
      li.querySelector('.card-head').setAttribute('aria-expanded', String(on));
      li.querySelector('.card-body').hidden = !on;
    }
    this.refreshToggles();
    requestAnimationFrame(() => {
      this.layoutRail();
      const li = this.items.get(id);
      const box = this.track.closest('#panel');
      if (li && box) {
        const top = li.offsetTop - 24;
        box.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    });
  }

  refreshToggles() {
    for (const b of this.list.querySelectorAll('.chip[data-action]')) {
      b.setAttribute('aria-pressed', String(this.isOn(b.dataset.action)));
    }
  }

  /** Позиции точек карточек по вертикали (центр заголовка) */
  layoutRail() {
    this.dots = this.cards.map((c) => {
      const li = this.items.get(c.id);
      const head = li.querySelector('.card-head');
      const cy = head.offsetTop + head.offsetHeight / 2;
      li.querySelector('.card-dot').style.top = `${cy}px`;
      return li.offsetTop + cy;
    });
    if (!this.dots.length) return;
    this.rail.style.top = `${this.dots[0]}px`;
    this.rail.style.height = `${this.dots[this.dots.length - 1] - this.dots[0]}px`;
  }

  /** Живой маркер: логарифм расстояния камеры, интерполированный между карточками */
  updateMarker(logDist) {
    const L = this.logs, Y = this.dots;
    if (!Y.length) return;
    let y;
    if (logDist >= L[0]) y = Y[0];
    else if (logDist <= L[L.length - 1]) y = Y[Y.length - 1];
    else {
      for (let i = 0; i < L.length - 1; i++) {
        if (logDist <= L[i] && logDist >= L[i + 1]) {
          y = Y[i] + ((Y[i + 1] - Y[i]) * (L[i] - logDist)) / (L[i] - L[i + 1]);
          break;
        }
      }
    }
    this.marker.style.transform = `translateY(${y}px)`;
  }
}
