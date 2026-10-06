const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

function installGallery(app, root) {
  const extension = /\.(png|jpe?g|webp|bmp)$/i;
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { res.status(error.code === 'ENOENT' ? 404 : error.status || 500).json({ error: error.code === 'ENOENT' ? 'Ảnh không còn tồn tại.' : error.message }); }
  };
  async function resolveImage(name) {
    if (!extension.test(name) || name !== path.basename(name) || /[\\/:]/.test(name)) {
      throw Object.assign(new Error('Tên ảnh không hợp lệ.'), { status: 400 });
    }
    const file = path.join(root, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Không phải file ảnh.'), { status: 400 });
    return file;
  }
  app.get('/api/gallery', wrap(async (req, res) => {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const images = (await Promise.all(entries.filter(entry => entry.isFile() && extension.test(entry.name)).map(async entry => {
      try {
        const stat = await fs.stat(path.join(root, entry.name));
        return { filename: entry.name, bytes: stat.size, modifiedAt: stat.mtimeMs };
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }))).filter(Boolean).sort((a, b) => b.modifiedAt - a.modifiedAt);
    res.set('Cache-Control', 'no-store').json({ images, directory: root });
  }));
  app.get('/api/gallery/:name', wrap(async (req, res) => {
    const file = await resolveImage(req.params.name);
    res.set('Cache-Control', 'no-store');
    if (req.query.thumbnail === '1') {
      const data = await sharp(file).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
      return res.type('webp').send(data);
    }
    res.sendFile(path.resolve(file));
  }));
  app.delete('/api/gallery/:name', wrap(async (req, res) => {
    const file = await resolveImage(req.params.name);
    await fs.unlink(file);
    res.json({ deleted: req.params.name });
  }));
}
module.exports = { installGallery };
