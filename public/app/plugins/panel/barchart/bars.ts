import uPlot, { Axis, AlignedData, Scale } from 'uplot';
import { intersects, pointWithin, Quadtree, Rect } from './quadtree';
import { distribute, SPACE_BETWEEN } from './distribute';
import { DataFrame, GrafanaTheme2 } from '@grafana/data';
import { measureText, PlotTooltipInterpolator } from '@grafana/ui';
import {
  StackingMode,
  VisibilityMode,
  ScaleDirection,
  ScaleOrientation,
  VizTextDisplayOptions,
  VizLegendOptions,
} from '@grafana/schema';
import { preparePlotData } from '../../../../../packages/grafana-ui/src/components/uPlot/utils';
import { alpha } from '@grafana/data/src/themes/colorManipulator';
import { formatTime } from '@grafana/ui/src/components/uPlot/config/UPlotAxisBuilder';

const groupDistr = SPACE_BETWEEN;
const barDistr = SPACE_BETWEEN;
// min.max font size for value label
const VALUE_MIN_FONT_SIZE = 8;
const VALUE_MAX_FONT_SIZE = 30;
// % of width/height of the bar that value should fit in when measuring size
const BAR_FONT_SIZE_RATIO = 0.65;
// distance between label and a bar in % of bar width
const LABEL_OFFSET_FACTOR_VT = 0.1;
const LABEL_OFFSET_FACTOR_HZ = 0.15;
// max distance
const LABEL_OFFSET_MAX_VT = 5;
const LABEL_OFFSET_MAX_HZ = 10;

// text baseline middle runs through the middle of lowercase letters
// since bar values are numbers and uppercase-like, we want the middle of uppercase
// this is a cheap fudge factor that skips expensive and inconsistent cross-browser measuring
const MIDDLE_BASELINE_SHIFT = 0.1;

/**
 * @internal
 */
export interface BarsOptions {
  xOri: ScaleOrientation;
  xDir: ScaleDirection;
  groupWidth: number;
  barWidth: number;
  barRadius: number;
  showValue: VisibilityMode;
  stacking: StackingMode;
  rawValue: (seriesIdx: number, valueIdx: number) => number | null;
  getColor?: (seriesIdx: number, valueIdx: number, value: any) => string | null;
  fillOpacity?: number;
  formatValue: (seriesIdx: number, value: any) => string;
  text?: VizTextDisplayOptions;
  onHover?: (seriesIdx: number, valueIdx: number) => void;
  onLeave?: (seriesIdx: number, valueIdx: number) => void;
  legend?: VizLegendOptions;
  xSpacing?: number;
  xTimeAuto?: boolean;
}

/**
 * @internal
 */
interface ValueLabelTable {
  [index: number]: ValueLabelArray;
}

/**
 * @internal
 */
interface ValueLabelArray {
  [index: number]: ValueLabel;
}

/**
 * @internal
 */
interface ValueLabel {
  text: string;
  value: number | null;
  hidden: boolean;
  bbox?: Rect;
  textMetrics?: TextMetrics;
  x?: number;
  y?: number;
}

/**
 * @internal
 */
function calculateFontSizeWithMetrics(
  text: string,
  width: number,
  height: number,
  lineHeight: number,
  maxSize?: number
) {
  // calculate width in 14px
  const textSize = measureText(text, 14);
  // how much bigger than 14px can we make it while staying within our width constraints
  const fontSizeBasedOnWidth = (width / (textSize.width + 2)) * 14;
  const fontSizeBasedOnHeight = height / lineHeight;

  // final fontSize
  const optimalSize = Math.min(fontSizeBasedOnHeight, fontSizeBasedOnWidth);
  return {
    fontSize: Math.min(optimalSize, maxSize ?? optimalSize),
    textMetrics: textSize,
  };
}

/**
 * @internal
 */
export function getConfig(opts: BarsOptions, theme: GrafanaTheme2) {
  const { xOri, xDir: dir, rawValue, getColor, formatValue, fillOpacity = 1, showValue, xSpacing = 0 } = opts;
  const isXHorizontal = xOri === ScaleOrientation.Horizontal;
  const hasAutoValueSize = !Boolean(opts.text?.valueSize);
  const isStacked = opts.stacking !== StackingMode.None;
  const pctStacked = opts.stacking === StackingMode.Percent;

  let { groupWidth, barWidth, barRadius = 0 } = opts;

  if (isStacked) {
    [groupWidth, barWidth] = [barWidth, groupWidth];
  }

  let qt: Quadtree;
  let hovered: Rect | undefined = undefined;

  let barMark = document.createElement('div');
  barMark.classList.add('bar-mark');
  barMark.style.position = 'absolute';
  barMark.style.background = 'rgba(255,255,255,0.4)';

  const xSplits: Axis.Splits = (u: uPlot) => {
    const dim = isXHorizontal ? u.bbox.width : u.bbox.height;
    const _dir = dir * (isXHorizontal ? 1 : -1);

    let dataLen = u.data[0].length;
    let lastIdx = dataLen - 1;

    let skipMod = 0;

    if (xSpacing !== 0) {
      let cssDim = dim / devicePixelRatio;
      let maxTicks = Math.abs(Math.floor(cssDim / xSpacing));

      skipMod = dataLen < maxTicks ? 0 : Math.ceil(dataLen / maxTicks);
    }

    let splits: number[] = [];

    // for distr: 2 scales, the splits array should contain indices into data[0] rather than values
    u.data[0].forEach((v, i) => {
      let shouldSkip = skipMod !== 0 && (xSpacing > 0 ? i : lastIdx - i) % skipMod > 0;

      if (!shouldSkip) {
        splits.push(i);
      }
    });

    return _dir === 1 ? splits : splits.reverse();
  };

  // the splits passed into here are data[0] values looked up by the indices returned from splits()
  const xValues: Axis.Values = (u, splits, axisIdx, foundSpace, foundIncr) => {
    if (opts.xTimeAuto) {
      // bit of a hack:
      // temporarily set x scale range to temporal (as expected by formatTime()) rather than ordinal
      let xScale = u.scales.x;
      let oMin = xScale.min;
      let oMax = xScale.max;

      xScale.min = u.data[0][0];
      xScale.max = u.data[0][u.data[0].length - 1];

      let vals = formatTime(u, splits, axisIdx, foundSpace, foundIncr);

      // revert
      xScale.min = oMin;
      xScale.max = oMax;

      return vals;
    }

    return splits.map((v) => formatValue(0, v));
  };

  // this expands the distr: 2 scale so that the indicies of each data[0] land at the proper justified positions
  const xRange: Scale.Range = (u, min, max) => {
    min = 0;
    max = Math.max(1, u.data[0].length - 1);

    let pctOffset = 0;

    // how far in is the first tick in % of full dimension
    distribute(u.data[0].length, groupWidth, groupDistr, 0, (di, lftPct, widPct) => {
      pctOffset = lftPct + widPct / 2;
    });

    // expand scale range by equal amounts on both ends
    let rn = max - min;

    if (pctOffset === 0.5) {
      min -= rn;
    } else {
      let upScale = 1 / (1 - pctOffset * 2);
      let offset = (upScale * rn - rn) / 2;

      min -= offset;
      max += offset;
    }

    return [min, max];
  };

  let distrTwo = (groupCount: number, barCount: number) => {
    let out = Array.from({ length: barCount }, () => ({
      offs: Array(groupCount).fill(0),
      size: Array(groupCount).fill(0),
    }));

    distribute(groupCount, groupWidth, groupDistr, null, (groupIdx, groupOffPct, groupDimPct) => {
      distribute(barCount, barWidth, barDistr, null, (barIdx, barOffPct, barDimPct) => {
        out[barIdx].offs[groupIdx] = groupOffPct + groupDimPct * barOffPct;
        out[barIdx].size[groupIdx] = groupDimPct * barDimPct;
      });
    });

    return out;
  };

  let distrOne = (groupCount: number, barCount: number) => {
    let out = Array.from({ length: barCount }, () => ({
      offs: Array(groupCount).fill(0),
      size: Array(groupCount).fill(0),
    }));

    distribute(groupCount, groupWidth, groupDistr, null, (groupIdx, groupOffPct, groupDimPct) => {
      distribute(barCount, barWidth, barDistr, null, (barIdx, barOffPct, barDimPct) => {
        out[barIdx].offs[groupIdx] = groupOffPct;
        out[barIdx].size[groupIdx] = groupDimPct;
      });
    });

    return out;
  };

  const LABEL_OFFSET_FACTOR = isXHorizontal ? LABEL_OFFSET_FACTOR_VT : LABEL_OFFSET_FACTOR_HZ;
  const LABEL_OFFSET_MAX = isXHorizontal ? LABEL_OFFSET_MAX_VT : LABEL_OFFSET_MAX_HZ;

  let barsPctLayout: Array<null | { offs: number[]; size: number[] }> = [];
  let barsColors: Array<null | { fill: Array<string | null>; stroke: Array<string | null> }> = [];
  let scaleFactor = 1;
  let labels: ValueLabelTable = {};
  let fontSize = opts.text?.valueSize ?? VALUE_MAX_FONT_SIZE;
  let labelOffset = LABEL_OFFSET_MAX;

  // minimum available space for labels between bar end and plotting area bound (in canvas pixels)
  let vSpace = Infinity;
  let hSpace = Infinity;

  let useMappedColors = getColor != null;

  let mappedColorDisp = useMappedColors
    ? {
        fill: {
          unit: 3,
          values: (u: uPlot, seriesIdx: number) => barsColors[seriesIdx]!.fill,
        },
        stroke: {
          unit: 3,
          values: (u: uPlot, seriesIdx: number) => barsColors[seriesIdx]!.stroke,
        },
      }
    : {};

  let barsBuilder = uPlot.paths.bars!({
    radius: barRadius,
    disp: {
      x0: {
        unit: 2,
        values: (u, seriesIdx) => barsPctLayout[seriesIdx]!.offs,
      },
      size: {
        unit: 2,
        values: (u, seriesIdx) => barsPctLayout[seriesIdx]!.size,
      },
      ...mappedColorDisp,
    },
    // collect rendered bar geometry
    each: (u, seriesIdx, dataIdx, lft, top, wid, hgt) => {
      // we get back raw canvas coords (included axes & padding)
      // translate to the plotting area origin
      lft -= u.bbox.left;
      top -= u.bbox.top;

      let val = u.data[seriesIdx][dataIdx]!;
      // accum min space abvailable for labels
      if (isXHorizontal) {
        vSpace = Math.min(vSpace, val < 0 ? u.bbox.height - (top + hgt) : top);
        hSpace = wid;
      } else {
        vSpace = hgt;
        hSpace = Math.min(hSpace, val < 0 ? lft : u.bbox.width - (lft + wid));
      }

      let barRect = { x: lft, y: top, w: wid, h: hgt, sidx: seriesIdx, didx: dataIdx };
      qt.add(barRect);

      if (showValue !== VisibilityMode.Never) {
        // Format Values and calculate label offsets
        const text = formatValue(
          seriesIdx,
          rawValue(seriesIdx, dataIdx)! / (pctStacked ? alignedTotals![seriesIdx][dataIdx]! : 1)
        );
        labelOffset = Math.min(labelOffset, Math.round(LABEL_OFFSET_FACTOR * (isXHorizontal ? wid : hgt)));

        if (labels[dataIdx] === undefined) {
          labels[dataIdx] = {};
        }
        labels[dataIdx][seriesIdx] = { text: text, value: rawValue(seriesIdx, dataIdx), hidden: false };

        // Calculate font size when it's set to be automatic
        if (hasAutoValueSize) {
          const { fontSize: calculatedSize, textMetrics } = calculateFontSizeWithMetrics(
            labels[dataIdx][seriesIdx].text,
            hSpace * (isXHorizontal ? BAR_FONT_SIZE_RATIO : 1) - (isXHorizontal ? 0 : labelOffset),
            vSpace * (isXHorizontal ? 1 : BAR_FONT_SIZE_RATIO) - (isXHorizontal ? labelOffset : 0),
            1
          );

          // Save text metrics
          labels[dataIdx][seriesIdx].textMetrics = textMetrics;

          // Retrieve the new font size and use it
          let autoFontSize = Math.round(Math.min(fontSize, VALUE_MAX_FONT_SIZE, calculatedSize));

          // Calculate the scaling factor for bouding boxes
          // Take into account the fact that calculateFontSize
          // uses 14px measurement so we need to adjust the scale factor
          scaleFactor = (autoFontSize / fontSize) * (autoFontSize / 14);

          // Update the end font-size
          fontSize = autoFontSize;
        } else {
          labels[dataIdx][seriesIdx].textMetrics = measureText(labels[dataIdx][seriesIdx].text, fontSize);
        }

        let middleShift = isXHorizontal ? 0 : -Math.round(MIDDLE_BASELINE_SHIFT * fontSize);
        let value = rawValue(seriesIdx, dataIdx);

        if (value != null) {
          // Calculate final co-ordinates for text position
          const x =
            u.bbox.left + (isXHorizontal ? lft + wid / 2 : value < 0 ? lft - labelOffset : lft + wid + labelOffset);
          const y =
            u.bbox.top +
            (isXHorizontal ? (value < 0 ? top + hgt + labelOffset : top - labelOffset) : top + hgt / 2 - middleShift);

          // Retrieve textMetrics with necessary default values
          // These _shouldn't_ be undefined at this point
          // but they _could_ be.
          const {
            textMetrics = {
              width: 1,
              actualBoundingBoxAscent: 1,
              actualBoundingBoxDescent: 1,
            },
          } = labels[dataIdx][seriesIdx];

          // Adjust bounding boxes based on text scale
          // factor and orientation (which changes the baseline)
          let xAdjust = 0,
            yAdjust = 0;

          if (isXHorizontal) {
            // Adjust for baseline which is "top" in this case
            xAdjust = (textMetrics.width * scaleFactor) / 2;

            // yAdjust only matters when when the value isn't negative
            yAdjust =
              value > 0
                ? (textMetrics.actualBoundingBoxAscent + textMetrics.actualBoundingBoxDescent) * scaleFactor
                : 0;
          } else {
            // Adjust from the baseline which is "middle" in this case
            yAdjust = ((textMetrics.actualBoundingBoxAscent + textMetrics.actualBoundingBoxDescent) * scaleFactor) / 2;

            // Adjust for baseline being "right" in the x direction
            xAdjust = value < 0 ? textMetrics.width * scaleFactor : 0;
          }

          // Construct final bounding box for the label text
          labels[dataIdx][seriesIdx].x = x;
          labels[dataIdx][seriesIdx].y = y;
          labels[dataIdx][seriesIdx].bbox = {
            x: x - xAdjust,
            y: y - yAdjust,
            w: textMetrics.width * scaleFactor,
            h: (textMetrics.actualBoundingBoxAscent + textMetrics.actualBoundingBoxDescent) * scaleFactor,
          };
        }
      }
    },
  });

  const init = (u: uPlot) => {
    let over = u.over;
    over.style.overflow = 'hidden';
    over.appendChild(barMark);
  };

  // Build bars
  const drawClear = (u: uPlot) => {
    qt = qt || new Quadtree(0, 0, u.bbox.width, u.bbox.height);
    qt.clear();

    // clear the path cache to force drawBars() to rebuild new quadtree
    u.series.forEach((s) => {
      // @ts-ignore
      s._paths = null;
    });

    if (isStacked) {
      //barsPctLayout = [null as any].concat(distrOne(u.data.length - 1, u.data[0].length));
      barsPctLayout = [null as any].concat(distrOne(u.data[0].length, u.data.length - 1));
    } else {
      barsPctLayout = [null as any].concat(distrTwo(u.data[0].length, u.data.length - 1));
    }

    if (useMappedColors) {
      barsColors = [null];

      // map per-bar colors
      for (let i = 1; i < u.data.length; i++) {
        let colors = u.data[i].map((value, valueIdx) => {
          if (value != null) {
            return getColor!(i, valueIdx, value);
          }

          return null;
        });

        barsColors.push({
          fill: fillOpacity < 1 ? colors.map((c) => (c != null ? alpha(c, fillOpacity) : null)) : colors,
          stroke: colors,
        });
      }
    }

    labels = {};
    fontSize = opts.text?.valueSize ?? VALUE_MAX_FONT_SIZE;
    labelOffset = LABEL_OFFSET_MAX;
    vSpace = hSpace = Infinity;
  };

  // uPlot hook to draw the labels on the bar chart.
  const draw = (u: uPlot) => {
    if (showValue === VisibilityMode.Never || fontSize < VALUE_MIN_FONT_SIZE) {
      return;
    }

    u.ctx.save();
    u.ctx.fillStyle = theme.colors.text.primary;
    u.ctx.font = `${fontSize}px ${theme.typography.fontFamily}`;

    let curAlign: CanvasTextAlign | undefined = undefined,
      curBaseline: CanvasTextBaseline | undefined = undefined;

    for (const didx in labels) {
      for (const sidx in labels[didx]) {
        const { text, value, x = 0, y = 0, bbox = { x: 0, y: 0, w: 1, h: 1 } } = labels[didx][sidx];

        let align: CanvasTextAlign = isXHorizontal ? 'center' : value !== null && value < 0 ? 'right' : 'left';
        let baseline: CanvasTextBaseline = isXHorizontal
          ? value !== null && value < 0
            ? 'top'
            : 'alphabetic'
          : 'middle';

        if (align !== curAlign) {
          u.ctx.textAlign = curAlign = align;
        }

        if (baseline !== curBaseline) {
          u.ctx.textBaseline = curBaseline = baseline;
        }

        if (showValue === VisibilityMode.Always) {
          u.ctx.fillText(text, x, y);
        } else if (showValue === VisibilityMode.Auto) {
          let intersectsLabel = false;

          // Test for any collisions
          for (const subsidx in labels[didx]) {
            const r = labels[didx][subsidx].bbox!;

            if (!labels[didx][subsidx].hidden && sidx !== subsidx && intersects(bbox, r)) {
              intersectsLabel = true;
              labels[didx][sidx].hidden = true;
              break;
            }
          }

          !intersectsLabel && u.ctx.fillText(text, x, y);
        }
      }
    }

    u.ctx.restore();
  };

  // handle hover interaction with quadtree probing
  const interpolateTooltip: PlotTooltipInterpolator = (
    updateActiveSeriesIdx,
    updateActiveDatapointIdx,
    updateTooltipPosition,
    u
  ) => {
    let found: Rect | undefined;
    let cx = u.cursor.left! * devicePixelRatio;
    let cy = u.cursor.top! * devicePixelRatio;

    qt.get(cx, cy, 1, 1, (o) => {
      if (pointWithin(cx, cy, o.x, o.y, o.x + o.w, o.y + o.h)) {
        found = o;
      }
    });

    if (found) {
      // prettier-ignore
      if (found !== hovered) {
          barMark.style.display = '';
          barMark.style.left   = found.x / devicePixelRatio + 'px';
          barMark.style.top    = found.y / devicePixelRatio + 'px';
          barMark.style.width  = found.w / devicePixelRatio + 'px';
          barMark.style.height = found.h / devicePixelRatio + 'px';
          hovered = found;
          updateActiveSeriesIdx(hovered.sidx);
          updateActiveDatapointIdx(hovered.didx);
          updateTooltipPosition();
        }
    } else if (hovered !== undefined) {
      updateActiveSeriesIdx(hovered!.sidx);
      updateActiveDatapointIdx(hovered!.didx);
      updateTooltipPosition();
      hovered = undefined;
      barMark.style.display = 'none';
    } else {
      updateTooltipPosition(true);
    }
  };

  let alignedTotals: AlignedData | null = null;

  function prepData(frames: DataFrame[]) {
    alignedTotals = null;

    return preparePlotData(
      frames,
      ({ totals }) => {
        alignedTotals = totals;
      },
      opts.legend
    );
  }

  return {
    cursor: {
      x: false,
      y: false,
      points: { show: false },
    },
    // scale & axis opts
    xRange,
    xValues,
    xSplits,

    barsBuilder,

    // hooks
    init,
    drawClear,
    draw,
    interpolateTooltip,
    prepData,
  };
}
