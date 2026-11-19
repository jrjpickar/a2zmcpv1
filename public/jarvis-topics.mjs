import { frames } from './animation-frame.mjs';
import { topicFor } from './topic-rules.mjs';
export { topicFor };

export function mountTopics(container, select) {
  const canvas = document.createElement('canvas');
  canvas.width = 680;
  canvas.height = 220;
  canvas.setAttribute('aria-hidden', 'true');
  const controls = document.createElement('div');
  controls.className = 'jarvis-topic-controls';
  container.append(canvas, controls);
  const context = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const started = new Map();
  let topics = [], points = [], active = '', frame = 0;

  function draw(now) {
    frame = 0;
    if (!context || document.hidden || !container.getClientRects().length) return;
    context.clearRect(0, 0, 680, 220);
    context.lineWidth = 1;
    for (const [radius, height] of [[52, 26], [68, 36]]) {
      context.beginPath();
      context.ellipse(340, 106, radius, height, -.25, 0, Math.PI * 2);
      context.strokeStyle = '#246297';
      context.stroke();
    }
    const sphere = (x, y, r, color) => {
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      context.strokeStyle = '#69dcff';
      context.stroke();
    };
    const pulse = motion.matches ? 0 : Math.sin(now / 900) * 3;
    sphere(340, 106, 35 + pulse, '#195480');
    context.font = '14px monospace';
    context.textAlign = 'center';
    context.fillStyle = '#e6f9ff';
    context.fillText('JARVIS', 340, 111);
    points = topics.map(([label, count], index) => {
      const angle = (index / topics.length) * Math.PI * 2;
      const x = 340 + Math.cos(angle) * 245;
      const y = 106 + Math.sin(angle) * 65;
      const progress = motion.matches ? 1 : Math.min(1, (now - started.get(label)) / 250);
      const r = (12 + Math.min(14, Math.sqrt(count) * 3)) * Math.max(.1, progress);
      sphere(x, y, r, active === label ? '#1c7ba1' : '#102f51');
      context.fillStyle = '#bbebff';
      context.fillText(label, x, y + r + 14);
      return { x, y, r, label, count };
    });
    if (!motion.matches) frame = frames.request(draw);
  }

  function resume() {
    if (frame) frames.cancel(frame);
    frame = document.hidden ? 0 : frames.request(draw);
  }

  function hit(event) {
    const bounds = canvas.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * 680 / bounds.width;
    const y = (event.clientY - bounds.top) * 220 / bounds.height;
    return points.find(point => Math.hypot(x - point.x, y - point.y) <= point.r + 5);
  }
  canvas.onpointermove = event => {
    const point = hit(event);
    canvas.title = point ? point.label + ' (' + point.count + ' chats)' : '';
  };
  canvas.onclick = event => {
    const point = hit(event);
    if (point) select(active === point.label ? '' : point.label);
  };
  document.addEventListener('visibilitychange', resume);
  return {
    update(threads, filter) {
      active = filter;
      const counts = new Map();
      for (const thread of threads) {
        const topic = thread.topic || topicFor(thread.title);
        counts.set(topic, (counts.get(topic) || 0) + 1);
      }
      topics = [...counts].sort(([a], [b]) => a.localeCompare(b));
      for (const label of started.keys()) if (!counts.has(label)) started.delete(label);
      for (const [label] of topics) if (!started.has(label)) started.set(label, performance.now());
      controls.replaceChildren(...[['', threads.length], ...topics].map(([label, count]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = (label || 'All chats') + ' (' + count + ')';
        button.setAttribute('aria-pressed', String(active === label));
        button.onclick = () => select(label);
        return button;
      }));
      resume();
    },
  };
}
