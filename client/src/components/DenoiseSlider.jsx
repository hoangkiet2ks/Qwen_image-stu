import { useState } from 'react';
import './DenoiseSlider.css';

const PRESETS = [
  { label: 'Nhẹ', value: 0.53 },
  { label: 'Vừa', value: 0.75 },
  { label: 'Mạnh', value: 0.80 },
];
const DEFAULT = 0.72;

export default function DenoiseSlider({ denoise, onDenoiseChange }) {
  const [locked, setLocked] = useState(false);

  // Internal denoise is 0-1; display as percentage
  const displayVal = Math.round(denoise * 100);
  const pct = denoise * 100;

  const handleChange = (val) => {
    if (!locked) onDenoiseChange(val);
  };

  return (
    <div className="denoise-slider">
      <div className="slider-header">
        <label className="section-label">Cường độ chỉnh sửa</label>
        <div className="header-right">
          <span className="slider-value">{displayVal}</span>
          <button
            className={`lock-btn ${locked ? 'locked' : 'unlocked'}`}
            onClick={() => setLocked(!locked)}
            type="button"
            title={locked ? 'Mở khoá chỉnh sửa' : 'Khoá cường độ'}
          >
            {locked ? (
              // Locked icon
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            ) : (
              // Unlocked icon
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 9.9-1" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <div className={`slider-track-wrap ${locked ? 'locked' : ''}`}>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={displayVal}
          onChange={(e) => handleChange(parseInt(e.target.value) / 100)}
          style={{ '--pct': pct }}
          disabled={locked}
        />
        <div className="slider-labels">
          <span>Nhạt</span>
          <span>Đậm</span>
        </div>
      </div>

      <div className={`preset-row ${locked ? 'locked' : ''}`}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className={`preset-btn ${Math.abs(denoise - p.value) < 0.02 ? 'active' : ''}`}
            onClick={() => handleChange(p.value)}
            type="button"
            disabled={locked}
          >
            {p.label} · {Math.round(p.value * 100)}
          </button>
        ))}
        <button
          className="reset-btn"
          onClick={() => handleChange(DEFAULT)}
          type="button"
          title="Khôi phục mặc định"
          disabled={locked}
        >
          Mặc định · {Math.round(DEFAULT * 100)}
        </button>
      </div>
    </div>
  );
}
