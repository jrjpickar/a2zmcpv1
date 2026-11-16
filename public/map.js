const stations = [
  { key: 'leads', x: -4.5, z: -3.6, color: '#7bad9a' },
  { key: 'proposals', x: -0.9, z: -4.7, color: '#9bb4c5' },
  { key: 'wins', x: 3.7, z: -4.1, color: '#cfad74' },
  { key: 'labor', x: 5.5, z: -0.8, color: '#dc8c60' },
  { key: 'containers', x: 3.9, z: 3.9, color: '#bd9968' },
  { key: 'workforce', x: 0, z: 5.15, color: '#8da18a' },
  { key: 'runway', x: -3.8, z: 3.55, color: '#8bac98' },
  { key: 'system', x: -5.7, z: .1, color: '#b5ac94' },
];

export function setupMap(canvas, labels, select) {
  const context = canvas.getContext('2d');
  if (!context) return { update() {}, reset() {} };
  let angle = -.48;
  let tiles = [];
  let drag;
  const buttons = new Map();
  for (const { key } of stations) {
    const button = document.createElement('button');
    button.className = 'station';
    button.type = 'button';
    button.addEventListener('click', () => select(key));
    labels.append(button);
    buttons.set(key, button);
  }

  function render() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.scale(dpr, dpr);
    const scale = Math.min(width / 17, height / 10.5);
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const depth = (x, z) => x * sin + z * cos;
    const project = (x, y, z) => [width / 2 + (x * cos - z * sin) * scale, height * .56 + (depth(x, z) * .44 - y) * scale];
    function polygon(points, color, edge) {
      context.beginPath();
      for (const [i, point] of points.entries()) {
        const [x, y] = project(...point);
        if (i) context.lineTo(x, y);
        else context.moveTo(x, y);
      }
      context.closePath();
      context.fillStyle = color;
      context.fill();
      if (edge) { context.strokeStyle = edge; context.stroke(); }
    }
    function block(x, z, radius, tall, color) {
      const base = [[x-radius, z-radius], [x+radius, z-radius], [x+radius, z+radius], [x-radius, z+radius]];
      const edges = base.map((a, i) => [a, base[(i+1) % 4]]).sort((a, b) =>
        depth(...a[0]) + depth(...a[1]) - depth(...b[0]) - depth(...b[1]));
      for (const [a, b] of edges) {
        polygon([[a[0],0,a[1]], [b[0],0,b[1]], [b[0],tall,b[1]], [a[0],tall,a[1]]], color + '86', '#181c17');
      }
      polygon(base.map(([bx, bz]) => [bx, tall, bz]), color, '#272e26');
    }
    polygon([[-7,0,-6.4], [7,0,-6.4], [7,0,6.4], [-7,0,6.4]], '#262e26', '#566153');
    for (let i = -6; i < 7; i++) {
      polygon([[i,0,-6], [i+.013,0,-6], [i+.013,0,6], [i,0,6]], '#515b4c');
      polygon([[-7,0,i], [7,0,i], [7,0,i+.013], [-7,0,i+.013]], '#515b4c');
    }
    for (const { x, z, color } of stations) {
      polygon([[0,0,0], [x,0,z], [x+.09,0,z+.1], [.09,0,.1]], color + 'b3');
    }
    const structures = [...stations, { x: 0, z: 0, color: '#edb475', key: 'core' }]
      .sort((a, b) => depth(a.x, a.z) - depth(b.x, b.z));
    const labelPositions = [];
    for (const { key, x, z, color } of structures) {
      const core = key === 'core';
      const tile = tiles.find(item => item.key === key);
      const tall = core ? 2.35 : tile?.value === '—' ? .35 : 1.5;
      block(x, z, core ? 1.28 : .85, .19, '#455246');
      block(x, z, core ? .83 : .53, tall, color);
      if (core) {
        polygon([[-.83,tall,-.83], [.83,tall,-.83], [0,tall+1.05,0]], '#ffe2af');
        polygon([[.83,tall,.83], [-.83,tall,.83], [0,tall+1.05,0]], '#d99350');
        polygon([[-.83,tall,.83], [-.83,tall,-.83], [0,tall+1.05,0]], '#fbc88b');
        continue;
      }
      const point = project(x, tall + .38, z);
      labelPositions.push({ key, x: point[0], y: point[1] });
    }
    // Give buttons room when two stations align during rotation.
    const placed = [];
    for (const point of labelPositions.sort((a, b) => a.y - b.y)) {
      const button = buttons.get(point.key);
      const half = button.offsetWidth / 2;
      const x = Math.min(width - half - 4, Math.max(half + 4, point.x));
      let y = point.y;
      while (placed.some(p => Math.abs(p.x - x) < p.half + half + 4 && Math.abs(p.y - y) < 27)) y += 28;
      button.style.left = x + 'px';
      button.style.top = y + 'px';
      placed.push({ x, y, half });
    }
  }

  canvas.addEventListener('pointerdown', event => {
    drag = { x: event.clientX, angle };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    angle = drag.angle + (event.clientX - drag.x) / 160;
    render();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, () => { drag = null; });
  new ResizeObserver(render).observe(canvas);
  return {
    update(next, selected) {
      tiles = next;
      for (const { key, short } of tiles) {
        const button = buttons.get(key);
        button.textContent = short;
        button.setAttribute('aria-pressed', String(key === selected));
      }
      render();
    },
    reset() { angle = -.48; render(); },
  };
}
