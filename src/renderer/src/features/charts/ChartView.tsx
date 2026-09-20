// Renders one chart (ECharts canvas, KPI card or table) from the data of its source.

import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import { tr } from '@shared/i18n';
import { Spinner } from '../../components/ui/controls';
import { cssVar, useResolvedTheme } from '../../lib/theme';
import { buildOption, formatValue, processChart, type ChartTheme, type SourceData } from './engine';
import type { ChartDef } from './model';

export function useChartTheme(): ChartTheme {
  const t = useResolvedTheme();
  return useMemo(
    () => ({
      fg: cssVar('--fg'),
      muted: cssVar('--fg-muted'),
      grid: cssVar('--border'),
      bg: cssVar('--bg-panel'),
      accent: cssVar('--accent'),
      success: cssVar('--success'),
      danger: cssVar('--danger'),
      dark: t === 'dark'
    }),
    [t]
  );
}

export function ChartView({ chart, data, loading, error }: { chart: ChartDef; data: SourceData | null; loading?: boolean; error?: string | null }) {
  const theme = useChartTheme();
  const host = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const processed = useMemo(() => (data ? processChart(chart, data) : null), [chart, data]);
  const canvas = chart.type !== 'kpi' && chart.type !== 'table';
  const missing =
    !chart.values.length
      ? tr('Ziehen bzw. wählen Sie mindestens ein Wertfeld.', 'Choose at least one value field.')
      : chart.type === 'scatter' && chart.values.length < 2
        ? tr('Streudiagramme benötigen zwei Wertfelder (X und Y).', 'Scatter charts need two value fields (X and Y).')
        : (chart.type === 'heatmap' && (!chart.category || !chart.series))
          ? tr('Heatmaps benötigen Kategorie und Serie.', 'Heatmaps need a category and a series.')
          : null;

  useEffect(() => {
    if (!canvas || !host.current) return;
    const el = host.current;
    const chartInst = echarts.init(el, undefined, { renderer: 'canvas' });
    inst.current = chartInst;
    const ro = new ResizeObserver(() => chartInst.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chartInst.dispose();
      inst.current = null;
    };
  }, [canvas]);

  useEffect(() => {
    if (!inst.current || !processed || missing) {
      inst.current?.clear();
      return;
    }
    try {
      inst.current.setOption(buildOption(chart, processed, theme), true);
    } catch (e) {
      console.error(e);
    }
  }, [chart, processed, theme, missing]);

  let overlay: React.ReactNode = null;
  if (error) overlay = <span className="danger-text">{error}</span>;
  else if (loading && !data) overlay = <Spinner size={20} />;
  else if (!data) overlay = <span className="faint">{tr('Keine Daten geladen', 'No data loaded')}</span>;
  else if (missing) overlay = <span className="faint">{missing}</span>;

  return (
    <div className="ks-ch-view">
      {canvas && <div ref={host} className="ks-ch-canvas" />}
      {!overlay && chart.type === 'kpi' && processed && (
        <div className="ks-ch-kpi">
          {chart.showTitle && <div className="ks-ch-kpi-title">{chart.title || chart.name}</div>}
          <div className="ks-ch-kpi-value" style={{ color: chart.target !== null && processed.value !== null && processed.value !== undefined ? (processed.value >= chart.target ? 'var(--success)' : 'var(--danger)') : undefined }}>
            {formatValue(processed.value, chart.format)}
          </div>
          {chart.target !== null && processed.value !== null && processed.value !== undefined && (
            <>
              <div className="ks-ch-kpi-bar">
                <div style={{ width: `${Math.max(0, Math.min(100, (processed.value / (chart.target || 1)) * 100))}%` }} />
              </div>
              <div className="ks-ch-kpi-sub">
                {tr('Ziel', 'Target')} {formatValue(chart.target, chart.format)} · {formatValue((processed.value / (chart.target || 1)) * 100, { decimals: 0, prefix: '', suffix: ' %', thousands: true, unit: '' })}
              </div>
            </>
          )}
        </div>
      )}
      {!overlay && chart.type === 'table' && processed?.table && (
        <div className="ks-ch-table-wrap">
          {chart.showTitle && <div className="ks-ch-kpi-title">{chart.title || chart.name}</div>}
          <table className="ks-table">
            <thead>
              <tr>
                {processed.table.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {processed.table.rows.slice(0, 2000).map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={typeof v === 'number' ? 'num' : undefined}>
                      {typeof v === 'number' ? formatValue(v, chart.format) : v === null ? '' : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {overlay && <div className="ks-ch-overlay">{overlay}</div>}
    </div>
  );
}
