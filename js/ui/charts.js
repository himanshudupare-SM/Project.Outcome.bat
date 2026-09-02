/* Chart primitives: tooltip, sparkline (SVG), stacked state bar (HTML).
 * Specs follow the dashboard mark rules: 2px lines, >=8px markers with a
 * surface ring, 2px surface gaps between stacked segments, recessive chrome,
 * text in text tokens (never the series color). */
(function (global) {
  const OEE = (global.OEE = global.OEE || {});
  const { el, clear, esc } = OEE.fmt;

  const COLORS = {
    surface: '#1a1a19',
    line: '#898781',
    grid: '#2c2c2a',
    accent: '#3987e5',
    ink2: '#c3c2b7',
    muted: '#898781'
  };

  /* ---------- tooltip ---------- */

  const tooltip = {
    node: null,
    ensure() {
      if (!this.node) this.node = document.getElementById('tooltip');
      return this.node;
    },
    show(html, x, y) {
      const n = this.ensure();
      n.innerHTML = html;
      n.hidden = false;
      const rect = n.getBoundingClientRect();
      const px = Math.min(x + 14, window.innerWidth - rect.width - 10);
      const py = Math.max(8, y - rect.height - 12);
      n.style.left = px + 'px';
      n.style.top = py + 'px';
    },
    hide() {
      const n = this.ensure();
      n.hidden = true;
    }
  };

  /* ---------- sparkline ---------- */

  function sparkline(container, points, opts) {
    opts = opts || {};
    const W = 300, H = opts.height || 56, PAD = 6;
    const min = 0, max = 100;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', opts.ariaLabel || 'trend');
    svg.style.height = H + 'px';

    const x = (i) => PAD + (i * (W - 2 * PAD)) / Math.max(1, points.length - 1);
    const y = (v) => H - PAD - ((v - min) * (H - 2 * PAD)) / (max - min);

    // hairline midline for orientation (50%)
    const mid = document.createElementNS(svgNS, 'line');
    mid.setAttribute('x1', PAD); mid.setAttribute('x2', W - PAD);
    mid.setAttribute('y1', y(50)); mid.setAttribute('y2', y(50));
    mid.setAttribute('stroke', COLORS.grid); mid.setAttribute('stroke-width', '1');
    svg.appendChild(mid);

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(''));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', COLORS.line);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);

    // current point: accent dot with surface ring
    const last = points.length - 1;
    const ring = document.createElementNS(svgNS, 'circle');
    ring.setAttribute('cx', x(last)); ring.setAttribute('cy', y(points[last].value));
    ring.setAttribute('r', '6'); ring.setAttribute('fill', COLORS.surface);
    svg.appendChild(ring);
    const dot = document.createElementNS(svgNS, 'circle');
    dot.setAttribute('cx', x(last)); dot.setAttribute('cy', y(points[last].value));
    dot.setAttribute('r', '4'); dot.setAttribute('fill', opts.accent || COLORS.accent);
    svg.appendChild(dot);

    // hover crosshair + tooltip (nearest point)
    const cross = document.createElementNS(svgNS, 'line');
    cross.setAttribute('stroke', COLORS.line);
    cross.setAttribute('stroke-width', '1');
    cross.setAttribute('y1', PAD); cross.setAttribute('y2', H - PAD);
    cross.setAttribute('opacity', '0');
    svg.appendChild(cross);
    const hoverDot = document.createElementNS(svgNS, 'circle');
    hoverDot.setAttribute('r', '4'); hoverDot.setAttribute('fill', opts.accent || COLORS.accent);
    hoverDot.setAttribute('stroke', COLORS.surface); hoverDot.setAttribute('stroke-width', '2');
    hoverDot.setAttribute('opacity', '0');
    svg.appendChild(hoverDot);

    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const relX = ((e.clientX - rect.left) / rect.width) * W;
      let idx = 0, bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = Math.abs(x(i) - relX);
        if (d < bestD) { bestD = d; idx = i; }
      }
      cross.setAttribute('x1', x(idx)); cross.setAttribute('x2', x(idx));
      cross.setAttribute('opacity', '1');
      hoverDot.setAttribute('cx', x(idx)); hoverDot.setAttribute('cy', y(points[idx].value));
      hoverDot.setAttribute('opacity', '1');
      tooltip.show(
        `<div class="tt-title">${esc(points[idx].label)}</div>` +
        `<div class="tt-row"><span>${esc(opts.seriesName || 'Confidence')}</span><span class="v">${points[idx].value}%</span></div>`,
        e.clientX, e.clientY
      );
    });
    svg.addEventListener('mouseleave', () => {
      cross.setAttribute('opacity', '0');
      hoverDot.setAttribute('opacity', '0');
      tooltip.hide();
    });

    container.appendChild(svg);
    return svg;
  }

  /* ---------- stacked horizontal state bar (HTML) ---------- */

  function stackedBar(container, segments, opts) {
    opts = opts || {};
    const total = segments.reduce((s, x) => s + x.value, 0);
    const bar = el('div', {
      style:
        `display:flex;gap:2px;height:${opts.height || 18}px;border-radius:4px;overflow:hidden;` +
        `background:transparent;`
    });
    for (const seg of segments) {
      if (seg.value <= 0) continue;
      const pct = (100 * seg.value) / total;
      const cell = el('div', {
        style:
          `flex:${seg.value} ${seg.value} 0;min-width:3px;background:${seg.color};` +
          `display:flex;align-items:center;justify-content:center;overflow:visible;`,
        tabindex: '0',
        role: 'img',
        'aria-label': `${seg.label}: ${seg.value} working days (${Math.round(pct)}%)`
      });
      // direct label only where it comfortably fits (>=18% of the bar)
      if (pct >= 18 && (opts.labels !== false)) {
        cell.appendChild(
          el('span', {
            style: 'font-size:10.5px;font-weight:600;color:#0d0d0d;white-space:nowrap;',
            html: `${Math.round(pct)}%`
          })
        );
      }
      const html =
        `<div class="tt-title">${esc(opts.title || '')}</div>` +
        `<div class="tt-row"><span>${esc(seg.label)}</span><span class="v">${seg.value} wd</span></div>` +
        `<div class="tt-row"><span>share</span><span class="v">${Math.round(pct)}%</span></div>`;
      cell.addEventListener('mousemove', (e) => tooltip.show(html, e.clientX, e.clientY));
      cell.addEventListener('mouseleave', () => tooltip.hide());
      bar.appendChild(cell);
    }
    container.appendChild(bar);
    return bar;
  }

  OEE.charts = { tooltip, sparkline, stackedBar, COLORS };
})(typeof window !== 'undefined' ? window : globalThis);
