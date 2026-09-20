// Small wrapper around echarts (resizes with its container, follows the app theme).

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { cssVar, useResolvedTheme } from '../../lib/theme';

export interface ChartSeries {
  name: string;
  /** [time ms, value] */
  data: [number, number][];
}

export function LineChart({ title, series, unit, format }: { title: string; series: ChartSeries[]; unit?: string; format?: (v: number) => string }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    if (!host.current) return;
    const c = echarts.init(host.current, undefined, { renderer: 'canvas' });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const fg = cssVar('--fg');
    const muted = cssVar('--fg-muted');
    const grid = cssVar('--grid-line');
    const fmt = (v: number) => (format ? format(v) : `${Number.isInteger(v) ? v : v.toFixed(2)}${unit ? ` ${unit}` : ''}`);
    c.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        title: { text: title, left: 8, top: 4, textStyle: { color: fg, fontSize: 12, fontWeight: 600 } },
        tooltip: {
          trigger: 'axis',
          backgroundColor: cssVar('--bg-menu'),
          borderColor: cssVar('--border'),
          textStyle: { color: fg, fontSize: 12 },
          valueFormatter: (v: unknown) => fmt(Number(v))
        },
        legend: series.length > 1 ? { top: 4, right: 8, textStyle: { color: muted, fontSize: 11 }, itemHeight: 8 } : undefined,
        grid: { left: 56, right: 14, top: 32, bottom: 24 },
        xAxis: { type: 'time', axisLabel: { color: muted, fontSize: 10, hideOverlap: true }, axisLine: { lineStyle: { color: grid } }, splitLine: { show: false } },
        yAxis: {
          type: 'value',
          min: 0,
          axisLabel: { color: muted, fontSize: 10, formatter: (v: number) => (format ? format(v) : String(v)) },
          splitLine: { lineStyle: { color: grid } }
        },
        series: series.map((s) => ({ name: s.name, type: 'line', showSymbol: false, smooth: false, lineStyle: { width: 1.6 }, areaStyle: series.length === 1 ? { opacity: 0.12 } : undefined, data: s.data }))
      },
      { notMerge: true }
    );
  }, [series, title, unit, format, theme]);

  return <div ref={host} className="ks-monitor-chart" />;
}
