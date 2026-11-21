// Temperatura y humedad: tarjetas con rango seguro + gráfica medida vs. pronóstico TinyML.
import type { EChartsOption } from 'echarts';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Droplets, Thermometer } from 'lucide-react';
import { useMemo } from 'react';
import { num } from '../lib/formato';
import { ultimo, useBodega } from '../lib/store';
import Grafico, { EJE, TOOLTIP, horaEje } from './Grafico';

interface PropsVariable {
  titulo: string;
  icono: typeof Thermometer;
  unidad: string;
  valor?: number;
  pronostico?: number;
  horizonte: number;
  rango: [number, number];
  escala: [number, number];
  color: string;
}

export function TarjetaVariable({ titulo, icono: Icono, unidad, valor, pronostico, horizonte, rango, escala, color }: PropsVariable) {
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - escala[0]) / (escala[1] - escala[0])) * 100))}%`;
  const dentro = valor != null && valor >= rango[0] && valor <= rango[1];
  const pronDentro = pronostico == null || (pronostico >= rango[0] && pronostico <= rango[1]);
  const delta = valor != null && pronostico != null ? pronostico - valor : 0;
  const Flecha = Math.abs(delta) < 0.3 ? ArrowRight : delta > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="panel grano p-4">
      <div className="flex items-center justify-between">
        <span className="etiqueta flex items-center gap-1.5"><Icono size={14} style={{ color }} aria-hidden />{titulo}</span>
        <span className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ color: valor == null ? 'var(--color-suave)' : dentro ? 'var(--color-ok)' : 'var(--color-critica)', background: 'rgb(255 228 196 / 0.05)' }}>
          {valor == null ? 'sin datos' : dentro ? 'En rango' : 'Fuera de rango'}
        </span>
      </div>
      <div className="mt-2 flex items-end gap-1.5">
        <span className="font-display text-5xl leading-none font-semibold tracking-[-0.04em]">{num(valor)}</span>
        <span className="mb-1 text-lg text-suave">{unidad}</span>
      </div>

      {/* rango seguro y valor actual */}
      <div className="relative mt-4 h-2 rounded-full bg-panel-2" aria-hidden>
        <div className="absolute inset-y-0 rounded-full" style={{ left: pos(rango[0]), width: `calc(${pos(rango[1])} - ${pos(rango[0])})`, background: 'rgb(79 180 119 / 0.28)' }} />
        {pronostico != null && <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed" style={{ left: pos(pronostico), borderColor: color }} />}
        {valor != null && <div className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow transition-[left] duration-700" style={{ left: pos(valor), background: color }} />}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-tenue">
        <span>{escala[0]}</span><span>seguro {rango[0]}–{rango[1]} {unidad}</span><span>{escala[1]}</span>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-linea pt-3 text-sm">
        <Flecha size={16} aria-hidden style={{ color: pronDentro ? 'var(--color-suave)' : 'var(--color-aviso)' }} />
        <span className="text-suave">Pronóstico a {horizonte} min:</span>
        <span className="cifra font-medium" style={{ color: pronDentro ? 'var(--color-texto)' : 'var(--color-aviso)' }}>
          {num(pronostico)} {unidad}
        </span>
      </div>
    </div>
  );
}

export function TarjetasClima() {
  const l = useBodega((s) => ultimo(s.lecturas));
  const p = useBodega((s) => ultimo(s.pronostico));
  const cfg = useBodega((s) => s.config);
  return (
    <>
      <TarjetaVariable titulo="Temperatura" icono={Thermometer} unidad="°C" valor={l?.temperatura} pronostico={p?.temperatura_pred}
        horizonte={p?.horizonte_min ?? 5} rango={cfg.rango_temp} escala={[10, 32]} color="var(--color-temp)" />
      <TarjetaVariable titulo="Humedad relativa" icono={Droplets} unidad="%" valor={l?.humedad} pronostico={p?.humedad_pred}
        horizonte={p?.horizonte_min ?? 5} rango={cfg.rango_hum} escala={[40, 80]} color="var(--color-hum)" />
    </>
  );
}

export function GraficoClima() {
  const lecturas = useBodega((s) => s.lecturas);
  const pronostico = useBodega((s) => s.pronostico);
  const cfg = useBodega((s) => s.config);

  const opcion = useMemo<EChartsOption>(() => {
    // El pronóstico hecho en t es para t + horizonte: se dibuja en el futuro
    const fut = (p: (typeof pronostico)[number]) => p.t + p.horizonte_min * 60_000;
    const banda = (r: [number, number], eje: number, color: string) => ({
      silent: true, itemStyle: { color }, data: [[{ yAxis: r[0] }, { yAxis: r[1] }]] as never, yAxisIndex: eje,
    });
    return {
      animation: false,
      grid: { left: 44, right: 44, top: 36, bottom: 28 },
      tooltip: { ...TOOLTIP, valueFormatter: (v) => (typeof v === 'number' ? v.toFixed(1).replace('.', ',') : String(v)) },
      legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: '#b3a293', fontSize: 11 } },
      xAxis: { type: 'time', ...EJE, splitLine: { show: false }, axisLabel: { ...EJE.axisLabel, formatter: horaEje } },
      yAxis: [
        { type: 'value', name: '°C', min: 10, max: 32, nameTextStyle: { color: '#ec9f4a', fontSize: 10 }, ...EJE },
        { type: 'value', name: '% HR', min: 40, max: 80, nameTextStyle: { color: '#3bb8c4', fontSize: 10 }, ...EJE, splitLine: { show: false } },
      ],
      series: [
        { name: 'Temperatura', type: 'line', showSymbol: false, smooth: 0.3, yAxisIndex: 0, lineStyle: { width: 2.2, color: '#ec9f4a' }, itemStyle: { color: '#ec9f4a' },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(236,159,74,0.18)' }, { offset: 1, color: 'rgba(236,159,74,0)' }] } },
          data: lecturas.map((l) => [l.t, l.temperatura]), markArea: banda(cfg.rango_temp, 0, 'rgba(236,159,74,0.05)') },
        { name: 'Humedad', type: 'line', showSymbol: false, smooth: 0.3, yAxisIndex: 1, lineStyle: { width: 2.2, color: '#3bb8c4' }, itemStyle: { color: '#3bb8c4' },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(59,184,196,0.16)' }, { offset: 1, color: 'rgba(59,184,196,0)' }] } },
          data: lecturas.map((l) => [l.t, l.humedad]),
          markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(239,90,90,0.55)', type: [4, 4] }, label: { color: '#ef5a5a', fontSize: 10, formatter: 'límite moho {c} %' }, data: [{ yAxis: cfg.rango_hum[1] }] } },
        { name: 'T pronosticada', type: 'line', showSymbol: false, smooth: 0.3, yAxisIndex: 0, lineStyle: { width: 1.6, type: [6, 5], color: '#ec9f4a', opacity: 0.8 }, itemStyle: { color: '#ec9f4a' },
          data: pronostico.map((p) => [fut(p), p.temperatura_pred]) },
        { name: 'H pronosticada', type: 'line', showSymbol: false, smooth: 0.3, yAxisIndex: 1, lineStyle: { width: 1.6, type: [6, 5], color: '#3bb8c4', opacity: 0.8 }, itemStyle: { color: '#3bb8c4' },
          data: pronostico.map((p) => [fut(p), p.humedad_pred]),
          markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(255,228,196,0.3)', type: 'solid' }, label: { color: '#b3a293', fontSize: 10, formatter: 'ahora' },
            data: [{ xAxis: Date.now() }] } },
      ],
    };
  }, [lecturas, pronostico, cfg]);

  const l = ultimo(lecturas), p = ultimo(pronostico);
  const resumen = l ? `Temperatura ${num(l.temperatura)} grados y humedad ${num(l.humedad)} por ciento.${p ? ` Pronóstico a ${p.horizonte_min} minutos: ${num(p.temperatura_pred)} grados y ${num(p.humedad_pred)} por ciento.` : ''}` : 'Sin lecturas todavía.';
  return <Grafico opcion={opcion} alto={300} etiqueta={`Gráfica de temperatura y humedad medidas y pronosticadas. ${resumen}`} />;
}
