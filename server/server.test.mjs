import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from './server.mjs';
import { createRoom, applyEdit, validateRoom } from './room.mjs';
const fixture = JSON.parse(readFileSync(new URL('./test-room.json', import.meta.url)));
const base = () => validateRoom(fixture);
const edit = () => ({ reply: 'Updated', roomChanges: {}, add: [], update: [], remove: [] });
const response = value => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
async function withServer(options, run) {
  const server = createServer({ apiKey: 'test', token: 'secret', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const post = (url, data, route = '/api/room', token = 'secret') => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });

test('connection probe verifies token and contract without using Gemini quota', async () => {
  await withServer({ fetchImpl: () => { throw Error('Unexpected AI'); } }, async url => {
    assert.equal((await fetch(url + '/api/connection')).status, 401);
    const r = await fetch(url + '/api/connection', { headers: { Authorization: 'Bearer secret' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, configured: true, provider: 'gemini', contractVersion: 2 });
  });
});

test('stalled uploads time out and release server capacity', async () => {
  let calls = 0;
  await withServer({ requestTimeoutMs: 100, fetchImpl: async () => { calls++; return response(fixture); } }, async url => {
    await Promise.all([1,2].map(() => new Promise((resolve, reject) => {
      const req = http.request(url + '/api/room', { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer secret', 'Content-Length': '1000'
      } });
      req.on('error', resolve);
      req.on('response', res => { res.resume(); reject(Error('Stalled request unexpectedly completed')); });
      req.setTimeout(3000, () => { req.destroy(); reject(Error('Server failed to close stalled upload')); });
      req.write('{');
    })));
    assert.equal(calls, 0);
    assert.equal((await post(url, { prompt: 'Room' })).status, 200);
    assert.equal(calls, 1);
  });
});
test('pipeline is unavailable, never sample success; health/diagnosis invoke no AI', async () => {
  await withServer({ fetchImpl: () => { throw Error('Unexpected AI'); } }, async url => {
    const diagnosis = await (await fetch(url + '/api/diagnosis')).json();
    assert.equal(diagnosis.segmentation.available, false);
    assert.equal(diagnosis.modules.filter(x => x.status === 'UNAVAILABLE').length, 3);
    assert.equal((await post(url, {}, '/api/segment', '')).status, 401);
    const r = await post(url, { image: 'not-an-image' }, '/api/segment');
    assert.equal(r.status, 503); assert.equal((await r.json()).code, 'PIPELINE_UNAVAILABLE');
  });
});
test('text/image generation produces canonical IDs and no refined image call', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';
  let calls = 0;
  await withServer({ fetchImpl: async (url, options) => {
    calls++; assert.ok(url.endsWith(':generateContent'));
    const body = JSON.parse(options.body);
    assert.ok(body.contents[0].parts.some(x => x.inlineData?.data === png));
    assert.ok(body.generationConfig.responseJsonSchema.properties.objects);
    return response(fixture);
  } }, async url => {
    const r = await post(url, { prompt: 'Room', imageBase64: png });
    assert.equal(r.status, 200); const room = await r.json();
    assert.equal(room.layoutVersion, 2); assert.notEqual(room.objects[0].id, 'desk-1');
    assert.equal(room.refinedImage, undefined); assert.equal(calls, 1);
  });
});
test('sparse edit preserves all unrelated objects and fields exactly', () => {
  const before = base(); const patch = edit();
  patch.update = [{ id: 'desk-1', changes: { color: '#abc' } }];
  const after = applyEdit(before, patch, 'change desk color');
  assert.deepEqual(after.objects[1], before.objects[1]);
  assert.deepEqual(after.objects[0], { ...before.objects[0], color: '#AABBCC' });
  assert.equal(before.objects[0].color, '#8B7355');
});
test('edit endpoint asks for patches and preserves IDs', async () => {
  await withServer({ fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.generationConfig.responseJsonSchema.properties.update);
    assert.ok(body.contents[0].parts[0].text.includes('desk-1'));
    return response({ ...edit(), update: [{ id: 'desk-1', changes: { x: -1.5 } }] });
  } }, async url => {
    const r = await post(url, { prompt: 'Move desk', previousRoom: base() });
    assert.equal(r.status, 200); const after = await r.json();
    assert.equal(after.objects[0].id, 'desk-1'); assert.equal(after.objects[0].x, -1.5);
    assert.deepEqual(after.objects[1], base().objects[1]);
  });
});
test('invalid edits are atomic: unknown IDs, duplicates, unknown fields, geometry, resize', () => {
  const before = base(); const snapshot = JSON.stringify(before);
  for (const changes of [
    { remove: ['missing'] }, { remove: ['desk-1','desk-1'] },
    { update: [{ id: 'desk-1', changes: { id: 'changed' } }] },
    { update: [{ id: 'desk-1', changes: { x: 8 } }] },
    { roomChanges: { width: 1 } }, { objects: [] }
  ]) assert.throws(() => applyEdit(before, { ...edit(), ...changes }, 'test'));
  assert.equal(JSON.stringify(before), snapshot);
});
test('add/remove use server IDs; unsupported objects never become cabinets', () => {
  const { id, ...item } = fixture.objects[0];
  const after = applyEdit(base(), { ...edit(), remove: ['chair-1'], add: [item] }, 'test', () => 'new-id');
  assert.deepEqual(after.objects.map(x => x.id), ['desk-1','new-id']);
  assert.throws(() => applyEdit(base(), { ...edit(), add: [{ ...item, kind: 'unknown' }] }, 'test'));
});
test('normalization preserves meaning and rejects bad data', () => {
  const room = structuredClone(fixture); room.width = '6'; room.wallColor = '#fff';
  assert.equal(validateRoom(room).width, 6); assert.equal(validateRoom(room).wallColor, '#FFFFFF');
  room.objects[0].kind = 'unknown'; assert.throws(() => validateRoom(room), /kind/);
  room.objects[0].kind = 'desk'; room.objects[0].width = Infinity; assert.throws(() => validateRoom(room));
});
test('source attribution requires a real text quote and never retains stale attribution on identity changes', () => {
  const raw = structuredClone(fixture); raw.objects[0].source = { type: 'user_provided', evidence: 'invented story' };
  assert.equal(createRoom(raw, 'desk').objects[0].source.type, 'inferred');
  raw.objects[0].source.evidence = 'my desk';
  const room = createRoom(raw, 'this is my desk'); assert.equal(room.objects[0].source.type, 'user_provided');
  const after = applyEdit(room, { ...edit(), update: [{ id: room.objects[0].id, changes: { description: 'new design' } }] }, 'change');
  assert.equal(after.objects[0].source.type, 'inferred');
  assert.equal(after.caregiverContext, undefined);
});
test('bad output repairs once, repeated invalid output returns error without replacing room', async () => {
  for (const repair of [true, false]) {
    let calls = 0;
    await withServer({ fetchImpl: async () => response(++calls === 1 || !repair ? { ...fixture, width: 100 } : fixture) }, async url => {
      const r = await post(url, { prompt: 'room' });
      assert.equal(r.status, repair ? 200 : 502); assert.equal(calls, 2);
    });
  }
});

test('texture route requires auth/image, skips Gemini, and reports unavailable without sample data', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';
  let calls = 0;
  await withServer({ apiKey: '', textureImpl: async () => { calls++; throw Error('No Python'); }, fetchImpl: () => { throw Error('Unexpected AI'); } }, async url => {
    assert.equal((await post(url, {}, '/api/extract-textures', '')).status, 401);
    assert.equal((await post(url, { prompt: 'room' }, '/api/extract-textures')).status, 400);
    const r = await post(url, { imageBase64: png }, '/api/extract-textures');
    assert.equal(r.status, 503); assert.equal((await r.json()).code, 'TEXTURE_UNAVAILABLE'); assert.equal(calls, 1);
  });
});
