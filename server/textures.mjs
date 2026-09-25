import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/extract_textures.py', import.meta.url));
export async function extractTextures(image, signal) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mw-texture-'));
  try {
    const input = path.join(dir, 'image.bin'), output = path.join(dir, 'textures.json');
    await writeFile(input, Buffer.from(image.split(',')[1], 'base64'));
    const localPython = path.join(os.homedir(), 'AppData', 'Local', 'Python', 'bin', 'python.exe');
    const python = process.env.PYTHON_BIN || (process.platform === 'win32' && existsSync(localPython) ? localPython : 'python');
    await new Promise((resolve, reject) => {
      const child = spawn(python, [script, '--image', input, '--output', output], {
        windowsHide: true, signal, timeout: 20000, stdio: 'ignore'
      });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('Texture extraction unavailable')));
    });
    const data = JSON.parse(await readFile(output, 'utf8'));
    if (data.status !== 'success' || !data.textures || !Object.keys(data.textures).length) throw new Error('No textures');
    return { ...data, approximate: true, method: 'fixed_regions', warning: 'Texture lấy từ vùng ảnh ước lượng; có thể không khớp đồ vật thực tế.' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
