// Clasificación de imágenes de la ESP32-CAM: última foto, probabilidades e historial.
import { Camera, ImageOff } from 'lucide-react';
import { motion } from 'motion/react';
import { hora, pct } from '../lib/formato';
import { ultimo, useBodega } from '../lib/store';

export function PanelCamara() {
  const v = useBodega((s) => ultimo(s.vision));
  const historial = useBodega((s) => s.vision);
  const foto = useBodega((s) => s.foto);
  const cfg = useBodega((s) => s.config);
  const esMala = (c: string, p: number) => cfg.clases_alerta_vision.includes(c) && p >= cfg.umbral_vision;
  const mala = v ? esMala(v.clase, v.confianza) : false;
  const color = !v ? 'var(--color-suave)' : mala ? 'var(--color-critica)' : 'var(--color-ok)';
  const clases = v ? Object.entries(v.probs).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <figure className="relative aspect-[4/3] overflow-hidden rounded-xl border border-linea bg-panel-2">
        {foto ? (
          <img src={foto.url} alt={`Última foto de la ESP32-CAM, clasificada como ${v?.clase ?? 'sin clasificar'}`} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <GranosIlustracion mala={mala} />
            <figcaption className="absolute bottom-3 left-3 right-3 flex items-center justify-center gap-1.5 text-xs text-suave">
              <ImageOff size={13} aria-hidden className="shrink-0" /> <span>La ESP32-CAM publica solo la clasificación; la ilustración refleja lo que ve</span>
            </figcaption>
          </div>
        )}
        {v && (
          <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg bg-fondo/85 px-2.5 py-1 text-sm backdrop-blur" style={{ borderLeft: `3px solid ${color}` }}>
            <Camera size={13} aria-hidden style={{ color }} /> <span className="font-medium">{v.clase}</span> <span className="cifra text-suave">{pct(v.confianza)}</span>
          </div>
        )}
      </figure>

      <div className="flex flex-col">
        <span className="etiqueta">Clasificación actual</span>
        <div className="mt-1 font-display text-3xl font-semibold" style={{ color }}>
          {v ? (mala ? `Grano con ${v.clase}` : v.clase === 'sano' ? 'Grano sano' : v.clase) : 'Esperando imagen'}
        </div>
        <p className="text-sm text-suave">{v ? `Recibida a las ${hora(v.t)} desde ${v.dispositivo}` : 'La ESP32-CAM clasifica una imagen cada pocos segundos.'}</p>

        <div className="mt-4 space-y-2.5">
          {clases.map(([c, p]) => (
            <div key={c} className="grid grid-cols-[80px_1fr_44px] items-center gap-2 text-sm">
              <span className={c === v?.clase ? 'font-medium' : 'text-suave'}>{c}</span>
              <div className="h-2.5 overflow-hidden rounded-full bg-panel-2">
                <motion.div className="h-full rounded-full" initial={false} animate={{ width: `${p * 100}%` }} transition={{ type: 'spring', stiffness: 140, damping: 22 }}
                  style={{ background: cfg.clases_alerta_vision.includes(c) ? 'var(--color-critica)' : 'var(--color-ok)', opacity: c === v?.clase ? 1 : 0.45 }} />
              </div>
              <span className="cifra text-right text-xs text-suave">{pct(p)}</span>
            </div>
          ))}
        </div>

        <div className="mt-auto pt-4">
          <span className="etiqueta">Últimas imágenes</span>
          <ol className="mt-2 flex flex-wrap gap-1.5" aria-label="Historial de clasificaciones">
            {historial.slice(-14).reverse().map((h) => {
              const m = esMala(h.clase, h.confianza);
              return (
                <li key={h.t} title={`${hora(h.t)} · ${pct(h.confianza)}`} className="rounded-md border px-2 py-0.5 text-[11px]"
                  style={{ borderColor: m ? 'rgb(239 90 90 / 0.5)' : 'var(--color-linea)', color: m ? 'var(--color-critica)' : 'var(--color-suave)' }}>
                  {h.clase}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

// Ilustración de granos de café pergamino (cuando no hay foto real)
function GranosIlustracion({ mala }: { mala: boolean }) {
  const granos = Array.from({ length: 22 }, (_, i) => ({
    x: 30 + ((i * 53) % 240), y: 30 + ((i * 37) % 150), r: (i * 47) % 180, manchado: mala && i % 4 === 0,
  }));
  return (
    <svg viewBox="0 0 300 210" className="h-full w-full opacity-80" aria-hidden>
      {granos.map((g, i) => (
        <g key={i} transform={`translate(${g.x} ${g.y}) rotate(${g.r})`}>
          <ellipse rx="15" ry="10" fill={g.manchado ? '#4d5b3c' : '#c9a774'} />
          <path d="M-12 0 Q0 4 12 0" stroke="#7a5a35" strokeWidth="1.6" fill="none" />
          {g.manchado && <circle r="4" cx="4" cy="-2" fill="#8fa36b" opacity="0.8" />}
        </g>
      ))}
    </svg>
  );
}
