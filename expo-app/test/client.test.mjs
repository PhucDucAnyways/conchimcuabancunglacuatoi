import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { requestRoom, requestSegmentation, validEndpoint, validateRoom, sanitizeHex } from '../lib/room-api.js';
const room = validateRoom(JSON.parse(fs.readFileSync(new URL('../../server/test-room.json', import.meta.url))));
test('LAN endpoints and secure URLs only', () => {
  assert.ok(validEndpoint('http://192.168.1.17:8787'));
  assert.ok(validEndpoint('https://example.com'));
  for (const url of ['http://localhost:8787','http://example.com','https://user:secret@example.com']) assert.equal(validEndpoint(url), false);
});
test('client keeps IDs, image and previous layout; invalid layout is rejected', async () => {
  const result = await requestRoom({ endpoint: 'http://192.168.1.17:8787', token: 'test', image: 'image', previousRoom: room,
    fetchImpl: async (_, options) => {
      const data = JSON.parse(options.body);
      assert.deepEqual(data.previousRoom, room); assert.equal(data.imageBase64, 'image');
      return Response.json(room);
    } });
  assert.deepEqual(result, room);
  await assert.rejects(requestRoom({ endpoint: 'http://192.168.1.17:8787', fetchImpl: async () => Response.json({ ...room, objects: [{ ...room.objects[0], kind: 'alien' }] }) }), /kind/);
});
test('pipeline unavailable stays an error, never becomes a room', async () => {
  await assert.rejects(requestSegmentation({ endpoint: 'http://192.168.1.17:8787', fetchImpl: async () => Response.json({ error: 'Pipeline unavailable' }, { status: 503 }) }), /unavailable/);
});
test('safe formatting only: bad kind/color/dimension is never fabricated', () => {
  assert.equal(sanitizeHex('#fff'), '#FFFFFF');
  assert.throws(() => sanitizeHex('banana'));
  assert.throws(() => validateRoom({ ...room, width: Infinity }));
  assert.throws(() => validateRoom({ ...room, objects: [null] }));
});
test('3D starts blank, preserves authoritative placement through edits, and disposes on reset', () => {
  const html = fs.readFileSync(new URL('../viewer/room.html', import.meta.url), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const overlay = { style: {} }; const events = [];
  const loaded = []; let texturesDisposed = 0;
  const frames = new Map(); let nextFrame = 0, renders = 0, now = 0;
  const tick = () => { const pending = [...frames]; frames.clear(); pending.forEach(([,fn]) => fn(100)); };
  class TextureLoader { load() { const t = new THREE.Texture(); loaded.push(t); t.addEventListener('dispose', () => texturesDisposed++); return t; } }
  class Renderer { constructor() { this.domElement = { addEventListener() {} }; this.shadowMap = {}; } setPixelRatio() {} setSize() {} render() { renders++; } }
  class Controls { constructor() { this.target = new THREE.Vector3(); } addEventListener() {} update() {} }
  const context = vm.createContext({ THREE: { ...THREE, TextureLoader, WebGLRenderer: Renderer, OrbitControls: Controls },
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id),
    performance: { now: () => now },
    window: { innerWidth: 400, innerHeight: 300, devicePixelRatio: 1, addEventListener() {}, ReactNativeWebView: { postMessage: x => events.push(JSON.parse(x)) } },
    document: { getElementById: id => id === 'empty-overlay' ? overlay : { appendChild() {}, style: {} } }, console });
  vm.runInContext(script, context);
  assert.equal(vm.runInContext('roomGroup', context), null); assert.equal(events[0].type, 'READY');
  context.window.updateRoom(room);
  // Let camera transitions complete before testing the idle loop.
  for (let i=0;i<10;i++) { now += 1000; const pending = [...frames]; frames.clear(); pending.forEach(([,fn]) => fn(now)); }
  assert.equal(frames.size, 0, 'overview stops scheduling when camera is idle');
  const geometries = new Set();
  vm.runInContext('roomGroup', context).traverse(c => { if (c.geometry?.type === 'BoxGeometry') geometries.add(c.geometry); });
  assert.equal(geometries.size, 1, 'all box meshes share one geometry');
  const snapshot = () => vm.runInContext('furnitureMeshes.map(g => [g.position.x,g.position.y,g.position.z,g.rotation.y])', context).map(x => Array.from(x));
  assert.equal(snapshot()[1][3], 0); // Do not auto-turn the chair toward the desk.
  let disposed = 0;
  vm.runInContext('roomGroup', context).traverse(c => c.geometry?.addEventListener('dispose', () => disposed++));
  const before = snapshot();
  context.window.updateRoom({ ...room, objects: room.objects.map((x,i) => i === 0 ? { ...x, color: '#000000' } : x) });
  assert.deepEqual(snapshot(), before); assert.ok(disposed > 0);
  const originals = vm.runInContext('furnitureMeshes.flatMap(g => { const a=[]; g.traverse(c => { if(c.material) a.push([c.material,c.material.map]); }); return a; })', context);
  context.window.applyExtractedTextures({ floor: 'floor', wall: 'wall', desk: 'desk', chair: 'chair' });
  assert.equal(loaded.length, 4, 'one texture per surface/repeat, not per mesh');
  context.window.applyExtractedTextures({});
  assert.equal(texturesDisposed, 4);
  originals.forEach(([material,map]) => assert.equal(material.map,map));
  context.window.applyExtractedTextures({ desk: 'desk' });
  context.window.setNavMode('fpv');
  assert.equal(frames.size, 1);
  vm.runInContext('moveInput.forward = 1', context);
  context.window.setAppActive(false);
  assert.equal(frames.size, 0);
  assert.equal(vm.runInContext('moveInput.forward', context), 0);
  const pausedRenders = renders; vm.runInContext('render()', context);
  assert.equal(renders, pausedRenders);
  context.window.setAppActive(true); context.window.setAppActive(true);
  assert.equal(frames.size, 1, 'resume does not duplicate animation loops');
  assert.equal(vm.runInContext('navMode', context), 'fpv');
  assert.equal(vm.runInContext('camera.position.y', context), 1.65);
  assert.equal(vm.runInContext('checkPositionCollision(camera.position.x, camera.position.z)', context), false);
  vm.runInContext('moveInput.forward = 1; for(let i=0;i<100;i++) updateFPV(0.08)', context);
  assert.equal(vm.runInContext('checkPositionCollision(camera.position.x, camera.position.z)', context), false);
  context.window.updateRoom(null);
  assert.equal(texturesDisposed, 5, 'reset frees shared photo texture once');
  assert.equal(vm.runInContext('navMode', context), 'overview');
  assert.equal(vm.runInContext('moveInput.forward', context), 0);
  assert.equal(vm.runInContext('roomGroup', context), null); assert.equal(overlay.style.display, 'flex');
  tick(); assert.equal(frames.size, 0, 'empty room stops animation');
  context.window.updateRoom({ ...room, objects: Array.from({length:20}, (_,i) => ({...room.objects[0],id:'lamp-'+i,kind:'lamp'})) });
  let lights = 0;
  vm.runInContext('roomGroup', context).traverse(c => { if(c.isLight) lights++; });
  assert.equal(lights, 2, 'twenty lamps do not create twenty shader lights');
  context.window.updateRoom(null);
});
test('quota and cancellation are not relabeled as a network failure', async () => {
  const base = { endpoint: 'http://192.168.1.17:8787' };
  await assert.rejects(requestRoom({ ...base, fetchImpl: async () => Response.json({ error: 'Quota' }, { status: 502 }) }), { message: 'Quota' });
  const abort = new DOMException('Canceled', 'AbortError');
  await assert.rejects(requestRoom({ ...base, fetchImpl: async () => { throw abort; } }), e => e === abort);
});
