import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';
import ModelSelector from './ModelSelector';
import './ImageChat.css';

async function request(route, options) {
  const response = await fetch(`${API_BASE}/api/chats${route}`, { ...options, signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Không kết nối được lịch sử chat.');
  return data;
}
const makeId = () => globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const pending = turn => ['submitting', 'queued', 'processing'].includes(turn.status);
const media = (id, name) => `${API_BASE}/api/chats/${id}/media/${encodeURIComponent(name)}`;
const MAX_IMAGE_SIZE = 50 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|bmp)$/i;

export default function ImageChat() {
  const [list, setList] = useState([]);
  const [id, setId] = useState(() => localStorage.getItem('image-chat:last-id') || '');
  const [chat, setChat] = useState(null);
  const [showLibrary, setShowLibrary] = useState(!id);
  const [gallery, setGallery] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [source, setSource] = useState('');
  const [denoise, setDenoise] = useState(0.75);
  const [model, setModel] = useState({ unet: '', clip: '', vae: '' });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState('');
  const [draggingImage, setDraggingImage] = useState(false);
  const inFlight = useRef(false);
  const requestId = useRef(null);
  const dragDepth = useRef(0);
  const uploadInput = useRef(null);
  const currentId = useRef(id);
  currentId.current = id;
  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        const [items, record] = await Promise.all([request(''), id ? request(`/${id}`) : null]);
        if (!disposed) { setList(items); setChat(record); }
      } catch (err) { if (!disposed) setError(err.message); }
      finally { refreshing = false; }
    }
    void refresh();
    const timer = setInterval(refresh, 4000);
    const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', refresh);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('focus', refresh); };
  }, [id]);
  const select = record => {
    setId(record.id); localStorage.setItem('image-chat:last-id', record.id);
    setChat(null); setShowLibrary(false); setGallery(false); setSource(''); setFile(null); setPrompt(''); setError(''); requestId.current = null;
  };
  async function create() {
    if (inFlight.current) return;
    inFlight.current = true; setSending(true);
    try { select(await request('', { method: 'POST' })); }
    catch (err) { setError(err.message); }
    finally { inFlight.current = false; setSending(false); }
  }
  const latest = chat?.turns?.filter(turn => turn.output).at(-1)?.output;
  const base = source || latest;
  const busy = sending || chat?.turns?.some(pending);
  function selectUploadFile(candidate) {
    if (!candidate) return;
    if (!ALLOWED_IMAGE_EXTENSIONS.test(candidate.name || '') || (candidate.type && !candidate.type.startsWith('image/'))) {
      setError('Chỉ nhận ảnh PNG, JPG/JPEG, WebP hoặc BMP.');
      return;
    }
    if (candidate.size > MAX_IMAGE_SIZE) {
      setError('Ảnh vượt quá giới hạn 50 MB.');
      return;
    }
    setFile(candidate);
    setSource('');
    setGallery(false);
    setError('');
  }
  function hasDraggedFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }
  function resetDragState() {
    dragDepth.current = 0;
    setDraggingImage(false);
  }
  function handleDragEnter(event) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    if (busy || !chat || showLibrary) return;
    dragDepth.current += 1;
    setDraggingImage(true);
  }
  function handleDragOver(event) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy || !chat || showLibrary ? 'none' : 'copy';
  }
  function handleDragLeave(event) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingImage(false);
  }
  function handleDrop(event) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    const droppedFiles = Array.from(event.dataTransfer.files || []);
    resetDragState();
    if (!chat || showLibrary) {
      setError('Mở hoặc tạo cuộc trò chuyện trước khi thêm ảnh.');
      return;
    }
    if (busy) {
      setError('AI đang xử lý ảnh. Hãy thả ảnh mới sau khi lượt hiện tại hoàn tất.');
      return;
    }
    if (droppedFiles.length !== 1) {
      setError('Mỗi lần chỉ kéo thả một ảnh.');
      return;
    }
    selectUploadFile(droppedFiles[0]);
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || inFlight.current || !prompt.trim() || (!file && !base)) return;
    inFlight.current = true; setSending(true); setError('');
    const targetId = id;
    requestId.current ||= makeId();
    const form = new FormData();
    form.append('turnId', requestId.current);
    form.append('prompt', prompt.trim()); form.append('denoise', String(denoise));
    if (file) form.append('image', file);
    else form.append('source', base);
    for (const [key, value] of Object.entries(model)) if (value) form.append(key, value);
    try {
      const record = await request(`/${targetId}/turns`, { method: 'POST', body: form });
      if (currentId.current === targetId) { setChat(record); setPrompt(''); setFile(null); setSource(''); }
      requestId.current = null;
    } catch (err) {
      // The id remains stable: a second send acknowledges the original request.
      if (currentId.current === targetId) setError(`${err.message} Bạn có thể gửi lại để kiểm tra lượt vừa gửi.`);
    } finally { inFlight.current = false; setSending(false); }
  }
  function editFrom(name) { setSource(name); setFile(null); setGallery(false); document.querySelector('.chat-composer textarea')?.focus(); }
  return <section
    className={`image-chat${draggingImage ? ' is-dragging-image' : ''}`}
    onDragEnter={handleDragEnter}
    onDragOver={handleDragOver}
    onDragLeave={handleDragLeave}
    onDrop={handleDrop}
    onDragEnd={resetDragState}
  >
    {draggingImage && <div className="chat-drop-overlay" aria-hidden="true"><strong>Thả ảnh vào đây để chỉnh sửa</strong><span>PNG, JPG, WebP hoặc BMP · tối đa 50 MB</span></div>}
    <div className="chat-header">
      <button type="button" onClick={() => setShowLibrary(value => !value)} aria-expanded={showLibrary}>Lịch sử</button>
      <div className="chat-heading"><strong>Chat chỉnh ảnh</strong><small>Chỉnh từng bước, giữ trọn ý tưởng.</small></div>
      <button type="button" onClick={create} disabled={sending}>＋ Mới</button>
    </div>
    {error && <p className="chat-error" role="alert">{error}<button onClick={() => setError('')} type="button">Đóng</button></p>}
    {showLibrary && <div className="chat-library">
      <p>Lưu trên máy AI · Mở lại cuộc trò chuyện để xem ảnh</p>
      {!list.length && <p>Chưa có cuộc trò chuyện. Bấm “＋ Mới” để bắt đầu.</p>}
      {list.map(item => <button type="button" key={item.id} onClick={() => select(item)} className={id === item.id ? 'selected' : ''}>
        <strong>{item.title}</strong><small>{item.count} lượt · {item.busy ? 'Đang tạo ảnh' : new Date(item.updatedAt).toLocaleString('vi-VN')}</small>
      </button>)}
    </div>}
    {!showLibrary && chat && <>
      <div className="chat-title"><h2>{chat.title}</h2><button type="button" onClick={() => setGallery(value => !value)}>{gallery ? 'Tin nhắn' : 'Kho ảnh'}</button></div>
      {chat.turns.length > 0 && <p className="chat-note">Mỗi lượt tiếp tục từ ảnh kết quả gần nhất. Thêm ảnh mới để đổi ảnh đầu vào.</p>}
      {gallery ? <div className="chat-gallery">
        {chat.turns.flatMap(turn => [turn.source, turn.output].filter(Boolean)).filter((name, index, all) => all.indexOf(name) === index).map(name => <div key={name}>
          <button type="button" className="chat-photo" onClick={() => setLightbox(media(id, name))}><img loading="lazy" src={media(id, name)} alt="Ảnh trong cuộc trò chuyện" /></button>
          <button type="button" onClick={() => editFrom(name)}>Chỉnh từ ảnh này</button>
        </div>)}
        {!chat.turns.length && <p>Ảnh đầu vào và kết quả sẽ xuất hiện ở đây.</p>}
      </div> : <div className="chat-messages">
        {!chat.turns.length && <div className="chat-empty">
          <span className="chat-step-label">01 / CHỌN ẢNH</span>
          <h3>Bắt đầu từ ý tưởng của bạn</h3>
          <p>Thêm ảnh, rồi mô tả điều bạn muốn thay đổi.</p>
          <button type="button" className="chat-upload-zone" disabled={busy} onClick={() => uploadInput.current?.click()}>
            {preview ? <img src={preview} alt="Ảnh đã chọn" /> : <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></svg>}
            <strong>{file ? 'Đổi ảnh đã chọn' : 'Chọn ảnh hoặc kéo thả vào đây'}</strong>
            <small>PNG, JPG, WebP, BMP · tối đa 50 MB</small>
          </button>
        </div>}
        {chat.turns.map(turn => <article key={turn.id} className="chat-turn">
          <div className="chat-user"><button type="button" className="chat-photo" onClick={() => setLightbox(media(id, turn.source))}><img loading="lazy" src={media(id, turn.source)} alt="Ảnh dùng cho yêu cầu này" /></button><p>{turn.prompt}</p></div>
          <div className="chat-assistant">
            {turn.output ? <><button type="button" className="chat-photo" onClick={() => setLightbox(media(id, turn.output))}><img loading="lazy" src={media(id, turn.output)} alt="Kết quả chỉnh ảnh" /></button>
              <div className="chat-image-actions"><button type="button" onClick={() => editFrom(turn.output)}>Chỉnh tiếp ảnh này</button><a href={`${media(id, turn.output)}?download=1`} download>Tải ảnh</a></div></>
              : <p role="status">{turn.status === 'failed' ? turn.error : turn.status === 'processing' ? 'AI đang chỉnh ảnh… Bạn có thể rời màn hình và quay lại.' : 'Đã nhận yêu cầu, đang chờ xử lý…'}</p>}
          </div>
        </article>)}
      </div>}
      <form className="chat-composer" onSubmit={submit}>
        {(preview || base) && <div className="chat-source">
          {(preview || base) && <img src={preview || media(id, base)} alt="Ảnh sẽ chỉnh tiếp" />}
          <span>{file ? file.name : source ? 'Ảnh bạn đã chọn' : latest ? 'Tiếp tục từ kết quả gần nhất' : 'Chọn ảnh để bắt đầu'}</span>
          {(file || source) && <button type="button" onClick={() => { setFile(null); setSource(''); }}>Bỏ chọn</button>}
        </div>}
        <label className="chat-prompt-label" htmlFor="chat-prompt">Bạn muốn thay đổi điều gì?</label>
        <textarea id="chat-prompt" aria-label="Yêu cầu chỉnh ảnh" placeholder="Ví dụ: Đổi nền thành khu vườn, giữ nguyên chủ thể…" value={prompt} maxLength={4000} onChange={event => setPrompt(event.target.value)} rows={3} disabled={sending} />
        <details><summary>Tùy chọn tạo ảnh</summary>
          <label>Cường độ thay đổi: {denoise}<input type="range" min="0.1" max="1" step="0.01" value={denoise} onChange={event => setDenoise(Number(event.target.value))} /></label>
          <ModelSelector value={model} onChange={setModel} />
        </details>
        <div className="chat-send-row"><label className="chat-attach">＋ Thêm ảnh<input ref={uploadInput} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" disabled={busy} onChange={event => { selectUploadFile(event.target.files?.[0]); event.target.value = ''; }} /></label>
          <button className="chat-send" type="submit" disabled={busy || !prompt.trim() || (!file && !base)}>{busy ? 'Đang xử lý…' : 'Gửi yêu cầu ↑'}</button></div>
        <p className="chat-composer-hint" role="status">{busy ? 'Bạn có thể quay lại khi ảnh hoàn tất.' : !file && !base ? 'Chọn ảnh để bắt đầu.' : !prompt.trim() ? 'Nhập mô tả để gửi yêu cầu.' : 'Sẵn sàng chỉnh ảnh.'}</p>
      </form>
    </>}
    {lightbox && <div className="chat-lightbox" role="dialog" aria-modal="true" aria-label="Xem ảnh"><button type="button" onClick={() => setLightbox('')}>Đóng ảnh</button><img src={lightbox} alt="Ảnh phóng lớn" /></div>}
  </section>;
}
