// HTML-подписи объектов, проецируемые из 3D-сцены.
export class Labels {
  constructor(root) {
    this.root = root;
    this.pool = [];
  }
  update(items, project, w, h) {
    const panel = document.querySelector('#panel')?.getBoundingClientRect();
    let n = 0;
    for (const it of items) {
      const p = project(it.pos);
      if (!p || p.x < 8 || p.y < 8 || p.x > w - 8 || p.y > h - 8) continue;
      if (panel && p.x > panel.left && p.x < panel.right && p.y > panel.top && p.y < panel.bottom) continue;
      let el = this.pool[n];
      if (!el) {
        el = document.createElement('div');
        el.className = 'label';
        this.root.appendChild(el);
        this.pool.push(el);
      }
      if (el.textContent !== it.name) el.textContent = it.name;
      el.dataset.kind = it.kind;
      el.style.opacity = Math.min(1, it.vis).toFixed(2);
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      el.hidden = false;
      n++;
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].hidden = true;
  }
}
