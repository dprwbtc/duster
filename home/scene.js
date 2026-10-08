// The lilvader.space homepage scene: a chrome Cuban link hanging in a U around $LILVADER.
// Bundled into public/home/scene.js by `npm run build:home` (the site's CSP allows scripts from its own origin only).
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

const canvas = document.getElementById("gl");
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
// Phones get a lighter scene (a simpler chrome shader and coarser links). On any device, the frame pacing below
// steps resolution down from the first of these while frames run long.
const phone = matchMedia("(pointer: coarse)").matches;
const DPRS = [...new Set([1.75, 1.5, 1.25, 1].map((d) => Math.min(window.devicePixelRatio || 1, d)))];

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
} catch {
  canvas.remove(); // no WebGL: the page keeps its painted haze and the text
  document.documentElement.classList.add("ready");
  throw new Error("WebGL unavailable");
}
renderer.setPixelRatio(DPRS[0]);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050507);
scene.fog = new THREE.FogExp2(0x060608, 0.035);
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
const CAM_Z = 10, HALF_H = Math.tan((15 * Math.PI) / 180) * CAM_Z;

// Reflections: a dark studio with softbox strips, so the chrome reads as chrome.
{
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x020203);
  const panel = (w, h, hex, k, pos, rot) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.rotation.set(...rot); env.add(m);
  };
  panel(12, 1.2, 0xffffff, 4.5, [0, 6, 0], [Math.PI / 2, 0, 0]);
  panel(1.1, 9, 0xffffff, 2.2, [-7, 0, 2], [0, Math.PI / 2, 0]);
  panel(1.1, 9, 0xdde6ff, 1.6, [7, 1, -1], [0, -Math.PI / 2, 0]);
  panel(6, 2, 0xffad40, 0.7, [0, -0.5, 8], [0, Math.PI, 0]);
  panel(5, 0.8, 0xff2236, 1.6, [0, -5, -3], [-Math.PI / 2.4, 0, 0]);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(env, 0.03).texture;
  pm.dispose();
}
const chrome = phone
  ? new THREE.MeshStandardMaterial({ color: 0xf1f3f7, metalness: 1, roughness: 0.12, envMapIntensity: 1.1 })
  : new THREE.MeshPhysicalMaterial({ color: 0xf1f3f7, metalness: 1, roughness: 0.13, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 1.0 });

// ---------- the chain: twisted, flattened Cuban links hanging in a U from above the frame ----------
const LINKS = 110, SPACING = 0.215;
const chain = new THREE.InstancedMesh(new THREE.TorusGeometry(0.2, 0.074, phone ? 12 : 16, phone ? 28 : 40), chrome, LINKS);
chain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
const holder = new THREE.Group();
holder.add(chain);
scene.add(holder);
let HANG = [];
const linkPos = [];
const M = new THREE.Matrix4(), S = new THREE.Matrix4();
const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), F = new THREE.Vector3(0, 0, 1);
const P = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3();
const twist = [new THREE.Matrix4().makeRotationX(0.95), new THREE.Matrix4().makeRotationX(-0.95)];
let linkScale = 1;
// One curve, reshaped in place every frame, so the loop allocates nothing (Safari's garbage collection showed up
// as hitches). The link count is set once per layout: counting from each frame's swaying length made it flip
// between two values, and every flip slid all the links along the chain at once.
const hangPts = Array.from({ length: 7 }, () => new THREE.Vector3());
const curve = new THREE.CatmullRomCurve3(hangPts, false, "catmullrom", 0.5);
let linkCount = 0;
function shapeCurve(sway) {
  HANG.forEach(([x, y, z], i) => {
    const w = Math.sin((Math.PI * i) / (HANG.length - 1));
    hangPts[i].set(x + sway * w * 0.5, y, z + sway * w);
  });
  curve.needsUpdate = true;
}
function layoutChain(t) {
  shapeCurve(calm ? 0 : Math.sin(t * 0.8) * 0.07);
  const n = linkCount;
  S.makeScale(1.32 * linkScale, linkScale, 0.6 * linkScale);
  for (let i = 0; i < n; i++) {
    const u = curve.getUtoTmapping((i + 0.5) / n);
    curve.getPoint(u, P);
    curve.getPoint(Math.max(0, u - 1e-4), A); curve.getPoint(Math.min(1, u + 1e-4), B);
    X.subVectors(B, A).normalize();
    Z.copy(F).addScaledVector(X, -X.dot(F)).normalize();
    Y.crossVectors(Z, X);
    M.makeBasis(X, Y, Z).multiply(twist[i % 2]).multiply(S).setPosition(P);
    chain.setMatrixAt(i, M);
    (linkPos[i] ||= new THREE.Vector3()).copy(P);
  }
  chain.count = n;
  chain.instanceMatrix.needsUpdate = true;
  linkPos.length = n;
}

// ---------- atmosphere: warm haze, dust in the light, glints on the ice ----------
function softTexture(stops) {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d"), grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const haze = [
  [softTexture([[0, "rgba(150,92,38,.32)"], [0.5, "rgba(80,48,22,.12)"], [1, "rgba(0,0,0,0)"]]), [0, 0.4, -4], 14],
  [softTexture([[0, "rgba(60,72,110,.24)"], [1, "rgba(0,0,0,0)"]]), [-4, -1.4, -6], 12],
  [softTexture([[0, "rgba(170,20,40,.2)"], [1, "rgba(0,0,0,0)"]]), [4, -2.6, -5], 9],
].map(([map, pos, size]) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  m.position.set(...pos); scene.add(m); return m;
});
const DUST = 420;
const dustPos = new Float32Array(DUST * 3);
for (let i = 0; i < DUST; i++) { dustPos[i * 3] = (Math.random() - 0.5) * 14; dustPos[i * 3 + 1] = (Math.random() - 0.5) * 8; dustPos[i * 3 + 2] = (Math.random() - 0.5) * 6 - 1; }
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.035, map: softTexture([[0, "rgba(255,230,190,1)"], [1, "rgba(0,0,0,0)"]]), color: 0xffe2b8, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending })));

const starTex = (() => {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.12, "rgba(255,255,255,.7)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "rgba(255,255,255,.95)"; g.lineWidth = 2.2; g.beginPath();
  g.moveTo(64, 2); g.lineTo(64, 126); g.moveTo(2, 64); g.lineTo(126, 64); g.stroke();
  return new THREE.CanvasTexture(c);
})();
const glints = Array.from({ length: 18 }, (_, i) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTex, color: new THREE.Color(2.2, 2.2, 2.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  holder.add(s);
  return { s, at: 0.08 + ((i * 0.618) % 1) * 0.84, phase: Math.random() * 6.28, speed: 0.7 + Math.random() * 0.9 };
});

// ---------- lights ----------
const key = new THREE.SpotLight(0xffd7a0, 14, 20, 0.6, 0.6, 1.6); key.position.set(-3, 6, 5); scene.add(key, key.target);
const rim = new THREE.PointLight(0x9fb6ff, 7, 12, 2); rim.position.set(3.5, 2, -3); scene.add(rim);
const red = new THREE.PointLight(0xff1e3c, 5, 9, 2); red.position.set(-2.5, -2.4, 1.5); scene.add(red);

// ---------- post: bloom, then film (vignette, grain, a little colour fringing) ----------
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.4, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const film = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5; vec2 off = d * 0.0035;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= mix(1.0, smoothstep(0.75, 0.1, dot(d, d) * 1.7), 0.8);
      col += (rand(vUv * 900.0 + uTime) - 0.5) * 0.045;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
composer.addPass(film);

const pointer = { x: 0, y: 0 }, look = { x: 0, y: 0 };
addEventListener("pointermove", (e) => { pointer.x = (e.clientX / innerWidth) * 2 - 1; pointer.y = -((e.clientY / innerHeight) * 2 - 1); }, { passive: true });

let raf = 0;
let start = performance.now();

// ---------- layout: the U wraps $LILVADER and bottoms out just below it ----------
const h1 = document.querySelector("h1");
function resize() {
  const w = innerWidth, h = innerHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const halfW = HALF_H * camera.aspect;
  const yAt = (f) => (0.5 - f) * 2 * HALF_H; // screen fraction -> world y on the z=0 plane
  const r = h1.getBoundingClientRect();
  const textHalf = (r.width / w) * halfW;
  const side = Math.min(halfW * 0.86, Math.max(textHalf + 0.55, halfW * 0.5));
  const bottom = yAt(Math.min(0.68, r.bottom / h + 0.1));
  const top = HALF_H + 1.2;
  linkScale = Math.min(1, Math.max(0.55, side / 3));
  HANG = [
    [-side * 1.04, top, -1.3], [-side, (top + bottom) / 2 + 0.5, -0.4], [-side * 0.86, bottom + 0.62, 0.35],
    [0, bottom, 0.75],
    [side * 0.86, bottom + 0.62, 0.35], [side, (top + bottom) / 2 + 0.5, -0.4], [side * 1.04, top, -1.3],
  ];
  shapeCurve(0);
  linkCount = Math.min(LINKS, Math.floor(curve.getLength() / (SPACING * linkScale)));
  if (calm) frame(performance.now());
}
addEventListener("resize", resize);
document.fonts?.ready.then(resize);

// ---------- the loop ----------
document.addEventListener("visibilitychange", kick);
function kick() { if (!raf && !document.hidden && !calm && HANG.length) raf = requestAnimationFrame(frame); }
let prevNow = 0;
function frame(now) {
  raf = 0;
  if (!calm && !pace(now)) return kick();
  const dt = prevNow ? Math.min(0.1, (now - prevNow) / 1000) : 1 / 60;
  prevNow = now;
  const t = calm ? 10 : (now - start) / 1000;
  // the chain drops in and settles
  holder.position.y = calm ? 0 : 3.4 * Math.exp(-3.1 * t) * Math.cos(6.5 * t);
  layoutChain(t);
  const n = linkPos.length;
  glints.forEach((gl) => {
    const p = linkPos[Math.floor(gl.at * n)];
    if (!p) return;
    gl.s.position.set(p.x, p.y + 0.05 * linkScale, p.z + 0.14 * linkScale);
    const a = calm ? 0.5 : Math.max(0, Math.sin(t * gl.speed + gl.phase)) ** 10;
    gl.s.scale.setScalar((0.06 + 0.32 * a) * linkScale);
  });
  haze.forEach((m, i) => (m.rotation.z = t * 0.02 * (i % 2 ? -1 : 1)));
  if (!calm) {
    const a = dustGeo.attributes.position;
    const rise = 0.108 * dt; // the same drift at any frame rate
    for (let i = 0; i < DUST; i++) { let y = a.getY(i) + rise; if (y > 4) y = -4; a.setY(i, y); }
    a.needsUpdate = true;
  }
  const ease = 1 - Math.pow(0.95, dt * 60);
  look.x += (pointer.x - look.x) * ease; look.y += (pointer.y - look.y) * ease;
  camera.position.set(look.x * 0.45, look.y * 0.25, CAM_Z);
  camera.lookAt(0, 0, 0);
  film.uniforms.uTime.value = t;
  composer.render();
  if (!calm) kick();
}

// ---------- frame pacing ----------
// A phone that can't hold 60fps showed frames 16, 33 and 50ms apart, which reads as stutter even when each frame is
// right. So while frames run long, resolution steps down; if the lowest step still can't hold 60, drawing locks to
// every other display frame, an even 30fps. It never steps back up, so it can't oscillate.
const WINDOW = 24, SLOW_MS = 20;
let dprAt = 0, lock30 = false, settled = false, lastTick = 0, lastDraw = 0, skip = 4;
const deltas = [];
function pace(now) {
  const dt = lastTick ? now - lastTick : 0;
  lastTick = now;
  if (lock30 && now - lastDraw < 1000 / 30 - 4) return false;
  const sinceDraw = lastDraw ? now - lastDraw : 0;
  lastDraw = now;
  if (lock30 || !dt || dt > 250) return true; // a hidden tab or a long pause isn't a measure of anything
  if (skip > 0) { skip--; return true; } // the frames right after a change carry its one-off cost
  deltas.push(sinceDraw);
  if (deltas.length < WINDOW) return true;
  const median = [...deltas].sort((a, b) => a - b)[WINDOW >> 1];
  deltas.length = 0;
  if (median <= SLOW_MS) { settled = true; return true; }
  if (dprAt < DPRS.length - 1) {
    dprAt++;
    renderer.setPixelRatio(DPRS[dprAt]);
    composer.setPixelRatio(DPRS[dprAt]);
    resize();
    skip = 4;
  } else {
    lock30 = settled = true;
  }
  return true;
}
// lilvader.space/?fps shows the frame rate and the resolution step, to check a device by eye
if (new URLSearchParams(location.search).has("fps")) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:9;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.7);color:#9f9;font:12px/1.3 ui-monospace,monospace;pointer-events:none";
  document.body.append(el);
  let frames = 0, since = performance.now();
  const count = () => { frames++; requestAnimationFrame(count); };
  requestAnimationFrame(count);
  setInterval(() => {
    const now = performance.now(), fps = (frames * 1000) / (now - since);
    el.textContent = `${Math.round(lock30 ? Math.min(fps, 30) : fps)} fps · ${renderer.getPixelRatio()}x${lock30 ? " · 30 lock" : ""}${phone ? " · phone" : ""}`;
    frames = 0; since = now;
  }, 500);
}

// ---------- first paint ----------
// The page stays hidden (see index.html) until the title's font is in and the first frame is drawn, so the title
// never flashes in a fallback font, the chain never refits around a font swap, and the drop starts when it shows.
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
async function boot() {
  const fonts = document.fonts
    ? Promise.all([document.fonts.load('400 100px "Pirata One"', "$LILVADER"), document.fonts.load('700 15px "Barlow Condensed"'), document.fonts.load('600 15px "Barlow Condensed"')]).catch(() => {})
    : null;
  await Promise.race([fonts, new Promise((r) => setTimeout(r, 2500))]);
  resize();
  start = performance.now();
  frame(start); // compiles the shaders and uploads the chain while nothing shows yet
  await nextFrame(); await nextFrame();
  // let the pacing find a resolution this device holds before anything shows (up to about a second)
  const t0 = performance.now();
  while (!calm && !settled && performance.now() - t0 < 1200) await nextFrame();
  start = performance.now();
  document.documentElement.classList.add("ready");
}
boot();
