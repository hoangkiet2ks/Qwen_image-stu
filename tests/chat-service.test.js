const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const sharp = require('sharp');
const { installChat } = require('../chat-service');

test('chat archives input/output, deduplicates submissions and resumes after restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-chat-test-'));
  const inputDir = path.join(dir, 'input'); const outputDir = path.join(dir, 'output');
  fs.mkdirSync(inputDir); fs.mkdirSync(outputDir);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3388aa' } }).png().toBuffer();
  let posts = 0; const graphs = []; const history = {};
  const comfy = {
    post: async (url, body) => { graphs.push(body.prompt); return { data: { prompt_id: `prompt-${++posts}` } }; },
    get: async url => ({ data: url.startsWith('/history/') ? history : { queue_running: [], queue_pending: [] } })
  };
  const options = { root: path.join(dir, 'archive'), inputDir, outputDir, comfy, buildWorkflow: value => value, autoPoll: false };
  const app = express(); app.use(express.json()); const service = installChat(app, options);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); service.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/chats`;
  const record = await (await fetch(base, { method: 'POST' })).json();
  const form = () => { const body = new FormData(); body.append('turnId', 'test-turn-0001'); body.append('prompt', 'Change the background to blue'); body.append('image', new Blob([png]), 'test.png'); return body; };
  let response = await fetch(`${base}/${record.id}/turns`, { method: 'POST', body: form() });
  assert.equal(response.status, 202);
  response = await fetch(`${base}/${record.id}/turns`, { method: 'POST', body: form() });
  assert.equal(response.status, 202); assert.equal(posts, 1);
  const parallel = new FormData(); parallel.append('turnId', 'test-turn-0002'); parallel.append('prompt', 'Change to green');
  assert.equal((await fetch(`${base}/${record.id}/turns`, { method: 'POST', body: parallel })).status, 409);
  fs.writeFileSync(path.join(outputDir, 'result.png'), png);
  history['prompt-1'] = { status: { status_str: 'success', completed: true }, outputs: { '9': { images: [{ filename: 'result.png' }] } } };
  // A fresh service reads pending jobs from disk and archives their finished output.
  const app2 = express(); app2.use(express.json()); const resumed = installChat(app2, options);
  t.after(() => resumed.close());
  await resumed.poll();
  const saved = JSON.parse(fs.readFileSync(path.join(options.root, `${record.id}.json`)));
  assert.equal(saved.turns[0].status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(options.root, record.id, saved.turns[0].output)), png);
  assert.equal(graphs[0].steps, 4);
  const server2 = app2.listen(0, '127.0.0.1'); await new Promise(resolve => server2.once('listening', resolve));
  t.after(() => server2.close());
  const base2 = `http://127.0.0.1:${server2.address().port}/api/chats/${record.id}`;
  const next = new FormData(); next.append('turnId', 'test-turn-0002'); next.append('prompt', 'Make the background green');
  const continued = await (await fetch(`${base2}/turns`, { method: 'POST', body: next })).json();
  assert.equal(continued.turns[1].source, saved.turns[0].output);
  assert.equal(posts, 2);
  const denied = await fetch(`${base2}/media/unknown.png`);
  assert.equal(denied.status, 404);
  assert.equal((await fetch(`${base2}/media/${saved.turns[0].output}`)).status, 200);
});
