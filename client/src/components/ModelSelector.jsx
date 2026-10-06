import { useState, useEffect } from 'react';
import { API_BASE } from '../api';
import './ModelSelector.css';

export default function ModelSelector({ value, onChange }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let mounted = true;
    fetch(`${API_BASE}/api/models`)
      .then(r => r.json())
      .then(data => {
        if (!mounted) return;
        const items = (data.unet || []).map(m => m.name);
        setModels(items);
        setLoading(false);
      })
      .catch(err => {
        if (!mounted) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  const clean = (n) => {
    if (!n) return 'qwen-rapid-nsfw-v9.0-Q4_K_S';
    const s = n.endsWith('.gguf') ? n.slice(0, -5) : n;
    return s.replace(/_/g, ' ');
  };

  const filtered = search
    ? models.filter(m => m.toLowerCase().includes(search.toLowerCase()))
    : models;

  const select = (name) => {
    onChange({ ...value, unet: name });
    setIsOpen(false);
  };

  if (loading) return <div className="model-selector loading">Đang tải...</div>;
  if (error) return <div className="model-selector error">{error}</div>;

  return (
    <div className={`model-selector ${isOpen ? 'open' : ''}`}>
      <button
        type="button"
        className="model-selector-toggle"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>Unet: {clean(value?.unet)}</span>
      </button>

      {isOpen && (
        <div className="model-selector-dropdown">
          <input
            className="model-search-input"
            type="text"
            placeholder="Tìm..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="model-list">
            <div
              className={`model-item ${!value?.unet ? 'sel' : ''}`}
              onClick={() => select('')}
            >
              {clean('qwen-rapid-nsfw-v9.0-Q4_K_S.gguf')}
            </div>
            {filtered.map(name => (
              <div
                key={name}
                className={`model-item ${value?.unet === name ? 'sel' : ''}`}
                onClick={() => select(name)}
              >
                {clean(name)}
              </div>
            ))}
          </div>
          <button className="model-close-btn" onClick={() => setIsOpen(false)}>
            Đóng
          </button>
        </div>
      )}
    </div>
  );
}