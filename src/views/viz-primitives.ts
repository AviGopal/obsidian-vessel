// viz-primitives.ts — pure SVG visualization primitives for the dispatch panel.
// No imports, no Obsidian APIs, no side effects.

const SVG_NS = "http://www.w3.org/2000/svg";

function makeSvg(width: number, height: number, label: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  return svg;
}

function title(svg: SVGSVGElement, text: string): void {
  const t = document.createElementNS(SVG_NS, "title");
  t.textContent = text;
  svg.insertBefore(t, svg.firstChild);
}

function titleEl(text: string): SVGTitleElement {
  const t = document.createElementNS(SVG_NS, "title") as SVGTitleElement;
  t.textContent = text;
  return t;
}

// ── 1. renderSparkline ────────────────────────────────────────────────────────

export function renderSparkline(
  values: number[],
  opts: { width?: number; height?: number; target?: number }
): SVGSVGElement {
  const w = opts.width ?? 120;
  const h = opts.height ?? 32;
  const pad = 4;
  const label = `Sparkline of ${values.length} values` +
    (opts.target !== undefined ? `, target ${opts.target}` : "");
  const svg = makeSvg(w, h, label);
  title(svg, label);

  if (values.length === 0) return svg;

  const xOf = (i: number): number => pad + (i / Math.max(values.length - 1, 1)) * (w - pad * 2);
  // Map value to [0,1] range, then to y-coordinate.
  // Assumes values are already normalized between 0 and 1.
  const yOf = (v: number) => (h - pad) - v * (h - pad * 2);

  // Area fill
  const areaPoints: string[] = [];
  areaPoints.push(`${xOf(0)},${h - pad}`);
  values.forEach((v, i) => areaPoints.push(`${xOf(i)},${yOf(v)}`));
  areaPoints.push(`${xOf(values.length - 1)},${h - pad}`);

  const area = document.createElementNS(SVG_NS, "polygon");
  area.setAttribute("points", areaPoints.join(" "));
  area.setAttribute("fill", "var(--sub-accent)");
  area.setAttribute("opacity", "0.15");
  svg.appendChild(area);

  // Polyline
  const pts = values.map((v, i) => `${xOf(i)},${yOf(v)}`).join(" ");
  const line = document.createElementNS(SVG_NS, "polyline");
  line.setAttribute("points", pts);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--sub-accent)");
  line.setAttribute("stroke-width", "2");
  svg.appendChild(line);

  // Target hairline
  if (opts.target !== undefined) {
    const ty = yOf(opts.target);
    const dash = document.createElementNS(SVG_NS, "line");
    dash.setAttribute("x1", String(pad));
    dash.setAttribute("y1", String(ty));
    dash.setAttribute("x2", String(w - pad));
    dash.setAttribute("y2", String(ty));
    dash.setAttribute("stroke", "var(--text-muted)");
    dash.setAttribute("stroke-width", "1");
    dash.setAttribute("stroke-dasharray", "3 3");
    dash.appendChild(titleEl(`target: ${opts.target}`));
    svg.appendChild(dash);
  }

  // Endpoint dot
  const last = values[values.length - 1]!;
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(xOf(values.length - 1)));
  dot.setAttribute("cy", String(yOf(last)));
  dot.setAttribute("r", "3");
  dot.setAttribute("fill", "var(--sub-accent)");
  dot.appendChild(titleEl(`last: ${last}`));
  svg.appendChild(dot);

  return svg;
}

// ── 2. renderPosteriorBand ───────────────────────────────────────────────────

export function renderPosteriorBand(
  alpha: number,
  beta: number,
  opts?: { width?: number }
): SVGSVGElement {
  const w = opts?.width ?? 200;
  const h = 24;
  const pad = 8;
  const mean = alpha / (alpha + beta);
  const evidence = alpha + beta;
  const se = Math.sqrt((mean * (1 - mean)) / (evidence + 1));
  const lo = Math.max(0, mean - 1.645 * se);
  const hi = Math.min(1, mean + 1.645 * se);
  const dotR = Math.min(6, Math.max(2, Math.log(evidence + 1)));

  const label = `Posterior band: mean=${mean.toFixed(2)}, 90% CI [${lo.toFixed(2)}, ${hi.toFixed(2)}]`;
  const svg = makeSvg(w, h, label);
  title(svg, label);

  const trackY = h / 2;
  const xOf = (v: number): number => pad + v * (w - pad * 2);

  // Track
  const track = document.createElementNS(SVG_NS, "line");
  track.setAttribute("x1", String(pad));
  track.setAttribute("y1", String(trackY));
  track.setAttribute("x2", String(w - pad));
  track.setAttribute("y2", String(trackY));
  track.setAttribute("stroke", "var(--background-modifier-border)");
  track.setAttribute("stroke-width", "4");
  track.setAttribute("stroke-linecap", "round");
  svg.appendChild(track);

  // Band
  const band = document.createElementNS(SVG_NS, "rect");
  band.setAttribute("x", String(xOf(lo)));
  band.setAttribute("y", String(trackY - 4));
  band.setAttribute("width", String(xOf(hi) - xOf(lo)));
  band.setAttribute("height", "8");
  band.setAttribute("fill", "var(--sub-accent)");
  band.setAttribute("opacity", "0.4");
  band.appendChild(titleEl(`90% CI: [${lo.toFixed(3)}, ${hi.toFixed(3)}]`));
  svg.appendChild(band);

  // Mean dot
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(xOf(mean)));
  dot.setAttribute("cy", String(trackY));
  dot.setAttribute("r", String(dotR));
  dot.setAttribute("fill", "var(--sub-accent)");
  dot.appendChild(titleEl(`mean: ${mean.toFixed(3)}, n=${evidence}`));
  svg.appendChild(dot);

  return svg;
}

// ── 3. renderDotMatrix ───────────────────────────────────────────────────────

export function renderDotMatrix(
  rows: { label: string; cells: number[] }[],
  opts?: { maxRadius?: number }
): SVGSVGElement {
  const maxR = opts?.maxRadius ?? 10;
  const cellW = maxR * 2 + 8;
  const cellH = maxR * 2 + 8;
  const labelW = 64;
  const cols = rows.length > 0 ? Math.max(...rows.map(r => r.cells.length)) : 0;
  const w = labelW + cols * cellW;
  const h = rows.length * cellH + 4;

  const allCounts = rows.flatMap(r => r.cells);
  const maxCount = allCounts.length > 0 ? Math.max(...allCounts) : 1;

  const label = `Dot matrix: ${rows.length} rows x ${cols} columns`;
  const svg = makeSvg(w, h, label);
  title(svg, label);

  rows.forEach((row, ri) => {
    const cy = (ri + 0.5) * cellH + 4;

    // Row label
    const txt = document.createElementNS(SVG_NS, "text");
    txt.setAttribute("x", String(labelW - 4));
    txt.setAttribute("y", String(cy + 4));
    txt.setAttribute("text-anchor", "end");
    txt.setAttribute("font-size", "10");
    txt.setAttribute("fill", "var(--text-muted)");
    txt.textContent = row.label;
    svg.appendChild(txt);

    row.cells.forEach((count, ci) => {
      const cx = labelW + (ci + 0.5) * cellW;
      const r = count === 0 ? 1 : Math.sqrt(count / maxCount) * maxR;
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", String(r));
      if (count === 0) {
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", "var(--background-modifier-border)");
        circle.setAttribute("stroke-width", "1");
        circle.setAttribute("opacity", "0.4");
      } else {
        circle.setAttribute("fill", "var(--sub-accent)");
      }
      circle.appendChild(titleEl(`${row.label} col ${ci + 1}: ${count}`));
      svg.appendChild(circle);
    });
  });

  return svg;
}

// ── 4. renderTickLane ────────────────────────────────────────────────────────

export function renderTickLane(
  events: { t: number; kind: "ok" | "fail" | "neutral" }[],
  opts: { t0: number; t1: number; width?: number; height?: number }
): SVGSVGElement {
  const w = opts.width ?? 200;
  const h = opts.height ?? 20;
  const pad = 4;
  const span = opts.t1 - opts.t0 || 1;
  const baseY = h / 2;

  const colorOf = (kind: "ok" | "fail" | "neutral"): string => {
    if (kind === "ok") return "var(--sub-ok)";
    if (kind === "fail") return "var(--sub-fail)";
    return "var(--sub-warn)";
  };

  const label = `Tick lane: ${events.length} events from t=${opts.t0} to t=${opts.t1}`;
  const svg = makeSvg(w, h, label);
  title(svg, label);

  // Baseline
  const base = document.createElementNS(SVG_NS, "line");
  base.setAttribute("x1", String(pad));
  base.setAttribute("y1", String(baseY));
  base.setAttribute("x2", String(w - pad));
  base.setAttribute("y2", String(baseY));
  base.setAttribute("stroke", "var(--background-modifier-border)");
  base.setAttribute("stroke-width", "1");
  svg.appendChild(base);

  // Ticks
  events.forEach(ev => {
    const x = pad + ((ev.t - opts.t0) / span) * (w - pad * 2);
    const tick = document.createElementNS(SVG_NS, "line");
    tick.setAttribute("x1", String(x));
    tick.setAttribute("y1", String(baseY - 4));
    tick.setAttribute("x2", String(x));
    tick.setAttribute("y2", String(baseY + 4));
    tick.setAttribute("stroke", colorOf(ev.kind));
    tick.setAttribute("stroke-width", "2");
    tick.appendChild(titleEl(`t=${ev.t} kind=${ev.kind}`));
    svg.appendChild(tick);
  });

  return svg;
}
