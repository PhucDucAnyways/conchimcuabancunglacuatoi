// Shared by the server and Expo. No network or platform dependencies.
export const kinds = ['sofa','table','chair','bed','shelf','cabinet','plant','lamp','rug','picture','window','door','desk','wardrobe','clock','mug','backpack','blackboard','whiteboard','curtain','water_bottle','notebook','air_conditioner','fan','book','lunchbox','television'];
export const roomFields = ['title','wallColor','floorColor','width','depth','height','floorTextureStyle','lightingStyle'];
export const itemFields = ['kind','label','description','x','y','z','yaw','width','height','depth','color','isInteractable','restrictedDialogue','restrictedReason','parentSupport','source'];
const fail = message => { throw new Error(message); };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, name) => typeof value === 'string' && value.length <= max ? value : fail(`Invalid ${name}`);
export function sanitizeHex(value) {
  if (typeof value !== 'string') return fail('Invalid color');
  let c = value.trim();
  if (!c.startsWith('#')) c = '#' + c;
  if (/^#[a-f0-9]{3}$/i.test(c)) c = '#' + [...c.slice(1)].map(x => x + x).join('');
  return /^#[a-f0-9]{6}$/i.test(c) ? c.toUpperCase() : fail('Invalid color');
}
function number(value, min, max, name) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail(`Invalid ${name} (${min}..${max})`);
  return n;
}
export function validateRoom(input) {
  if (!isObject(input)) fail('Invalid room');
  const room = {
    title: text(input.title, 200, 'title'), reply: text(input.reply, 2000, 'reply'),
    wallColor: sanitizeHex(input.wallColor), floorColor: sanitizeHex(input.floorColor),
    width: number(input.width, 4, 16, 'room width'), depth: number(input.depth, 4, 16, 'room depth'), height: number(input.height, 2.5, 5, 'room height'),
    floorTextureStyle: input.floorTextureStyle ?? 'solid', lightingStyle: input.lightingStyle ?? 'morning_sun',
    layoutVersion: 2, objects: []
  };
  if (!['vintage_tiles','wood_planks','bamboo_mat','solid'].includes(room.floorTextureStyle)) fail('Invalid floor style');
  if (!['morning_sun','warm_evening','cozy_night'].includes(room.lightingStyle)) fail('Invalid lighting');
  if (!Array.isArray(input.objects) || input.objects.length > 20) fail('Invalid furniture count');
  const ids = new Set();
  for (const raw of input.objects) {
    if (!isObject(raw) || !kinds.includes(raw.kind)) fail('Unsupported furniture kind');
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(raw.id) || ids.has(raw.id)) fail('Invalid or duplicate object ID');
    ids.add(raw.id);
    const item = { id: raw.id, kind: raw.kind, label: text(raw.label, 200, 'label'), description: text(raw.description, 1200, 'description'),
      color: sanitizeHex(raw.color), x: number(raw.x, -8, 8, 'x'), z: number(raw.z, -8, 8, 'z'), yaw: number(raw.yaw, -360, 360, 'yaw'),
      y: number(raw.y ?? 0, 0, 5, 'y'), width: number(raw.width, .05, 4, 'width'), height: number(raw.height, .05, 4, 'height'), depth: number(raw.depth, .05, 4, 'depth') };
    const angle = item.yaw * Math.PI / 180;
    const hx = (Math.abs(Math.cos(angle)) * item.width + Math.abs(Math.sin(angle)) * item.depth) / 2;
    const hz = (Math.abs(Math.sin(angle)) * item.width + Math.abs(Math.cos(angle)) * item.depth) / 2;
    if (Math.abs(item.x) + hx > room.width / 2 + 0.001 || Math.abs(item.z) + hz > room.depth / 2 + 0.001 || item.y + item.height > room.height + 0.001) fail(`Object ${item.id} exceeds room boundaries`);
    item.isInteractable = raw.isInteractable ?? true;
    if (typeof item.isInteractable !== 'boolean') fail('Invalid interaction flag');
    item.restrictedDialogue = text(raw.restrictedDialogue ?? '', 500, 'restricted dialogue');
    item.restrictedReason = text(raw.restrictedReason ?? '', 300, 'restricted reason');
    item.parentSupport = text(raw.parentSupport ?? '', 80, 'parent support');
    const source = raw.source ?? { type: 'inferred', evidence: '' };
    if (!isObject(source) || !['user_provided','inferred'].includes(source.type)) fail('Invalid source');
    item.source = { type: source.type, evidence: text(source.evidence ?? '', 1000, 'evidence') };
    room.objects.push(item);
  }
  for (const item of room.objects) {
    if (item.parentSupport && (!ids.has(item.parentSupport) || item.parentSupport === item.id)) fail('Unknown parent support ID');
  }
  return room;
}
