import { useState } from 'react';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import './ResultViewer.css';

export default function ResultViewer({ results, isLoading, error, apiBase, onDelete, comparison = false }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImg, setLightboxImg] = useState(null);

  if (isLoading) {
    return (
      <div className="result-viewer result-loading">
        <div className="loading-animation">
          <div className="loading-ring" />
          <div className="loading-ring delay-1" />
          <div className="loading-ring delay-2" />
        </div>
        <p className="loading-text">ComfyUI đang xử lý…</p>
        <p className="loading-hint">Bạn có thể chuyển chức năng hoặc đưa app ra nền; ảnh sẽ tự tải lại khi quay lại.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="result-viewer result-error">
        <div className="error-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <p className="error-title">Đã xảy ra lỗi</p>
        <p className="error-message">{error}</p>
      </div>
    );
  }

  if (!results || results.length === 0) {
    if (comparison) {
      return (
        <div className="result-viewer result-ready comparison-empty-state">
          <div className="comparison-grid">
            <div className="comparison-card comparison-placeholder">
              <div className="comparison-label">Ảnh trước đổi mặt</div>
              <div className="comparison-empty-image">
                <svg viewBox="0 0 64 64" fill="none">
                  <rect x="8" y="8" width="48" height="48" rx="4" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
                  <path d="M24 40l8-12 6 8 6-8 8 12" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                </svg>
                <span>Sẽ hiển thị ảnh từ Qwen</span>
              </div>
            </div>
            <div className="comparison-card comparison-placeholder">
              <div className="comparison-label">Ảnh đã đổi mặt</div>
              <div className="comparison-empty-image">
                <svg viewBox="0 0 64 64" fill="none">
                  <circle cx="32" cy="25" r="10" stroke="currentColor" strokeWidth="2" />
                  <path d="M14 54c2-10 9-15 18-15s16 5 18 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span>Sẽ hiển thị sau ReActor</span>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="result-viewer result-empty">
        <div className="empty-icon">
          <svg viewBox="0 0 64 64" fill="none">
            <rect x="8" y="8" width="48" height="48" rx="4" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
            <path d="M24 40l8-12 6 8 6-8 8 12" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </div>
        <p className="empty-text">Chưa có kết quả</p>
        <p className="empty-hint">Upload ảnh, nhập prompt rồi bấm <strong>Tạo ảnh</strong> để bắt đầu</p>
      </div>
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  const blobToBase64 = (blob) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const hapticLight = async () => {
    try { await Haptics.impact({ style: ImpactStyle.Light }); } catch {}
  };

  const hapticHeavy = async () => {
    try { await Haptics.impact({ style: ImpactStyle.Heavy }); } catch {}
  };

  const openPreview = async (result) => {
    await hapticLight();
    setLightboxImg(result);
    setLightboxOpen(true);
  };

  // ── Download ──────────────────────────────────────────────────────────────
  const downloadImage = async (result) => {
    await hapticLight();
    // Use the original filename from ComfyUI output (e.g. ComfyUI_Proxy_00001_.png)
    const filename = result.filename || 'result.png';
    const saveName = filename.replace(/\.(png|jpg|jpeg|webp|bmp)$/i, '_saved.png');
    try {
      const isMobile = !!window.Capacitor;
      if (isMobile) {
        const base64 = await fetch(result.url)
          .then(r => r.blob())
          .then(b => blobToBase64(b));

        await Filesystem.writeFile({
          path: saveName,
          data: base64,
          directory: Directory.Documents,
        });
        await hapticHeavy();
        alert(`Đã lưu: Documents/${saveName}`);
      } else {
        const res = await fetch(result.url);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = saveName;
        a.click();
      }
    } catch {
      window.open(result.url, '_blank');
    }
  };

  // ── Delete current output ───────────────────────────────────────────────
  const deleteOutput = async (result) => {
    if (!window.confirm(`Xoá ảnh "${result.filename}"?`)) return;
    await hapticLight();
    try {
      await fetch(`${apiBase}/api/output/${encodeURIComponent(result.filename)}`, {
        method: 'DELETE',
      });
    } catch {}
    if (onDelete) onDelete(result.filename);
    await hapticHeavy();
    // Close lightbox if open for this image
    if (lightboxImg?.filename === result.filename) {
      setLightboxOpen(false);
      setLightboxImg(null);
    }
  };

  // ── Lightbox save ───────────────────────────────────────────────────────
  const handleLightboxSave = async () => {
    setLightboxOpen(false);
    await downloadImage(lightboxImg);
  };

  // ── Lightbox delete ──────────────────────────────────────────────────────
  const handleLightboxDelete = async () => {
    await deleteOutput(lightboxImg);
  };

  const current = results[0];
  const isMultiple = results.length > 1;

  return (
    <div className="result-viewer result-ready">
      {comparison && isMultiple ? (
        <div className="comparison-grid">
          {results.slice(0, 2).map((result, index) => {
            const isOriginal = result.kind === 'original';
            return (
              <div className="comparison-card" key={result.filename || index}>
                <div className="comparison-label">{isOriginal ? 'Ảnh gốc sau Qwen' : 'Ảnh đã đổi mặt'}</div>
                <button
                  className="comparison-image-btn"
                  onClick={() => { setLightboxImg(result); setLightboxOpen(true); }}
                  type="button"
                  aria-label={isOriginal ? 'Xem ảnh gốc sau Qwen' : 'Xem ảnh đã đổi mặt'}
                >
                  <img src={result.url} alt={isOriginal ? 'Original result before face swap' : 'Face swapped result'} />
                </button>
                <button className="comparison-download-btn" onClick={() => downloadImage(result)} type="button">
                  Tải {isOriginal ? 'ảnh gốc' : 'ảnh đổi mặt'}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <>
      {isMultiple && (
        <div className="thumbnail-strip">
          {results.map((r, i) => (
            <div
              key={i}
              className="thumb-wrap"
            >
              <button
                className="thumb-btn active"
                onClick={() => openPreview(r)}
                type="button"
                aria-label={`Xem trước ảnh kết quả ${i + 1}`}
              >
                <img src={r.url} alt={`Output ${i + 1}`} />
              </button>
              <button
                className="thumb-delete-btn"
                onClick={() => deleteOutput(r)}
                type="button"
                title="Xoá"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main image — tap/click to preview */}
      <div className="main-image-wrap">
        <button
          className="image-touch-target"
          onClick={() => openPreview(current)}
          type="button"
          aria-label="Xem ảnh tạo ra toàn màn hình"
        >
          <img src={current.url} alt="Generated result" className="main-image" />
          <span className="tap-hint" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="6" />
              <path d="m16 16 4 4" />
            </svg>
            <span>Xem</span>
          </span>
        </button>
      </div>
        </>
      )}

      <div className="result-meta">
        <div className="meta-grid">
          {current.seed       && <div className="meta-item"><span className="meta-key">Seed</span><span className="meta-val">{current.seed}</span></div>}
          {current.denoise    != null && <div className="meta-item"><span className="meta-key">Denoise</span><span className="meta-val">{current.denoise}</span></div>}
          {current.steps      && <div className="meta-item"><span className="meta-key">Steps</span><span className="meta-val">{current.steps}</span></div>}
          {current.cfg        && <div className="meta-item"><span className="meta-key">CFG</span><span className="meta-val">{current.cfg}</span></div>}
          {current.filename   && <div className="meta-item"><span className="meta-key">File</span><span className="meta-val filename">{current.filename}</span></div>}
        </div>

        <div className="action-row">
          <button className="action-btn primary" onClick={() => downloadImage(current)} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Tải xuống
          </button>
          <button className="action-btn danger" onClick={() => deleteOutput(current)} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4h6v2" />
            </svg>
            Xoá ảnh
          </button>
        </div>
      </div>

      {/* Lightbox */}
      {lightboxOpen && lightboxImg && (
        <div className="lightbox-overlay" role="dialog" aria-modal="true" aria-label="Xem trước ảnh tạo ra" onClick={(e) => { if (e.target === e.currentTarget) setLightboxOpen(false); }}>
          <button className="lightbox-close" onClick={() => setLightboxOpen(false)} type="button" aria-label="Đóng xem trước">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <div className="lightbox-content">
            <img
              src={lightboxImg.url}
              alt="Preview"
              className="lightbox-image"
              onClick={(e) => e.stopPropagation()}
            />
            <div className="lightbox-actions">
              <button className="lightbox-btn save" onClick={handleLightboxSave}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Lưu ảnh
              </button>
              <button className="lightbox-btn delete" onClick={handleLightboxDelete}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4h6v2" />
                </svg>
                Xoá ảnh
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
