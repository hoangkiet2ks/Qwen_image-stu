# ComfyUI Proxy Server

Node.js/Express server gửi HTTP request tới ComfyUI (`localhost:8188`) theo workflow `qwen-edit-rapid-aio-gguf.json`.

---

## Cài đặt

```bash
cd comfy-proxy
cp .env.example .env   # chỉnh sửa .env cho đúng đường dẫn
npm install
```

## Chạy

```bash
npm start
# hoặc dev mode (tự restart khi sửa code):
npm run dev
```

Server mặc định chạy trên `http://localhost:3000`.

---

## Cấu hình (environment variables)

Tạo file `.env` từ `.env.example`:

```bash
cp .env.example .env
# Sửa các giá trị trong .env cho đúng với máy bạn
```

| Variable              | Default                                              | Mô tả                           |
|-----------------------|------------------------------------------------------|---------------------------------|
| `PORT`                | `3000`                                               | Port chạy proxy server          |
| `COMFYUI_HOST`        | `127.0.0.1`                                          | Host của ComfyUI                 |
| `COMFYUI_PORT`        | `8188`                                               | Port của ComfyUI                 |
| `COMFYUI_INPUT_DIR`   | `C:\ComfyUI_windows\ComfyUI\input`                   | Thư mục input của ComfyUI        |
| `COMFYUI_OUTPUT_DIR`  | `C:\ComfyUI_windows\ComfyUI\output`                  | Thư mục output của ComfyUI       |

**Lưu ý:** Cập nhật `COMFYUI_INPUT_DIR` và `COMFYUI_OUTPUT_DIR` cho đúng đường dẫn ComfyUI trên máy bạn.

---

## API Endpoints

### `POST /api/edit` — Chỉnh sửa ảnh

Gửi ảnh + prompt tới ComfyUI, chờ kết quả và trả ảnh về.

**Content-Type:** `multipart/form-data`

| Field      | Loại    | Mô tả                                                    |
|------------|---------|----------------------------------------------------------|
| `image`    | File    | Ảnh đầu vào (PNG/JPG/WebP/BMP, tối đa 50 MB)           |
| `prompt`   | String  | Chỉ dẫn chỉnh sửa — map vào node **68** (`TextEncodeQwenImageEditPlus` positive) |
| `denoise`  | Number  | Cường độ chỉnh sửa 0.0–1.0 — map vào node **65** (`KSampler`) |
| `seed`     | Number  | Random seed cho KSampler (mặc định: random)              |
| `steps`    | Number  | Số bước sampling (mặc định: 4)                           |
| `cfg`      | Number  | CFG scale (mặc định: 1)                                  |

**Response:** Trả về file ảnh PNG binary, kèm headers:

| Header             | Mô tả                                  |
|--------------------|----------------------------------------|
| `X-Filename`       | Tên file ảnh output                    |
| `X-Prompt-ID`      | ID của prompt trên ComfyUI             |
| `X-Seed`           | Seed đã dùng                           |
| `X-Denoise`        | Giá trị denoise                        |
| `X-Steps`          | Số bước sampling                       |
| `X-Cfg`            | Giá trị CFG                            |
| `X-Images-Found`   | Số lượng ảnh output                    |
| `X-All-Filenames`  | JSON array chứa tất cả filename       |
| `Content-Disposition` | Force download filename            |

> Nếu cần metadata dạng JSON, dùng `GET /api/output/:filename` sau khi gọi `/api/edit`.

**Ví dụ cURL:**

```bash
curl -X POST http://localhost:3000/api/edit \
  -F "image=@input.png" \
  -F "prompt=change the background to sunset" \
  -F "denoise=0.68" \
  -F "steps=4" \
  -F "cfg=1" \
  -o output.png
```

**Ví dụ JavaScript:**

```js
const form = new FormData();
form.append('image', fileInput.files[0]);
form.append('prompt', 'change hair color to red');
form.append('denoise', 0.7);
form.append('steps', 4);
form.append('cfg', 1);

const res = await fetch('http://localhost:3000/api/edit', {
  method: 'POST',
  body: form
});

if (!res.ok) {
  const err = await res.json();
  console.error('Error:', err.error);
  return;
}

// Read metadata from response headers
const filename  = res.headers.get('X-Filename');
const promptId  = res.headers.get('X-Prompt-ID');
const seed      = res.headers.get('X-Seed');
const allFiles  = JSON.parse(res.headers.get('X-All-Filenames') || '[]');

// Read binary image
const blob = await res.blob();
const url = URL.createObjectURL(blob);

// Preview / download
const img = new Image();
img.src = url;
document.body.appendChild(img);

// Or force download:
const a = document.createElement('a');
a.href = url;
a.download = filename;
a.click();
```

**Metadata endpoint** — sau khi có filename, tra JSON metadata từ ComfyUI history:

```js
const historyRes = await fetch(`http://localhost:3000/api/queue`);
const data = await historyRes.json();
// Tìm prompt_id trong history.data để lấy chi tiết đầy đủ
```

---

### `POST /api/upload` — Upload ảnh

Chỉ upload ảnh vào thư mục input của ComfyUI (không chạy workflow).

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "image=@my-image.png"
```

**Response:**
```json
{ "filename": "my-image_1741234567890.png", "path": "..." }
```

---

### `GET /api/output/:filename` — Lấy ảnh output

Serve file ảnh từ thư mục output của ComfyUI.

```bash
curl http://localhost:3000/api/output/my-generated-image.png -o out.png
```

---

### `GET /api/queue` — Trạng thái queue

```bash
curl http://localhost:3000/api/queue
```

---

### `GET /api/system_stats` — System stats của ComfyUI

```bash
curl http://localhost:3000/api/system_stats
```

---

### `GET /health` — Health check

```bash
curl http://localhost:3000/health
# → { "status": "ok", "comfyui": "http://127.0.0.1:8188" }
```

---

## Node Mapping

Workflow sử dụng các node sau từ `qwen-edit-rapid-aio-gguf.json`:

| Node ID | Class Type                     | Trường gửi từ client | Ghi chú                                          |
|---------|-------------------------------|-----------------------|--------------------------------------------------|
| **41**  | `LoadImage`                   | `image` (file)       | Upload vào ComfyUI input dir, dùng filename     |
| **68**  | `TextEncodeQwenImageEditPlus` | `prompt`              | Prompt text cho chỉnh sửa (positive)            |
| **65**  | `KSampler`                   | `denoise`, `seed`, `steps`, `cfg` | Các thông số sampling chính               |
| **81**  | `TextEncodeQwenImageEditPlus` | — (blank)            | Negative prompt, luôn để trống                   |
| **8**   | `VAEDecode`                  | —                     | Tự động decode latent → pixel                  |
| **9**   | `SaveImage`                   | —                     | Output: ảnh cuối được trả về cho client          |

Các node `70` (CLIPLoader), `71` (UnetLoader), `82` (VAE Loader), `88` (Scale), `89` (VAEEncode) giữ nguyên cấu hình từ file JSON gốc.

---

## Yêu cầu hệ thống

- **Node.js** ≥ 18
- **ComfyUI** đang chạy trên `localhost:8188` (hoặc cổng khác qua env `COMFYUI_PORT`)
- ComfyUI phải có các custom node: `TextEncodeQwenImageEditPlus`, `CLIPLoaderGGUF`, `UnetLoaderGGUF`, `VaeGGUF`
- Các file model GGUF phải nằm đúng thư mục:
  - `Qwen2.5-VL-7B-Instruct-abliterated.Q4_K_S.gguf`
  - `qwen-rapid-nsfw-v9.0-Q4_K_S.gguf`
  - `pig_qwen_image_vae_fp32-f16.gguf`
