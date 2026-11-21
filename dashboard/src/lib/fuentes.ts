// Fuentes de datos: la API real (REST + WebSocket) o una demostración local.
// Las dos emiten los mismos eventos, así el resto del dashboard no sabe de dónde vienen.
import { cargarInicial, emitir, reiniciar, setConexion } from './store';
import type { Alerta, ConfigBodega, Evento, Imu, Lectura, Pronostico, Ventilador, Vision } from './tipos';

const params = new URLSearchParams(location.search);
export const API_BASE = (params.get('api') ?? '').replace(/\/$/, '');
export const FORZAR_DEMO = params.has('demo');
const VELOCIDAD_DEMO = Math.min(10, Math.max(0.25, Number(params.get('vel')) || 1)); // ?vel=3 acelera el guion
export const GRAFANA_URL = params.get('grafana') ?? `${location.protocol}//${location.hostname}:3000/d/bodega-ia`;

const wsUrl = () => {
  const base = API_BASE ? new URL(API_BASE) : location;
  return `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/ws`;
};

async function getJSON<T>(ruta: string): Promise<T> {
  const r = await fetch(API_BASE + ruta, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${ruta} respondió ${r.status}`);
  return r.json() as Promise<T>;
}

// ---------------- API real ----------------
export function conectarApi(alFallar: (motivo: string) => void): () => void {
  let ws: WebSocket | null = null;
  let cerrado = false;
  let reintento: ReturnType<typeof setTimeout> | undefined;
  let intentos = 0;

  const abrirWs = () => {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => { intentos = 0; setConexion({ modo: 'vivo' }); };
    ws.onmessage = (m) => {
      try { emitir(JSON.parse(m.data) as Evento); } catch { /* mensaje inválido: se ignora */ }
    };
    ws.onclose = () => {
      if (cerrado) return;
      setConexion({ modo: 'caido', detalle: 'Se perdió la conexión con la API. Reintentando…' });
      reintento = setTimeout(abrirWs, Math.min(15000, 1500 * 2 ** intentos++));
    };
  };

  (async () => {
    try {
      const est = await getJSON<{
        config: ConfigBodega;
        alarmas_activas: Alerta[];
        foto: string | null;
        dispositivos: Record<string, { conectado: boolean }>;
        servicios: { mqtt: boolean; influx: boolean; telegram: boolean };
      }>('/api/estado');
      const serie = <T,>(s: string) =>
        getJSON<{ datos: T[] }>(`/api/historial?serie=${s}&minutos=30`).then((r) => r.datos).catch(() => [] as T[]);
      const tipar = <T extends Evento>(tipo: T['tipo'], datos: Omit<T, 'tipo'>[]) => datos.map((d) => ({ ...d, tipo }) as T);
      const [lecturas, pronostico, imu, ventilador, vision, alertas] = await Promise.all([
        serie<Omit<Lectura, 'tipo'>>('lecturas'), serie<Omit<Pronostico, 'tipo'>>('pronostico'),
        serie<Omit<Imu, 'tipo'>>('imu'), serie<Omit<Ventilador, 'tipo'>>('ventilador'), serie<Omit<Vision, 'tipo'>>('vision'),
        getJSON<{ datos: Alerta[] }>('/api/alertas?limite=60').then((r) => r.datos).catch(() => []),
      ]);
      const ultimoT = Math.max(0, ...[lecturas, imu, ventilador].map((l) => l.at(-1)?.t ?? 0));
      cargarInicial({
        config: est.config,
        lecturas: tipar<Lectura>('lectura', lecturas),
        pronostico: tipar<Pronostico>('pronostico', pronostico).map((p) => ({ ...p, horizonte_min: p.horizonte_min ?? 5 })),
        imu: tipar<Imu>('imu', imu).slice(-300),
        ventilador: tipar<Ventilador>('ventilador', ventilador).map((v) => ({ ...v, probs: v.probs ?? {} })).slice(-300),
        vision: tipar<Vision>('vision', vision).map((v) => ({ ...v, probs: v.probs ?? {} })).slice(-60),
        alertas: alertas.map((a) => ({ ...a, tipo: 'alerta' as const })),
        activas: Object.fromEntries(est.alarmas_activas.map((a) => [a.id, { ...a, tipo: 'alerta' as const }])),
        foto: est.foto ? { url: API_BASE + est.foto, t: Date.now() } : null,
        esp32Conectado: est.dispositivos['esp32-01']?.conectado ?? null,
        ultimoDato: ultimoT || null,
        servicios: est.servicios,
      });
      if (!cerrado) abrirWs();
    } catch (e) {
      alFallar(e instanceof Error ? e.message : 'La API no responde');
    }
  })();

  return () => { cerrado = true; clearTimeout(reintento); ws?.close(); };
}

// ---------------- Demostración ----------------
// Guion de 3 minutos (el mismo de backend/simulador): humedad que sube, ventilador con fallas,
// cámara que detecta moho y recuperación. Incluye una versión simple de las reglas de alarma.
const CLASES_VENT = ['apagado', 'desbalanceado', 'normal', 'obstruido'];
const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.max(0, Math.min(1, k));
const gauss = (s: number) => (Math.random() + Math.random() + Math.random() - 1.5) * s * 1.4;

function guion(s: number) {
  const hum = s < 30 ? 57.5 : s < 75 ? lerp(57.5, 68.5, (s - 30) / 45) : s < 140 ? 68.5 : lerp(68.5, 58, (s - 140) / 30);
  const temp = s < 30 ? 21.4 : s < 140 ? lerp(21.4, 23.8, (s - 30) / 50) : lerp(23.8, 21.4, (s - 140) / 35);
  const vent = s >= 75 && s < 100 ? 'desbalanceado' : s >= 100 && s < 125 ? 'obstruido' : 'normal';
  const vision = s >= 120 && s < 140 ? 'moho' : 'sano';
  return { temp, hum, vent, vision };
}

function probs(dom: string, conf: number, clases: string[]): Record<string, number> {
  const r = clases.map(() => Math.random() + 0.2);
  const tot = r.reduce((a, b, i) => a + (clases[i] === dom ? 0 : b), 0);
  return Object.fromEntries(clases.map((c, i) => [c, +(c === dom ? conf : ((1 - conf) * r[i]) / tot).toFixed(3)]));
}

const fmt = (n: number, d = 1) => n.toFixed(d).replace('.', ',');

export function conectarDemo(cfg: ConfigBodega, motivo: string): () => void {
  reiniciar();
  setConexion({ modo: 'demo', motivo });
  const [t0, t1] = cfg.rango_temp, [h0, h1] = cfg.rango_hum;
  const fuera = (t: number, h: number) => t < t0 || t > t1 || h < h0 || h > h1;

  // Reglas de alarma (versión simplificada de backend/api/app/alarmas.py)
  const activas = new Map<string, Alerta>();
  const malas: Record<string, number> = {}, buenas: Record<string, number> = {};
  const regla = (id: string, nombre: string, nivel: Alerta['nivel'], malo: boolean, nAct: number, nRes: number, t: number, msg: string, msgOk: string) => {
    if (malo) {
      buenas[id] = 0; malas[id] = (malas[id] ?? 0) + 1;
      if (!activas.has(id) && malas[id] >= nAct) {
        const a: Alerta = { tipo: 'alerta', t, id, regla: nombre, nivel, estado: 'activa', mensaje: msg, notificar: true };
        activas.set(id, a); emitir(a);
      }
      return;
    }
    malas[id] = 0;
    if (!activas.has(id)) return;
    buenas[id] = (buenas[id] ?? 0) + 1;
    if (buenas[id] >= nRes) {
      activas.delete(id);
      emitir({ tipo: 'alerta', t, id, regla: nombre, nivel: 'info', estado: 'resuelta', mensaje: msgOk, notificar: true });
    }
  };

  // Historial de 15 min para que las gráficas no arranquen vacías
  let T = 21.4, H = 57.5;
  const ahora = Date.now();
  for (let i = 90; i > 0; i--) {
    const t = ahora - i * 10000;
    T += (21.4 - T) * 0.1 + gauss(0.06); H += (57.5 - H) * 0.1 + gauss(0.25);
    emitir({ tipo: 'lectura', t, dispositivo: 'esp32-01', temperatura: +T.toFixed(1), humedad: +H.toFixed(1), estado: 'OK' });
    emitir({ tipo: 'pronostico', t, dispositivo: 'esp32-01', temperatura_pred: +(T + gauss(0.1)).toFixed(1), humedad_pred: +(H + gauss(0.3)).toFixed(1), horizonte_min: 5, alerta: false });
  }
  emitir({ tipo: 'dispositivo', t: ahora, dispositivo: 'esp32-01', conectado: true });

  const inicio = performance.now();
  let tick = 0;
  const id = setInterval(() => {
    const s = (((performance.now() - inicio) / 1000) * VELOCIDAD_DEMO) % 180;
    const g = guion(s), t = Date.now();

    // Ventana de 2 s: IMU + ventilador
    const vib = ({ apagado: 0.002, normal: 0.035, desbalanceado: 0.11, obstruido: 0.06 } as Record<string, number>)[g.vent];
    const fase = t / 140;
    emitir({
      tipo: 'imu', t, dispositivo: 'esp32-01',
      ax: +(0.12 + Math.sin(fase) * vib * 4 + gauss(vib)).toFixed(3), ay: +(-0.08 + Math.cos(fase) * vib * 3 + gauss(vib)).toFixed(3),
      az: +(9.79 + gauss(vib * 2)).toFixed(3), gx: +gauss(30 * vib).toFixed(2), gy: +gauss(30 * vib).toFixed(2), gz: +gauss(12 * vib).toFixed(2),
      vib_rms: +(vib * (0.85 + Math.random() * 0.3)).toFixed(4),
    });
    const conf = g.vent === 'normal' ? 0.62 + Math.random() * 0.28 : 0.78 + Math.random() * 0.18;
    emitir({ tipo: 'ventilador', t, dispositivo: 'esp32-01', clase: g.vent, confianza: +conf.toFixed(3), probs: probs(g.vent, conf, CLASES_VENT), dsp_ms: 4, red_ms: 1 });
    const falla = cfg.clases_falla_ventilador.includes(g.vent) && conf >= cfg.umbral_ventilador;
    regla('ventilador_falla', 'ventilador', 'critica', falla, 3, 3, t, `Ventilador ${g.vent} (confianza ${fmt(conf, 2)}): revisar aspas y rejilla`, 'El ventilador volvió a funcionar normal');

    // Cada 10 s: DHT11 + pronóstico TinyML
    if (tick % 5 === 0) {
      T += (g.temp - T) * 0.5 + gauss(0.05); H += (g.hum - H) * 0.5 + gauss(0.2);
      emitir({ tipo: 'lectura', t, dispositivo: 'esp32-01', temperatura: +T.toFixed(1), humedad: +H.toFixed(1), estado: fuera(T, H) ? 'ALERTA' : 'OK' });
      const f = guion((s + 30) % 180);
      const tp = T + (f.temp - T) * 0.8 + gauss(0.1), hp = H + (f.hum - H) * 0.8 + gauss(0.3);
      emitir({ tipo: 'pronostico', t, dispositivo: 'esp32-01', temperatura_pred: +tp.toFixed(1), humedad_pred: +hp.toFixed(1), horizonte_min: 5, alerta: fuera(tp, hp) });
      const dh = hp > h1 ? hp - h1 : hp < h0 ? h0 - hp : 0;
      regla('pronostico', 'pronostico', dh >= 4 ? 'critica' : 'aviso', fuera(tp, hp), 1, 2, t,
        `Alerta anticipada: en 5 min la humedad llegaría a ${fmt(hp)} % (máx. ${h1} %)`, 'El pronóstico volvió al rango seguro');
      regla('ambiente', 'ambiente', 'critica', fuera(T, H), 1, 2, t,
        `Bodega fuera de rango: temperatura ${fmt(T)} °C, humedad ${fmt(H)} %`, 'La bodega volvió al rango seguro');
    }

    // Cada 10 s: ESP32-CAM
    if (tick % 5 === 2) {
      const cv = g.vision === 'sano' ? 0.86 + Math.random() * 0.11 : 0.8 + Math.random() * 0.13;
      emitir({ tipo: 'vision', t, dispositivo: 'esp32cam-01', clase: g.vision, confianza: +cv.toFixed(3), probs: probs(g.vision, cv, ['sano', 'moho', 'broca']) });
      const mala = cfg.clases_alerta_vision.includes(g.vision) && cv >= cfg.umbral_vision;
      regla('vision_moho', 'vision', 'aviso', mala && g.vision === 'moho', 1, 2, t,
        `La cámara detectó «moho» en el grano (confianza ${fmt(cv, 2)})`, 'La cámara ya no detecta «moho»');
    }
    tick++;
  }, 2000);

  return () => clearInterval(id);
}
