// Estado del dashboard: un store mínimo con useSyncExternalStore (sin librerías extra).
import { useSyncExternalStore } from 'react';
import type { Alerta, ConfigBodega, Conexion, Evento, Imu, Lectura, Pronostico, Ventilador, Vision } from './tipos';
import { CONFIG_POR_DEFECTO } from './tipos';

const LIMITE = { lecturas: 400, pronostico: 400, imu: 300, ventilador: 300, vision: 60, alertas: 120 };

export interface Estado {
  conexion: Conexion;
  config: ConfigBodega;
  lecturas: Lectura[];
  pronostico: Pronostico[];
  imu: Imu[];
  ventilador: Ventilador[];
  vision: Vision[];
  alertas: Alerta[];          // historial, la más reciente primero
  activas: Record<string, Alerta>;
  foto: { url: string; t: number } | null;
  esp32Conectado: boolean | null;
  ultimoDato: number | null;  // hora del último evento del ESP32
  servicios: { mqtt: boolean; influx: boolean; telegram: boolean } | null;
  pausado: boolean;
}

let estado: Estado = {
  conexion: { modo: 'conectando' },
  config: CONFIG_POR_DEFECTO,
  lecturas: [], pronostico: [], imu: [], ventilador: [], vision: [], alertas: [],
  activas: {}, foto: null, esp32Conectado: null, ultimoDato: null, servicios: null, pausado: false,
};
const oyentes = new Set<() => void>();
let pendientes: Evento[] = [];
let programado = false;

const agregar = <T,>(lista: T[], item: T, max: number) => {
  const n = lista.length >= max ? lista.slice(lista.length - max + 1) : lista.slice();
  n.push(item);
  return n;
};

function aplicar(s: Estado, ev: Evento): Estado {
  switch (ev.tipo) {
    case 'lectura': return { ...s, lecturas: agregar(s.lecturas, ev, LIMITE.lecturas), ultimoDato: ev.t, esp32Conectado: true };
    case 'pronostico': return { ...s, pronostico: agregar(s.pronostico, ev, LIMITE.pronostico), ultimoDato: ev.t, esp32Conectado: true };
    case 'imu': return { ...s, imu: agregar(s.imu, ev, LIMITE.imu), ultimoDato: ev.t, esp32Conectado: true };
    case 'ventilador': return { ...s, ventilador: agregar(s.ventilador, ev, LIMITE.ventilador), ultimoDato: ev.t, esp32Conectado: true };
    case 'vision': return { ...s, vision: agregar(s.vision, ev, LIMITE.vision) };
    case 'foto': return { ...s, foto: { url: ev.url, t: ev.t } };
    case 'dispositivo': return ev.dispositivo.startsWith('esp32cam') ? s : { ...s, esp32Conectado: ev.conectado };
    case 'alerta': {
      const activas = { ...s.activas };
      if (ev.estado === 'activa') activas[ev.id] = ev; else delete activas[ev.id];
      return { ...s, activas, alertas: [ev, ...s.alertas].slice(0, LIMITE.alertas) };
    }
  }
}

function notificar() {
  for (const o of oyentes) o();
}

// Agrupa los eventos que llegan juntos en un solo render por cuadro
export function emitir(ev: Evento) {
  pendientes.push(ev);
  if (estado.pausado || programado) return;
  programado = true;
  requestAnimationFrame(vaciar);
}

function vaciar() {
  programado = false;
  if (estado.pausado || !pendientes.length) return;
  let s = estado;
  for (const ev of pendientes) s = aplicar(s, ev);
  pendientes = [];
  estado = s;
  notificar();
}

export function cargarInicial(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  notificar();
}

export function setConexion(conexion: Conexion) {
  estado = { ...estado, conexion };
  notificar();
}

export function setPausa(pausado: boolean) {
  estado = { ...estado, pausado };
  notificar();
  if (!pausado) vaciar();
}

export function reiniciar() {
  pendientes = [];
  estado = { ...estado, lecturas: [], pronostico: [], imu: [], ventilador: [], vision: [], alertas: [], activas: {}, foto: null, ultimoDato: null };
  notificar();
}

const suscribir = (o: () => void) => { oyentes.add(o); return () => oyentes.delete(o); };
export const leer = () => estado;

export function useBodega<T>(selector: (s: Estado) => T): T {
  return useSyncExternalStore(suscribir, () => selector(estado));
}

export const ultimo = <T,>(lista: T[]): T | undefined => lista[lista.length - 1];
