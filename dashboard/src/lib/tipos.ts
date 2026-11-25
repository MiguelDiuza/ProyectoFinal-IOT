// Eventos que llegan por WebSocket desde la API (contrato: docs/contrato-mqtt.md)

export type Nivel = 'info' | 'aviso' | 'critica';

export interface Lectura { tipo: 'lectura'; t: number; dispositivo: string; temperatura: number; humedad: number; estado: 'OK' | 'ALERTA' }
export interface Pronostico { tipo: 'pronostico'; t: number; dispositivo: string; temperatura_pred: number; humedad_pred: number; horizonte_min: number; alerta?: boolean }
// El sketch de AWS (bodega_final.ino) solo manda el RMS de la ventana; el local manda además los ejes
export interface Imu { tipo: 'imu'; t: number; dispositivo: string; ax?: number; ay?: number; az?: number; gx?: number; gy?: number; gz?: number; vib_rms?: number; rms_giro?: number }
export interface Clasificacion { t: number; dispositivo: string; clase: string; confianza: number; probs: Record<string, number> }
export interface Ventilador extends Clasificacion { tipo: 'ventilador'; dsp_ms?: number; red_ms?: number }
export interface Vision extends Clasificacion { tipo: 'vision' }
export interface Alerta { tipo: 'alerta'; t: number; id: string; regla: string; nivel: Nivel; estado: 'activa' | 'resuelta'; mensaje: string; valor?: number | null; notificar?: boolean }
export interface Foto { tipo: 'foto'; t: number; dispositivo: string; url: string }
export interface Dispositivo { tipo: 'dispositivo'; t: number; dispositivo: string; conectado: boolean }
export interface Led { tipo: 'led'; t: number; estado: 'ON' | 'OFF' }

export type Evento = Lectura | Pronostico | Imu | Ventilador | Vision | Alerta | Foto | Dispositivo | Led;

export interface ConfigBodega {
  rango_temp: [number, number];
  rango_hum: [number, number];
  umbral_ventilador: number;
  umbral_vision: number;
  clases_falla_ventilador: string[];
  clases_alerta_vision: string[];
}

export type Conexion =
  | { modo: 'conectando' }
  | { modo: 'vivo' }
  | { modo: 'demo'; motivo: string }
  | { modo: 'caido'; detalle: string };

export const CONFIG_POR_DEFECTO: ConfigBodega = {
  rango_temp: [15, 25],
  rango_hum: [50, 65],
  umbral_ventilador: 0.6,
  umbral_vision: 0.7,
  clases_falla_ventilador: ['desbalanceado', 'obstruido'],
  clases_alerta_vision: ['negro', 'partido', 'moho', 'broca', 'defecto'],
};
