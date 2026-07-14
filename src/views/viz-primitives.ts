interface SparklineOptions {
  width: number;
  height: number;
  target?: number;
  container: HTMLElement;
}

export function renderSparkline(data: number[], options: SparklineOptions): void {
  const svg = options.container.createSvg('svg');
  svg.setAttr('width', options.width);
  svg.setAttr('height', options.height);
  svg.setAttr('viewBox', `0 0 ${options.width} ${options.height}`);
  svg.setAttr('preserveAspectRatio', 'none');

  if (data.length === 0) return;

  const maxVal = Math.max(...data);
  const minVal = Math.min(...data);

  const points = data.map((value, i) => {
    const x = (i / (data.length - 1)) * options.width;
    const y = options.height - ((value - minVal) / (maxVal - minVal)) * options.height;
    return `${x},${y}`;
  }).join(' ');

  const polyline = svg.createSvg('polyline');
  polyline.setAttr('points', points);
  polyline.setAttr('fill', 'none');
  polyline.setAttr('stroke', 'var(--text-normal)');
  polyline.setAttr('stroke-width', '1');

  if (options.target !== undefined) {
    const targetY = options.height - ((options.target - minVal) / (maxVal - minVal)) * options.height;
    const targetLine = svg.createSvg('line');
    targetLine.setAttr('x1', '0');
    targetLine.setAttr('y1', targetY);
    targetLine.setAttr('x2', options.width);
    targetLine.setAttr('y2', targetY);
    targetLine.setAttr('stroke', 'var(--text-faint)');
    targetLine.setAttr('stroke-dasharray', '2,2');
    targetLine.setAttr('stroke-width', '0.5');
  }
}

interface PosteriorBandOptions {
  width: number;
  container: HTMLElement;
}

export function renderPosteriorBand(alpha: number, beta: number, options: PosteriorBandOptions): void {
  const svg = options.container.createSvg('svg');
  svg.setAttr('width', options.width);
  svg.setAttr('height', '10'); // Fixed height for posterior band
  svg.setAttr('viewBox', `0 0 ${options.width} 10`);

  const total = alpha + beta;
  if (total === 0) return; // Avoid division by zero

  const mean = alpha / total;
  // For simplicity, let's just render the mean with a certain width for now
  // More complex rendering, e.g., using Beta distribution CDF for credible intervals, can be added later

  const rect = svg.createSvg('rect');
  rect.setAttr('x', mean * options.width - 1); // Center the line on the mean estimate
  rect.setAttr('y', '0');
  rect.setAttr('width', '2'); // Fixed width for the mean indicator
  rect.setAttr('height', '10');
  rect.setAttr('fill', 'var(--interactive-success)');
}
