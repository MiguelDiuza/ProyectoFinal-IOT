// Alarmas generadas a partir de los modelos de IA (las mismas que llegan a Telegram).
import { AlertOctagon, AlertTriangle, CheckCircle2, Send } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { COLOR_NIVEL, hora } from '../lib/formato';
import { useBodega } from '../lib/store';
import type { Alerta } from '../lib/tipos';
import { MODO } from '../lib/fuentes';

const ORIGEN: Record<string, string> = {
  pronostico: 'TinyML · pronóstico', ambiente: 'DHT11 · medida', ventilador: 'Edge Impulse · ventilador',
  vision: 'ESP32-CAM · imagen', sin_datos: 'Conexión',
};

function Icono({ a }: { a: Alerta }) {
  if (a.estado === 'resuelta') return <CheckCircle2 size={18} aria-hidden style={{ color: 'var(--color-ok)' }} />;
  return a.nivel === 'critica'
    ? <AlertOctagon size={18} aria-hidden style={{ color: COLOR_NIVEL.critica }} />
    : <AlertTriangle size={18} aria-hidden style={{ color: COLOR_NIVEL[a.nivel] }} />;
}

export function AlarmasActivas() {
  const activas = useBodega((s) => s.activas);
  const lista = Object.values(activas).sort((a, b) => b.t - a.t);
  if (!lista.length) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-linea bg-panel-2/60 px-3 py-2.5 text-sm text-suave">
        <CheckCircle2 size={16} aria-hidden style={{ color: 'var(--color-ok)' }} /> Sin alarmas activas
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      <AnimatePresence initial={false}>
        {lista.map((a) => (
          <motion.li key={a.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.22 }}
            className="flex gap-2.5 rounded-xl border px-3 py-2.5 text-sm"
            style={{ borderColor: a.nivel === 'critica' ? 'rgb(239 90 90 / 0.4)' : 'rgb(227 162 59 / 0.35)', background: a.nivel === 'critica' ? 'rgb(239 90 90 / 0.07)' : 'rgb(227 162 59 / 0.06)' }}>
            <Icono a={a} />
            <div className="min-w-0">
              <div className="leading-snug">{a.mensaje}</div>
              <div className="mt-0.5 text-[11px] text-suave">{ORIGEN[a.regla] ?? a.regla} · desde {hora(a.t)}</div>
            </div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

export function HistorialAlarmas() {
  const alertas = useBodega((s) => s.alertas);
  const telegram = useBodega((s) => s.servicios?.telegram);
  const modo = useBodega((s) => s.conexion.modo);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-suave">{MODO === 'serverless' ? 'El ESP32 publica cada alarma nueva y la Lambda bodega-alertas la envía por Telegram.' : 'Cada alarma que se activa o se resuelve también se envía por Telegram.'}</p>
        <span className="flex items-center gap-1.5 rounded-full border border-linea px-2.5 py-1 text-xs"
          style={{ color: telegram || (MODO === 'serverless' && modo !== 'demo') ? 'var(--color-ok)' : 'var(--color-suave)' }}>
          <Send size={12} aria-hidden /> {modo === 'demo' ? 'Telegram: simulado' : MODO === 'serverless' ? 'Telegram vía AWS Lambda' : telegram ? 'Telegram conectado' : 'Telegram sin configurar'}
        </span>
      </div>
      {!alertas.length ? (
        <p className="rounded-xl border border-dashed border-linea p-6 text-center text-sm text-suave">Todavía no se han generado alarmas.</p>
      ) : (
        <ol className="max-h-[340px] space-y-1 overflow-y-auto pr-1" aria-live="polite" aria-label="Historial de alarmas">
          {alertas.slice(0, 40).map((a) => (
            <li key={`${a.id}-${a.t}-${a.estado}`} className="grid grid-cols-[22px_76px_1fr] items-start gap-2 rounded-lg px-2 py-2 text-sm odd:bg-panel-2/40">
              <Icono a={a} />
              <span className="cifra pt-0.5 text-xs text-suave">{hora(a.t)}</span>
              <div className="min-w-0">
                <span className={a.estado === 'resuelta' ? 'text-suave' : ''}>{a.mensaje}</span>
                <span className="ml-2 whitespace-nowrap text-[11px] text-tenue">{ORIGEN[a.regla] ?? a.regla}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
