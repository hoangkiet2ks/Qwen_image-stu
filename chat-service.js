const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

// Each conversation is committed atomically; image copies belong to the chat
// archive, not to the temporary ComfyUI output history.
function installChat(app, { root, inputDir, outputDir, comfy, buildWorkflow, autoPoll = true }) {
  fs.mkdirSync(root, { recursive: true });
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value);
  const records = new Map();
  for (const file of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      if (validId(record.id) && Array.isArray(record.turns)) records.set(record.id, record);
    } catch (error) { console.error('[CHAT] Cannot read archive', file, error.message); }
  }
  const save = record => {
    record.updatedAt = Date.now();
    const target = path.join(root, `${record.id}.json`);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(record));
    fs.renameSync(`${target}.tmp`, target);
    records.set(record.id, record);
  };
  const busy = turn => ['submitting', 'queued', 'processing'].includes(turn.status);
  const locks = new Set();
  const mediaDir = record => path.join(root, record.id);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  const summary = record => ({ id: record.id, title: record.title, updatedAt: record.updatedAt,
    count: record.turns.length, busy: record.turns.some(busy) });
  const wrap = action => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
  app.get('/api/chats', (req, res) => res.json([...records.values()].map(summary).sort((a, b) => b.updatedAt - a.updatedAt)));
  app.post('/api/chats', (req, res) => {
    const record = { id: randomUUID(), title: 'Cuộc trò chuyện mới', turns: [], createdAt: Date.now() };
    fs.mkdirSync(mediaDir(record), { recursive: true });
    save(record);
    res.status(201).json(record);
  });
  app.get('/api/chats/:id', (req, res) => {
    const record = records.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện.' });
    res.json(record);
  });
  app.get('/api/chats/:id/media/:name', (req, res) => {
    const record = records.get(req.params.id);
    const name = req.params.name;
    if (!record || !record.turns.some(turn => turn.source === name || turn.output === name)) {
      return res.status(404).json({ error: 'Không tìm thấy ảnh.' });
    }
    if (req.query.download === '1') return res.download(path.join(mediaDir(record), name));
    res.sendFile(path.resolve(mediaDir(record), name));
  });
  app.post('/api/chats/:id/turns', upload.single('image'), wrap(async (req, res) => {
    const record = records.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Không tìm thấy cuộc trò chuyện.' });
    const turnId = req.body.turnId;
    if (!validId(turnId)) return res.status(400).json({ error: 'Mã lượt không hợp lệ.' });
    // Mobile retries always reuse their id, including after an interrupted upload.
    if (record.turns.some(turn => turn.id === turnId)) return res.status(202).json(record);
    if (locks.has(record.id) || record.turns.some(busy)) return res.status(409).json({ error: 'Đợi ảnh hiện tại hoàn tất rồi chỉnh tiếp.' });
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    const denoise = Number(req.body.denoise ?? 0.75);
    if (!prompt || prompt.length > 4000 || !Number.isFinite(denoise) || denoise < 0 || denoise > 1) {
      return res.status(400).json({ error: 'Nhập yêu cầu tối đa 4000 ký tự và cường độ từ 0 đến 1.' });
    }
    locks.add(record.id);
    try {
      let source = req.body.source;
      if (req.file) {
        source = `${turnId}-input.png`;
        await sharp(req.file.buffer, { limitInputPixels: 40000000 }).rotate().png().toFile(path.join(mediaDir(record), source));
      } else {
        source = source || [...record.turns].reverse().find(turn => turn.output)?.output;
        if (!source || !record.turns.some(turn => turn.source === source || turn.output === source)) {
          return res.status(400).json({ error: 'Chọn ảnh đầu vào cho lượt chỉnh sửa.' });
        }
      }
      const seed = Math.floor(Math.random() * 1e9);
      const turn = { id: turnId, prompt, source, status: 'submitting', createdAt: Date.now(), meta: { seed, steps: 4, denoise, cfg: 1 } };
      record.turns.push(turn);
      if (record.turns.length === 1) record.title = prompt.slice(0, 70);
      save(record);
      try {
        const imageFilename = `chat-${turnId}.png`;
        fs.copyFileSync(path.join(mediaDir(record), source), path.join(inputDir, imageFilename));
        const workflow = buildWorkflow({ imageFilename, prompt, ...turn.meta,
          unetName: req.body.unet || undefined, clipName: req.body.clip || undefined, vaeName: req.body.vae || undefined,
          filenamePrefix: `app/Chat_${turnId}` });
        const result = await comfy.post('/prompt', { prompt: workflow, extra_data: { chatTurnId: turnId } }, { timeout: 15000 });
        if (!result.data.prompt_id) throw new Error('ComfyUI không trả về mã xử lý.');
        turn.promptId = result.data.prompt_id;
        turn.status = 'queued';
      } catch (error) {
        // Network timeout is ambiguous: recover via queue/history, never submit twice.
        if (error.response || !['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code)) {
          turn.status = 'failed';
          turn.error = error.response?.data?.error?.message || error.message;
        }
      }
      save(record);
      res.status(202).json(record);
    } finally { locks.delete(record.id); }
  }));

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const record of records.values()) for (const turn of record.turns.filter(busy)) {
        if (locks.has(record.id)) continue;
        try {
          if (!turn.promptId) {
            const [queue, history] = await Promise.all([comfy.get('/queue'), comfy.get('/history?max_items=100')]);
            const queued = [...(queue.data.queue_running || []), ...(queue.data.queue_pending || [])]
              .find(item => item[3]?.chatTurnId === turn.id);
            const completed = Object.entries(history.data).find(([, entry]) => entry.prompt?.[3]?.chatTurnId === turn.id);
            turn.promptId = queued?.[1] || completed?.[0];
            if (!turn.promptId) {
              if (Date.now() - turn.createdAt > 120000) { turn.status = 'failed'; turn.error = 'Không xác nhận được lượt trong ComfyUI. Kiểm tra lịch sử trước khi gửi lại.'; save(record); }
              continue;
            }
            turn.status = 'queued';
            save(record);
          }
          const response = await comfy.get(`/history/${encodeURIComponent(turn.promptId)}`);
          const entry = response.data[turn.promptId];
          if (!entry) {
            const queue = await comfy.get('/queue');
            const running = (queue.data.queue_running || []).some(item => item[1] === turn.promptId);
            const pending = (queue.data.queue_pending || []).some(item => item[1] === turn.promptId);
            if (!running && !pending && Date.now() - turn.createdAt > 120000) {
              turn.status = 'failed'; turn.error = 'Lượt tạo không còn trong hàng đợi/lịch sử ComfyUI.'; save(record);
            } else if (running && turn.status !== 'processing') { turn.status = 'processing'; save(record); }
            continue;
          }
          if (entry.status?.status_str === 'error') {
            turn.status = 'failed'; turn.error = 'ComfyUI xử lý lỗi. Kiểm tra model và bộ nhớ GPU.'; save(record); continue;
          }
          const output = entry.outputs?.['9']?.images?.[0];
          if (!output) {
            if (entry.status?.completed) { turn.status = 'failed'; turn.error = 'Lượt hoàn tất nhưng không có ảnh.'; save(record); }
            continue;
          }
          const file = path.resolve(outputDir, output.subfolder || '', output.filename);
          if (!file.startsWith(path.resolve(outputDir) + path.sep)) throw new Error('Invalid output path');
          const name = `${turn.id}-result.png`;
          fs.copyFileSync(file, path.join(mediaDir(record), name));
          turn.output = name;
          turn.status = 'completed';
          save(record);
        } catch (error) {
          // Leave jobs pending during a network outage or while output is flushing.
          console.warn('[CHAT] Will retry', turn.id, error.message);
        }
      }
    } finally { polling = false; }
  }
  const timer = autoPoll ? setInterval(() => void poll(), 4000) : null;
  timer?.unref();
  app.use('/api/chats', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Ảnh tối đa 25 MB.' : error.message });
  });
  return { poll, close: () => clearInterval(timer) };
}
module.exports = { installChat };
