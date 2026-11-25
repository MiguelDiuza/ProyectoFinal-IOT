import { Activity, Box, Coffee, Download, LayoutGrid, Lightbulb, Pause, Play, Radio, Wifi, WifiOff } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { AlarmasActivas, HistorialAlarmas } from './components/Alarmas';
import { PanelCamara } from './components/Camara';
import { GraficoClima, TarjetasClima } from './components/Clima';
import { SeccionModelos } from './components/Modelos';
import { EstadoVentilador, GraficoImu, LineaTiempoVentilador } from './components/Ventilador';
import { EstadoModelos } from './components/VistaAnalitica';
import { CSV_URL, FORZAR_DEMO, MODO, conectarApi, conectarDemo, conectarServerless, enviarLed } from './lib/fuentes';
import { hace } from './lib/formato';
import { leer, setPausa, ultimo, useBodega } from './lib/store';

const GemeloDigital = lazy(() => import('./components/GemeloDigital'));

function useAhora(ms = 1000) {
  const [ahora, setAhora] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setAhora(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return ahora;
}

// ---------- Vista: con gemelo 3D o solo analítica (se recuerda en este navegador) ----------
type Vista = '3d' | 'analitica';
function useVista() {
  const inicial = (): Vista => {
    const q = new URLSearchParams(location.search).get('vista');
    if (q === '3d' || q === 'analitica') return q;
    try { return localStorage.getItem('bodega-vista') === 'analitica' ? 'analitica' : '3d'; } catch { return '3d'; }
  };
  const [vista, setVista] = useState<Vista>(inicial);
  const cambiar = (v: Vista) => { setVista(v); try { localStorage.setItem('bodega-vista', v); } catch { /* sin almacenamiento */ } };
  return [vista, cambiar] as const;
}

function SelectorVista({ vista, setVista }: { vista: Vista; setVista: (v: Vista) => void }) {
  const op = [['3d', 'Gemelo 3D', Box], ['analitica', 'Analítica', LayoutGrid]] as const;
  return (
    <div role="group" aria-label="Vista del dashboard" className="flex rounded-lg border border-linea bg-panel/70 p-0.5">
      {op.map(([id, texto, Icono]) => (
        <button key={id} type="button" aria-pressed={vista === id} onClick={() => setVista(id)}
          className={`flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors ${vista === id ? 'bg-pergamino/15 text-pergamino' : 'text-suave hover:text-texto'}`}>
          <Icono size={13} aria-hidden />{texto}
        </button>
      ))}
    </div>
  );
}

// ---------- Conexión: API real, y si no responde, demostración claramente marcada ----------
function useFuente() {
  const [modoDemo, setModoDemo] = useState(FORZAR_DEMO);
  useEffect(() => {
    if (modoDemo) return conectarDemo(leer().config, FORZAR_DEMO ? 'Modo demostración (?demo)' : 'Elegiste la demostración');
    let detenerDemo: (() => void) | undefined;
    const conectar = MODO === 'serverless' ? conectarServerless : conectarApi;
    const detenerApi = conectar((motivo) => { detenerDemo = conectarDemo(leer().config, `La API no responde (${motivo})`); });
    return () => { detenerApi(); detenerDemo?.(); };
  }, [modoDemo]);
  return { modoDemo, setModoDemo };
}

// ---------- Notificaciones en pantalla para cada alarma nueva ----------
function useAvisos() {
  const alertas = useBodega((s) => s.alertas);
  const visto = useRef<string | null>(null);
  const abierto = useRef(Date.now());
  useEffect(() => {
    const a = alertas[0];
    if (!a) return;
    const clave = `${a.id}-${a.t}-${a.estado}`;
    if (clave === visto.current) return;
    // Solo se avisan las alarmas nuevas: las del historial (anteriores a abrir la página) no
    const nuevas = [];
    for (const x of alertas) {
      if (`${x.id}-${x.t}-${x.estado}` === visto.current || x.t < abierto.current - 2000) break;
      nuevas.push(x);
    }
    visto.current = clave;
    for (const x of nuevas.reverse()) {
      if (x.estado === 'resuelta') toast.success(x.mensaje);
      else if (x.nivel === 'critica') toast.error(x.mensaje, { duration: 8000 });
      else toast.warning(x.mensaje, { duration: 6000 });
    }
  }, [alertas]);
}

function EstadoConexion() {
  const conexion = useBodega((s) => s.conexion);
  const ultimoDato = useBodega((s) => s.ultimoDato);
  const ahora = useAhora();
  const viejo = ultimoDato != null && ahora - ultimoDato > 30_000;
  const [texto, color, Icono] =
    conexion.modo === 'vivo' ? (viejo ? [`Sin datos del ESP32 · ${hace(ultimoDato, ahora)}`, 'var(--color-aviso)', WifiOff] : [`En vivo · ${hace(ultimoDato, ahora)}`, 'var(--color-ok)', Wifi])
      : conexion.modo === 'demo' ? ['Demostración', 'var(--color-pergamino)', Radio]
        : conexion.modo === 'caido' ? ['Reconectando…', 'var(--color-critica)', WifiOff]
          : ['Conectando…', 'var(--color-suave)', Wifi];
  return (
    <div className="flex items-center gap-2 rounded-full border border-linea bg-panel/70 px-3 py-1.5 text-xs" role="status"
      title={conexion.modo === 'demo' ? conexion.motivo : conexion.modo === 'caido' ? conexion.detalle : undefined}>
      <span className="relative flex h-2 w-2">
        {conexion.modo === 'vivo' && !viejo && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: color }} />}
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: color }} />
      </span>
      <Icono size={13} aria-hidden style={{ color }} />
      <span>{texto}</span>
    </div>
  );
}

function Encabezado({ modoDemo, setModoDemo, vista, setVista }: { modoDemo: boolean; setModoDemo: (v: boolean) => void; vista: Vista; setVista: (v: Vista) => void }) {
  const pausado = useBodega((s) => s.pausado);
  const enlaces = [['resumen', 'Resumen'], ['clima', 'Clima'], ['modelos', 'Modelos IA'], ['ventilador', 'Ventilador'], ['camara', 'Cámara'], ['alarmas', 'Alarmas']];
  const boton = 'flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-linea px-3 text-xs text-suave transition-colors hover:border-linea-fuerte hover:text-texto';
  return (
    <header className="sticky top-0 z-30 border-b border-linea bg-fondo/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <a href="#resumen" className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-pergamino/15 text-pergamino"><Coffee size={19} aria-hidden /></span>
          <span className="leading-tight">
            <span className="block font-display text-[17px] font-semibold">Bodega 1</span>
            <span className="block text-[11px] text-suave">Café pergamino · IA en el borde</span>
          </span>
        </a>
        <nav aria-label="Secciones" className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto lg:order-none lg:w-auto">
          {enlaces.map(([id, t]) => (
            <a key={id} href={`#${id}`} className="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm text-suave transition-colors hover:bg-panel-2 hover:text-texto">{t}</a>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SelectorVista vista={vista} setVista={setVista} />
          <EstadoConexion />
          <button type="button" className={boton} onClick={() => setPausa(!pausado)} aria-pressed={pausado}>
            {pausado ? <Play size={13} aria-hidden /> : <Pause size={13} aria-hidden />}{pausado ? 'Reanudar' : 'Pausar'}
          </button>
          <button type="button" className={boton} onClick={() => setModoDemo(!modoDemo)}>
            <Activity size={13} aria-hidden />{modoDemo ? 'Conectar a la API' : 'Ver demostración'}
          </button>
          {CSV_URL && <a className={boton} href={CSV_URL} download><Download size={13} aria-hidden />Descargar CSV</a>}
        </div>
      </div>
    </header>
  );
}

// Actuador: el LED D2 del ESP32 se prende o apaga desde la API (Lambda → IoT Core → bodega1/led)
function ControlLed() {
  const led = useBodega((s) => s.led);
  const conexion = useBodega((s) => s.conexion);
  const [enviando, setEnviando] = useState<'ON' | 'OFF' | null>(null);
  const enviar = async (estado: 'ON' | 'OFF') => {
    setEnviando(estado);
    try {
      await enviarLed(estado);
      toast.success(estado === 'ON' ? 'LED encendido: orden enviada al ESP32' : 'LED apagado: orden enviada al ESP32');
    } catch (e) {
      toast.error(`No se pudo enviar la orden al ESP32: ${e instanceof Error ? e.message : 'error de red'}. Revisa la conexión con la API.`);
    } finally {
      setEnviando(null);
    }
  };
  const boton = (activo: boolean) =>
    `flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors disabled:cursor-wait disabled:opacity-60 ${activo ? 'border-pergamino/60 bg-pergamino/15 text-pergamino' : 'border-linea text-suave hover:border-linea-fuerte hover:text-texto'}`;
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="etiqueta">Actuador · LED D2</span>
        <span className="flex items-center gap-1.5 text-xs text-suave">
          <Lightbulb size={13} aria-hidden style={{ color: led === 'ON' ? 'var(--color-aviso)' : undefined }} />
          {led === 'ON' ? 'Encendido' : led === 'OFF' ? 'Apagado' : 'Sin reporte'}
        </span>
      </div>
      <div className="mt-3 flex gap-2" role="group" aria-label="Encender o apagar el LED del ESP32">
        <button type="button" className={boton(led === 'ON')} disabled={!!enviando} onClick={() => enviar('ON')}>{enviando === 'ON' ? 'Enviando…' : 'Encender'}</button>
        <button type="button" className={boton(led === 'OFF')} disabled={!!enviando} onClick={() => enviar('OFF')}>{enviando === 'OFF' ? 'Enviando…' : 'Apagar'}</button>
      </div>
      {conexion.modo === 'demo' && <p className="mt-2 text-[11px] text-tenue">En la demostración la orden no sale del navegador.</p>}
    </div>
  );
}

// Frase principal: lo más importante que hay que saber de la bodega en este momento
function Veredicto() {
  const activas = useBodega((s) => s.activas);
  const l = useBodega((s) => ultimo(s.lecturas));
  const lista = Object.values(activas).sort((a, b) => (a.nivel === 'critica' ? -1 : 1) - (b.nivel === 'critica' ? -1 : 1) || b.t - a.t);
  const peor = lista[0];
  const [titulo, sub, color] = !l
    ? ['Esperando al ESP32', 'Todavía no llegan lecturas de los sensores.', 'var(--color-suave)']
    : !peor
      ? ['La bodega está en condiciones seguras', 'Clima en rango, ventilador sano y grano sin defectos según los tres modelos.', 'var(--color-ok)']
      : peor.regla === 'pronostico' && lista.length === 1
        ? ['Riesgo en los próximos 5 minutos', peor.mensaje, 'var(--color-aviso)']
        : [lista.length > 1 ? `${lista.length} alarmas requieren atención` : 'Requiere atención', peor.mensaje, peor.nivel === 'critica' ? 'var(--color-critica)' : 'var(--color-aviso)'];
  return (
    <motion.div key={titulo} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
      <span className="etiqueta flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />Estado general</span>
      <h1 className="mt-2 max-w-xl font-display text-3xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[42px]">
        <span style={{ color }}>{titulo}</span>
      </h1>
      <p className="mt-2 max-w-lg text-sm text-suave sm:text-base">{sub}</p>
    </motion.div>
  );
}

function Seccion({ id, titulo, subtitulo, children, className = '' }: { id: string; titulo: string; subtitulo: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-t`} className={`scroll-mt-28 ${className}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 id={`${id}-t`} className="font-display text-2xl font-semibold tracking-tight">{titulo}</h2>
        <p className="text-sm text-suave">{subtitulo}</p>
      </div>
      {children}
    </section>
  );
}

function Hero() {
  const l = useBodega((s) => ultimo(s.lecturas));
  const v = useBodega((s) => ultimo(s.ventilador));
  const cam = useBodega((s) => ultimo(s.vision));
  const cfg = useBodega((s) => s.config);
  const reducir = useReducedMotion() ?? false;
  return (
    <section id="resumen" aria-label="Resumen" className="scroll-mt-28 grid gap-4 lg:grid-cols-12">
      <div className="panel relative min-h-[440px] overflow-hidden lg:col-span-8 lg:min-h-[560px]">
        <Suspense fallback={<div className="absolute inset-0 animate-pulse bg-panel-2/50" />}>
          <GemeloDigital temperatura={l?.temperatura} humedad={l?.humedad} rangoHum={cfg.rango_hum} ventClase={v?.clase} ventConf={v?.confianza}
            visionClase={cam?.clase} visionMala={!!cam && cfg.clases_alerta_vision.includes(cam.clase) && cam.confianza >= cfg.umbral_vision} reducirMovimiento={reducir} />
        </Suspense>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-fondo/95 via-fondo/60 to-transparent p-5 pb-16 sm:p-7 sm:pb-20">
          <Veredicto />
        </div>
        <div className="pointer-events-none absolute bottom-3 left-4 right-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-tenue">
          <span>Gemelo digital · arrastra para girar</span>
          <span className="hidden sm:inline">Niebla = humedad · color de los sacos = riesgo de moho · cono = cámara</span>
        </div>
      </div>
      <div className="flex flex-col gap-4 lg:col-span-4">
        <TarjetasClima />
        <div className="panel p-4">
          <span className="etiqueta">Alarmas activas</span>
          <div className="mt-3"><AlarmasActivas /></div>
        </div>
        <ControlLed />
      </div>
    </section>
  );
}

function HeroAnalitico() {
  return (
    <section id="resumen" aria-label="Resumen" className="scroll-mt-28 grid gap-4 lg:grid-cols-12">
      <div className="panel grano flex flex-col gap-6 p-5 sm:p-7 lg:col-span-8">
        <Veredicto />
        <div>
          <span className="etiqueta">Lo que dicen los modelos ahora</span>
          <div className="mt-3"><EstadoModelos /></div>
        </div>
        <div id="clima" className="mt-auto scroll-mt-28">
          <span className="etiqueta">Temperatura y humedad · medida y pronóstico</span>
          <GraficoClima />
        </div>
      </div>
      <div className="flex flex-col gap-4 lg:col-span-4">
        <TarjetasClima />
        <div className="panel p-4">
          <span className="etiqueta">Alarmas activas</span>
          <div className="mt-3"><AlarmasActivas /></div>
        </div>
        <ControlLed />
      </div>
    </section>
  );
}

function Arquitectura() {
  const pasos = MODO === 'serverless'
    ? ['DHT11 + MPU6050 + ESP32-CAM', 'TinyML + Edge Impulse en el borde', 'MQTT/TLS · AWS IoT Core', 'Reglas IoT → DynamoDB', 'Lambda + API Gateway', 'Dashboard en S3 · Telegram']
    : ['DHT11 + MPU6050', 'ESP32 · TinyML + Edge Impulse', 'MQTT · Mosquitto', 'Telegraf → InfluxDB', 'API · alarmas', 'Dashboard · Grafana · Telegram'];
  return (
    <footer className="mx-auto max-w-[1440px] px-4 pb-10 pt-4 sm:px-6">
      <ol className="flex flex-wrap items-center gap-2 text-xs text-suave" aria-label="Arquitectura del sistema">
        {pasos.map((p, i) => (
          <li key={p} className="flex items-center gap-2">
            <span className="rounded-md border border-linea px-2 py-1">{p}</span>
            {i < pasos.length - 1 && <span aria-hidden className="text-tenue">→</span>}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-tenue">Proyecto final · Inteligencia Artificial aplicada a Internet de las Cosas · Especialización en IA</p>
    </footer>
  );
}

export default function App() {
  const fuente = useFuente();
  const [vista, setVista] = useVista();
  useAvisos();
  return (
    <>
      <a href="#resumen" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2">Saltar al contenido</a>
      <Encabezado {...fuente} vista={vista} setVista={setVista} />
      <main className="mx-auto max-w-[1440px] space-y-10 px-4 py-6 sm:px-6">
        {vista === '3d' ? <Hero /> : <HeroAnalitico />}

        {vista === '3d' && (
          <Seccion id="clima" titulo="Clima y pronóstico" subtitulo="DHT11 cada 10 s · modelo TinyML pronostica a 5 min (línea punteada)">
            <div className="panel p-4"><GraficoClima /></div>
          </Seccion>
        )}

        <Seccion id="modelos" titulo="Modelos de IA" subtitulo="Comportamiento y confianza de los tres modelos que corren en el borde">
          <SeccionModelos />
        </Seccion>

        <Seccion id="ventilador" titulo="Ventilador" subtitulo="MPU6050 a 100 Hz · Edge Impulse clasifica la vibración cada 2 s">
          <div className="grid gap-4 lg:grid-cols-12">
            <div className="panel p-5 lg:col-span-4"><EstadoVentilador /></div>
            <div className="panel space-y-4 p-4 lg:col-span-8">
              <LineaTiempoVentilador />
              <div className="grid gap-2 xl:grid-cols-2">
                <div><span className="etiqueta">Acelerómetro</span><GraficoImu modo="acel" /></div>
                <div><span className="etiqueta">Giroscopio</span><GraficoImu modo="giro" /></div>
              </div>
            </div>
          </div>
        </Seccion>

        <Seccion id="camara" titulo="Cámara" subtitulo="ESP32-CAM · clasificación de imágenes del grano">
          <div className="panel p-4 sm:p-5"><PanelCamara /></div>
        </Seccion>

        <Seccion id="alarmas" titulo="Alarmas" subtitulo="Generadas a partir de los resultados de los modelos de IA">
          <div className="panel p-4 sm:p-5"><HistorialAlarmas /></div>
        </Seccion>
      </main>
      <Arquitectura />
      <Toaster theme="dark" position="bottom-right" richColors closeButton toastOptions={{ style: { fontFamily: 'Geist Variable' } }} />
    </>
  );
}
