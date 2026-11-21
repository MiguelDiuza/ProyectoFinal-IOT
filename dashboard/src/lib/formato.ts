import type { Nivel } from './tipos';

export const num = (n: number | undefined | null, d = 1) =>
  n == null || Number.isNaN(n) ? '—' : n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });

export const hora = (t: number) => new Date(t).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function hace(t: number | null, ahora = Date.now()): string {
  if (!t) return 'sin datos';
  const s = Math.max(0, Math.round((ahora - t) / 1000));
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
}

export const COLOR_NIVEL: Record<Nivel | 'ok', string> = {
  ok: 'var(--color-ok)', info: 'var(--color-info)', aviso: 'var(--color-aviso)', critica: 'var(--color-critica)',
};

// Los mismos colores en hex, para ECharts (canvas no resuelve variables CSS)
export const COLOR_HEX = { ok: '#4fb477', info: '#6aa7e8', aviso: '#e3a23b', critica: '#ef5a5a' } as const;

// Estado del ventilador: color + texto (nunca solo color)
export const VENTILADOR: Record<string, { etiqueta: string; nivel: Nivel | 'ok'; detalle: string }> = {
  apagado: { etiqueta: 'Apagado', nivel: 'info', detalle: 'Sin vibración: el motor está detenido' },
  normal: { etiqueta: 'Normal', nivel: 'ok', detalle: 'Vibración dentro del patrón de entrenamiento' },
  desbalanceado: { etiqueta: 'Desbalanceado', nivel: 'critica', detalle: 'Aspa con peso extra: vibración fuerte y periódica' },
  obstruido: { etiqueta: 'Obstruido', nivel: 'aviso', detalle: 'Rejilla tapada: menos flujo de aire' },
  incierto: { etiqueta: 'Incierto', nivel: 'info', detalle: 'Ninguna clase supera el umbral de confianza' },
};

export const pct = (p: number) => `${Math.round(p * 100)} %`;
