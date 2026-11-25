// Fuentes de datos: AWS serverless (API Gateway + Lambda + DynamoDB), la API local
// (REST + WebSocket) o una demostración. Todas emiten los mismos eventos, así el resto del
// dashboard no sabe de dónde vienen.
import { cargarInicial, emitir, leer, reiniciar, setConexion } from './store';
import type { Alerta, ConfigBodega, Evento, Imu, Lectura, Nivel, Pronostico, Ventilador, Vision } from './tipos';

// public/config.js (se edita en S3 sin recompilar) define window.BODEGA_CONFIG
interface ConfigDespliegue { api?: string; modo?: string; sondeoSeg?: number; camaraVivo?: string }
const DESPLIEGUE: ConfigDespliegue = (window as unknown as { BODEGA_CONFIG?: ConfigDespliegue }).BODEGA_CONFIG ?? {};

const params = new URLSearchParams(location.search);
export const API_BASE = (params.get('api') ?? DESPLIEGUE.api ?? '').trim().replace(/\/$/, '');
export const MODO: 'serverless' | 'local' = (params.get('modo') ?? DESPLIEGUE.modo) === 'serverless' ? 'serverless' : 'local';
export const FORZAR_DEMO = params.has('demo');
// Vista en vivo de la ESP32-CAM (http://<IP> en la red local; ?cam=http://IP también sirve).
// Solo se ve si quien abre el dashboard está en la misma red WiFi que la cámara.
export const CAMARA_VIVO = (params.get('cam') ?? DESPLIEGUE.camaraVivo ?? '').trim().replace(/\/$/, '');
const VELOCIDAD_DEMO = Math.min(10, Math.max(0.25, Number(params.get('vel')) || 1)); // ?vel=3 acelera el guion
const SONDEO_MS = Math.min(60, Math.max(2, Number(DESPLIEGUE.sondeoSeg) || 5)) * 1000;
export const CSV_URL = MODO === 'serverless' && API_BASE ? `${API_BASE}/lecturas/csv?horas=24` : null;

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

// ---------------- AWS serverless: API Gateway → Lambda bodega-api → DynamoDB ----------------
// El navegador no puede suscribirse a AWS IoT Core sin credenciales, así que pregunta a la API
// cada SONDEO_MS por lo nuevo. Contrato de los datos: docs/contrato-aws.md
type Item = Record<string, unknown>;
const n = (v: unknown) => {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
};
const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Item) : undefined);
const bool = (v: unknown) => (v === true || v === 'true' || v === 1 ? true : v === false || v === 'false' || v === 0 ? false : undefined);
const lista = (v: unknown) => (Array.isArray(v) ? (v.filter(obj) as Item[]) : []);
const tsDe = (it: Item) => { const t = n(it.ts) ?? Date.now(); return t < 1e12 ? t * 1000 : t; };
function probsDe(v: unknown) {
  const r: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v) ?? {})) { const y = n(x); if (y !== undefined) r[k] = y; }
  return r;
}

// Un item de bodega1/lecturas trae sensores + las predicciones del ESP32 en un solo mensaje.
// Nombres de esp32/bodega_final.ino: t_pred, h_pred, estado_futuro, alerta_anticipada, vent_clase,
// vent_confianza, vent_falla, rms_acc, rms_giro, led. También se aceptan variantes largas o anidadas.
export function eventosDeLectura(it: Item, cfg: ConfigBodega): Evento[] {
  const t = tsDe(it), dispositivo = s(it.dispositivo) ?? 'esp32-01';
  const ev: Evento[] = [];
  const T = n(it.temperatura), H = n(it.humedad);
  if (T !== undefined && H !== undefined) {
    const [t0, t1] = cfg.rango_temp, [h0, h1] = cfg.rango_hum;
    const est = s(it.estado)?.toUpperCase();
    const estado = est === 'OK' || est === 'ALERTA' ? est : T < t0 || T > t1 || H < h0 || H > h1 ? 'ALERTA' : 'OK';
    ev.push({ tipo: 'lectura', t, dispositivo, temperatura: T, humedad: H, estado });
  }
  const pron = obj(it.pronostico) ?? {};
  const tp = n(it.t_pred) ?? n(it.temp_pred) ?? n(it.temperatura_pred) ?? n(pron.temperatura) ?? n(pron.temperatura_pred);
  const hp = n(it.h_pred) ?? n(it.hum_pred) ?? n(it.humedad_pred) ?? n(pron.humedad) ?? n(pron.humedad_pred);
  if (tp !== undefined && hp !== undefined) {
    ev.push({ tipo: 'pronostico', t, dispositivo, temperatura_pred: tp, humedad_pred: hp,
      horizonte_min: n(it.horizonte_min) ?? n(pron.horizonte_min) ?? 5,
      alerta: bool(it.estado_futuro === undefined ? it.alerta_pred ?? pron.alerta : it.estado_futuro === 'ALERTA') });
  }
  const imu = obj(it.imu) ?? it;
  const m: Imu = { tipo: 'imu', t, dispositivo, ax: n(imu.ax), ay: n(imu.ay), az: n(imu.az), gx: n(imu.gx), gy: n(imu.gy), gz: n(imu.gz),
    vib_rms: n(imu.vib_rms) ?? n(it.rms_acc), rms_giro: n(it.rms_giro) };
  if (m.ax !== undefined || m.vib_rms !== undefined || m.rms_giro !== undefined) ev.push(m);
  const vent = obj(it.ventilador) ?? {};
  const clase = s(it.ventilador) ?? s(it.vent_clase) ?? s(vent.clase);
  if (clase) {
    const confianza = n(it.vent_confianza) ?? n(it.vent_conf) ?? n(vent.confianza) ?? 0;
    const probs = probsDe(it.vent_probs ?? vent.probs);
    ev.push({ tipo: 'ventilador', t, dispositivo, clase, confianza,
      // el sketch de AWS no manda todas las probabilidades: se muestra la de la clase elegida
      probs: Object.keys(probs).length ? probs : { [clase]: confianza },
      dsp_ms: n(it.dsp_ms ?? vent.dsp_ms), red_ms: n(it.red_ms ?? vent.red_ms) });
  }
  const led = s(it.led)?.toUpperCase();
  if (led === 'ON' || led === 'OFF') ev.push({ tipo: 'led', t, estado: led });
  return ev;
}

export function eventosDeCamara(it: Item): Evento[] {
  const clase = s(it.clase);
  if (!clase) return [];
  const t = tsDe(it), dispositivo = s(it.dispositivo) ?? 'bodega1-camara';
  const probs = probsDe(it.probs);
  // camara_bodega.ino manda prob_negro, prob_partido, prob_sano como campos sueltos
  for (const [k, x] of Object.entries(it)) if (k.startsWith('prob_')) { const y = n(x); if (y !== undefined) probs[k.slice(5)] = y; }
  const ev: Evento[] = [{ tipo: 'vision', t, dispositivo, clase, confianza: n(it.confianza) ?? probs[clase] ?? 0, probs }];
  const foto = s(it.foto) ?? s(it.imagen);
  if (foto && /^https?:\/\//.test(foto)) ev.push({ tipo: 'foto', t, dispositivo, url: foto });
  return ev;
}

// "tipo" que publica bodega_final.ino en bodega1/alertas → regla y nivel del dashboard
const TIPO_ALERTA: Record<string, { regla: string; nivel: Nivel }> = {
  alerta_anticipada: { regla: 'pronostico', nivel: 'aviso' },   // ahora OK, en 5 min fuera de rango
  alerta_th: { regla: 'ambiente', nivel: 'critica' },           // ya fuera de rango y seguirá así
  falla_ventilador: { regla: 'ventilador', nivel: 'critica' },
  grano_defectuoso: { regla: 'vision', nivel: 'aviso' },
};

export function eventoDeAlerta(it: Item): Alerta | null {
  const mensaje = s(it.mensaje);
  if (!mensaje) return null;
  const tipo = TIPO_ALERTA[s(it.tipo) ?? ''];
  const regla = s(it.regla) ?? tipo?.regla ?? s(it.tipo) ?? 'esp32';
  const nivel = (['info', 'aviso', 'critica'] as Nivel[]).find((x) => x === it.nivel) ?? tipo?.nivel ?? 'aviso';
  return { tipo: 'alerta', t: tsDe(it), id: s(it.id) ?? regla, regla, nivel, estado: it.estado === 'resuelta' ? 'resuelta' : 'activa', mensaje, valor: n(it.valor) ?? null };
}

// El ESP32 avisa cuando una alarma aparece, pero no cuando se resuelve: se deduce de los datos.
// Devuelve, por regla, si la condición sigue mala según el último dato de cada modelo.
function condicionesActuales(evs: Evento[], cfg: ConfigBodega): Record<string, boolean> {
  const c: Record<string, boolean> = {};
  let pron: Pronostico | undefined, lect: Lectura | undefined;
  for (const e of evs) {
    if (e.tipo === 'pronostico') { pron = e; c.pronostico = !!e.alerta; }
    if (e.tipo === 'lectura') lect = e;
    if (e.tipo === 'ventilador') c.ventilador = cfg.clases_falla_ventilador.includes(e.clase) && e.confianza >= cfg.umbral_ventilador;
    if (e.tipo === 'vision') c.vision = cfg.clases_alerta_vision.includes(e.clase) && e.confianza >= cfg.umbral_vision;
  }
  if (lect) c.ambiente = lect.estado === 'ALERTA' || !!pron?.alerta;
  return c;
}

const RESUELTA: Record<string, string> = {
  pronostico: 'El pronóstico volvió al rango seguro',
  ambiente: 'La bodega volvió al rango seguro',
  ventilador: 'El ventilador volvió a funcionar normal',
  vision: 'La cámara volvió a ver grano sano',
};

interface Paquete { lecturas: Item[]; camara: Item[]; alertas: Item[] }

export function conectarServerless(alFallar: (motivo: string) => void): () => void {
  if (!API_BASE) {
    alFallar('falta la URL de la API en config.js');
    return () => {};
  }
  let cerrado = false;
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  let rutaDashboard: boolean | undefined; // ¿la Lambda tiene GET /dashboard? (la de la Act. 3 solo tiene /lecturas)
  let ultimoTs = 0;
  let enLinea = false;
  const vistos = new Set<string>();
  const activas = new Set<string>(); // reglas con una alarma abierta (para resolverla cuando los datos mejoren)

  const pedirJSON = async (ruta: string) => {
    const r = await fetch(API_BASE + ruta, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!r.ok) throw new Error(`${ruta.split('?')[0]} respondió ${r.status}`);
    return r.json() as Promise<unknown>;
  };

  async function pedir(desde: number | null): Promise<Paquete> {
    if (rutaDashboard !== false) {
      try {
        const j = obj(await pedirJSON(desde ? `/dashboard?desde=${desde}` : '/dashboard?minutos=30')) ?? {};
        rutaDashboard = true;
        return { lecturas: lista(j.lecturas), camara: lista(j.camara), alertas: lista(j.alertas) };
      } catch (e) {
        if (rutaDashboard === true) throw e;
        rutaDashboard = false; // Lambda vieja: seguir solo con las lecturas
      }
    }
    const horas = desde ? Math.max(0.02, (Date.now() - desde) / 3.6e6 + 0.01) : 0.5;
    return { lecturas: lista(await pedirJSON(`/lecturas?horas=${horas.toFixed(3)}`)), camara: [], alertas: [] };
  }

  function aplicarPaquete(p: Paquete) {
    const cfg = leer().config;
    const nuevos: Evento[] = [];
    const tomar = (serie: string, it: Item, convertir: (it: Item) => Evento[]) => {
      const clave = `${serie}:${tsDe(it)}:${s(it.dispositivo) ?? ''}`;
      if (vistos.has(clave)) return;
      vistos.add(clave);
      ultimoTs = Math.max(ultimoTs, tsDe(it));
      nuevos.push(...convertir(it));
    };
    for (const it of p.lecturas) tomar('l', it, (x) => eventosDeLectura(x, cfg));
    for (const it of p.camara) tomar('c', it, eventosDeCamara);
    for (const it of p.alertas) tomar('a', it, (x) => { const a = eventoDeAlerta(x); return a ? [a] : []; });
    nuevos.sort((a, b) => a.t - b.t);
    for (const ev of nuevos) {
      emitir(ev);
      if (ev.tipo === 'alerta') { if (ev.estado === 'activa') activas.add(ev.id); else activas.delete(ev.id); }
    }
    const cond = condicionesActuales(nuevos, cfg);
    const tFin = nuevos.at(-1)?.t ?? Date.now();
    for (const id of [...activas]) {
      if (cond[id] === false) {
        activas.delete(id);
        emitir({ tipo: 'alerta', t: tFin, id, regla: id, nivel: 'info', estado: 'resuelta', mensaje: RESUELTA[id] ?? `${id}: volvió a la normalidad` });
      }
    }
    if (vistos.size > 5000) vistos.clear(); // la ventana de "desde" evita duplicados igual
  }

  const ciclo = async () => {
    try {
      // Se piden 20 s de solapamiento por si DynamoDB entrega algo un poco tarde (los duplicados se descartan)
      aplicarPaquete(await pedir(ultimoTs ? ultimoTs - 20_000 : null));
      if (!enLinea) { enLinea = true; setConexion({ modo: 'vivo' }); }
    } catch (e) {
      const motivo = e instanceof Error ? e.message : 'la API no responde';
      if (!ultimoTs && !enLinea) { alFallar(motivo); return; } // nunca conectó: pasar a la demostración
      enLinea = false;
      setConexion({ modo: 'caido', detalle: `No se pudo leer la API (${motivo}). Reintentando…` });
    }
    if (!cerrado) temporizador = setTimeout(ciclo, SONDEO_MS);
  };

  reiniciar();
  setConexion({ modo: 'conectando' });
  ciclo();
  return () => { cerrado = true; clearTimeout(temporizador); };
}

// Actuador: API → Lambda → IoT Core publica ON/OFF en bodega1/led.
// Se envía como text/plain para que el navegador no haga la consulta previa de CORS (OPTIONS).
export async function enviarLed(estado: 'ON' | 'OFF'): Promise<void> {
  if (MODO !== 'serverless' || !API_BASE || leer().conexion.modo === 'demo') {
    emitir({ tipo: 'led', t: Date.now(), estado });
    return;
  }
  const r = await fetch(`${API_BASE}/led`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ estado }), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`la API respondió ${r.status}`);
  emitir({ tipo: 'led', t: Date.now(), estado }); // el ESP32 lo confirma en su próxima lectura
}

// ---------------- Demostración ----------------
// Guion de 3 minutos (el mismo de backend/simulador): humedad que sube, ventilador con fallas,
// cámara que detecta granos negros y partidos, y recuperación. Incluye una versión simple de las reglas de alarma.
const CLASES_VENT = ['apagado', 'desbalanceado', 'normal', 'obstruido'];
const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.max(0, Math.min(1, k));
const gauss = (s: number) => (Math.random() + Math.random() + Math.random() - 1.5) * s * 1.4;

function guion(s: number) {
  const hum = s < 30 ? 57.5 : s < 75 ? lerp(57.5, 68.5, (s - 30) / 45) : s < 140 ? 68.5 : lerp(68.5, 58, (s - 140) / 30);
  const temp = s < 30 ? 21.4 : s < 140 ? lerp(21.4, 23.8, (s - 30) / 50) : lerp(23.8, 21.4, (s - 140) / 35);
  const vent = s >= 75 && s < 100 ? 'desbalanceado' : s >= 100 && s < 125 ? 'obstruido' : 'normal';
  const vision = s >= 120 && s < 132 ? 'negro' : s >= 132 && s < 142 ? 'partido' : 'sano';
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
      emitir({ tipo: 'vision', t, dispositivo: 'bodega1-camara', clase: g.vision, confianza: +cv.toFixed(3), probs: probs(g.vision, cv, ['sano', 'negro', 'partido']) });
      const mala = cfg.clases_alerta_vision.includes(g.vision) && cv >= cfg.umbral_vision;
      regla('vision', 'vision', g.vision === 'negro' ? 'critica' : 'aviso', mala, 1, 2, t,
        `La cámara detectó grano ${g.vision} (confianza ${fmt(cv, 2)})`, 'La cámara volvió a ver grano sano');
    }
    tick++;
  }, 2000);

  return () => clearInterval(id);
}
