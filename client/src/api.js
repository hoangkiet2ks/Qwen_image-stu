/**
 * api.js — API base URL configuration
 *
 * Web frontend → /api (Vite proxy tới localhost:3000)
 * Mobile APK   → URL Tailscale đã ghép với máy AI
 */

// One stable private address for every device signed in to this Tailnet.
// Do not use a Wi-Fi IP here: it changes whenever the PC changes network.
export const TAILSCALE_API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';
export const API_BASE_STORAGE_KEY = 'qwen-image-editor:machine-ai-url:v1';

// Auto-detect: dùng Capacitor hay browser
const isCapacitor = typeof window !== 'undefined'
  && window.Capacitor?.isNativePlatform?.() === true;
export const USE_BROWSER_PROXY = !isCapacitor;

const defaultApiBase = isCapacitor
  ? TAILSCALE_API_BASE
  : '';

function normalizeApiBase(value) {
  const source = String(value || '').trim().replace(/\/+$/, '');
  if (!source) return '';
  const normalized = /^https?:\/\//i.test(source) ? source : `https://${source}`;
  try {
    const parsed = new URL(normalized);
    // Tailscale Serve is HTTPS-only. Repair values saved by older APK builds
    // instead of making the user open the connection dialog and retype it.
    if (parsed.hostname.toLowerCase().endsWith('.ts.net')) {
      return `https://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    }
  } catch {}
  return normalized;
}

export function getApiBase() {
  // When the Vite frontend is opened from another device, its hostname may be
  // a LAN or Tailscale IP. The proxy backend intentionally stays on 127.0.0.1,
  // so browser requests must go through Vite's existing /api forwarding rule.
  // Ignore an old browser setting here; native APK keeps its saved AI-machine
  // URL and still connects directly through Tailscale.
  if (USE_BROWSER_PROXY) return defaultApiBase;
  try {
    const saved = normalizeApiBase(localStorage.getItem(API_BASE_STORAGE_KEY));
    // Migrate old Wi-Fi/LAN values from earlier APK versions. A user-entered
    // HTTPS hostname remains untouched, while a changing private IP can no
    // longer strand the app after changing networks.
    if (/^http:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(saved)
      || /^http:\/\/[^/]+\.ts\.net(?::\d+)?$/i.test(saved)) {
      return TAILSCALE_API_BASE;
    }
    return saved || defaultApiBase;
  } catch {
    return defaultApiBase;
  }
}

export function saveApiBase(value) {
  const normalized = normalizeApiBase(value);
  if (!normalized) throw new Error('Vui lòng nhập URL máy AI.');
  localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
  return normalized;
}

export function resetApiBase() {
  localStorage.removeItem(API_BASE_STORAGE_KEY);
}

// Read once on launch. Saving a new server URL reloads the small web app so
// every in-flight API helper uses one consistent endpoint.
export const API_BASE = getApiBase();

// Debug: log ra đang dùng API nào
console.log('[API] Base URL:', API_BASE, isCapacitor ? '(Capacitor)' : '(Browser)');

// Cached status để không ping liên tục
let serverStatusCache = { online: false, lastCheck: 0 };

export async function checkServerStatus() {
  const now = Date.now();
  // Cache 10 giây
  if (now - serverStatusCache.lastCheck < 10000) {
    return serverStatusCache.online;
  }
  try {
    const res = await fetch(`${API_BASE}/api/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    });
    serverStatusCache = { online: res.ok, lastCheck: now };
    return res.ok;
  } catch {
    serverStatusCache = { online: false, lastCheck: now };
    return false;
  }
}

/**
 * Post an image edit request to the proxy server.
 */
export async function postEdit({ image, prompt, denoise, preserveFace, unetName, clipName, vaeName }, onProgress) {
  const form = new FormData();
  form.append('image', image);
  form.append('prompt', prompt);
  form.append('denoise', String(denoise));
  form.append('preserve_face', String(preserveFace));
  if (unetName) form.append('unet_name', unetName);
  if (clipName) form.append('clip_name', clipName);
  if (vaeName) form.append('vae_name', vaeName);

  const res = await fetch(`${API_BASE}/api/edit`, {
    method: 'POST',
    headers: { 'X-Source': 'app' },
    body: form,
  });

  if (!res.ok) {
    let msg = `Lỗi ${res.status}`;
    try { msg = (await res.json())?.error || msg; } catch {}
    throw new Error(msg);
  }

  const headers = {};
  res.headers.forEach((value, key) => { headers[key] = value; });
  return { blob: await res.blob(), headers };
}

export async function resolvePromptIntent(prompt, activeFeature, targetScope = 'single') {
  const res = await fetch(`${API_BASE}/api/prompt-intent/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Source': 'app' },
    body: JSON.stringify({ prompt, activeFeature, targetScope }),
    signal: AbortSignal.timeout(8000)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Không thể phân tích yêu cầu chỉnh sửa.');
  return data;
}

async function submitGenerationJob(path, form) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'X-Source': 'app' },
    body: form,
    // The async endpoint only uploads and queues the task. Do not let an
    // unreachable PC leave the Android create button pending indefinitely.
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    let message = `Lỗi ${res.status}`;
    try { message = (await res.json())?.error || message; } catch {}
    throw new Error(message);
  }
  return res.json();
}

/**
 * Queue an edit and return immediately with a resumable job id. This avoids
 * keeping a mobile fetch open while ComfyUI generates in the background.
 */
export async function queueEditJob({ image, prompt, negativePrompt, denoise, preserveFace, jobId, unet, clip, vae, unetName, clipName, vaeName }) {
  const form = new FormData();
  form.append('image', image);
  form.append('prompt', prompt);
  form.append('denoise', String(denoise));
  form.append('preserve_face', String(preserveFace));
  form.append('client_job_id', jobId);
  if (negativePrompt) form.append('negative', negativePrompt);
  if (unetName || unet) form.append('unet_name', unetName || unet);
  if (clipName || clip) form.append('clip_name', clipName || clip);
  if (vaeName || vae) form.append('vae_name', vaeName || vae);
  return submitGenerationJob('/api/edit?async=1', form);
}

/**
 * Inpaint: thay đổi vùng được mask trong ảnh theo prompt.
 *  image          : File ảnh chính
 *  mask           : File mask PNG (đen = giữ, trắng = vẽ)
 *  prompt         : chỉ dẫn cho vùng được mask
 *  negativePrompt : negative prompt (optional)
 *  denoise        : 0..1
 *  growMask       : số pixel mở rộng vùng mask (optional)
 */
export async function postInpaint({ image, mask, prompt, negativePrompt, denoise, growMask, unetName, clipName, vaeName }) {
  const form = new FormData();
  form.append('image', image);
  form.append('mask', mask);
  form.append('prompt', prompt);
  form.append('denoise', String(denoise));
  if (negativePrompt) form.append('negative', negativePrompt);
  if (growMask != null) form.append('grow_mask', String(growMask));
  if (unetName) form.append('unet_name', unetName);
  if (clipName) form.append('clip_name', clipName);
  if (vaeName) form.append('vae_name', vaeName);

  const res = await fetch(`${API_BASE}/api/inpaint`, {
    method: 'POST',
    headers: { 'X-Source': 'app' },
    body: form,
  });
  if (!res.ok) {
    let message = `Lỗi ${res.status}`;
    try { message = (await res.json()).error || message; } catch {}
    throw new Error(message);
  }
  const headers = {};
  res.headers.forEach((value, key) => { headers[key] = value; });
  return { blob: await res.blob(), headers };
}

export async function queueInpaintJob({ image, mask, poseReference, poseLabel, prompt, negativePrompt, denoise, steps, growMask, skinToneMatch, sceneIntegration, jobId, unet, clip, vae, unetName, clipName, vaeName }) {
  const form = new FormData();
  form.append('image', image);
  form.append('mask', mask);
  if (poseReference) {
    form.append('pose_reference', poseReference);
    form.append('pose_label', poseLabel || 'selected pose');
  }
  form.append('prompt', prompt);
  form.append('denoise', String(denoise));
  if (steps) form.append('steps', String(steps));
  form.append('skin_tone_match', String(Boolean(skinToneMatch)));
  form.append('client_job_id', jobId);
  if (negativePrompt) form.append('negative', negativePrompt);
  if (Array.isArray(sceneIntegration) && sceneIntegration.length) form.append('scene_integration', sceneIntegration.join(','));
  if (growMask != null) form.append('grow_mask', String(growMask));
  if (unetName || unet) form.append('unet_name', unetName || unet);
  if (clipName || clip) form.append('clip_name', clipName || clip);
  if (vaeName || vae) form.append('vae_name', vaeName || vae);
  return submitGenerationJob('/api/inpaint?async=1', form);
}

export async function getGenerationJob(jobId, promptId) {
  const query = promptId ? `?prompt_id=${encodeURIComponent(promptId)}` : '';
  const res = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}${query}`, {
    headers: { 'X-Source': 'app' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const error = new Error(res.status === 404 ? 'Generation job not found yet' : `Lỗi ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/**
 * Fetch an image from the proxy server by filename.
 */
export async function fetchOutputImage(filename) {
  const url = `${API_BASE}/api/output/${encodeURIComponent(filename)}`;
  const res = await fetch(url, { headers: { 'X-Source': 'app' } });
  if (!res.ok) throw new Error(`Không tải được ảnh: ${res.status}`);
  return res.blob();
}

/**
 * Shutdown ComfyUI and the proxy server.
 */
export async function shutdownServer() {
  const res = await fetch(`${API_BASE}/api/shutdown`, { method: 'POST' });
  if (!res.ok) throw new Error(`Lỗi ${res.status}`);
  return res.json();
}
