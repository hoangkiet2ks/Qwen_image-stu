import { useState } from 'react';
import { API_BASE, USE_BROWSER_PROXY, resetApiBase, saveApiBase } from '../api';

export default function ServerConnection({ onClose }) {
  const [url, setUrl] = useState(API_BASE);
  const [status, setStatus] = useState('');
  const [checking, setChecking] = useState(false);

  const normalize = value => {
    const trimmed = value.trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  };

  const check = async () => {
    const target = normalize(url);
    if (!url.trim()) return setStatus('Nhập URL máy AI trước.');
    setChecking(true);
    setStatus('Đang kiểm tra…');
    try {
      const response = await fetch(`${target}/api/models`, { signal: AbortSignal.timeout(8000) });
      setStatus(response.ok ? 'Máy AI đã sẵn sàng.' : `Máy AI trả về lỗi ${response.status}.`);
    } catch {
      setStatus('Không kết nối được. Kiểm tra Tailscale và backend trên PC.');
    } finally {
      setChecking(false);
    }
  };

  const save = () => {
    try {
      saveApiBase(url);
      window.location.reload();
    } catch (error) {
      setStatus(error.message);
    }
  };

  const useDefault = () => {
    resetApiBase();
    window.location.reload();
  };

  if (USE_BROWSER_PROXY) {
    return (
      <div className="server-connection-overlay" role="presentation" onPointerDown={onClose}>
        <section className="server-connection-sheet" role="dialog" aria-modal="true" aria-labelledby="server-connection-title" onPointerDown={event => event.stopPropagation()}>
          <div className="server-connection-handle" />
          <h2 id="server-connection-title">Kết nối máy AI</h2>
          <p>Web đang tự kết nối qua frontend này. Không cần nhập IP hoặc URL máy AI.</p>
          <button type="button" className="primary-btn" onClick={onClose}>Đóng</button>
        </section>
      </div>
    );
  }

  return (
    <div className="server-connection-overlay" role="presentation" onPointerDown={onClose}>
      <section className="server-connection-sheet" role="dialog" aria-modal="true" aria-labelledby="server-connection-title" onPointerDown={event => event.stopPropagation()}>
        <div className="server-connection-handle" />
        <h2 id="server-connection-title">Kết nối máy AI</h2>
        <p>Nhập URL HTTPS của máy AI qua Tailscale. Chỉ cần lưu một lần.</p>
        <label>
          URL máy AI
          <input value={url} onChange={event => setUrl(event.target.value)} inputMode="url" autoCapitalize="none" placeholder="https://ten-may.tailnet.ts.net" />
        </label>
        {status && <p className="server-connection-status" role="status">{status}</p>}
        <div className="server-connection-actions">
          <button type="button" className="secondary-btn" onClick={check} disabled={checking}>{checking ? 'Đang kiểm tra…' : 'Kiểm tra'}</button>
          <button type="button" className="primary-btn" onClick={save}>Lưu máy AI</button>
        </div>
        <button type="button" className="server-connection-reset" onClick={useDefault}>Dùng URL Tailscale mặc định</button>
      </section>
    </div>
  );
}
