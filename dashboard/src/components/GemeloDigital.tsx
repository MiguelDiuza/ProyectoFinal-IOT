// Gemelo digital 3D de la bodega: los datos de los sensores y de los modelos de IA mueven la escena.
//  - Ventilador: gira, tiembla o se frena según la clase de Edge Impulse.
//  - Niebla de humedad: más densa cuanto más húmeda está la bodega.
//  - Sacos de café: se oscurecen si la humedad sale del rango (riesgo de moho).
//  - Cono de la ESP32-CAM: color según la clasificación de la imagen.
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Html, OrbitControls, RoundedBox } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { VENTILADOR, pct } from '../lib/formato';

export interface DatosGemelo {
  temperatura?: number;
  humedad?: number;
  rangoHum: [number, number];
  ventClase?: string;
  ventConf?: number;
  visionClase?: string;
  visionMala: boolean;
  reducirMovimiento: boolean;
}

const C = {
  ok: new THREE.Color('#4fb477'), aviso: new THREE.Color('#e3a23b'), critica: new THREE.Color('#ef5a5a'),
  info: new THREE.Color('#6aa7e8'), saco: new THREE.Color('#8f6a43'), sacoHumedo: new THREE.Color('#3f3326'),
  hum: new THREE.Color('#3bb8c4'),
};

function Ventilador({ clase = 'normal', reducir }: { clase?: string; reducir: boolean }) {
  const aspas = useRef<THREE.Group>(null!);
  const cuerpo = useRef<THREE.Group>(null!);
  const aro = useRef<THREE.MeshStandardMaterial>(null!);
  const nivel = VENTILADOR[clase]?.nivel ?? 'info';
  const color = C[nivel === 'ok' ? 'ok' : nivel];

  useFrame((estado, dt) => {
    const vel = { apagado: 0, normal: 14, desbalanceado: 13, obstruido: 5, incierto: 8 }[clase] ?? 8;
    if (!reducir) aspas.current.rotation.z -= vel * dt;
    const tiempo = estado.clock.elapsedTime;
    const temblor = clase === 'desbalanceado' && !reducir ? 0.035 : clase === 'obstruido' && !reducir ? 0.008 : 0;
    cuerpo.current.position.x = 1.6 + Math.sin(tiempo * 41) * temblor;
    cuerpo.current.position.y = 2.35 + Math.cos(tiempo * 37) * temblor;
    aro.current.color.lerp(color, 0.08);
    aro.current.emissive.lerp(color, 0.08);
    aro.current.emissiveIntensity = nivel === 'critica' ? 0.9 + Math.sin(tiempo * 6) * 0.5 : 0.6;
  });

  return (
    <group ref={cuerpo} position={[1.6, 2.35, -2.9]}>
      <mesh>
        <torusGeometry args={[0.95, 0.07, 16, 64]} />
        <meshStandardMaterial ref={aro} color="#4fb477" emissive="#4fb477" emissiveIntensity={0.6} roughness={0.4} />
      </mesh>
      {/* rejilla */}
      {[0.35, 0.65].map((r) => (
        <mesh key={r} position={[0, 0, 0.08]}>
          <torusGeometry args={[r, 0.012, 8, 48]} />
          <meshStandardMaterial color="#5c4a3b" metalness={0.6} roughness={0.5} />
        </mesh>
      ))}
      <group ref={aspas}>
        <mesh>
          <cylinderGeometry args={[0.14, 0.14, 0.12, 24]} />
          <meshStandardMaterial color="#c9b49a" metalness={0.7} roughness={0.3} />
        </mesh>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i} rotation={[0.35, 0, (i * Math.PI) / 2]} position={[Math.cos((i * Math.PI) / 2) * 0.45, Math.sin((i * Math.PI) / 2) * 0.45, 0]}>
            <boxGeometry args={[0.62, 0.2, 0.02]} />
            <meshStandardMaterial color="#d9cbb8" metalness={0.5} roughness={0.35} />
          </mesh>
        ))}
        {clase === 'desbalanceado' && (
          <mesh position={[0.62, 0.05, 0.03]}>
            <cylinderGeometry args={[0.07, 0.07, 0.03, 16]} />
            <meshStandardMaterial color="#e3c16f" metalness={0.9} roughness={0.2} />
          </mesh>
        )}
      </group>
      {clase === 'obstruido' && (
        <mesh position={[0.35, -0.2, 0.16]} rotation={[0, 0, 0.2]}>
          <boxGeometry args={[0.9, 0.8, 0.02]} />
          <meshStandardMaterial color="#a8865a" roughness={0.95} />
        </mesh>
      )}
    </group>
  );
}

function Sacos({ humedad, rango }: { humedad?: number; rango: [number, number] }) {
  // Un solo material para todos los sacos: se cambia el color de todos a la vez
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8f6a43', roughness: 0.95 }), []);
  const posiciones = useMemo(() => {
    const p: [number, number, number, number][] = [];
    for (const [px, pz] of [[-2.1, -0.4], [2.1, -0.4], [-2.1, 1.6]] as const) {
      for (let capa = 0; capa < 3; capa++)
        for (let i = 0; i < 2; i++)
          for (let j = 0; j < 2; j++)
            if (!(capa === 2 && i === 1 && j === 1)) p.push([px + (i - 0.5) * 0.82, 0.32 + capa * 0.42, pz + (j - 0.5) * 0.56, (i + j + capa) % 2 ? 0.05 : -0.05]);
    }
    return p;
  }, []);

  useFrame(() => {
    const exceso = humedad == null ? 0 : Math.max(0, Math.min(1, (humedad - rango[1] + 2) / 8));
    material.color.lerp(C.saco.clone().lerp(C.sacoHumedo, exceso), 0.05);
  });

  return (
    <group>
      {[[-2.1, -0.4], [2.1, -0.4], [-2.1, 1.6]].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.07, z]} receiveShadow>
          <boxGeometry args={[1.8, 0.14, 1.25]} />
          <meshStandardMaterial color="#4a3627" roughness={0.9} />
        </mesh>
      ))}
      {posiciones.map(([x, y, z, rot], k) => (
        <RoundedBox key={k} args={[0.78, 0.4, 0.52]} radius={0.16} smoothness={3} position={[x, y, z]} rotation={[0, rot, 0]} castShadow>
          <primitive object={material} attach="material" />
        </RoundedBox>
      ))}
    </group>
  );
}

function NieblaHumedad({ humedad, reducir }: { humedad?: number; reducir: boolean }) {
  const puntos = useRef<THREE.Points>(null!);
  const mat = useRef<THREE.PointsMaterial>(null!);
  const N = 700;
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      p[i * 3] = (Math.random() - 0.5) * 8;
      p[i * 3 + 1] = Math.random() * 3.6;
      p[i * 3 + 2] = (Math.random() - 0.5) * 6;
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    return g;
  }, []);

  useFrame((e, dt) => {
    const objetivo = humedad == null ? 0.05 : Math.max(0.04, Math.min(0.75, (humedad - 50) / 25));
    mat.current.opacity += (objetivo - mat.current.opacity) * 0.05;
    if (reducir) return;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < N; i++) {
      let y = pos.getY(i) + dt * (0.08 + (i % 7) * 0.012);
      if (y > 3.6) y = 0;
      pos.setY(i, y);
      pos.setX(i, pos.getX(i) + Math.sin(e.clock.elapsedTime * 0.3 + i) * dt * 0.04);
    }
    pos.needsUpdate = true;
  });

  return (
    <points ref={puntos} geometry={geo}>
      <pointsMaterial ref={mat} color={C.hum} size={0.045} transparent opacity={0.1} depthWrite={false} sizeAttenuation />
    </points>
  );
}

function Camara({ mala, clase }: { mala: boolean; clase?: string }) {
  const cono = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame((e) => {
    cono.current.color.lerp(mala ? C.critica : clase ? C.ok : C.info, 0.06);
    cono.current.opacity = mala ? 0.13 + Math.sin(e.clock.elapsedTime * 5) * 0.05 : 0.045;
  });
  return (
    <group position={[2.9, 2.9, 1.6]} rotation={[0, 0, 0]}>
      <mesh>
        <boxGeometry args={[0.26, 0.2, 0.2]} />
        <meshStandardMaterial color="#2b211a" roughness={0.5} />
      </mesh>
      <mesh position={[-0.13, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.06, 0.06, 0.05, 16]} />
        <meshStandardMaterial color="#111" metalness={0.8} roughness={0.2} />
      </mesh>
      {/* campo de visión hacia los sacos */}
      <mesh position={[-1.55, -1.25, -0.6]} rotation={[0.25, 0, 0.98]}>
        <coneGeometry args={[0.7, 3.4, 32, 1, true]} />
        <meshBasicMaterial ref={cono} color="#4fb477" transparent opacity={0.09} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Esp32() {
  const led = useRef<THREE.MeshStandardMaterial>(null!);
  useFrame((e) => { led.current.emissiveIntensity = Math.sin(e.clock.elapsedTime * 4) > 0.6 ? 3 : 0.4; });
  return (
    <group position={[-3.4, 1.35, -2.86]}>
      <mesh>
        <boxGeometry args={[0.5, 0.32, 0.06]} />
        <meshStandardMaterial color="#1d3b2c" roughness={0.6} />
      </mesh>
      <mesh position={[0.17, 0.1, 0.04]}>
        <sphereGeometry args={[0.025, 12, 12]} />
        <meshStandardMaterial ref={led} color="#4fb477" emissive="#4fb477" emissiveIntensity={1} />
      </mesh>
    </group>
  );
}

function Etiqueta({ posicion, titulo, valor, nivel }: { posicion: [number, number, number]; titulo: string; valor: string; nivel: string }) {
  return (
    <Html position={posicion} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
      <div className="whitespace-nowrap rounded-md border border-linea-fuerte bg-fondo/85 px-2 py-1 backdrop-blur" style={{ borderLeft: `3px solid var(--color-${nivel})` }}>
        <div className="text-[9px] uppercase tracking-[0.14em] text-suave">{titulo}</div>
        <div className="font-mono text-xs text-texto">{valor}</div>
      </div>
    </Html>
  );
}

function Escena(d: DatosGemelo) {
  const luz = useRef<THREE.PointLight>(null!);
  useFrame(() => {
    const calor = d.temperatura == null ? 0 : Math.max(0, Math.min(1, (d.temperatura - 18) / 10));
    luz.current.color.lerp(new THREE.Color('#ffd7a0').lerp(new THREE.Color('#ff7a3d'), calor), 0.05);
  });
  const vent = VENTILADOR[d.ventClase ?? ''] ?? null;
  const nivelVent = vent ? (vent.nivel === 'ok' ? 'ok' : vent.nivel) : 'info';

  return (
    <>
      <color attach="background" args={['#0d0805']} />
      <fog attach="fog" args={['#0d0805', 9, 18]} />
      <ambientLight intensity={0.35} />
      <hemisphereLight args={['#ffe2bd', '#1a0f08', 0.5]} />
      <directionalLight position={[4, 6, 5]} intensity={1.1} color="#ffe0b8" castShadow />
      <pointLight ref={luz} position={[0, 3.3, 0.5]} intensity={18} distance={9} color="#ffd7a0" />

      {/* piso y muros */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[14, 12]} />
        <meshStandardMaterial color="#20160f" roughness={0.95} />
      </mesh>
      <gridHelper args={[14, 28, '#3a2a1e', '#2a1d14']} position={[0, 0.002, 0]} />
      <mesh position={[0, 2, -3.05]}>
        <planeGeometry args={[14, 4]} />
        <meshStandardMaterial color="#1a110b" roughness={1} />
      </mesh>
      <mesh position={[-4, 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[12, 4]} />
        <meshStandardMaterial color="#160e09" roughness={1} />
      </mesh>

      <Sacos humedad={d.humedad} rango={d.rangoHum} />
      <Ventilador clase={d.ventClase} reducir={d.reducirMovimiento} />
      <NieblaHumedad humedad={d.humedad} reducir={d.reducirMovimiento} />
      <Camara mala={d.visionMala} clase={d.visionClase} />
      <Esp32 />
      <ContactShadows position={[0, 0.01, 0]} opacity={0.5} scale={12} blur={2.4} far={4} />

      <Etiqueta posicion={[1.6, 1.05, -2.9]} titulo="Ventilador · Edge Impulse" nivel={nivelVent}
        valor={vent ? `${vent.etiqueta} ${d.ventConf != null ? pct(d.ventConf) : ''}` : 'esperando datos'} />
      <Etiqueta posicion={[2.9, 2.55, 1.6]} titulo="ESP32-CAM" nivel={d.visionMala ? 'critica' : d.visionClase ? 'ok' : 'info'} valor={d.visionClase ?? 'esperando'} />
      <Etiqueta posicion={[-2.1, 1.9, -0.4]} titulo="Café pergamino" nivel={d.humedad != null && d.humedad > d.rangoHum[1] ? 'critica' : 'ok'}
        valor={d.humedad != null ? `${d.humedad.toFixed(1).replace('.', ',')} % HR` : '—'} />

      <OrbitControls enableZoom={false} enablePan={false} autoRotate={!d.reducirMovimiento} autoRotateSpeed={0.35}
        minPolarAngle={0.85} maxPolarAngle={1.35} minAzimuthAngle={-0.9} maxAzimuthAngle={0.9} target={[0.6, 1.25, -0.2]} />
    </>
  );
}

export default function GemeloDigital(d: DatosGemelo) {
  // Detiene el render cuando el gemelo no está en pantalla (ahorra batería/CPU)
  const contenedor = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = contenedor.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={contenedor} className="absolute inset-0">
      <Canvas shadows dpr={[1, 1.75]} frameloop={visible ? 'always' : 'never'} camera={{ position: [3.6, 2.9, 7.6], fov: 44 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}>
        <Escena {...d} />
      </Canvas>
    </div>
  );
}
