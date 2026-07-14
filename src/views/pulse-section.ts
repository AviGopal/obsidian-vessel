import { renderSparkline, renderPosteriorBand } from "./viz-primitives";

export interface PulseData {
  settlements: { reached: boolean; t: number }[];
  gapsOpen: number;
  gapsClosed24h: number;
  oldestGapDays: number;
  rhythms: { family: string; staleness: number; budget: number; alpha: number; beta: number }[];
}

export function renderPulseSection(container: HTMLElement, data: PulseData): void {
  container.empty();

  const createEl = <K extends keyof HTMLElementTagNameMap>(tag: K, classNames?: string[], parent?: HTMLElement): HTMLElementTagNameMap[K] => {
    const el = container.createEl(tag, { cls: classNames?.join(' ') });
    if (parent) parent.appendChild(el);
    return el;
  };

  const section = createEl("div", ["pulse-section"]); // Assuming a main section class

  // Tiles
  const tilesDiv = createEl("div", ["sub-pulse-tiles"], section);

  // Reach tile
  const reachTile = createEl("div", ["sub-stat-tile"], tilesDiv);
  const last10Settlements = data.settlements.slice(-10);
  const reachedCount = last10Settlements.filter(s => s.reached).length;
  createEl("div", [], reachTile).setText(`${reachedCount}`);
  createEl("div", [], reachTile).setText("reached");

  const rollingReach = data.settlements.map((_, i, arr) => {
    const slice = arr.slice(Math.max(0, i - 9), i + 1);
    return slice.filter(s => s.reached).length / slice.length;
  });
  const sparklineDiv = createEl("div", ["sparkline-container"], reachTile);
  renderSparkline(rollingReach, { width: 120, height: 28, target: 0.9, container: sparklineDiv });

  // Gaps open tile
  const gapsOpenTile = createEl("div", ["sub-stat-tile"], tilesDiv);
  createEl("div", [], gapsOpenTile).setText(`${data.gapsOpen}`);
  createEl("div", [], gapsOpenTile).setText("open gaps");
  createEl("div", [], gapsOpenTile).setText(`${data.gapsClosed24h} closed 24h`);

  // Oldest gap tile
  const oldestGapTile = createEl("div", ["sub-stat-tile"], tilesDiv);
  createEl("div", [], oldestGapTile).setText(`${data.oldestGapDays}d`);
  createEl("div", [], oldestGapTile).setText("oldest gap");

  // Rhythms
  data.rhythms.forEach(rhythm => {
    const rhythmRow = createEl("div", ["sub-rhythm-row"], section);
    createEl("span", [], rhythmRow).setText(rhythm.family);
    const meterBg = createEl("div", ["sub-rhythm-meter-bg"], rhythmRow);
    const meter = createEl("div", ["sub-rhythm-meter"], meterBg);
    meter.style.width = (rhythm.staleness * 100) + "%";
    const posteriorBandDiv = createEl("div", ["posterior-band-container"], rhythmRow);
    renderPosteriorBand(rhythm.alpha, rhythm.beta, { width: 60, container: posteriorBandDiv });
  });

  // Why sentence
  const whySentence = createEl("div", ["why-sentence"], section);
  const allSettlements = data.settlements;
  if (allSettlements.length >= 20) {
    const last10Reach = allSettlements.slice(-10).filter(s => s.reached).length;
    const prev10Reach = allSettlements.slice(-20, -10).filter(s => s.reached).length;

    const meanLast10 = last10Reach / 10;
    const meanPrev10 = prev10Reach / 10;

    if (meanLast10 < meanPrev10) {
      whySentence.setText(`reach falling — ${10 - last10Reach} of last 10 settlements failed`);
    } else if (meanLast10 > meanPrev10) {
      whySentence.setText(`reach rising — ${last10Reach} of last 10 reached`);
    } else {
      whySentence.setText("reach steady");
    }
  } else {
    whySentence.setText("Not enough data to determine reach trend."); // Fallback for insufficient data
  }
}
