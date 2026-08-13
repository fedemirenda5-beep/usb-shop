'use client';

import { useId, useMemo, useState } from 'react';
import styles from './InteractiveDualLineChart.module.css';

type ChartPoint = {
  id: string;
  label: string;
  meta?: string;
  primary: number;
  secondary?: number;
};

type InteractiveDualLineChartProps = {
  data: ChartPoint[];
  primaryLabel: string;
  secondaryLabel?: string;
  formatPrimary: (value: number) => string;
  formatSecondary?: (value: number) => string;
  primaryColor?: string;
  secondaryColor?: string;
  minWidth?: number;
  height?: number;
};

const DEFAULT_WIDTH = 760;

const buildPath = (points: Array<{ x: number; y: number }>) =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

export default function InteractiveDualLineChart({
  data,
  primaryLabel,
  secondaryLabel,
  formatPrimary,
  formatSecondary = (value) => String(value),
  primaryColor = '#06b6d4',
  secondaryColor = '#8b5cf6',
  minWidth = 720,
  height = 300,
}: InteractiveDualLineChartProps) {
  const gradientId = useId().replace(/:/g, '');
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, data.length - 1));

  const geometry = useMemo(() => {
    const width = DEFAULT_WIDTH;
    const paddingTop = 26;
    const paddingBottom = 54;
    const paddingLeft = 74;
    const paddingRight = secondaryLabel ? 74 : 24;
    const innerWidth = width - paddingLeft - paddingRight;
    const innerHeight = height - paddingTop - paddingBottom;
    const maxPrimary = Math.max(1, ...data.map((item) => item.primary));
    const maxSecondary = Math.max(1, ...data.map((item) => item.secondary ?? 0));
    const primaryPoints = data.map((item, index) => {
      const x =
        data.length <= 1 ? paddingLeft + innerWidth / 2 : paddingLeft + (index / (data.length - 1)) * innerWidth;
      const primaryY = paddingTop + innerHeight - (item.primary / maxPrimary) * innerHeight;
      const secondaryY =
        secondaryLabel && item.secondary !== undefined
          ? paddingTop + innerHeight - ((item.secondary ?? 0) / maxSecondary) * innerHeight
          : primaryY;
      return { ...item, x, primaryY, secondaryY };
    });

    const primaryTicks = Array.from({ length: 4 }, (_, index) => {
      const value = (maxPrimary / 3) * (3 - index);
      const y = paddingTop + (innerHeight / 3) * index;
      return { value, y };
    });

    const secondaryTicks = secondaryLabel
      ? Array.from({ length: 4 }, (_, index) => {
          const value = (maxSecondary / 3) * (3 - index);
          const y = paddingTop + (innerHeight / 3) * index;
          return { value, y };
        })
      : [];

    const primaryLine = buildPath(primaryPoints.map((point) => ({ x: point.x, y: point.primaryY })));
    const secondaryLine =
      secondaryLabel && data.some((item) => item.secondary !== undefined)
        ? buildPath(primaryPoints.map((point) => ({ x: point.x, y: point.secondaryY })))
        : '';
    const baseline = height - paddingBottom;
    const first = primaryPoints[0];
    const last = primaryPoints[primaryPoints.length - 1];
    const primaryArea = first && last ? `${primaryLine} L ${last.x} ${baseline} L ${first.x} ${baseline} Z` : '';
    const secondaryArea =
      secondaryLine && first && last ? `${secondaryLine} L ${last.x} ${baseline} L ${first.x} ${baseline} Z` : '';

    return {
      width,
      height,
      baseline,
      paddingLeft,
      paddingRight,
      primaryPoints,
      primaryTicks,
      secondaryTicks,
      primaryLine,
      secondaryLine,
      primaryArea,
      secondaryArea,
    };
  }, [data, height, secondaryLabel]);

  const safeIndex = Math.min(activeIndex, Math.max(0, data.length - 1));
  const activePoint = geometry.primaryPoints[safeIndex];
  const tooltipPosition = activePoint
    ? activePoint.x / geometry.width < 0.2
      ? { left: '12px' as const }
      : activePoint.x / geometry.width > 0.8
        ? { right: '12px' as const }
        : { left: `${(activePoint.x / geometry.width) * 100}%`, transform: 'translateX(-50%)' }
    : { right: '12px' as const };

  if (data.length === 0) {
    return null;
  }

  return (
    <div className={styles.shell}>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <i className={styles.legendSwatch} style={{ background: primaryColor }} />
          {primaryLabel}
        </span>
        {secondaryLabel ? (
          <span className={styles.legendItem}>
            <i className={styles.legendSwatch} style={{ background: secondaryColor }} />
            {secondaryLabel}
          </span>
        ) : null}
      </div>

      <div className={styles.viewport}>
        {activePoint ? (
          <div className={styles.tooltip} style={tooltipPosition}>
            <div className={styles.tooltipLabel}>
              <strong>{activePoint.meta || activePoint.label}</strong>
              <span>{activePoint.label}</span>
            </div>
            <div className={styles.tooltipMetrics}>
              <div className={styles.tooltipMetric}>
                <span>{primaryLabel}</span>
                <strong>{formatPrimary(activePoint.primary)}</strong>
              </div>
              {secondaryLabel ? (
                <div className={styles.tooltipMetric}>
                  <span>{secondaryLabel}</span>
                  <strong>{formatSecondary(activePoint.secondary ?? 0)}</strong>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <svg
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          className={styles.chart}
          style={{ minWidth }}
          role="img"
          aria-label={`${primaryLabel}${secondaryLabel ? ` y ${secondaryLabel}` : ''}`}
        >
          <defs>
            <linearGradient id={`${gradientId}-primary`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={primaryColor} stopOpacity="0.26" />
              <stop offset="100%" stopColor={primaryColor} stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`${gradientId}-secondary`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={secondaryColor} stopOpacity="0.16" />
              <stop offset="100%" stopColor={secondaryColor} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {geometry.primaryTicks.map((tick) => (
            <g key={`primary-${tick.y}`}>
              <line
                x1={geometry.paddingLeft}
                x2={geometry.width - geometry.paddingRight}
                y1={tick.y}
                y2={tick.y}
                className={styles.gridLine}
              />
              <text x={geometry.paddingLeft - 10} y={tick.y + 4} textAnchor="end" className={styles.axisLabel}>
                {formatPrimary(tick.value)}
              </text>
            </g>
          ))}

          {secondaryLabel
            ? geometry.secondaryTicks.map((tick) => (
                <text
                  key={`secondary-${tick.y}`}
                  x={geometry.width - geometry.paddingRight + 10}
                  y={tick.y + 4}
                  textAnchor="start"
                  className={styles.axisLabel}
                >
                  {formatSecondary(tick.value)}
                </text>
              ))
            : null}

          {geometry.secondaryArea ? (
            <path d={geometry.secondaryArea} fill={`url(#${gradientId}-secondary)`} className={styles.secondaryArea} />
          ) : null}
          <path d={geometry.primaryArea} fill={`url(#${gradientId}-primary)`} className={styles.primaryArea} />
          {geometry.secondaryLine ? (
            <path d={geometry.secondaryLine} className={styles.secondaryLine} style={{ stroke: secondaryColor }} />
          ) : null}
          <path d={geometry.primaryLine} className={styles.primaryLine} style={{ stroke: primaryColor }} />

          {activePoint ? (
            <line
              x1={activePoint.x}
              x2={activePoint.x}
              y1="26"
              y2={geometry.baseline}
              className={styles.activeGuide}
            />
          ) : null}

          {geometry.primaryPoints.map((point, index) => {
            const hotspotWidth =
              geometry.primaryPoints.length <= 1
                ? geometry.width - geometry.paddingLeft - geometry.paddingRight
                : index === 0
                  ? (geometry.primaryPoints[index + 1].x - point.x) / 2
                  : index === geometry.primaryPoints.length - 1
                    ? (point.x - geometry.primaryPoints[index - 1].x) / 2
                    : (geometry.primaryPoints[index + 1].x - geometry.primaryPoints[index - 1].x) / 2;

            return (
              <g key={point.id}>
                <rect
                  x={point.x - hotspotWidth / 2}
                  y="18"
                  width={hotspotWidth}
                  height={geometry.baseline - 2}
                  className={styles.hotspot}
                  onMouseEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => setActiveIndex(index)}
                  tabIndex={0}
                />
                {point.secondary !== undefined && secondaryLabel ? (
                  <circle
                    cx={point.x}
                    cy={point.secondaryY}
                    r={safeIndex === index ? 5.6 : 4.4}
                    className={`${styles.secondaryPoint} ${safeIndex === index ? styles.activePoint : ''}`}
                    style={{ fill: '#ffffff', stroke: secondaryColor }}
                  />
                ) : null}
                <circle
                  cx={point.x}
                  cy={point.primaryY}
                  r={safeIndex === index ? 6.2 : 5}
                  className={`${styles.primaryPoint} ${safeIndex === index ? styles.activePoint : ''}`}
                  style={{ fill: '#ffffff', stroke: primaryColor }}
                />
                <text x={point.x} y={geometry.baseline + 20} textAnchor="middle" className={styles.monthLabel}>
                  {point.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {activePoint ? (
        <div className={styles.insights}>
          <article className={styles.insightCard}>
            <span>Periodo</span>
            <strong>{activePoint.meta || activePoint.label}</strong>
          </article>
          <article className={styles.insightCard}>
            <span>{primaryLabel}</span>
            <strong>{formatPrimary(activePoint.primary)}</strong>
          </article>
          {secondaryLabel ? (
            <article className={styles.insightCard}>
              <span>{secondaryLabel}</span>
              <strong>{formatSecondary(activePoint.secondary ?? 0)}</strong>
            </article>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
