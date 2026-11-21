// Modelo del ventilador (Edge Impulse): clase actual, probabilidades, línea de tiempo e IMU.
import type { EChartsOption } from 'echarts';
import { Cpu, Fan } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo } from 'react';
import { COLOR_NIVEL, VENTILADOR, hora, num, pct } from '../lib/formato';
import { ultimo, useBodega } from '../lib/store';
import Grafico, { EJE, TOOLTIP, horaEje } from './Grafico';

const ORDEN = ['apagado', 'normal', 'desbalanceado', 'obstruido'];

export function EstadoVentilador() {
  const v = useBodega((s) => ultimo(s.ventilador));
  const umbral = useBodega((s) => s.config.umbral_ventilador);
  const info = v ? VENTILADOR[v.clase] ?? { etiqueta: v.clase, nivel: 'info' as const, detalle: '' } : null;
  const clases = v ? [...new Set([...ORDEN, ...Object.keys(v.probs)])].filter((c) => c in v.probs || ORDEN.includes(c)) : ORDEN;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl" style={{ background: 'rgb(255 228 196 / 0.05)', color: info ? COLOR_NIVEL[info.nivel] : 'var(--color-suave)' }}>
          <Fan size={26} aria-hidden className={v && v.clase !== 'apagado' ? 'animate-spin [animation-duration:1.4s]' : ''} />
        </div>
        <div className="min-w-0">
          <div className="font-display text-3xl font-semibold leading-tight" style={{ color: info ? COLOR_NIVEL[info.nivel] : undefined }}>{info?.etiqueta ?? 'Esperando datos'}</div>
          <p className="text-sm text-suave">{info?.detalle ?? 'El ESP32 publica una clasificación cada 2 s.'}</p>
        </div>
      </div>

      <div className="mt-5 space-y-2.5" role="list" aria-label="Probabilidad de cada clase">
        {clases.map((c) => {
          const p = v?.probs[c] ?? (v?.clase === c ? v.confianza : 0);
          const nivel = VENTILADOR[c]?.nivel ?? 'info';
          return (
            <div key={c} role="listitem" className="grid grid-cols-[96px_1fr_44px] items-center gap-2 text-sm">
              <span className={v?.clase === c ? 'font-medium text-texto' : 'text-suave'}>{VENTILADOR[c]?.etiqueta ?? c}</span>
              <div className="relative h-2.5 overflow-hidden rounded-full bg-panel-2">
                <motion.div className="h-full rounded-full" initial={false} animate={{ width: `${p * 100}%` }} transition={{ type: 'spring', stiffness: 140, damping: 22 }}
                  style={{ background: COLOR_NIVEL[nivel], opacity: v?.clase === c ? 1 : 0.45 }} />
                <div className="absolute inset-y-0 w-px bg-texto/40" style={{ left: `${umbral * 100}%` }} title={`Umbral ${pct(umbral)}`} />
              </div>
              <span className="cifra text-right text-xs text-suave">{pct(p)}</span>
            </div>
          );
        })}
        <p className="pt-1 text-[11px] text-tenue">La línea vertical marca el umbral de alarma ({pct(umbral)}).</p>
      </div>

      <div className="mt-auto grid grid-cols-3 gap-2 border-t border-linea pt-3 text-xs">
        <Dato titulo="DSP" valor={v?.dsp_ms != null ? `${v.dsp_ms} ms` : '—'} />
        <Dato titulo="Red neuronal" valor={v?.red_ms != null ? `${v.red_ms} ms` : '—'} />
        <Dato titulo="Última" valor={v ? hora(v.t) : '—'} />
      </div>
    </div>
  );
}

function Dato({ titulo, valor }: { titulo: string; valor: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-tenue"><Cpu size={11} aria-hidden />{titulo}</div>
      <div className="cifra mt-0.5 text-sm text-texto">{valor}</div>
    </div>
  );
}

// Una celda por ventana de 2 s (últimos 2 minutos). Cada clase tiene color y letra.
export function LineaTiempoVentilador() {
  const lista = useBodega((s) => s.ventilador);
  const ventanas = lista.slice(-60);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="etiqueta">Últimas {ventanas.length} ventanas (2 s c/u)</span>
        <div className="hidden gap-3 text-[11px] text-suave sm:flex">
          {ORDEN.map((c) => (
            <span key={c} className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: COLOR_NIVEL[VENTILADOR[c].nivel] }} />{VENTILADOR[c].etiqueta}</span>
          ))}
        </div>
      </div>
      <div className="flex h-7 gap-[2px]" role="img" aria-label={`Historial del ventilador: ${ventanas.slice(-10).map((v) => v.clase).join(', ')}`}>
        {ventanas.map((v) => {
          const nivel = VENTILADOR[v.clase]?.nivel ?? 'info';
          return (
            <div key={v.t} className="flex-1 rounded-[3px] text-center font-mono text-[9px] leading-7 text-fondo/80"
              style={{ background: COLOR_NIVEL[nivel], opacity: 0.35 + v.confianza * 0.65 }} title={`${hora(v.t)} · ${v.clase} ${pct(v.confianza)}`}>
              {ventanas.length <= 40 ? v.clase[0].toUpperCase() : ''}
            </div>
          );
        })}
        {!ventanas.length && <div className="flex-1 rounded bg-panel-2" />}
      </div>
    </div>
  );
}

export function GraficoImu({ modo }: { modo: 'acel' | 'giro' }) {
  const imu = useBodega((s) => s.imu);
  const opcion = useMemo<EChartsOption>(() => {
    const ejes = modo === 'acel' ? (['ax', 'ay', 'az'] as const) : (['gx', 'gy', 'gz'] as const);
    const colores = ['#ec9f4a', '#3bb8c4', '#c9a0f0'];
    const tipos = ['solid', [6, 4], [2, 3]] as const;
    return {
      animation: false,
      grid: { left: 40, right: modo === 'acel' ? 44 : 12, top: 30, bottom: 24 },
      tooltip: { ...TOOLTIP, valueFormatter: (v) => (typeof v === 'number' ? v.toFixed(3) : String(v)) },
      legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: '#b3a293', fontSize: 11 } },
      xAxis: { type: 'time', ...EJE, splitLine: { show: false }, axisLabel: { ...EJE.axisLabel, formatter: horaEje } },
      yAxis: [
        { type: 'value', scale: true, name: modo === 'acel' ? 'm/s²' : '°/s', nameTextStyle: { color: '#8a7a6c', fontSize: 10 }, ...EJE },
        ...(modo === 'acel' ? [{ type: 'value' as const, name: 'RMS', min: 0, max: 0.2, nameTextStyle: { color: '#d9a55b', fontSize: 10 }, ...EJE, splitLine: { show: false } }] : []),
      ],
      series: [
        // az ronda 9,8 (gravedad): se centra restando su media para ver la vibración en la misma escala
        ...ejes.map((k, i) => ({
          name: k === 'az' ? 'az − g' : k, type: 'line' as const, showSymbol: false, yAxisIndex: 0,
          lineStyle: { width: 1.4, color: colores[i], type: tipos[i] as never }, itemStyle: { color: colores[i] },
          data: imu.filter((m) => m[k] != null).map((m) => [m.t, k === 'az' ? +(m.az - 9.81).toFixed(3) : m[k]!]),
        })),
        ...(modo === 'acel' ? [{
          name: 'vibración RMS', type: 'bar' as const, yAxisIndex: 1, barMaxWidth: 4, itemStyle: { color: 'rgba(217,165,91,0.45)' },
          data: imu.filter((m) => m.vib_rms != null).map((m) => [m.t, m.vib_rms!]),
        }] : []),
      ],
    };
  }, [imu, modo]);
  const u = ultimo(imu);
  const texto = modo === 'acel'
    ? `Acelerómetro: ax ${num(u?.ax, 2)}, ay ${num(u?.ay, 2)}, az ${num(u?.az, 2)} metros por segundo al cuadrado; vibración ${num(u?.vib_rms, 3)}.`
    : `Giroscopio: gx ${num(u?.gx, 1)}, gy ${num(u?.gy, 1)}, gz ${num(u?.gz, 1)} grados por segundo.`;
  return <Grafico opcion={opcion} alto={190} etiqueta={texto} />;
}
