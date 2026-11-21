// Cabecera de la vista "Analítica" (sin 3D): veredicto + estado de cada modelo con su confianza.
import { BrainCircuit, Camera, Fan, Radio } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { COLOR_NIVEL, VENTILADOR, hace, num, pct } from '../lib/formato';
import { ultimo, useBodega } from '../lib/store';

// Anillo de confianza: el porcentaje va siempre escrito, el color solo refuerza
function Anillo({ valor, color, umbral }: { valor: number | null; color: string; umbral?: number }) {
  const r = 26, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 shrink-0 -rotate-90" aria-hidden>
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgb(255 228 196 / 0.08)" strokeWidth="6" />
      {umbral != null && (
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgb(255 228 196 / 0.45)" strokeWidth="8"
          strokeDasharray={`1.2 ${c}`} strokeDashoffset={-c * umbral} />
      )}
      <motion.circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - (valor ?? 0)) }} transition={{ type: 'spring', stiffness: 90, damping: 20 }} />
    </svg>
  );
}

function Modelo({ icono, titulo, herramienta, clase, detalle, confianza, color, umbral }: {
  icono: ReactNode; titulo: string; herramienta: string; clase: string; detalle: string; confianza: number | null; color: string; umbral?: number;
}) {
  return (
    <div className="rounded-xl border border-linea bg-panel-2/50 p-4">
      <div className="flex items-center gap-2 text-sm text-suave">{icono}<span>{titulo}</span></div>
      <div className="mt-3 flex items-center gap-3">
        <div className="relative">
          <Anillo valor={confianza} color={color} umbral={umbral} />
          <span className="cifra absolute inset-0 grid place-items-center text-xs font-semibold">{confianza != null ? pct(confianza) : '—'}</span>
        </div>
        <div className="min-w-0">
          <div className="truncate text-xl font-semibold tracking-tight" style={{ color }}>{clase}</div>
          <div className="text-xs text-suave">{detalle}</div>
          <div className="mt-0.5 text-[10px] text-tenue">{herramienta}</div>
        </div>
      </div>
    </div>
  );
}

export function EstadoModelos() {
  const v = useBodega((s) => ultimo(s.ventilador));
  const cam = useBodega((s) => ultimo(s.vision));
  const p = useBodega((s) => ultimo(s.pronostico));
  const cfg = useBodega((s) => s.config);
  const ultimoDato = useBodega((s) => s.ultimoDato);
  const esp32 = useBodega((s) => s.esp32Conectado);

  const infoV = v ? VENTILADOR[v.clase] : undefined;
  const camMala = !!cam && cfg.clases_alerta_vision.includes(cam.clase) && cam.confianza >= cfg.umbral_vision;
  const fuera = (x: number, r: [number, number]) => x < r[0] || x > r[1];
  const pronFuera = !!p && (fuera(p.temperatura_pred, cfg.rango_temp) || fuera(p.humedad_pred, cfg.rango_hum));

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Modelo icono={<BrainCircuit size={15} aria-hidden />} titulo="Pronóstico 5 min" herramienta="TinyML · TensorFlow Lite"
        clase={p ? (pronFuera ? 'Saldrá de rango' : 'Seguirá en rango') : 'Esperando'} confianza={null}
        detalle={p ? `${num(p.temperatura_pred)} °C · ${num(p.humedad_pred)} %` : 'sin pronóstico'}
        color={!p ? COLOR_NIVEL.info : pronFuera ? COLOR_NIVEL.aviso : COLOR_NIVEL.ok} />
      <Modelo icono={<Fan size={15} aria-hidden />} titulo="Ventilador" herramienta="Edge Impulse · MPU6050"
        clase={infoV?.etiqueta ?? v?.clase ?? 'Esperando'} confianza={v?.confianza ?? null} umbral={cfg.umbral_ventilador}
        detalle={v ? `umbral de alarma ${pct(cfg.umbral_ventilador)}` : 'sin clasificación'} color={infoV ? COLOR_NIVEL[infoV.nivel] : COLOR_NIVEL.info} />
      <Modelo icono={<Camera size={15} aria-hidden />} titulo="Cámara" herramienta="Edge Impulse · ESP32-CAM"
        clase={cam?.clase ?? 'Esperando'} confianza={cam?.confianza ?? null} umbral={cfg.umbral_vision}
        detalle={cam ? (camMala ? 'defecto detectado' : 'sin defectos') : 'sin imagen'} color={!cam ? COLOR_NIVEL.info : camMala ? COLOR_NIVEL.critica : COLOR_NIVEL.ok} />
      <Modelo icono={<Radio size={15} aria-hidden />} titulo="ESP32" herramienta="WiFi · MQTT"
        clase={esp32 === false ? 'Desconectado' : ultimoDato ? 'Publicando' : 'Esperando'} confianza={null}
        detalle={`último dato ${hace(ultimoDato)}`} color={esp32 === false ? COLOR_NIVEL.critica : ultimoDato ? COLOR_NIVEL.ok : COLOR_NIVEL.info} />
    </div>
  );
}
