import { validateRoom } from './room-contract.mjs';
export { validateRoom, sanitizeHex } from './room-contract.mjs';
export function validEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(url.hostname);
  } catch { return false; }
}

export async function requestRoom({ endpoint, token, prompt, image, previousRoom, signal, fetchImpl = fetch }) {
  if (!validEndpoint(endpoint)) throw new Error('Cần URL HTTPS của backend cloud hoặc địa chỉ HTTP trong mạng LAN.');
  const baseEp = endpoint.replace(/\/+$/, '');
  let res;
  try { res = await fetchImpl(`${baseEp}/api/room`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ prompt, imageBase64: image || '', ...(previousRoom ? { previousRoom } : {}) }),
  });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const netErr = new Error(`Không kết nối được ${endpoint}. Kiểm tra IP trong Cài đặt và mở ${endpoint}/health trên Chrome điện thoại.`);
    netErr.isNetworkError = true;
    throw netErr;
  }
  let data;
  try { data = await res.json(); } catch { throw new Error(`Server trả dữ liệu không hợp lệ (${res.status}).`); }
  if (!res.ok) throw new Error(data.error || `Lỗi server (${res.status}).`);
  return validateRoom(data);
}

export async function requestSegmentation({ endpoint, token, prompt, image, signal, fetchImpl = fetch }) {
  if (!validEndpoint(endpoint)) throw new Error('Cần URL HTTPS của backend cloud hoặc địa chỉ HTTP trong mạng LAN.');
  const baseEp = endpoint.replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(`${baseEp}/api/segment`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ prompt, image: image || '' }),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const netErr = new Error(`Không kết nối được ${endpoint} để bóc tách.`);
    netErr.isNetworkError = true;
    throw netErr;
  }
  let data;
  try { data = await res.json(); } catch { throw new Error(`Server trả dữ liệu không hợp lệ (${res.status}).`); }
  if (!res.ok) throw new Error(data.error || `Lỗi server (${res.status}).`);
  return data;
}

export async function requestDiagnosis({ endpoint, signal, fetchImpl = fetch }) {
  if (!validEndpoint(endpoint)) throw new Error('Cần URL HTTPS của backend cloud hoặc địa chỉ HTTP trong mạng LAN.');
  const baseEp = endpoint.replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(`${baseEp}/api/diagnosis`, { method: 'GET', signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    const netErr = new Error(`Không kết nối được chẩn đoán ${endpoint}.`);
    netErr.isNetworkError = true;
    throw netErr;
  }
  let data;
  try { data = await res.json(); } catch { throw new Error(`Server trả dữ liệu không hợp lệ (${res.status}).`); }
  if (!res.ok) throw new Error(data.error || `Lỗi server (${res.status}).`);
  return data;
}

export async function extractTextures({ endpoint, token, image, signal, fetchImpl = fetch }) {
  if (!validEndpoint(endpoint)) throw new Error('Địa chỉ server không hợp lệ.');
  const res = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/api/extract-textures`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ imageBase64: image })
  });
  const data = await res.json();
  if (!res.ok || data.status !== 'success') throw new Error(data.error || 'Chưa lấy được texture.');
  return data;
}
