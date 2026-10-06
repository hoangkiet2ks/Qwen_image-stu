require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const { resolvePromptIntent, spec: promptIntentSpec } = require('./prompt-intent');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';

// ── ComfyUI connection ──────────────────────────────────────────────────────
const COMFYUI_HOST = process.env.COMFYUI_HOST || '127.0.0.1';
const COMFYUI_PORT = process.env.COMFYUI_PORT || '8188';
const COMFYUI_BASE = `http://${COMFYUI_HOST}:${COMFYUI_PORT}`;

// ComfyUI input / output directories — adjust these to match your local install
const COMFYUI_INPUT_DIR = process.env.COMFYUI_INPUT_DIR || path.resolve(__dirname, '../ComfyUI/input');
const COMFYUI_OUTPUT_DIR = process.env.COMFYUI_OUTPUT_DIR || path.resolve(__dirname, '../ComfyUI/output');
const APP_OUTPUT_SUBFOLDER = 'app';
const COMFYUI_ROOT = path.dirname(COMFYUI_INPUT_DIR);
const COMFYUI_PYTHON = process.env.COMFYUI_PYTHON || path.join(path.dirname(COMFYUI_ROOT), 'python_embeded', 'python.exe');
const FACE_DETECTOR_SCRIPT = path.join(__dirname, 'scripts', 'detect_faces.py');

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  // The browser client reads these headers to name and describe the returned
  // image. Without exposing them, browsers silently hide them from fetch().
  exposedHeaders: [
    'Content-Disposition', 'X-Prompt-ID', 'X-Filename', 'X-Seed',
    'X-Denoise', 'X-Steps', 'X-Cfg', 'X-Images-Found', 'X-All-Filenames',
    'X-Face-Reference'
  ]
}));
app.use(express.json());

// Resolve a short Vietnamese request into a transparent Qwen-local edit plan.
// This is deterministic configuration, not another remote AI service.
app.post('/api/prompt-intent/resolve', (req, res) => {
  const result = resolvePromptIntent({
    prompt: req.body?.prompt,
    activeFeature: req.body?.activeFeature,
    targetScope: req.body?.targetScope
  });
  if (result.error) return res.status(400).json(result);
  return res.json(result);
});

app.get('/api/prompt-intents', (req, res) => {
  res.json({ version: promptIntentSpec.version, intents: promptIntentSpec.intents.map(({ id, label, synonyms, workflow, parameters }) => ({ id, label, synonyms, workflow, parameters })) });
});

// ── File upload (stores into ComfyUI input folder) ─────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, COMFYUI_INPUT_DIR);
    },
    filename: (req, file, cb) => {
      // Preserve extension, prefix with timestamp to avoid collisions
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext);
      const ts = Date.now();
      cb(null, `${base}_${ts}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpg|jpeg|webp|bmp)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('Only image files (png/jpg/webp/bmp) are allowed'));
  }
});

// ── Workflow template ───────────────────────────────────────────────────────
// Derived from qwen-edit-rapid-aio-gguf.json
// Node IDs:
//   41  → LoadImage               (image filename)
//   68  → TextEncodeQwenImageEditPlus / Positive  (prompt text)
//   65  → KSampler               (denoise, steps, cfg, sampler, seed, …)
//   89  → VAEEncode               (reads from node 88)
//   8   → VAEDecode
//   9   → SaveImage               (final output)
//
// Chain: 41 → 88 (scale) → 89 (encode) → 65 (sample)
//         41 → 68 (positive)      → 65 (positive)
//         41 → 68 (image1)        → 65 (positive)
//         65 (latent) → 8 (decode) → 9 (save)
//
// NOTE: ModelSamplingAuraFlow(67) and CFGNorm(64) are inserted between
//       the Unet and the KSampler to match the original workflow precisely.
// ── Default model names (hardcoded for compatibility) ────────────────────────
const DEFAULT_CLIP_NAME = 'Qwen2.5-VL-7B-Instruct-abliterated.Q4_K_S.gguf';
const DEFAULT_UNET_NAME = 'qwen-rapid-nsfw-v9.0-Q4_K_S.gguf';
const DEFAULT_VAE_NAME = 'pig_qwen_image_vae_fp32-f16.gguf';
// Basic image editing is tuned for speed at 4 steps. Inpainting has to
// reconstruct a masked boundary, so it gets its own quality-oriented default.
const INPAINT_DEFAULT_STEPS = 8;
const INPAINT_DEFAULT_CFG = 1;
const INPAINT_QUALITY_SUFFIX = `\n\nChỉ chỉnh phần được tô; giữ nội dung ngoài vùng tô nguyên vẹn. Khớp ánh sáng, bóng đổ, màu sắc và độ nét với vùng xung quanh. Giữ texture và chất liệu tự nhiên, không làm mịn hoặc làm sáng quá mức. Tách bạch rõ chất liệu khác nhau ở mép tiếp giáp. Chuyển tiếp tự nhiên, không có đường viền, vùng vá hoặc khác biệt chất liệu tại mép mask. Không tạo chữ, nhãn, logo, watermark hoặc ký tự nhìn thấy trên ảnh.`;
const SCENE_INTEGRATION_RULES = {
  edge: 'Làm mượt viền tiếp giáp với nền, giữ các sợi tóc và chi tiết nhỏ tự nhiên, không tạo halo hoặc viền sáng.',
  lighting: 'Khớp độ sáng, hướng sáng, nhiệt độ màu và độ tương phản của vùng tô với môi trường xung quanh.',
  shadow: 'Tạo hoặc chỉnh bóng tiếp xúc mềm, đúng hướng nguồn sáng và bề mặt nền; không để chủ thể có cảm giác lơ lửng.',
  texture: 'Khớp độ nét, hạt ảnh và texture ở ranh giới nhưng không làm nhòe hoặc thay đổi cấu trúc của chủ thể.'
};

function parseSceneIntegration(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(item => Object.hasOwn(SCENE_INTEGRATION_RULES, item));
}

function buildInpaintPrompt(userPrompt, sceneIntegration = []) {
  const sceneRules = sceneIntegration.map(item => SCENE_INTEGRATION_RULES[item]);
  const sceneSuffix = sceneRules.length
    ? `\n\nMục tiêu hòa ảnh ghép: ${sceneRules.join(' ')}`
    : '';
  return `${userPrompt.trim()}${INPAINT_QUALITY_SUFFIX}${sceneSuffix}`;
}

function buildWorkflow({ imageFilename, faceReferenceFilename, prompt, negativePrompt, denoise, seed, steps, cfg, filenamePrefix, clipName, unetName, vaeName }) {
  const positiveInputs = {
    prompt,
    target_size: 896,
    clip: ['70', 0],
    vae: ['82', 0],
    image1: ['41', 0]
  };
  if (faceReferenceFilename) positiveInputs.image2 = ['94', 0];

  return {
    // ── Load Image ─────────────────────────────────────────────────────────
    '41': {
      inputs: {
        image: imageFilename
      },
      class_type: 'LoadImage'
    },

    // A close crop of the source face is supplied as Qwen's second image
    // reference. It is conditioning only: no pixels are pasted or swapped.
    ...(faceReferenceFilename ? {
      '94': {
        inputs: { image: faceReferenceFilename },
        class_type: 'LoadImage'
      }
    } : {}),

    // ── Scale Image (upstream of VAEEncode) ────────────────────────────────
    '88': {
      inputs: {
        upscale_method: 'area',
        largest_size: 1280,
        image: ['41', 0]
      },
      class_type: 'ImageScaleToMaxDimension'
    },

    // ── VAE Encode ──────────────────────────────────────────────────────────
    '89': {
      inputs: {
        pixels: ['88', 0],
        vae: ['82', 0]
      },
      class_type: 'VAEEncode'
    },

    // ── Positive Prompt ─────────────────────────────────────────────────────
    '68': {
      inputs: positiveInputs,
      class_type: 'TextEncodeQwenImageEditPlus'
    },

    // ── Negative Prompt (blank) ─────────────────────────────────────────────
    '81': {
      inputs: {
        prompt: negativePrompt || '',
        target_size: 896,
        clip: ['70', 0],
        vae: ['82', 0]
      },
      class_type: 'TextEncodeQwenImageEditPlus'
    },

    // ── Model Sampling (AuraFlow + shift) ──────────────────────────────────
    '67': {
      inputs: {
        shift: 4.4,
        model: ['71', 0]
      },
      class_type: 'ModelSamplingAuraFlow'
    },

    // ── CFG Normalization ───────────────────────────────────────────────────
    '64': {
      inputs: {
        strength: 1,
        model: ['67', 0]
      },
      class_type: 'CFGNorm'
    },

    // ── KSampler ───────────────────────────────────────────────────────────
    '65': {
      inputs: {
        seed: seed,
        steps: steps,
        cfg: cfg,
        sampler_name: 'heun',
        scheduler: 'beta',
        denoise: denoise,
        model: ['64', 0],
        positive: ['68', 0],
        negative: ['81', 0],
        latent_image: ['89', 0]
      },
      class_type: 'KSampler'
    },

    // ── VAE Decode ──────────────────────────────────────────────────────────
    '8': {
      inputs: {
        samples: ['65', 0],
        vae: ['82', 0]
      },
      class_type: 'VAEDecode'
    },

    // ── Save Image ──────────────────────────────────────────────────────────
    '9': {
      inputs: {
        filename_prefix: filenamePrefix,
        images: ['8', 0]
      },
      class_type: 'SaveImage'
    },

    // ── Static loaders (model can be overridden via parameters) ─────────────────
    '70': {
      inputs: {
        clip_name: clipName || DEFAULT_CLIP_NAME,
        type: 'qwen_image'
      },
      class_type: 'CLIPLoaderGGUF'
    },
    '71': {
      inputs: {
        unet_name: unetName || DEFAULT_UNET_NAME
      },
      class_type: 'UnetLoaderGGUF'
    },
    '82': {
      inputs: {
        vae_name: vaeName || DEFAULT_VAE_NAME
      },
      class_type: 'VaeGGUF'
    }
  };
}

// Native Qwen inpaint workflow using a latent noise mask.
// Node IDs:
//   41  → LoadImage               (main image)
//   93  → LoadImage               (mask image - uses MASK output)
//   88  → ImageScaleToMaxDimension (scale 1280)
//   89  → VAEEncode
//   91  → SetLatentNoiseMask
//   94–98 → normalize the alpha mask, scale it to the source, and grow it
//   70  → CLIPLoaderGGUF
//   82  → VaeGGUF
//   71  → UnetLoaderGGUF
//   67  → ModelSamplingAuraFlow
//   64  → CFGNorm
//   68  → TextEncodeQwenImageEditPlus / Positive  (image1 from scaled)
//   81  → TextEncodeQwenImageEditPlus / Negative
//   65  → KSampler
//   8   → VAEDecode
//   9   → SaveImage
function buildInpaintWorkflow({ imageFilename, maskFilename, poseReferenceFilename, prompt, negativePrompt, denoise, seed, steps, cfg, growMask, filenamePrefix, clipName, unetName, vaeName }) {
  return {
    // ── Load Image (main) ─────────────────────────────────────────────────
    '41': {
      inputs: { image: imageFilename },
      class_type: 'LoadImage'
    },

    // ── Load Image (mask - uses MASK output) ──────────────────────────────
    '93': {
      inputs: { image: maskFilename },
      class_type: 'LoadImage'
    },

    ...(poseReferenceFilename ? {
      '99': {
        inputs: { image: poseReferenceFilename },
        class_type: 'LoadImage'
      }
    } : {}),

    // ── Scale source and mask to identical dimensions ──────────────────────
    // The input mask is painted at the original image size. It must follow
    // exactly the same resize as the source before it is used in latent space.
    '88': {
      inputs: {
        upscale_method: 'area',
        largest_size: 896,
        image: ['41', 0]
      },
      class_type: 'ImageScaleToMaxDimension'
    },

    // LoadImage exposes its MASK output as 1 - alpha. The editor exports
    // painted pixels as opaque, so invert once here to restore the app's
    // contract: white/painted = edit, transparent = preserve.
    '98': {
      inputs: { mask: ['93', 1] },
      class_type: 'InvertMask'
    },

    '94': {
      inputs: { mask: ['98', 0] },
      class_type: 'MaskToImage'
    },

    '95': {
      inputs: {
        upscale_method: 'nearest-exact',
        largest_size: 896,
        image: ['94', 0]
      },
      class_type: 'ImageScaleToMaxDimension'
    },

    '96': {
      inputs: {
        image: ['95', 0],
        channel: 'red'
      },
      class_type: 'ImageToMask'
    },

    '97': {
      inputs: {
        mask: ['96', 0],
        expand: growMask ?? 6,
        tapered_corners: true
      },
      class_type: 'GrowMask'
    },

    // Encode the full image first, then tell the sampler exactly which latent
    // pixels may receive noise. White in the app mask means "edit here".
    '89': {
      inputs: {
        pixels: ['88', 0],
        vae: ['82', 0]
      },
      class_type: 'VAEEncode'
    },

    '91': {
      inputs: {
        samples: ['89', 0],
        mask: ['97', 0]
      },
      class_type: 'SetLatentNoiseMask'
    },

    // ── CLIP Loader (Qwen2.5-VL) ───────────────────────────────────────────
    '70': {
      inputs: {
        clip_name: clipName || DEFAULT_CLIP_NAME,
        type: 'qwen_image'
      },
      class_type: 'CLIPLoaderGGUF'
    },

    // ── VAE Loader ─────────────────────────────────────────────────────────
    '82': {
      inputs: {
        vae_name: vaeName || DEFAULT_VAE_NAME
      },
      class_type: 'VaeGGUF'
    },

    // ── UNet Loader ───────────────────────────────────────────────────────
    '71': {
      inputs: {
        unet_name: unetName || DEFAULT_UNET_NAME
      },
      class_type: 'UnetLoaderGGUF'
    },

    // ── Model Sampling (AuraFlow + shift) ──────────────────────────────────
    '67': {
      inputs: {
        shift: 4.4,
        model: ['71', 0]
      },
      class_type: 'ModelSamplingAuraFlow'
    },

    // ── CFG Normalization ───────────────────────────────────────────────────
    '64': {
      inputs: {
        strength: 1,
        model: ['67', 0]
      },
      class_type: 'CFGNorm'
    },

    // ── Positive Prompt (with image reference from slot 2 of scaled image) ──
    '68': {
      inputs: {
        prompt: prompt,
        target_size: 896,
        clip: ['70', 0],
        vae: ['82', 0],
        // ImageScaleToMaxDimension exposes one IMAGE output: slot 0.  The
        // original graph link's *target* input is slot 2 of this text encoder;
        // it is not output slot 2 of the scale node.
        image1: ['88', 0],
        ...(poseReferenceFilename ? { image2: ['99', 0] } : {})
      },
      class_type: 'TextEncodeQwenImageEditPlus'
    },

    // ── Negative Prompt (image1 from slot 2 of scaled image) ───────────────
    '81': {
      inputs: {
        prompt: negativePrompt || '',
        target_size: 896,
        clip: ['70', 0],
        vae: ['82', 0],
        image1: ['88', 0]
      },
      class_type: 'TextEncodeQwenImageEditPlus'
    },

    // ── KSampler ───────────────────────────────────────────────────────────
    '65': {
      inputs: {
        seed: seed,
        steps: steps,
        cfg: cfg,
        sampler_name: 'heun',
        scheduler: 'beta',
        denoise: denoise,
        model: ['64', 0],
        positive: ['68', 0],
        negative: ['81', 0],
        latent_image: ['91', 0]
      },
      class_type: 'KSampler'
    },

    // ── VAE Decode ─────────────────────────────────────────────────────────
    '8': {
      inputs: {
        samples: ['65', 0],
        vae: ['82', 0]
      },
      class_type: 'VAEDecode'
    },

    // Composite only the edited (white) region back onto the scaled original.
    // This prevents Qwen from redrawing unrelated areas outside the mask.
    '92': {
      inputs: {
        destination: ['88', 0],
        source: ['8', 0],
        x: 0,
        y: 0,
        resize_source: false,
        mask: ['97', 0]
      },
      class_type: 'ImageCompositeMasked'
    },

    // ── Save Image ─────────────────────────────────────────────────────────
    '9': {
      inputs: {
        filename_prefix: filenamePrefix,
        images: ['92', 0]
      },
      class_type: 'SaveImage'
    }
  };
}

// ── Polling helper ─────────────────────────────────────────────────────────
async function waitForCompletion(promptId, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await axios.get(`${COMFYUI_BASE}/history/${promptId}`, {
      timeout: 10000
    });
    const history = res.data && res.data[promptId];
    if (history) {
      const status = history.status?.status_str;
      if (status === 'error') {
        const message = history.status?.messages?.map(item => item?.[0]).join(', ') || 'unknown error';
        throw new Error(`ComfyUI execution failed: ${message}`);
      }
      if (status === 'success') return history;
    }
    await sleep(500);
  }
  throw new Error(`Timeout waiting for prompt ${promptId} after ${timeoutMs}ms`);
}

function historyImagePaths(image, outputDir) {
  const filename = typeof image === 'string' ? image : image.filename;
  // ComfyUI reports filename and subfolder separately.  Use both so the proxy
  // works for app/ prefixes and any nested output folder.
  const subfolder = typeof image === 'string' ? '' : (image.subfolder || '');
  const safeSubfolder = path.normalize(subfolder).replace(/^(?:\.\.(?:[\\/]|$))+/, '');
  const safeFilename = path.basename(filename);
  // The app route already points outputDir at output/app.  Prefer ComfyUI's
  // explicit subfolder (relative to the output root), then retain that route
  // as a compatibility fallback for older history payloads without it.
  return {
    filename: safeFilename,
    paths: [...new Set([
      path.join(COMFYUI_OUTPUT_DIR, safeSubfolder, safeFilename),
      path.join(outputDir, safeFilename)
    ])]
  };
}

async function waitForOutputFile(image, outputDir, timeoutMs = 5000) {
  const resolved = historyImagePaths(image, outputDir);
  const start = Date.now();
  // On Windows, ComfyUI can publish history just before the PNG becomes
  // observable from another Node process.  Retrying here prevents the first
  // request from being rejected while a subsequent click happens to succeed.
  while (Date.now() - start < timeoutMs) {
    try {
      for (const candidate of resolved.paths) {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 0) {
          return { filename: resolved.filename, path: candidate };
        }
      }
    } catch {}
    await sleep(100);
  }
  return null;
}

async function collectOutputImages(history, outputDir) {
  const images = [];
  for (const [nodeId, nodeOutput] of Object.entries(history.outputs || {})) {
    for (const image of nodeOutput.images || []) {
      const resolved = await waitForOutputFile(image, outputDir);
      if (resolved) images.push({ ...resolved, node: nodeId });
    }
  }
  return images;
}

// ComfyUI's ImageCompositeMasked has a hard mask edge. Blend only a narrow
// alpha transition after generation so the edited area joins the untouched
// source without altering pixels away from the mask.
async function buildEffectiveMask(maskPath, width, height, grow) {
  const { data, info } = await sharp(maskPath).ensureAlpha().extractChannel('alpha')
    .resize(width, height, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true });
  let current = Buffer.from(data);
  // Same 8-neighbour growth model as GrowMask, kept at output resolution.
  for (let step = 0; step < Math.max(0, grow || 0); step++) {
    const next = Buffer.alloc(current.length);
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      let value = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const px = x + ox, py = y + oy;
        if (px >= 0 && py >= 0 && px < info.width && py < info.height) value = Math.max(value, current[py * info.width + px]);
      }
      next[y * info.width + x] = value;
    }
    current = next;
  }
  return { data: current, width: info.width, height: info.height };
}

function correctBoundaryExposure(generated, original, alpha) {
  let count = 0, dr = 0, dg = 0, db = 0;
  for (let i = 0, p = 0; i < alpha.length; i++, p += 3) {
    const a = alpha[i] / 255;
    const difference = Math.abs(original[p] - generated[p]) + Math.abs(original[p + 1] - generated[p + 1]) + Math.abs(original[p + 2] - generated[p + 2]);
    if (a > 0.12 && a < 0.88 && difference < 75) { dr += original[p] - generated[p]; dg += original[p + 1] - generated[p + 1]; db += original[p + 2] - generated[p + 2]; count++; }
  }
  if (!count) return generated;
  const delta = [dr / count, dg / count, db / count].map(value => Math.max(-12, Math.min(12, value)));
  const corrected = Buffer.from(generated);
  for (let i = 0, p = 0; i < alpha.length; i++, p += 3) {
    const edge = Math.max(0, 1 - Math.abs(alpha[i] / 255 * 2 - 1));
    if (!edge) continue;
    corrected[p] = Math.max(0, Math.min(255, corrected[p] + delta[0] * edge));
    corrected[p + 1] = Math.max(0, Math.min(255, corrected[p + 1] + delta[1] * edge));
    corrected[p + 2] = Math.max(0, Math.min(255, corrected[p + 2] + delta[2] * edge));
  }
  return corrected;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function toYCbCr(r, g, b) {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  };
}

function fromYCbCr(y, cb, cr) {
  return {
    r: clampByte(y + 1.402 * (cr - 128)),
    g: clampByte(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)),
    b: clampByte(y + 1.772 * (cb - 128))
  };
}

// Conservative, RGB-only skin estimate. It deliberately rejects saturated
// pink/red fabric so the optional correction does not recolour clothing.
function skinConfidence(r, g, b) {
  if (r < 55 || g < 35 || b < 20 || r < g * 0.9 || r < b * 1.05 || g < b * 0.68) return 0;
  if (r - g > 100 || g - b > 85) return 0;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 12) return 0;
  const { cb, cr } = toYCbCr(r, g, b);
  if (cb < 78 || cb > 142 || cr < 133 || cr > 188 || cr - cb < 10) return 0;
  return Math.min(1, (max - min) / 38);
}

function collectSkinStats(pixels, width, height, alpha, bounds, alphaCheck) {
  const left = Math.max(0, Math.floor(bounds.left));
  const top = Math.max(0, Math.floor(bounds.top));
  const right = Math.min(width, Math.ceil(bounds.right));
  const bottom = Math.min(height, Math.ceil(bounds.bottom));
  let weight = 0, y = 0, cb = 0, cr = 0;
  for (let row = top; row < bottom; row += 2) for (let col = left; col < right; col += 2) {
    const index = row * width + col;
    if (alphaCheck && !alphaCheck(alpha[index])) continue;
    const pixel = index * 3;
    const confidence = skinConfidence(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]);
    if (!confidence) continue;
    const color = toYCbCr(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]);
    weight += confidence;
    y += color.y * confidence;
    cb += color.cb * confidence;
    cr += color.cr * confidence;
  }
  return weight >= 35 ? { weight, y: y / weight, cb: cb / weight, cr: cr / weight } : null;
}

function matchGeneratedSkinTone(generated, width, height, alpha, face, sourceWidth, sourceHeight, sourcePixels) {
  if (!face) return generated;
  const scaleX = width / sourceWidth;
  const scaleY = height / sourceHeight;
  const referenceBounds = {
    left: face.x1 * scaleX,
    top: face.y1 * scaleY,
    right: face.x2 * scaleX,
    bottom: face.y2 * scaleY
  };
  // The face must remain outside the paint mask to be a trustworthy reference.
  const reference = collectSkinStats(sourcePixels, width, height, alpha, referenceBounds, value => value < 28);
  if (!reference) return generated;
  const target = collectSkinStats(generated, width, height, alpha, { left: 0, top: 0, right: width, bottom: height }, value => value > 180);
  if (!target) return generated;

  // Preserve texture and local light/shadow: only apply a bounded global
  // YCbCr offset to confidently detected generated-skin pixels.
  const deltaY = Math.max(-10, Math.min(10, reference.y - target.y)) * 0.42;
  const deltaCb = Math.max(-14, Math.min(14, reference.cb - target.cb)) * 0.68;
  const deltaCr = Math.max(-14, Math.min(14, reference.cr - target.cr)) * 0.68;
  const corrected = Buffer.from(generated);
  for (let index = 0, pixel = 0; index < alpha.length; index++, pixel += 3) {
    const maskStrength = Math.max(0, (alpha[index] - 160) / 95);
    if (!maskStrength) continue;
    const confidence = skinConfidence(generated[pixel], generated[pixel + 1], generated[pixel + 2]);
    if (!confidence) continue;
    const influence = maskStrength * confidence;
    const color = toYCbCr(generated[pixel], generated[pixel + 1], generated[pixel + 2]);
    const output = fromYCbCr(color.y + deltaY * influence, color.cb + deltaCb * influence, color.cr + deltaCr * influence);
    corrected[pixel] = output.r;
    corrected[pixel + 1] = output.g;
    corrected[pixel + 2] = output.b;
  }
  return corrected;
}

async function softenInpaintSeams(images, sourcePath, maskPath, growMask, { skinToneMatch = false } = {}) {
  const source = await sharp(sourcePath).rotate().metadata();
  if (!source.width || !source.height) return images;
  let referenceFace = null;
  if (skinToneMatch) {
    try {
      const faces = await detectFaces(sourcePath);
      referenceFace = faces.sort((a, b) => ((b.x2 - b.x1) * (b.y2 - b.y1)) - ((a.x2 - a.x1) * (a.y2 - a.y1)))[0] || null;
    } catch (error) {
      console.warn('[PROXY] Skin-tone match skipped: face reference unavailable.', error.message);
    }
  }
  return Promise.all(images.map(async (image) => {
    const generated = await sharp(image.path).metadata();
    if (!generated.width || !generated.height) return image;
    const effective = await buildEffectiveMask(maskPath, generated.width, generated.height, growMask);
    const rawMask = { raw: { width: effective.width, height: effective.height, channels: 1 } };
    const { data: fineAlphaRaw } = await sharp(effective.data, rawMask).blur(2.5).raw().toBuffer({ resolveWithObject: true });
    const fineAlpha = await sharp(fineAlphaRaw, rawMask).png().toBuffer();
    const wideAlpha = await sharp(effective.data, rawMask).blur(7).png().toBuffer();
    const filename = image.filename.replace(/(\.[^.]+)$/, '_blended$1');
    const outputPath = path.join(path.dirname(image.path), filename);
    const base = await sharp(sourcePath).rotate().resize(generated.width, generated.height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    const { data: baseRaw } = await sharp(base).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data: generatedRaw } = await sharp(image.path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const correctedRaw = correctBoundaryExposure(generatedRaw, baseRaw, fineAlphaRaw);
    const skinMatchedRaw = skinToneMatch
      ? matchGeneratedSkinTone(correctedRaw, generated.width, generated.height, effective.data, referenceFace, source.width, source.height, baseRaw)
      : correctedRaw;
    const correctedPixels = await sharp(skinMatchedRaw, { raw: { width: generated.width, height: generated.height, channels: 3 } }).png().toBuffer();
    const fineForeground = await sharp(correctedPixels).joinChannel(fineAlpha).png().toBuffer();
    const wideForeground = await sharp(correctedPixels).joinChannel(wideAlpha).png().toBuffer();
    // Wide low-frequency blend removes colour/lighting jumps; the fine blend
    // restores edge texture, producing a two-band transition rather than one blur.
    const lowBand = await sharp(base).composite([{ input: wideForeground }]).png().toBuffer();
    const blendedModelSize = await sharp(lowBand).composite([{ input: fineForeground }]).png().toBuffer();

    // Preserve the user's original resolution outside the edited area. Qwen
    // still works at 896px, but only its edited result is upscaled for the
    // final composite; untouched pixels never go through the downscale path.
    const nativeBase = await sharp(sourcePath).rotate().png().toBuffer();
    const nativeMeta = await sharp(nativeBase).metadata();
    const scale = nativeMeta.width / generated.width;
    const nativeMask = await buildEffectiveMask(maskPath, nativeMeta.width, nativeMeta.height, Math.round((growMask || 0) * scale));
    const nativeMaskRaw = { raw: { width: nativeMask.width, height: nativeMask.height, channels: 1 } };
    const nativeAlpha = await sharp(nativeMask.data, nativeMaskRaw).blur(Math.max(2.5, 2.5 * scale)).png().toBuffer();
    const upscaledEdited = await sharp(blendedModelSize).resize(nativeMeta.width, nativeMeta.height, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().png().toBuffer();
    const nativeForeground = await sharp(upscaledEdited).joinChannel(nativeAlpha).png().toBuffer();
    await sharp(nativeBase).composite([{ input: nativeForeground }]).png().toFile(outputPath);
    // The raw ComfyUI result has served its purpose once the seam-blended
    // image is safely written. Keep only the final image in the app gallery.
    if (path.resolve(image.path) !== path.resolve(outputPath) && fs.existsSync(image.path)) {
      try {
        await fs.promises.unlink(image.path);
        console.log(`[PROXY] Removed intermediate inpaint image: ${image.filename}`);
      } catch (error) {
        // Returning the completed image is more important than cleanup; leave
        // a recoverable intermediate behind if Windows currently locks it.
        console.warn(`[PROXY] Could not remove intermediate ${image.filename}: ${error.message}`);
      }
    }
    return { ...image, filename, path: outputPath };
  }));
}

async function detectFaces(imagePath) {
  const { stdout } = await execFileAsync(COMFYUI_PYTHON, [FACE_DETECTOR_SCRIPT, imagePath], {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, COMFYUI_ROOT }
  });
  const result = JSON.parse(stdout);
  return Array.isArray(result.faces) ? result.faces : [];
}

async function createFaceReference(sourcePath) {
  const faces = await detectFaces(sourcePath);
  if (faces.length === 0) return null;

  // In a multi-person image, use the largest face as the primary subject.
  const face = faces.sort((a, b) => ((b.x2 - b.x1) * (b.y2 - b.y1)) - ((a.x2 - a.x1) * (a.y2 - a.y1)))[0];
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Cannot read source image dimensions');

  const faceWidth = face.x2 - face.x1;
  const faceHeight = face.y2 - face.y1;
  const left = Math.max(0, Math.floor(face.x1 - faceWidth * 0.35));
  const top = Math.max(0, Math.floor(face.y1 - faceHeight * 0.50));
  const right = Math.min(metadata.width, Math.ceil(face.x2 + faceWidth * 0.35));
  const bottom = Math.min(metadata.height, Math.ceil(face.y2 + faceHeight * 0.30));
  const width = right - left;
  const height = bottom - top;
  if (width < 16 || height < 16) return null;

  const filename = `face_reference_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  await sharp(sourcePath).extract({ left, top, width, height }).png().toFile(path.join(COMFYUI_INPUT_DIR, filename));
  return filename;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Background generation jobs ────────────────────────────────────────────
// Android may suspend a long-running WebView fetch in the background. Keep
// the ComfyUI wait on the server and expose a small job record the app can
// poll again whenever it returns to the foreground.
const generationJobs = new Map();
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GENERATION_JOBS = 100;

function publicGenerationJob(job) {
  return {
    id: job.id,
    promptId: job.promptId,
    feature: job.feature,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    images: job.images.map(image => ({ filename: image.filename })),
    meta: job.meta,
    error: job.error || null
  };
}

function pruneGenerationJobs() {
  const expiry = Date.now() - JOB_TTL_MS;
  for (const [id, job] of generationJobs) {
    if (job.updatedAt < expiry) generationJobs.delete(id);
  }
  if (generationJobs.size <= MAX_GENERATION_JOBS) return;
  const oldest = [...generationJobs.values()]
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, generationJobs.size - MAX_GENERATION_JOBS);
  oldest.forEach(job => generationJobs.delete(job.id));
}

function normalizeClientJobId(value, promptId) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value)
    ? value
    : promptId;
}

function createGenerationJob({ id, promptId, feature, outputDir, preferredNode, meta, postprocessImages }) {
  pruneGenerationJobs();
  const now = Date.now();
  const job = {
    id,
    promptId,
    feature,
    outputDir,
    preferredNode,
    meta,
    status: 'queued',
    images: [],
    error: null,
    createdAt: now,
    updatedAt: now
  };
  generationJobs.set(id, job);

  // Detached on purpose: generation continues after the request returns or
  // the Android app is put in the background.
  void (async () => {
    try {
      job.status = 'processing';
      job.updatedAt = Date.now();
      const history = await waitForCompletion(promptId);
      let images = await collectOutputImages(history, outputDir);
      if (postprocessImages) images = await postprocessImages(images);
      if (!images.length) throw new Error('No output images found');
      job.images = preferredNode
        ? [images.find(image => image.node === preferredNode) || images[0], ...images.filter(image => image.node !== preferredNode)]
        : images;
      job.status = 'completed';
      job.updatedAt = Date.now();
      console.log(`[PROXY] Job ${job.id} completed with ${job.images.length} image(s)`);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message || 'Generation failed';
      job.updatedAt = Date.now();
      console.error(`[PROXY] Job ${job.id} failed:`, job.error);
    }
  })();

  return job;
}

require('./gallery-service').installGallery(app, path.join(COMFYUI_OUTPUT_DIR, APP_OUTPUT_SUBFOLDER));
require('./chat-service').installChat(app, {
  root: path.join(__dirname, 'data', 'chats'),
  inputDir: COMFYUI_INPUT_DIR,
  outputDir: COMFYUI_OUTPUT_DIR,
  comfy: axios.create({ baseURL: COMFYUI_BASE, timeout: 8000 }),
  buildWorkflow
});

// ── API Routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/jobs/:jobId
 * Read a resumable generation job. If the proxy restarted, recover completed
 * app jobs from ComfyUI history where possible.
 */
app.get('/api/jobs/:jobId', async (req, res) => {
  const job = generationJobs.get(req.params.jobId);
  if (job) return res.json(publicGenerationJob(job));

  try {
    const promptId = typeof req.query.prompt_id === 'string' ? req.query.prompt_id : req.params.jobId;
    const historyRes = await axios.get(`${COMFYUI_BASE}/history/${encodeURIComponent(promptId)}`, { timeout: 5000 });
    const history = historyRes.data?.[promptId];
    if (history?.status?.status_str === 'success') {
      const images = await collectOutputImages(history, path.join(COMFYUI_OUTPUT_DIR, APP_OUTPUT_SUBFOLDER));
      return res.json({
        id: req.params.jobId,
        promptId,
        status: 'completed',
        images: images.map(image => ({ filename: image.filename })),
        meta: {},
        error: null
      });
    }
  } catch {
    // The client retains the local job and retries after the next resume.
  }
  return res.status(404).json({ error: 'Generation job not found yet' });
});

/**
 * POST /api/edit
 *
 * Body (multipart/form-data):
 *   image    – image file (required)
 *   prompt   – string (required)   → maps to node 68 "prompt"
 *   denoise  – number 0.0–1.0     → maps to node 65 "denoise"
 *   seed     – number (optional, default random)
 *   steps    – number (optional, default 4)
 *   cfg      – number (optional, default 1)
 */
app.post('/api/edit', upload.single('image'), async (req, res) => {
  try {
    // ── 1. Validate input ──────────────────────────────────────────────────
    if (!req.file) {
      return res.status(400).json({ error: 'Missing image file (field name: "image")' });
    }
    const imageFilename = req.file.filename;

    const prompt = req.body.prompt;
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
      // Delete uploaded file on validation error
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Missing or empty "prompt" field' });
    }

    const denoise = parseFloat(req.body.denoise);
    if (isNaN(denoise) || denoise < 0 || denoise > 1) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '"denoise" must be a number between 0 and 1' });
    }
    const preserveFace = req.body.preserve_face !== 'false';
    const negativePrompt = typeof req.body.negative === 'string' ? req.body.negative.trim() : '';

    // Optional params with defaults
    const seed = parseInt(req.body.seed) || Math.floor(Math.random() * 1e9);
    const steps = parseInt(req.body.steps) || 4;
    const cfg = parseFloat(req.body.cfg) || 1;

    // Optional model names (default values used if not provided)
    const clipName = req.body.clip_name || undefined;
    const unetName = req.body.unet_name || undefined;
    const vaeName = req.body.vae_name || undefined;

    // Detect request source: app sends X-Source header
    const isAppRequest = req.headers['x-source'] === 'app';
    // SaveImage can restart its counter and overwrite a shared prefix. Give
    // every request a stable, client-supplied key instead.
    const outputKey = normalizeClientJobId(req.body.client_job_id, `edit-${Date.now()}`);
    const filenamePrefix = isAppRequest ? `${APP_OUTPUT_SUBFOLDER}/ComfyUI_Proxy_${outputKey}` : `ComfyUI_Proxy_${outputKey}`;
    const outputDir = isAppRequest
      ? path.join(COMFYUI_OUTPUT_DIR, APP_OUTPUT_SUBFOLDER)
      : COMFYUI_OUTPUT_DIR;

    // Ensure app output subfolder exists
    if (isAppRequest && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    let faceReferenceFilename = null;
    let conditionedPrompt = prompt.trim();
    try {
      if (preserveFace) {
        faceReferenceFilename = await createFaceReference(req.file.path);
      }
      if (faceReferenceFilename) {
        conditionedPrompt += '\n\nPreserve the exact facial identity, facial proportions, eyes, nose, mouth, expression, and skin details from image2. Image2 is the face identity reference for the person in image1. Do not change, redraw, replace, beautify, or stylize the face.';
      }
    } catch (faceReferenceError) {
      // A non-face image remains a valid edit request; it simply runs without
      // the additional facial reference.
      console.warn(`[PROXY] Face reference unavailable: ${faceReferenceError.message}`);
    }

    console.log(`[PROXY] image=${imageFilename} prompt="${prompt}" denoise=${denoise} seed=${seed} preserve_face=${preserveFace} face_reference=${faceReferenceFilename || 'none'} source=${isAppRequest ? 'app' : 'web'}`);

    // ── 2. Build workflow ──────────────────────────────────────────────────
    const workflow = buildWorkflow({ imageFilename, faceReferenceFilename, prompt: conditionedPrompt, negativePrompt, denoise, seed, steps, cfg, filenamePrefix, clipName, unetName, vaeName });

    // ── 3. Queue prompt on ComfyUI ─────────────────────────────────────────
    const queueRes = await axios.post(`${COMFYUI_BASE}/prompt`, {
      prompt: workflow
    }, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });

    const promptId = queueRes.data.prompt_id;
    if (!promptId) {
      fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: 'ComfyUI did not return a prompt_id', detail: queueRes.data });
    }

    console.log(`[PROXY] Queued prompt ${promptId}`);

    if (req.query.async === '1') {
      const job = createGenerationJob({
        id: normalizeClientJobId(req.body.client_job_id, promptId),
        promptId,
        feature: 'edit',
        outputDir,
        meta: {
          seed,
          denoise,
          steps,
          cfg,
          faceReference: preserveFace ? (faceReferenceFilename ? 'applied' : 'unavailable') : 'off'
        }
      });
      return res.status(202).json(publicGenerationJob(job));
    }

    // ── 4. Wait for completion ─────────────────────────────────────────────
    const history = await waitForCompletion(promptId);

    // ── 5. Extract output images from history ──────────────────────────────
    const images = await collectOutputImages(history, outputDir);

    console.log(`[PROXY] Done. ${images.length} image(s) produced`);

    // ── 6. Return first image as binary + JSON metadata ───────────────────
    if (images.length === 0) {
      return res.status(500).json({ error: 'No output images found', history });
    }

    const primary = images[0];
    const imgBuffer = fs.readFileSync(primary.path);

    // Return raw PNG binary with metadata in custom headers.
    // Clients can read metadata from response headers:
    //   X-Prompt-ID  → prompt_id
    //   X-Filename   → filename
    //   X-Seed       → seed used
    //   X-Denoise    → denoise used
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${primary.filename}"`);
    res.setHeader('X-Prompt-ID', promptId);
    res.setHeader('X-Filename', primary.filename);
    res.setHeader('X-Seed', String(seed));
    res.setHeader('X-Denoise', String(denoise));
    res.setHeader('X-Steps', String(steps));
    res.setHeader('X-Cfg', String(cfg));
    res.setHeader('X-Images-Found', String(images.length));
    res.setHeader('X-All-Filenames', JSON.stringify(images.map(i => i.filename)));
    res.setHeader('X-Face-Reference', preserveFace ? (faceReferenceFilename ? 'applied' : 'unavailable') : 'off');
    if (isAppRequest) {
      res.setHeader('X-Output-Source', 'app');
    }

    console.log(`[PROXY] Done. ${images.length} image(s) produced`);
    return res.end(imgBuffer);

  } catch (err) {
    console.error('[PROXY] Error:', err.message);
    const status = err.response ? err.response.status : 500;
    res.status(status).json({
      error: err.message,
      detail: err.response ? err.response.data : null
    });
  }
});

/**
 * POST /api/inpaint
 * Body (multipart/form-data):
 *   image      = ảnh chính
 *   mask       = ảnh mask (đen trắng, dùng MASK output của LoadImage)
 *   prompt     = chỉ dẫn chỉnh sửa vùng được mask
 *   negative   = (tuỳ chọn) negative prompt
 *   denoise    = 0..1
 *   grow_mask  = (tuỳ chọn) số pixel mở rộng vùng mask, mặc định 6
 *   skin_tone_match = true để cân tông da vùng mới với mặt gốc được giữ lại
 * Uses the inpaint workflow derived from rapid (1).json
 */
app.post('/api/inpaint', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'mask', maxCount: 1 },
  { name: 'pose_reference', maxCount: 1 }
]), async (req, res) => {
  try {
    const imageFile = req.files?.image?.[0];
    const maskFile = req.files?.mask?.[0];
    const poseReferenceFile = req.files?.pose_reference?.[0];
    if (!imageFile) return res.status(400).json({ error: 'Image file is required (field name: "image")' });
    if (!maskFile) return res.status(400).json({ error: 'Mask file is required (field name: "mask")' });

    const seed = parseInt(req.body.seed, 10) || Math.floor(Math.random() * 1e9);
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    const negativePrompt = typeof req.body.negative === 'string' ? req.body.negative.trim() : '';
    const denoise = parseFloat(req.body.denoise);
    if (!prompt) return res.status(400).json({ error: 'Missing or empty "prompt" field' });
    if (req.body.pose_label && !poseReferenceFile) return res.status(400).json({ error: 'Pose reference image is required' });
    if (isNaN(denoise) || denoise < 0 || denoise > 1) {
      return res.status(400).json({ error: '"denoise" must be a number between 0 and 1' });
    }
    const steps = parseInt(req.body.steps, 10) || INPAINT_DEFAULT_STEPS;
    const cfg = parseFloat(req.body.cfg) || INPAINT_DEFAULT_CFG;
    const growMask = parseInt(req.body.grow_mask, 10);
    const skinToneMatch = req.body.skin_tone_match === 'true';
    const sceneIntegration = parseSceneIntegration(req.body.scene_integration);
    const clipName = req.body.clip_name || undefined;
    const unetName = req.body.unet_name || undefined;
    const vaeName = req.body.vae_name || undefined;
    const isAppRequest = req.headers['x-source'] === 'app';
    // Never reuse one static "Inpaint" prefix: ComfyUI may emit 00001 again
    // and silently overwrite an earlier result while the app is backgrounded.
    const outputKey = normalizeClientJobId(req.body.client_job_id, `inpaint-${Date.now()}`);
    const filenamePrefix = isAppRequest ? `${APP_OUTPUT_SUBFOLDER}/Inpaint_${outputKey}` : `Inpaint_${outputKey}`;
    const outputDir = isAppRequest ? path.join(COMFYUI_OUTPUT_DIR, APP_OUTPUT_SUBFOLDER) : COMFYUI_OUTPUT_DIR;
    if (isAppRequest && !fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const workflow = buildInpaintWorkflow({
      imageFilename: imageFile.filename,
      maskFilename: maskFile.filename,
      poseReferenceFilename: poseReferenceFile?.filename,
      prompt: poseReferenceFile
        ? buildInpaintPrompt(`Image1 is the original photograph. Image2 is a reference for BODY POSE ONLY, not the person's identity, face, clothing or background. Change the pose of the subject in image1 within the painted mask toward the body position and limb arrangement shown in image2. Keep the original person's identity, face, outfit, body appearance, camera framing, and environment. Preserve all pixels outside the mask. Selected pose: ${String(req.body.pose_label || 'reference pose').slice(0, 80)}. User request: ${prompt}`, sceneIntegration)
        : buildInpaintPrompt(prompt, sceneIntegration),
      negativePrompt,
      denoise,
      seed,
      steps,
      cfg,
      growMask: isNaN(growMask) ? 6 : growMask,
      filenamePrefix,
      clipName,
      unetName,
      vaeName
    });

    console.log(`[PROXY] inpaint image=${imageFile.filename} mask=${maskFile.filename} pose=${poseReferenceFile?.filename || 'none'} denoise=${denoise} skinToneMatch=${skinToneMatch} scene=${sceneIntegration.join('|') || 'none'} seed=${seed}`);
    const queueRes = await axios.post(`${COMFYUI_BASE}/prompt`, { prompt: workflow }, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });
    const promptId = queueRes.data.prompt_id;
    if (!promptId) return res.status(500).json({ error: 'ComfyUI did not return a prompt_id', detail: queueRes.data });

    if (req.query.async === '1') {
      const job = createGenerationJob({
        id: normalizeClientJobId(req.body.client_job_id, promptId),
        promptId,
        feature: 'inpaint',
        outputDir,
        preferredNode: '9',
        meta: { seed, denoise, steps, cfg },
        postprocessImages: (images) => softenInpaintSeams(
          images,
          path.join(COMFYUI_INPUT_DIR, imageFile.filename),
          path.join(COMFYUI_INPUT_DIR, maskFile.filename),
          isNaN(growMask) ? 6 : growMask,
          { skinToneMatch }
        )
      });
      return res.status(202).json(publicGenerationJob(job));
    }

    const history = await waitForCompletion(promptId);
    const images = await softenInpaintSeams(
      await collectOutputImages(history, outputDir),
      path.join(COMFYUI_INPUT_DIR, imageFile.filename),
      path.join(COMFYUI_INPUT_DIR, maskFile.filename),
      isNaN(growMask) ? 6 : growMask,
      { skinToneMatch }
    );
    if (!images.length) return res.status(500).json({ error: 'No output images found', history });

    const result = images.find(image => image.node === '9') || images[0];
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Prompt-ID', promptId);
    res.setHeader('X-Filename', result.filename);
    res.setHeader('X-Seed', String(seed));
    res.setHeader('X-Denoise', String(denoise));
    res.setHeader('X-Steps', String(steps));
    res.setHeader('X-Cfg', String(cfg));
    res.setHeader('X-Mask-Filename', maskFile.filename);
    if (isAppRequest) res.setHeader('X-Output-Source', 'app');
    return res.end(fs.readFileSync(result.path));
  } catch (err) {
    console.error('[PROXY] Inpaint error:', err.message);
    const status = err.response ? err.response.status : 500;
    return res.status(status).json({ error: err.message, detail: err.response ? err.response.data : null });
  }
});

/**
 * POST /api/upload
 * Upload a file to ComfyUI input directory (no workflow execution).
 */
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }
  res.json({ filename: req.file.filename, path: req.file.path });
});

/**
 * GET /api/queue
 * Return current ComfyUI queue status.
 */
app.get('/api/queue', async (req, res) => {
  try {
    const [history, queue] = await Promise.all([
      axios.get(`${COMFYUI_BASE}/history`, { timeout: 5000 }),
      axios.get(`${COMFYUI_BASE}/queue`, { timeout: 5000 })
    ]);
    res.json({ history: history.data, queue: queue.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/system_stats
 * Return ComfyUI system stats.
 */
app.get('/api/system_stats', async (req, res) => {
  try {
    const r = await axios.get(`${COMFYUI_BASE}/system_stats`, { timeout: 5000 });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/output/:filename
 * Delete an output image from ComfyUI output folder.
 * Header X-Source: app  →  looks in output/app/ subfolder
 */
app.delete('/api/output/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const isAppRequest = req.headers['x-source'] === 'app';
  const baseDir = isAppRequest
    ? path.join(COMFYUI_OUTPUT_DIR, APP_OUTPUT_SUBFOLDER)
    : COMFYUI_OUTPUT_DIR;
  const imgPath = path.join(baseDir, filename);
  if (!fs.existsSync(imgPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    fs.unlinkSync(imgPath);
    console.log(`[PROXY] Deleted output file: ${filename} (source: ${isAppRequest ? 'app' : 'web'})`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error(`[PROXY] Failed to delete ${filename}:`, err.message);
    res.status(500).json({ error: 'Failed to delete file', detail: err.message });
  }
});

/**
 * GET /api/output/:filename
 * Serve a previously generated output image.
 * Header X-Source: app  →  looks in output/app/ subfolder
 */
app.get('/api/output/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const isAppRequest = req.headers['x-source'] === 'app';
  const baseDir = isAppRequest
    ? path.join(COMFYUI_OUTPUT_DIR, APP_OUTPUT_SUBFOLDER)
    : COMFYUI_OUTPUT_DIR;
  const imgPath = path.join(baseDir, filename);
  if (!fs.existsSync(imgPath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.setHeader('Content-Type', 'image/png');
  fs.createReadStream(imgPath).pipe(res);
});

/**
 * POST /api/shutdown
 * Stop ComfyUI process then exit this proxy server.
 */
app.post('/api/shutdown', async (req, res) => {
  res.json({ message: 'Đang ngắt kết nối ComfyUI và proxy server...' });

  const { execSync } = require('child_process');

  // 1. Clear ComfyUI queue
  try {
    await axios.post(`${COMFYUI_BASE}/queue`, { clear: true }, { timeout: 10000 });
    console.log('[PROXY] ComfyUI queue cleared');
  } catch (e) {
    console.warn('[PROXY] Could not clear ComfyUI queue:', e.message);
  }

  // 2. Kill run_nvidia_gpu.bat and ComfyUI processes
  //    Uses WMI to find Python processes by command line (works without admin)
  try {
    execSync(
      'powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'python.exe\' -and ($_.CommandLine -like \'*ComfyUI*\' -or $_.CommandLine -like \'*run_nvidia*\' -or $_.CommandLine -like \'*main.py*\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host \'Killed PID:\' $_.ProcessId }"',
      { stdio: 'inherit' }
    );
    console.log('[PROXY] ComfyUI processes killed');
  } catch { }

  // 3. Kill any remaining python processes in the ComfyUI directories
  try {
    execSync(
      'powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'python.exe\' -and $_.ExecutablePath -like \'*ComfyUI*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      { stdio: 'ignore' }
    );
    console.log('[PROXY] ComfyUI python.exe processes killed');
  } catch { }

  // 5. Exit this server
  setTimeout(() => {
    console.log('[PROXY] Proxy server shutting down.');
    process.exit(0);
  }, 500);
});

/**
 * GET /api/models
 * List available GGUF models (Unet, CLIP, VAE).
 */
app.get('/api/models', (req, res) => {
  const comfyuiRoot = path.dirname(COMFYUI_INPUT_DIR);

  const listFiles = (subDir, pattern) => {
    try {
      const dir = path.join(comfyuiRoot, 'models', subDir);
      if (!fs.existsSync(dir)) {
        console.log(`[MODELS] Dir not found: ${dir}`);
        return [];
      }
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.gguf'))
        .map(name => ({ name, type: pattern }));
      console.log(`[MODELS] ${subDir}: ${files.length} gguf files`);
      return files;
    } catch (e) {
      console.log(`[MODELS] Error in ${subDir}:`, e.message);
      return [];
    }
  };

  res.json({
    unet: listFiles('unet', 'unet'),
    clip: listFiles('clip', 'clip'),
    vae: listFiles('vae', 'vae'),
  });
});

/**
 * GET /health
 * Health check.
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', comfyui: COMFYUI_BASE });
});

// ── Error handlers ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (max 50 MB)' });
    }
    return res.status(400).json({ error: err.message });
  }
  console.error('[PROXY] Unhandled error:', err);
  res.status(500).json({ error: err.message });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, BIND_HOST, () => {
  console.log(`\n  ComfyUI Proxy Server`);
  console.log(`  Listening on http://${BIND_HOST}:${PORT}`);
  console.log(`  ComfyUI target : ${COMFYUI_BASE}`);
  console.log(`  Input dir      : ${COMFYUI_INPUT_DIR}`);
  console.log(`  Output dir     : ${COMFYUI_OUTPUT_DIR}`);
  console.log(`  App output dir : ${path.join(COMFYUI_OUTPUT_DIR, APP_OUTPUT_SUBFOLDER)}`);
  console.log(`\n`);
});
