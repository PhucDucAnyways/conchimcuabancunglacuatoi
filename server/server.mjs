import http from 'node:http';
import { extractTextures } from './textures.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { instructions, roomSchema, editSchema, validateInput, createRoom, applyEdit } from './room.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
export function pipelineStatus() {
  const present = fs.existsSync(path.join(ROOT_DIR, 'memoryweaver_ai'));
  return { available: false, status: 'unavailable', reason: present
    ? 'Pipeline ảnh chưa được kiểm chứng ở chế độ thật; bản này chỉ dùng Gemini đọc ảnh và dựng bố cục.'
    : 'Bản Release thiếu package memoryweaver_ai. Gemini vẫn đọc ảnh và dựng bố cục; không có depth, segmentation hoặc inpainting thật.' };
}

// Tự động nạp .env nếu chưa nạp qua CLI flag --env-file
{
  try {
    const envUrl = new URL('.env', import.meta.url);
    if (fs.existsSync(envUrl)) process.loadEnvFile(envUrl);
  } catch {}
}

export function createServer({ apiKey = process.env.GEMINI_API_KEY, token = process.env.APP_ACCESS_TOKEN,
  model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest', fetchImpl = fetch, textureImpl = extractTextures,
  requestTimeoutMs = 150_000 } = {}) {
  let active = 0;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };
  const send = (res, code, body, req) => {
    if (req) console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url} -> ${code} ${code >= 400 ? JSON.stringify(body?.error || '') : 'OK'}`);
    if (!res.destroyed) {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...corsHeaders,
      });
      res.end(JSON.stringify(body));
    }
  };
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      return res.end();
    }
    let parsedUrl;
    try { parsedUrl = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, { error: 'Địa chỉ yêu cầu không hợp lệ.' }); }
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true, configured: Boolean(apiKey), provider: 'gemini', model, contractVersion: 2, segmentation: pipelineStatus() }, req);
    if (req.method === 'GET' && pathname === '/api/diagnosis') {
      const pipeline = pipelineStatus();
      return send(res, 200, { status: 'limited', roomGeneration: { provider: 'gemini', configured: Boolean(apiKey), verified: false },
        segmentation: pipeline, modules: [
          { id: 'gemini', name: 'Gemini: chữ/ảnh → bố cục 3D', status: apiKey ? 'CONFIGURED' : 'UNCONFIGURED', description: 'Có khóa không đồng nghĩa đã kiểm tra quyền và hạn mức.' },
          ...['Depth','Segmentation','Inpainting'].map(name => ({ id: name.toLowerCase(), name, status: 'UNAVAILABLE', description: pipeline.reason }))
        ] }, req);
    }
    const connectionCheck = req.method === 'GET' && pathname === '/api/connection';
    if (!connectionCheck && (req.method !== 'POST' || !['/api/room','/api/segment','/api/extract-textures'].includes(pathname))) return send(res, 404, { error: 'Không tìm thấy API.' }, req);
    if (token) {
      const got = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return send(res, 401, { error: 'Mã truy cập server chưa đúng.' }, req);
    }
    if (connectionCheck) return send(res, 200, { ok: true, configured: Boolean(apiKey), provider: 'gemini', contractVersion: 2 }, req);
    if (pathname === '/api/segment') return send(res, 503, { code: 'PIPELINE_UNAVAILABLE', error: pipelineStatus().reason }, req);
    if (pathname === '/api/room' && !apiKey) return send(res, 503, { error: 'Server chưa cấu hình GEMINI_API_KEY.' }, req);
    if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'Yêu cầu JSON.' }, req);
    const maxConcurrent = Math.max(1, Math.min(4, Number(process.env.MAX_CONCURRENT) || 2));
    if (active >= maxConcurrent) return send(res, 429, { error: 'Server đang bận. Hãy thử lại sau.' }, req);
    active++;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      // Aborting fetch alone does not stop a client stalled while uploading its body.
      if (!req.complete) req.destroy();
    }, requestTimeoutMs);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let length = 0; const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 6_200_000) { send(res, 413, { error: 'Ảnh quá lớn.' }); return; }
        chunks.push(chunk);
      }
      let input;
      try { input = validateInput(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) { return send(res, 400, { error: err.message }); }
      if (pathname === '/api/extract-textures') {
        if (!input.image) return send(res, 400, { error: 'Hãy chọn ảnh để lấy texture.' });
        try { return send(res, 200, await textureImpl(input.image, controller.signal)); }
        catch (error) {
          return send(res, error.name === 'AbortError' ? 504 : 503, { code: 'TEXTURE_UNAVAILABLE', error: 'Chưa lấy được texture ảnh. Phòng 3D vẫn dùng vật liệu mặc định; kiểm tra Python, numpy, Pillow và OpenCV nếu muốn bật tính năng này.' });
        }
      }
      const parts = [{ text: input.prompt || 'Tạo căn phòng từ ảnh tham chiếu này.' }];
      if (input.previous) parts.unshift({ text: 'Previous room design: ' + JSON.stringify(input.previous) });
      if (input.image) {
        const [, mimeType, base64] = input.image.match(/^data:([^;]+);base64,(.+)$/);
        parts.push({ inlineData: { mimeType, data: base64 } });
      }
      let activeModel = model;
      let contents = [{ role: 'user', parts }];
      for (let attempt = 0; attempt < 2; attempt++) {
      const upstream = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent`, {
        method: 'POST', signal: controller.signal,
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: instructions }] },
          contents,
          generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json', responseJsonSchema: input.previous ? editSchema : roomSchema } })
      });
      if (!upstream.ok) {
        if (attempt === 0 && upstream.status === 503 && activeModel !== 'gemini-flash-lite-latest') {
          activeModel = 'gemini-flash-lite-latest';
          continue;
        }
        // Never forward provider payloads, credentials or user images to logs.
        const errors = {
          400: 'Gemini từ chối yêu cầu. Kiểm tra GEMINI_API_KEY và model trên server.',
          403: 'Khóa Gemini chưa có quyền truy cập. Kiểm tra khóa và dự án Google AI Studio.',
          404: 'Không tìm thấy model Gemini. Kiểm tra GEMINI_MODEL trên server.',
          429: 'Gemini đã chạm hạn mức hoặc giới hạn lượt gọi. Hãy chờ rồi thử lại, hoặc kiểm tra hạn mức trong Google AI Studio.',
          503: 'Gemini đang quá tải. Hãy thử lại sau.'
        };
        return send(res, 502, { code: upstream.status === 429 ? 'AI_QUOTA' : 'AI_PROVIDER_ERROR',
          error: errors[upstream.status] || 'Không gọi được Gemini. Kiểm tra cấu hình server hoặc thử lại sau.' });
      }
      const data = await upstream.json();
      const candidate = data.candidates?.[0];
      if (data.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'IMAGE_SAFETY'].includes(candidate?.finishReason))
        return send(res, 422, { error: 'AI không thể xử lý yêu cầu này. Hãy thử mô tả khác.' });
      if (candidate?.finishReason !== 'STOP') return send(res, 502, { error: 'AI chưa trả đủ dữ liệu. Hãy thử mô tả ngắn hơn.' });
      const text = (candidate.content?.parts || []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
      let room;
      try { room = input.previous ? applyEdit(input.previous, JSON.parse(text), input.prompt) : createRoom(JSON.parse(text), input.prompt); }
      catch (error) {
        if (attempt === 0) {
          contents = [
            ...contents,
            { role: 'model', parts: [{ text }] },
            { role: 'user', parts: [{ text: `Your previous output failed validation: ${error.message}. Return a valid response in the same requested schema (edit operations for an existing room, complete room for a new room). Room width/depth 4..16, height 2.5..5; every furniture dimension 0.05..4; x/z -8..8; yaw -360..360. All colors must be #RRGGBB. Keep objects small enough to fit inside the room. Return all required fields.` }] }
          ];
          continue;
        }
        return send(res, 502, { error: 'AI chưa tạo được bố cục hợp lệ sau hai lần thử. Hãy mô tả phòng đơn giản hơn.' }, req);
      }
      return send(res, 200, room, req);
      }
    } catch (err) {
      const aborted = controller.signal.aborted || err.name === 'AbortError';
      send(res, aborted ? 504 : 502, { error: aborted ? 'Yêu cầu hết thời gian chờ. Hãy thử lại.' : 'Lỗi kết nối tới dịch vụ AI.' }, req);
    } finally { clearTimeout(timeout); active--; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '0.0.0.0';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (process.env.APP_ACCESS_TOKEN || '').length < 24) {
    console.error('APP_ACCESS_TOKEN must have at least 24 characters for LAN.'); process.exit(1);
  }
  createServer().listen(Number(process.env.PORT || 8787), host, () => console.log(`MemoryWeaver server listening on ${host}:${process.env.PORT || 8787}`));
}
