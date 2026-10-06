import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import './ImageLibrary.css';

export default function ImageLibrary({ onClose, onDeleted }) {
  const [images, setImages] = useState([]);
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [notice, setNotice] = useState('');
  const [limit, setLimit] = useState(40);
  const [query, setQuery] = useState('');
  const url = (image, thumb = false) => `${API_BASE}/api/gallery/${encodeURIComponent(image.filename)}${thumb ? '?thumbnail=1' : ''}`;
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch(`${API_BASE}/api/gallery`, { signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Không tải được kho ảnh.');
      setImages(data.images); setDirectory(data.directory);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = old; };
  }, []);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape') { if (selected) setSelected(null); else onClose(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [selected, onClose]);
  async function remove() {
    if (!selected || deleting) return;
    if (!window.confirm(`Xóa vĩnh viễn file ${selected.filename} khỏi output/app?\nKhông thể hoàn tác. Bản sao đã lưu trong lịch sử chat (nếu có) vẫn được giữ.`)) return;
    setDeleting(true); setError('');
    const name = selected.filename;
    try {
      const response = await fetch(`${API_BASE}/api/gallery/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) { const data = await response.json(); throw new Error(data.error || 'Không xóa được ảnh.'); }
      setImages(previous => previous.filter(image => image.filename !== name));
      onDeleted(name); setSelected(null);
    } catch (err) { setError(err.message); }
    finally { setDeleting(false); }
  }
  async function download(image) {
    if (downloading) return;
    setDownloading(image.filename); setError(''); setNotice('');
    try {
      const response = await fetch(url(image), { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('Không tải được ảnh gốc. Vui lòng thử lại.');
      const blob = await response.blob();
      if (Capacitor.isNativePlatform()) {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('Không đọc được dữ liệu ảnh.'));
          reader.readAsDataURL(blob);
        });
        await Filesystem.writeFile({ path: `AI Photo Editor/${image.filename}`, directory: Directory.Documents, data, recursive: true });
        setNotice(`Đã lưu vào Documents/AI Photo Editor/${image.filename}`);
      } else {
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl; link.download = image.filename;
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        setNotice('Đã gửi ảnh gốc tới trình tải xuống của trình duyệt.');
      }
    } catch (err) { setError(err.message || 'Không lưu được ảnh. Kiểm tra kết nối và quyền lưu tệp.'); }
    finally { setDownloading(''); }
  }
  const filtered = images.filter(image => image.filename.toLowerCase().includes(query.toLowerCase()));
  return <section className="image-library" role="dialog" aria-modal="true" aria-label="Kho ảnh đã tạo">
    <header><button type="button" onClick={() => selected ? setSelected(null) : onClose()}>← {selected ? 'Kho ảnh' : 'Đóng'}</button><strong>Kho ảnh</strong><button type="button" onClick={refresh} disabled={loading}>Làm mới</button></header>
    {error && <p className="library-error" role="alert">{error}</p>}
    {notice && <p className="library-notice" role="status">{notice}</p>}
    {selected ? <div className="library-preview">
      <img src={url(selected)} alt={selected.filename} />
      <p>{selected.filename}</p>
      <small>{new Date(selected.modifiedAt).toLocaleString('vi-VN')} · {(selected.bytes / 1048576).toFixed(2)} MB</small>
      <button className="library-download" type="button" onClick={() => download(selected)} disabled={!!downloading}>{downloading === selected.filename ? 'Đang tải…' : '↓ Tải ảnh gốc'}</button>
      <button className="library-delete" type="button" onClick={remove} disabled={deleting}>{deleting ? 'Đang xóa…' : 'Xóa khỏi máy'}</button>
    </div> : <>
      <p>{images.length} ảnh · { (images.reduce((sum, item) => sum + item.bytes, 0) / 1048576).toFixed(1) } MB</p>
      <details><summary>Thư mục lưu ảnh</summary><p className="library-path">{directory}</p><p>Hiển thị tất cả file ảnh trong output/app, bao gồm bản gốc và bản đã ghép. Bản lưu riêng trong chat được quản lý ở lịch sử chat.</p></details>
      <input aria-label="Tìm ảnh theo tên" placeholder="Tìm theo tên ảnh…" value={query} onChange={event => { setQuery(event.target.value); setLimit(40); }} />
      {loading && <p role="status">Đang đọc kho ảnh…</p>}
      {!loading && !filtered.length && <p>Chưa có ảnh phù hợp.</p>}
      <div className="library-grid">{filtered.slice(0, limit).map(image => <div className="library-card" key={image.filename}><button type="button" onClick={() => setSelected(image)}>
        <img src={url(image, true)} loading="lazy" alt={image.filename} /><span>{image.filename}</span>
      </button><button className="library-download" type="button" onClick={() => download(image)} disabled={!!downloading} aria-label={`Tải ảnh ${image.filename}`}>{downloading === image.filename ? 'Đang tải…' : '↓ Tải ảnh'}</button></div>)}</div>
      {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 40)}>Xem thêm ảnh</button>}
    </>}
  </section>;
}
