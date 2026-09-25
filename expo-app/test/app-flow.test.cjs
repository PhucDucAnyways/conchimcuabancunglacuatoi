const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const babel = require('@babel/core');
const fixture = require('../../server/test-room.json');
function mount(requestRoom, fetchImpl) {
  const alerts = [], writes = [];
  const slots = []; let cursor = 0; const effects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef: initial => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect: fn => { effects.push(fn); }
  };
  const native = new Proxy({ StyleSheet: { create: s => s }, Platform: { OS: 'android' }, Alert: { alert: (...args) => alerts.push(args) } }, { get: (o,k) => o[k] || k });
  const modules = {
    react: React, 'react-native': native,
    '@react-native-async-storage/async-storage': { getItem: async () => 'http://192.168.1.17:8787', removeItem: async () => {}, setItem: async (...args) => writes.push(args) },
    'expo-secure-store': { getItemAsync: async () => 'test', setItemAsync: async (...args) => writes.push(args) },
    'expo-image-picker': {}, 'expo-image-manipulator': {},
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
    './components/RoomViewer3D': 'RoomViewer3D',
    './lib/room-api': { requestRoom, validEndpoint: () => true, requestDiagnosis: async () => ({ modules: [] }) }
  };
  const compiled = babel.transformFileSync(path.join(__dirname, '../App.js'), { configFile: false, babelrc: false,
    plugins: [require.resolve('@babel/plugin-transform-react-jsx'), require.resolve('@babel/plugin-transform-modules-commonjs')] }).code;
  const context = { exports: {}, require: name => { if (!(name in modules)) throw Error(name); return modules[name]; }, fetch: fetchImpl, setTimeout, clearTimeout, AbortController, AbortSignal, console, process: { env: {} } };
  vm.runInNewContext(compiled, context);
  const render = () => { cursor = 0; return context.exports.default(); };
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of node.children || []) { const result = find(child, predicate); if (result) return result; }
    return null;
  };
  const root = render(); effects.splice(0).forEach(fn => fn());
  return { render, find, root, alerts, writes };
}

test('settings reject wrong tokens and old contracts before storing; valid probe stores settings', async () => {
  for (const [status, contractVersion] of [[401,2],[200,1],[200,2]]) {
    const app = mount(() => { throw Error('Unexpected AI'); }, async (url, options) => {
      assert.ok(url.endsWith('/api/connection'));
      assert.equal(options.headers.Authorization, 'Bearer test');
      return Response.json({ provider: 'gemini', configured: true, contractVersion }, { status });
    });
    await new Promise(r => setImmediate(r));
    let tree = app.render();
    const button = text => app.find(tree, n => n.type === 'TouchableOpacity' && app.find(n, c => c.type === 'Text' && c.children.some(x => typeof x === 'string' && x.includes(text))));
    button('Cài đặt').props.onPress(); tree = app.render();
    await button('Lưu').props.onPress();
    const valid = status === 200 && contractVersion === 2;
    assert.equal(app.writes.length, valid ? 2 : 0);
    assert.equal(app.alerts.length, valid ? 0 : 1);
  }
});
test('app opens blank without calling AI, sends first prompt without sample, preserves room and text on failure', async () => {
  const calls = []; let reject = false;
  const app = mount(async args => { calls.push(args); if (reject) throw Error('Provider unavailable'); return fixture; });
  await new Promise(r => setImmediate(r));
  let tree = app.render();
  const viewer = () => app.find(tree, n => n.type === 'RoomViewer3D');
  assert.equal(viewer().props.room, null); assert.equal(calls.length, 0);
  const input = () => app.find(tree, n => n.type === 'TextInput' && n.props.multiline);
  input().props.onChangeText('Tạo phòng'); tree = app.render();
  // Submit through the actual send control selected by its accessibility label.
  const submit = () => app.find(tree, n => n.type === 'TouchableOpacity' && (n.props.accessibilityLabel || '').includes('Gửi'));
  assert.ok(submit(), 'Send control should be accessible');
  submit().props.onPress(); await new Promise(r => setImmediate(r)); tree = app.render();
  assert.equal(calls[0].previousRoom, null); assert.equal(viewer().props.room, fixture);
  reject = true; input().props.onChangeText('Đổi màu bàn'); tree = app.render();
  submit().props.onPress(); await new Promise(r => setImmediate(r)); tree = app.render();
  assert.equal(calls[1].previousRoom, fixture); assert.equal(viewer().props.room, fixture);
  assert.equal(input().props.value, 'Đổi màu bàn');
});
