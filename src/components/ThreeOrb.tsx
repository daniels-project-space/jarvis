"use client";
import { useEffect, useRef } from "react";

// Premium audio-reactive orb: a high-poly icosphere displaced by GLSL simplex
// noise, fresnel rim + emissive core, UnrealBloom glow, particle halo, camera
// drift, and per-state colour palettes. Driven by live voice amplitude.
type State = "idle" | "listening" | "thinking" | "speaking";

const PAL: Record<State, { a: string; b: string; accent: string; bloom: number; amp: number }> = {
  idle: { a: "#FFD700", b: "#FF9500", accent: "#FFED4E", bloom: 0.45, amp: 0.16 },
  listening: { a: "#FFED4E", b: "#FFD700", accent: "#FFFF99", bloom: 0.5, amp: 0.28 },
  thinking: { a: "#FFA500", b: "#FF8C00", accent: "#FFD700", bloom: 0.5, amp: 0.28 },
  speaking: { a: "#FFD700", b: "#FFA500", accent: "#FFFF99", bloom: 0.58, amp: 0.4 },
};

const VERT = /* glsl */ `
uniform float uTime, uBass, uMid, uTreble, uLevel, uAmp, uFreq;
varying vec3 vNormal; varying vec3 vWorldPos; varying float vDisp;
vec3 mod289(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 mod289(vec4 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314*r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0); const vec4 D = vec4(0.0,0.5,1.0,2.0);
  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx; vec3 x2 = x0 - i2 + C.yyy; vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0,i1.z,i2.z,1.0)) + i.y + vec4(0.0,i1.y,i2.y,1.0)) + i.x + vec4(0.0,i1.x,i2.x,1.0));
  float n_ = 0.142857142857; vec3 ns = n_*D.wyz - D.xzx;
  vec4 j = p - 49.0*floor(p*ns.z*ns.z); vec4 x_ = floor(j*ns.z); vec4 y_ = floor(j - 7.0*x_);
  vec4 x = x_*ns.x + ns.yyyy; vec4 y = y_*ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0; vec4 s1 = floor(b1)*2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy,h.x); vec3 p1 = vec3(a0.zw,h.y); vec3 p2 = vec3(a1.xy,h.z); vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0); m = m*m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){ float f=0.0, amp=0.5; for(int i=0;i<4;i++){ f+=amp*snoise(p); p*=2.0; amp*=0.5; } return f; }
void main(){
  vNormal = normal;
  float amp = uAmp * (1.0 + uBass*2.2 + uLevel*0.8);
  float freq = uFreq * (1.0 + uMid*0.6);
  float t = uTime * (0.35 + uTreble*0.9);
  vec3 np = position*freq + vec3(0.0,0.0,t);
  float base = fbm(np);
  float ripple = snoise(position*(freq*3.0) + t*2.0) * (uTreble*0.35);
  float disp = base*amp + ripple;
  vec3 displaced = position + normal*disp;
  vDisp = disp;
  vec4 wp = modelMatrix * vec4(displaced,1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uColorAccent;
uniform float uTreble, uLevel;
varying vec3 vNormal; varying vec3 vWorldPos; varying float vDisp;
void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - max(dot(N,V),0.0), 2.5);
  vec3 col = mix(uColorA, uColorB, fres);
  col = mix(col, uColorAccent, smoothstep(0.15,0.5,vDisp) * (0.3 + uTreble*0.5));
  float intensity = 0.25 + fres*1.6 + uLevel*0.22;
  col *= intensity;
  col += uColorA * (0.04 + 0.06*uLevel);
  gl_FragColor = vec4(col, 1.0);
}`;

export default function ThreeOrb({
  state = "idle",
  energyRef,
}: {
  state?: State;
  energyRef?: { current: number };
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<State>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const mount = mountRef.current!;
    let raf = 0;
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      const { EffectComposer } = await import("three/addons/postprocessing/EffectComposer.js");
      const { RenderPass } = await import("three/addons/postprocessing/RenderPass.js");
      const { UnrealBloomPass } = await import("three/addons/postprocessing/UnrealBloomPass.js");
      const { OutputPass } = await import("three/addons/postprocessing/OutputPass.js");
      if (disposed) return;

      const lin = (hex: string) => new THREE.Color(hex).convertSRGBToLinear();
      const w = () => mount.clientWidth || 1;
      const h = () => mount.clientHeight || 1;
      const mobile = Math.min(window.innerWidth, window.innerHeight) < 768;
      const prCap = mobile ? 1.5 : 2;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prCap));
      renderer.setSize(w(), h());
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, w() / h(), 0.1, 100);
      camera.position.z = 4.3;

      const p0 = PAL[stateRef.current];
      const uniforms = {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uLevel: { value: 0 },
        uAmp: { value: p0.amp },
        uFreq: { value: 1.6 },
        uColorA: { value: lin(p0.a) },
        uColorB: { value: lin(p0.b) },
        uColorAccent: { value: lin(p0.accent) },
      };
      const geo = new THREE.IcosahedronGeometry(1, mobile ? 14 : 24);
      const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG });
      const orb = new THREE.Mesh(geo, material);
      scene.add(orb);

      // particle halo (additive → glowing nebula through bloom)
      const N = mobile ? 700 : 1400;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const r = 1.5 + Math.random() * 1.6;
        const th = Math.acos(2 * Math.random() - 1);
        const ph = Math.random() * Math.PI * 2;
        pos[i * 3] = r * Math.sin(th) * Math.cos(ph);
        pos[i * 3 + 1] = r * Math.sin(th) * Math.sin(ph);
        pos[i * 3 + 2] = r * Math.cos(th);
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      // soft round sprite (radial gradient) so particles read as glowing dust, not squares
      const cvs = document.createElement("canvas");
      cvs.width = cvs.height = 64;
      const g2 = cvs.getContext("2d")!;
      const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.4, "rgba(255,255,255,0.5)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g2.fillStyle = grad;
      g2.fillRect(0, 0, 64, 64);
      const dot = new THREE.CanvasTexture(cvs);
      const pm = new THREE.PointsMaterial({
        size: 0.045,
        map: dot,
        color: lin("#FFD700"),
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const halo = new THREE.Points(pg, pm);
      scene.add(halo);

      const composer = new EffectComposer(
        renderer,
        new THREE.WebGLRenderTarget(w(), h(), { type: THREE.HalfFloatType, samples: 2 }),
      );
      composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prCap));
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(w(), h()), p0.bloom, 0.6, 0.7);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());

      const clock = new THREE.Clock();
      let level = 0;
      const tgtA = new THREE.Color(),
        tgtB = new THREE.Color(),
        tgtAcc = new THREE.Color();

      const onResize = () => {
        renderer.setSize(w(), h());
        composer.setSize(w(), h());
        camera.aspect = w() / h();
        camera.updateProjectionMatrix();
      };
      window.addEventListener("resize", onResize);

      const animate = () => {
        const t = clock.getElapsedTime();
        uniforms.uTime.value = t;

        // audio energy → bands (single-value amplitude synthesised into bands)
        const dbg = (window as any).__orbE;
        const raw = typeof dbg === "number" ? dbg : (energyRef?.current ?? 0);
        level += (raw - level) * (raw > level ? 0.5 : 0.12);
        const idle = 0.05 + 0.035 * Math.sin(t * 1.2);
        const lvl = raw < 0.02 ? Math.max(level, idle) : level;
        uniforms.uLevel.value = lvl;
        uniforms.uBass.value = lvl * 0.95;
        uniforms.uMid.value = lvl * 0.65;
        uniforms.uTreble.value = lvl * 0.45 + 0.015 * (0.5 + 0.5 * Math.sin(t * 6.0));

        // state palette lerp
        const dbgS = (window as any).__orbState as State | undefined;
        const pal = PAL[dbgS ?? stateRef.current];
        tgtA.copy(new THREE.Color(pal.a).convertSRGBToLinear());
        tgtB.copy(new THREE.Color(pal.b).convertSRGBToLinear());
        tgtAcc.copy(new THREE.Color(pal.accent).convertSRGBToLinear());
        uniforms.uColorA.value.lerp(tgtA, 0.06);
        uniforms.uColorB.value.lerp(tgtB, 0.06);
        uniforms.uColorAccent.value.lerp(tgtAcc, 0.06);
        pm.color.lerp(tgtA, 0.04);
        uniforms.uAmp.value += (pal.amp - uniforms.uAmp.value) * 0.05;
        const bright = Math.min(lvl, 0.65);
        bloom.strength += (pal.bloom + bright * 0.12 - bloom.strength) * 0.05;

        orb.rotation.y += 0.0016;
        halo.rotation.y += 0.0006 + lvl * 0.004;
        pm.size = 0.045 + uniforms.uTreble.value * 0.04;

        camera.position.x = Math.sin(t * 0.15) * 0.35;
        camera.position.y = Math.cos(t * 0.11) * 0.22;
        camera.lookAt(0, 0, 0);

        composer.render();
        raf = requestAnimationFrame(animate);
      };
      animate();

      cleanup = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", onResize);
        geo.dispose();
        material.dispose();
        pg.dispose();
        pm.dispose();
        composer.dispose?.();
        renderer.dispose();
        if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return <div ref={mountRef} className="h-full w-full" />;
}
