// Envoltura de ECharts (canvas, apto para datos en tiempo real) con el tema de la bodega.
import ReactECharts from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, CanvasRenderer]);

export const EJE = {
  axisLine: { lineStyle: { color: 'rgba(255,228,196,0.14)' } },
  axisTick: { show: false },
  axisLabel: { color: '#8a7a6c', fontFamily: 'Geist Mono Variable', fontSize: 10, hideOverlap: true },
  splitLine: { lineStyle: { color: 'rgba(255,228,196,0.06)' } },
};

export const TOOLTIP = {
  trigger: 'axis' as const,
  backgroundColor: 'rgba(17,11,7,0.94)',
  borderColor: 'rgba(255,228,196,0.18)',
  textStyle: { color: '#f4eadd', fontFamily: 'Geist Variable', fontSize: 12 },
  axisPointer: { lineStyle: { color: 'rgba(217,165,91,0.5)' } },
};

export const horaEje = (v: number) =>
  new Date(v).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });

export default function Grafico({ opcion, alto, etiqueta }: { opcion: EChartsOption; alto: number; etiqueta: string }) {
  return (
    <div role="img" aria-label={etiqueta}>
      <ReactECharts echarts={echarts} option={opcion} notMerge={false} lazyUpdate style={{ height: alto, width: '100%' }} opts={{ renderer: 'canvas' }} />
    </div>
  );
}
