// Comportamiento de los tres modelos de IA: confianza en el tiempo, probabilidades,
// distribución de clases y qué tan bien acierta el pronóstico TinyML.
import type { EChartsOption } from 'echarts';
import { BrainCircuit, Camera, Fan, Gauge } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { COLOR_HEX, VENTILADOR, num, pct } from '../lib/formato';
import { useBodega } from '../lib/store';
import type { Clasificacion, Lectura, Pronostico } from '../lib/tipos';
import Grafico, { EJE, TOOLTIP, horaEje } from './Grafico';

const COLOR_CLASE: Record<string, string> = {
  apagado: COLOR_HEX.info, normal: COLOR_HEX.ok, desbalanceado: COLOR_HEX.critica, obstruido: COLOR_HEX.aviso, incierto: '#9b8cc4',
  sano: COLOR_HEX.ok, moho: COLOR_HEX.critica, broca: COLOR_HEX.aviso, defecto: COLOR_HEX.aviso,
};
const colorClase = (c: string) => COLOR_CLASE[c] ?? '#b3a293';
const LEYENDA = { top: 0, right: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: '#b3a293', fontSize: 11 } } as const;

// ---------- Cálculos ----------
const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Empareja cada pronóstico (hecho en t para t + horizonte) con la lectura real más cercana a ese momento
export function errorPronostico(pron: Pronostico[], lect: Lectura[]) {
  const pares: { t: number; et: number; eh: number }[] = [];
  if (!lect.length) return pares;
  let j = 0;
  for (const p of pron) {
    const objetivo = p.t + p.horizonte_min * 60_000;
    if (objetivo > lect[lect.length - 1].t + 15_000) break; // todavía no ha llegado ese momento
    while (j < lect.length - 1 && Math.abs(lect[j + 1].t - objetivo) <= Math.abs(lect[j].t - objetivo)) j++;
    if (Math.abs(lect[j].t - objetivo) > 20_000) continue;
    pares.push({ t: objetivo, et: Math.abs(p.temperatura_pred - lect[j].temperatura), eh: Math.abs(p.humedad_pred - lect[j].humedad) });
  }
  return pares;
}

function resumenClasificador(lista: Clasificacion[], umbral: number) {
  const ultimas = lista.slice(-60);
  const conteo: Record<string, { n: number; conf: number }> = {};
  for (const c of ultimas) {
    conteo[c.clase] ??= { n: 0, conf: 0 };
    conteo[c.clase].n++;
    conteo[c.clase].conf += c.confianza;
  }
  return {
    n: ultimas.length,
    confMedia: media(ultimas.map((c) => c.confianza)),
    bajoUmbral: ultimas.length ? ultimas.filter((c) => c.confianza < umbral).length / ultimas.length : null,
    clases: Object.entries(conteo).map(([clase, v]) => ({ clase, n: v.n, conf: v.conf / v.n })).sort((a, b) => b.n - a.n),
  };
}

// ---------- Tarjetas de resumen ----------
function TarjetaModelo({ icono, titulo, herramienta, children }: { icono: ReactNode; titulo: string; herramienta: string; children: ReactNode }) {
  return (
    <div className="panel grano p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-panel-2 text-pergamino">{icono}</span>
        <div className="leading-tight">
          <div className="text-sm font-medium">{titulo}</div>
          <div className="text-[11px] text-suave">{herramienta}</div>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2">{children}</dl>
    </div>
  );
}

function Metrica({ nombre, valor, nota }: { nombre: string; valor: string; nota?: string }) {
  return (
    <div>
      <dt className="text-[11px] text-suave">{nombre}</dt>
      <dd className="cifra mt-0.5 text-xl font-semibold tracking-tight">{valor}</dd>
      {nota && <dd className="text-[10px] text-tenue">{nota}</dd>}
    </div>
  );
}

export function ResumenModelos() {
  const vent = useBodega((s) => s.ventilador);
  const vis = useBodega((s) => s.vision);
  const pron = useBodega((s) => s.pronostico);
  const lect = useBodega((s) => s.lecturas);
  const cfg = useBodega((s) => s.config);
  const rv = useMemo(() => resumenClasificador(vent, cfg.umbral_ventilador), [vent, cfg]);
  const rc = useMemo(() => resumenClasificador(vis, cfg.umbral_vision), [vis, cfg]);
  const err = useMemo(() => errorPronostico(pron, lect).slice(-60), [pron, lect]);
  const ultimoV = vent[vent.length - 1];
  const inferencia = ultimoV?.dsp_ms != null ? (ultimoV.dsp_ms + (ultimoV.red_ms ?? 0)) : null;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <TarjetaModelo icono={<BrainCircuit size={16} aria-hidden />} titulo="Pronóstico de clima" herramienta="TinyML · TensorFlow Lite · 5 min">
        <Metrica nombre="Error medio T" valor={err.length ? `${num(media(err.map((e) => e.et)))}°` : '—'} nota="MAE en °C" />
        <Metrica nombre="Error medio H" valor={err.length ? `${num(media(err.map((e) => e.eh)))}%` : '—'} nota="MAE en % HR" />
        <Metrica nombre="Comparados" valor={String(err.length)} nota="pronóstico vs. real" />
      </TarjetaModelo>
      <TarjetaModelo icono={<Fan size={16} aria-hidden />} titulo="Estado del ventilador" herramienta="Edge Impulse · Spectral + red densa">
        <Metrica nombre="Confianza media" valor={rv.confMedia != null ? pct(rv.confMedia) : '—'} nota={`últimas ${rv.n} ventanas`} />
        <Metrica nombre="Bajo umbral" valor={rv.bajoUmbral != null ? pct(rv.bajoUmbral) : '—'} nota={`< ${pct(cfg.umbral_ventilador)}`} />
        <Metrica nombre="Inferencia" valor={inferencia != null ? `${inferencia} ms` : '—'} nota="DSP + red en el ESP32" />
      </TarjetaModelo>
      <TarjetaModelo icono={<Camera size={16} aria-hidden />} titulo="Clasificación de imágenes" herramienta="Edge Impulse · ESP32-CAM">
        <Metrica nombre="Confianza media" valor={rc.confMedia != null ? pct(rc.confMedia) : '—'} nota={`últimas ${rc.n} imágenes`} />
        <Metrica nombre="Bajo umbral" valor={rc.bajoUmbral != null ? pct(rc.bajoUmbral) : '—'} nota={`< ${pct(cfg.umbral_vision)}`} />
        <Metrica nombre="Clase más vista" valor={rc.clases[0]?.clase ?? '—'} />
      </TarjetaModelo>
    </div>
  );
}

// ---------- Confianza de los clasificadores en el tiempo ----------
export function GraficoConfianza() {
  const vent = useBodega((s) => s.ventilador);
  const vis = useBodega((s) => s.vision);
  const cfg = useBodega((s) => s.config);
  const opcion = useMemo<EChartsOption>(() => {
    const punto = (c: Clasificacion) => ({ value: [c.t, c.confianza], clase: c.clase, itemStyle: { color: colorClase(c.clase) } });
    const umbral = (y: number, nombre: string) => ({
      silent: true, symbol: 'none', lineStyle: { color: 'rgba(255,228,196,0.35)', type: [4, 4] as number[] },
      label: { color: '#b3a293', fontSize: 10, formatter: `${nombre} ${Math.round(y * 100)} %`, position: 'insideEndTop' as const }, data: [{ yAxis: y }],
    });
    return {
      animation: false,
      grid: { left: 40, right: 16, top: 30, bottom: 24 },
      tooltip: {
        ...TOOLTIP, trigger: 'item',
        formatter: (p: unknown) => {
          const d = (p as { seriesName: string; data: { value: [number, number]; clase: string } });
          return `${d.seriesName}<br/><b>${d.data.clase}</b> · ${pct(d.data.value[1])}`;
        },
      },
      legend: LEYENDA,
      xAxis: { type: 'time', ...EJE, splitLine: { show: false }, axisLabel: { ...EJE.axisLabel, formatter: horaEje } },
      yAxis: { type: 'value', min: 0, max: 1, ...EJE, axisLabel: { ...EJE.axisLabel, formatter: (v: number) => `${v * 100}%` } },
      series: [
        { name: 'Ventilador', type: 'line', symbol: 'circle', symbolSize: 5, lineStyle: { width: 1.4, color: '#d9a55b' }, itemStyle: { color: '#d9a55b' },
          data: vent.slice(-150).map(punto) as never, markLine: umbral(cfg.umbral_ventilador, 'umbral ventilador') },
        { name: 'Cámara', type: 'line', symbol: 'diamond', symbolSize: 9, lineStyle: { width: 1.4, color: '#c9a0f0', type: [6, 4] }, itemStyle: { color: '#c9a0f0' },
          data: vis.slice(-60).map(punto) as never, markLine: umbral(cfg.umbral_vision, 'umbral cámara') },
      ],
    };
  }, [vent, vis, cfg]);
  return <Grafico opcion={opcion} alto={260} etiqueta="Confianza de los modelos del ventilador y de la cámara en el tiempo; cada punto lleva el color de la clase predicha." />;
}

// ---------- Probabilidades del ventilador (apiladas, suman 100 %) ----------
export function GraficoProbabilidades() {
  const vent = useBodega((s) => s.ventilador);
  const opcion = useMemo<EChartsOption>(() => {
    const datos = vent.slice(-150);
    const clases = ['normal', 'apagado', 'obstruido', 'desbalanceado'];
    return {
      animation: false,
      grid: { left: 40, right: 16, top: 30, bottom: 24 },
      tooltip: { ...TOOLTIP, valueFormatter: (v) => (typeof v === 'number' ? pct(v) : String(v)) },
      legend: LEYENDA,
      xAxis: { type: 'time', ...EJE, splitLine: { show: false }, axisLabel: { ...EJE.axisLabel, formatter: horaEje } },
      yAxis: { type: 'value', min: 0, max: 1, ...EJE, axisLabel: { ...EJE.axisLabel, formatter: (v: number) => `${v * 100}%` } },
      series: clases.map((c) => ({
        name: VENTILADOR[c]?.etiqueta ?? c, type: 'line' as const, stack: 'p', showSymbol: false, smooth: 0.2,
        lineStyle: { width: 0.8, color: colorClase(c) }, itemStyle: { color: colorClase(c) }, areaStyle: { color: colorClase(c), opacity: 0.55 },
        data: datos.map((v) => [v.t, v.probs[c] ?? (v.clase === c ? v.confianza : 0)]),
      })),
    };
  }, [vent]);
  return <Grafico opcion={opcion} alto={260} etiqueta="Probabilidad que el modelo de Edge Impulse asigna a cada estado del ventilador en cada ventana de 2 segundos." />;
}

// ---------- Distribución de clases y confianza media por clase ----------
export function GraficoDistribucion() {
  const vent = useBodega((s) => s.ventilador);
  const vis = useBodega((s) => s.vision);
  const cfg = useBodega((s) => s.config);
  const opcion = useMemo<EChartsOption>(() => {
    const rv = resumenClasificador(vent, cfg.umbral_ventilador).clases.map((c) => ({ ...c, modelo: 'Ventilador' }));
    const rc = resumenClasificador(vis, cfg.umbral_vision).clases.map((c) => ({ ...c, modelo: 'Cámara' }));
    const filas = [...rc.reverse(), ...rv.reverse()];
    return {
      animation: true,
      grid: { left: 118, right: 70, top: 8, bottom: 8 },
      tooltip: { ...TOOLTIP, trigger: 'item', formatter: (p: unknown) => {
        const { data } = p as { data: { f: (typeof filas)[number] } };
        return `${data.f.modelo} · <b>${data.f.clase}</b><br/>${data.f.n} predicciones · confianza media ${pct(data.f.conf)}`;
      } },
      xAxis: { type: 'value', show: false },
      yAxis: { type: 'category', data: filas.map((f) => `${f.modelo === 'Cámara' ? 'Cám.' : 'Vent.'} · ${f.clase}`), ...EJE, axisLabel: { ...EJE.axisLabel, color: '#d8c9b8', fontSize: 11 } },
      series: [{
        type: 'bar', barWidth: 12, itemStyle: { borderRadius: 4 },
        label: { show: true, position: 'right', color: '#b3a293', fontSize: 10, fontFamily: 'Geist Mono Variable',
          formatter: (p: unknown) => { const f = (p as { data: { f: (typeof filas)[number] } }).data.f; return `${f.n} · ${pct(f.conf)}`; } },
        data: filas.map((f) => ({ value: f.n, f, itemStyle: { color: colorClase(f.clase), opacity: 0.4 + f.conf * 0.6 } })) as never,
      }],
    };
  }, [vent, vis, cfg]);
  const alto = 40 + (new Set(vent.slice(-60).map((v) => v.clase)).size + new Set(vis.slice(-60).map((v) => v.clase)).size) * 30;
  return <Grafico opcion={opcion} alto={Math.max(140, alto)} etiqueta="Cuántas veces predijo cada clase cada modelo en las últimas predicciones y con qué confianza media." />;
}

// ---------- Error del pronóstico TinyML ----------
export function GraficoErrorPronostico() {
  const pron = useBodega((s) => s.pronostico);
  const lect = useBodega((s) => s.lecturas);
  const opcion = useMemo<EChartsOption>(() => {
    const err = errorPronostico(pron, lect);
    return {
      animation: false,
      grid: { left: 40, right: 16, top: 30, bottom: 24 },
      tooltip: { ...TOOLTIP, valueFormatter: (v) => (typeof v === 'number' ? v.toFixed(2).replace('.', ',') : String(v)) },
      legend: LEYENDA,
      xAxis: { type: 'time', ...EJE, splitLine: { show: false }, axisLabel: { ...EJE.axisLabel, formatter: horaEje } },
      yAxis: { type: 'value', min: 0, ...EJE, name: 'error abs.', nameTextStyle: { color: '#8a7a6c', fontSize: 10 } },
      series: [
        { name: 'Error T (°C)', type: 'bar', barMaxWidth: 6, itemStyle: { color: 'rgba(236,159,74,0.75)', borderRadius: 2 }, data: err.map((e) => [e.t, +e.et.toFixed(2)]) },
        { name: 'Error H (% HR)', type: 'line', showSymbol: false, smooth: 0.3, lineStyle: { color: '#3bb8c4', width: 1.8 }, itemStyle: { color: '#3bb8c4' }, data: err.map((e) => [e.t, +e.eh.toFixed(2)]) },
      ],
    };
  }, [pron, lect]);
  const vacio = !errorPronostico(pron, lect).length;
  return (
    <div className="relative">
      <Grafico opcion={opcion} alto={260} etiqueta="Error absoluto entre el pronóstico TinyML hecho hace 5 minutos y la lectura real del DHT11." />
      {vacio && (
        <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-suave">
          Se llena 5 minutos después del primer pronóstico, cuando ya existe la lectura real para compararlo.
        </p>
      )}
    </div>
  );
}

export function SeccionModelos() {
  return (
    <div className="space-y-4">
      <ResumenModelos />
      <div className="grid gap-4 xl:grid-cols-2">
        <Bloque titulo="Confianza en el tiempo" nota="Cada punto toma el color de la clase predicha">
          <GraficoConfianza />
        </Bloque>
        <Bloque titulo="Probabilidades del ventilador" nota="Lo que el modelo cree en cada ventana de 2 s (suma 100 %)">
          <GraficoProbabilidades />
        </Bloque>
        <Bloque titulo="Pronóstico TinyML vs. realidad" nota="Error absoluto: pronóstico de hace 5 min menos la lectura real">
          <GraficoErrorPronostico />
        </Bloque>
        <Bloque titulo="Distribución de clases" nota="Predicciones recientes · número y confianza media" icono={<Gauge size={14} aria-hidden />}>
          <GraficoDistribucion />
        </Bloque>
      </div>
    </div>
  );
}

function Bloque({ titulo, nota, children, icono }: { titulo: string; nota: string; children: ReactNode; icono?: ReactNode }) {
  return (
    <div className="panel p-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">{icono}{titulo}</h3>
        <p className="text-[11px] text-suave">{nota}</p>
      </div>
      {children}
    </div>
  );
}
