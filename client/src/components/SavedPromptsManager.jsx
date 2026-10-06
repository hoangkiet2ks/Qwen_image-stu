import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import './SavedPromptsManager.css';

const STORAGE_KEY = 'saved_prompts';

/** Load saved prompts from localStorage */
function loadPrompts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Persist saved prompts to localStorage */
function savePrompts(prompts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
}

export default function SavedPromptsManager({ currentPrompt, currentDenoise, onLoad }) {
  const [prompts, setPrompts] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveNote, setSaveNote] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState('');
  const nameInputRef = useRef(null);

  // Load from storage on mount
  useEffect(() => {
    setPrompts(loadPrompts());
  }, []);

  // Focus name input when modal opens
  useEffect(() => {
    if (showSaveModal && nameInputRef.current) {
      setTimeout(() => nameInputRef.current?.focus(), 80);
    }
  }, [showSaveModal]);

  const hapticLight = async () => {
    try { await Haptics.impact({ style: ImpactStyle.Light }); } catch {}
  };

  // ── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    const name = saveName.trim();
    if (!name) {
      nameInputRef.current?.focus();
      return;
    }

    await hapticLight();

    const entry = {
      id: Date.now().toString(),
      name,
      note: saveNote.trim(),
      prompt: currentPrompt,
      denoise: currentDenoise,
      createdAt: new Date().toISOString(),
      usageCount: 0,
    };

    const updated = [entry, ...prompts];
    setPrompts(updated);
    savePrompts(updated);

    setSaveName('');
    setSaveNote('');
    setShowSaveModal(false);
  };

  // ── Load ─────────────────────────────────────────────────────────────────
  const handleLoad = async (entry) => {
    await hapticLight();

    // Increment usage count
    const updated = prompts.map(p =>
      p.id === entry.id ? { ...p, usageCount: (p.usageCount || 0) + 1 } : p
    );
    setPrompts(updated);
    savePrompts(updated);

    onLoad({ prompt: entry.prompt, denoise: entry.denoise });
  };

  // ── Delete ───────────────────────────────────────────────────────────────
  const handleDeleteRequest = async (e, entry) => {
    e.stopPropagation();
    await hapticLight();
    setDeleteConfirm(entry);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    await hapticLight();
    const updated = prompts.filter(p => p.id !== deleteConfirm.id);
    setPrompts(updated);
    savePrompts(updated);
    setDeleteConfirm(null);
  };

  // ── Filter ───────────────────────────────────────────────────────────────
  const filtered = prompts.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return p.name.toLowerCase().includes(q) ||
           p.prompt.toLowerCase().includes(q) ||
           (p.note || '').toLowerCase().includes(q);
  });

  const canSave = currentPrompt && currentPrompt.trim().length > 0;

  // ── Format date ─────────────────────────────────────────────────────────
  const formatDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
  };

  return (
    <div className="spm-wrapper">
      {/* ── Header bar ───────────────────────────────────────────────── */}
      <div className="spm-header" onClick={() => setExpanded(v => !v)}>
        <div className="spm-header-left">
          <svg className="spm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-3.5L5 21V5z" />
          </svg>
          <span className="spm-title">Prompt đã lưu</span>
          {prompts.length > 0 && (
            <span className="spm-count">{prompts.length}</span>
          )}
        </div>
        <div className="spm-header-right">
          <button
            className={`spm-save-btn ${canSave ? 'ready' : 'disabled'}`}
            onClick={(e) => { e.stopPropagation(); if (canSave) { hapticLight(); setShowSaveModal(true); } }}
            type="button"
            disabled={!canSave}
            title={canSave ? 'Lưu prompt hiện tại' : 'Nhập prompt trước'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Lưu prompt
          </button>
          <svg
            className={`spm-chevron ${expanded ? 'up' : 'down'}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {/* ── Expanded panel ──────────────────────────────────────────── */}
      {expanded && (
        <div className="spm-body">
          {prompts.length === 0 ? (
            <div className="spm-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-3.5L5 21V5z" />
              </svg>
              <p>Chưa có prompt nào được lưu.</p>
              <p>Sau khi tạo ảnh thành công, bấm <strong>Lưu prompt</strong> để ghi lại.</p>
            </div>
          ) : (
            <>
              <div className="spm-search-wrap">
                <svg className="spm-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  className="spm-search"
                  type="search"
                  placeholder="Tìm kiếm prompt…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>

              <div className="spm-list">
                {filtered.length === 0 ? (
                  <p className="spm-no-results">Không tìm thấy kết quả cho "{search}"</p>
                ) : (
                  filtered.map(entry => (
                    <div
                      key={entry.id}
                      className="spm-item"
                      onClick={() => handleLoad(entry)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => e.key === 'Enter' && handleLoad(entry)}
                    >
                      <div className="spm-item-top">
                        <span className="spm-item-name">{entry.name}</span>
                        <div className="spm-item-meta-row">
                          {entry.denoise != null && (
                            <span className="spm-badge">DN {Math.round(entry.denoise * 100)}</span>
                          )}
                          <span className="spm-item-date">{formatDate(entry.createdAt)}</span>
                          {entry.usageCount > 0 && (
                            <span className="spm-badge used">×{entry.usageCount}</span>
                          )}
                        </div>
                      </div>

                      <p className="spm-item-prompt">{entry.prompt}</p>

                      {entry.note && (
                        <p className="spm-item-note">{entry.note}</p>
                      )}

                      <button
                        className="spm-delete-btn"
                        onClick={e => handleDeleteRequest(e, entry)}
                        type="button"
                        title="Xoá prompt"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4h6v2" />
                        </svg>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}

      {showSaveModal && createPortal((
        <div className="spm-modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSaveModal(false); }}>
          <div className="spm-modal">
            <div className="spm-modal-header">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-3.5L5 21V5z" />
              </svg>
              <span>Lưu prompt mới</span>
              <button className="spm-modal-close" onClick={() => setShowSaveModal(false)} type="button">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="spm-modal-body">
              <div className="spm-field">
                <label htmlFor="spm-name">Tên prompt <span className="required">*</span></label>
                <input
                  id="spm-name"
                  ref={nameInputRef}
                  type="text"
                  placeholder="VD: Áo dài hoàng hôn, Nền mây…"
                  value={saveName}
                  onChange={e => setSaveName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                  maxLength={60}
                />
              </div>

              <div className="spm-field">
                <label htmlFor="spm-prompt-preview">Prompt</label>
                <div className="spm-prompt-preview">{currentPrompt}</div>
              </div>

              <div className="spm-field">
                <label htmlFor="spm-note">Ghi chú <span className="optional">(tuỳ chọn)</span></label>
                <textarea
                  id="spm-note"
                  placeholder="VD: Dùng cho ảnh chân dung, cường độ nhẹ…"
                  value={saveNote}
                  onChange={e => setSaveNote(e.target.value)}
                  rows={2}
                  maxLength={200}
                />
              </div>

              <div className="spm-modal-info">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>Prompt được lưu vào bộ nhớ thiết bị, không mất khi tắt app hoặc server.</span>
              </div>
            </div>

            <div className="spm-modal-footer">
              <button className="spm-modal-cancel" onClick={() => setShowSaveModal(false)} type="button">
                Huỷ
              </button>
              <button
                className={`spm-modal-confirm ${!saveName.trim() ? 'disabled' : ''}`}
                onClick={handleSave}
                disabled={!saveName.trim()}
                type="button"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Lưu
              </button>
            </div>
          </div>
        </div>
      ), document.body)}

      {/* ── Delete confirmation ──────────────────────────────────────── */}
      {deleteConfirm && createPortal((
        <div className="spm-modal-overlay" onClick={e => { if (e.target === e.currentTarget) setDeleteConfirm(null); }}>
          <div className="spm-confirm-dialog">
            <div className="spm-confirm-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4h6v2" />
              </svg>
            </div>
            <p className="spm-confirm-title">Xoá prompt?</p>
            <p className="spm-confirm-msg">
              Xoá <strong>"{deleteConfirm.name}"</strong>? Hành động này không thể hoàn tác.
            </p>
            <div className="spm-confirm-actions">
              <button className="spm-confirm-cancel" onClick={() => setDeleteConfirm(null)} type="button">
                Huỷ
              </button>
              <button className="spm-confirm-delete" onClick={confirmDelete} type="button">
                Xoá
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}
