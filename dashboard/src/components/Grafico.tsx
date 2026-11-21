// Envoltura de ECharts (canvas, apto para datos en tiempo real) con el tema de la bodega.
import { useMemo } from 'react';
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

// Si el ESP32 deja de enviar datos un rato, la línea se corta en vez de unir los puntos con una recta
// (una recta haría creer que hubo datos en ese hueco).
const HUECO_MS = 45_000;
type Punto = [number, ...unknown[]] | { value: [number, ...unknown[]] };
const tiempoDe = (p: Punto) => (Array.isArray(p) ? p[0] : p.value[0]);

export function cortarHuecos(datos: Punto[], maxMs = HUECO_MS): Punto[] {
  const salida: Punto[] = [];
  for (let i = 0; i < datos.length; i++) {
    if (i > 0) {
      const t0 = tiempoDe(datos[i - 1]), t1 = tiempoDe(datos[i]);
      if (t1 - t0 > maxMs) salida.push([(t0 + t1) / 2, null]);
    }
    salida.push(datos[i]);
  }
  return salida;
}

function conHuecos(opcion: EChartsOption): EChartsOption {
  const series = Array.isArray(opcion.series) ? opcion.series : [];
  return {
    ...opcion,
    series: series.map((s) => {
      const datos = (s as { data?: unknown }).data;
      if (s.type !== 'line' || !Array.isArray(datos) || !datos.length) return s;
      const primero = datos[0] as Punto;
      const esTiempo = Array.isArray(primero) ? typeof primero[0] === 'number' : typeof primero?.value?.[0] === 'number';
      return esTiempo ? { ...s, data: cortarHuecos(datos as Punto[]) as never } : s;
    }),
  };
}

export default function Grafico({ opcion, alto, etiqueta }: { opcion: EChartsOption; alto: number; etiqueta: string }) {
  const final = useMemo(() => conHuecos(opcion), [opcion]);
  return (
    <div role="img" aria-label={etiqueta}>
      <ReactECharts echarts={echarts} option={final} notMerge={false} lazyUpdate style={{ height: alto, width: '100%' }} opts={{ renderer: 'canvas' }} />
    </div>
  );
}
