import { useRef } from 'react';
import './ImageUpload.css';

export default function ImageUpload({ image, onImageChange, onClear, label = 'Ảnh đầu vào', hint = 'PNG · JPG · WebP · BMP · tối đa 50 MB' }) {
  const inputRef = useRef(null);

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      onImageChange(file);
    }
  };

  const handleDragOver = (e) => e.preventDefault();

  const handleClick = () => inputRef.current?.click();

  return (
    <div className="image-upload">
      <label className="section-label">{label}</label>

      {image ? (
        <div className="image-preview">
          <img src={URL.createObjectURL(image)} alt="Preview" />
          <button
            className="clear-btn"
            onClick={onClear}
            type="button"
            aria-label="Xóa ảnh"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ) : (
        <div
          className="drop-zone"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={handleClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleClick()}
        >
          <svg className="upload-icon" viewBox="0 0 64 64" fill="none">
            <rect x="8" y="16" width="48" height="40" rx="4" stroke="currentColor" strokeWidth="2" />
            <path d="M8 40l16-16 10 10 12-12 10 10" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <circle cx="22" cy="28" r="4" stroke="currentColor" strokeWidth="2" />
            <path d="M32 8v12M28 12l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="drop-text">Kéo thả ảnh hoặc <span>bấm để chọn</span></p>
          <p className="drop-hint">{hint}</p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp"
        onChange={(e) => e.target.files[0] && onImageChange(e.target.files[0])}
        style={{ display: 'none' }}
      />
    </div>
  );
}
