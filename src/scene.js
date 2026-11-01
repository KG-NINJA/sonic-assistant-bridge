import * as THREE from '../vendor/three.module.js';

/** @param {HTMLElement} container */
export function createField(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', 'PCを中心に、接近時は赤い波が内側へ、離反時は青い波が外側へ移動します');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
  camera.position.set(6.3, 6.5, 8.8); camera.lookAt(0, 0.3, 0);
  scene.add(new THREE.HemisphereLight(0xb3efff, 0x142531, 2.5));
  const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(2, 7, 5); scene.add(light);
  const field = new THREE.Group(); field.position.y = -0.7; scene.add(field);
  const grid = new THREE.PolarGridHelper(4.8, 16, 6, 96, 0x214354, 0x1a3446); field.add(grid);
  const laptop = new THREE.Group(); field.add(laptop);
  const caseMaterial = new THREE.MeshStandardMaterial({ color: 0x6a8996, roughness: 0.4, metalness: 0.7 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.07, 0.9), caseMaterial); base.position.y = 0.08; laptop.add(base);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.85, 0.055), caseMaterial); lid.position.set(0, 0.52, -0.4); lid.rotation.x = -0.13; laptop.add(lid);
  const screenMaterial = new THREE.MeshBasicMaterial({ color: 0x74edcc });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.7), screenMaterial); screen.position.set(0, 0.53, -0.36); screen.rotation.x = -0.13; laptop.add(screen);
  const keyboard = new THREE.GridHelper(0.9, 9, 0x29404d, 0x29404d); keyboard.scale.z = 0.45; keyboard.position.set(0, 0.12, -0.04); laptop.add(keyboard);
  const shellMaterial = new THREE.MeshBasicMaterial({ color: 0x74edcc, transparent: true, opacity: 0.05, wireframe: true, depthWrite: false });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(2.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), shellMaterial); field.add(shell);
  const ringGeometry = new THREE.TorusGeometry(1, 0.012, 5, 120);
  const rings = Array.from({ length: 5 }, () => {
    const ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: 0x74edcc, transparent: true, opacity: 0.5, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.045; field.add(ring); return ring;
  });
  const arrows = Array.from({ length: 8 }, (_, i) => {
    const angle = i / 8 * Math.PI * 2;
    const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const arrow = new THREE.ArrowHelper(radial, radial.clone().multiplyScalar(2.5), 0.55, 0x74edcc, 0.16, 0.12);
    arrow.position.y = 0.15; field.add(arrow); return { arrow, radial };
  });
  /** @type {import('./dsp.js').DetectionResult} */
  let result = { state: 'STOPPED', score: 0 };
  let intensity = 0, animation = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const color = new THREE.Color();
  function resize() {
    const { width, height } = container.getBoundingClientRect();
    renderer.setSize(width, height, false); camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix();
    camera.position.set(6.3, 6.5, 8.8).multiplyScalar(width / height < 0.8 ? 1.23 : 1);
  }
  new ResizeObserver(resize).observe(container); resize();
  function draw(time) {
    animation = requestAnimationFrame(draw);
    if (document.hidden) return;
    const t = reducedMotion.matches ? 0 : time / 1000;
    const active = ['APPROACH', 'RECEDE', 'MOTION'].includes(result.state);
    const running = ['CALM', 'APPROACH', 'RECEDE', 'MOTION'].includes(result.state);
    intensity += ((active ? Math.min(1, 0.65 + (result.score || 0) / 20) : 0) - intensity) * 0.06;
    color.set(result.state === 'APPROACH' ? 0xff776d : result.state === 'RECEDE' ? 0x75b6ff : result.state === 'MOTION' ? 0xe9c87c : running ? 0x74edcc : 0x477080);
    shellMaterial.color.copy(color); screenMaterial.color.copy(color);
    shellMaterial.opacity = 0.035 + intensity * 0.1;
    shell.scale.setScalar(1 + intensity * Math.sin(t * 2) * 0.06);
    rings.forEach((ring, i) => {
      const phase = (i / rings.length + t * (active ? 0.24 : 0.045)) % 1;
      const travel = result.state === 'APPROACH' ? 1 - phase : phase;
      const radius = running ? 0.9 + travel * 3.6 : 1.1 + i * 0.72;
      ring.scale.setScalar(radius);
      ring.material.color.copy(color);
      ring.material.opacity = running ? (0.2 + intensity * 0.7) * Math.sin(phase * Math.PI) : 0.14;
      ring.position.y = result.state === 'MOTION' ? 0.12 + Math.sin(t * 3 + i) * intensity * 0.1 : 0.045;
    });
    arrows.forEach(({ arrow, radial }, i) => {
      arrow.visible = active;
      const sign = result.state === 'APPROACH' ? -1 : result.state === 'RECEDE' ? 1 : Math.sin(t * 2 + i) >= 0 ? 1 : -1;
      arrow.setDirection(radial.clone().multiplyScalar(sign)); arrow.setColor(color);
      arrow.setLength(0.35 + intensity * 0.5, 0.16, 0.12);
    });
    renderer.render(scene, camera);
  }
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); cancelAnimationFrame(animation);
    document.getElementById('engine').textContent = '3D停止 · ページを再読込';
  });
  animation = requestAnimationFrame(draw);
  return { update: value => { result = value; } };
}
