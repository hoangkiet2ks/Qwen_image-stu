import { useState } from 'react';

// Relative pixel bounds of the six pose photographs in the REF-02 sheet.
// The headings and labels are deliberately excluded from model conditioning.
const POSES = [
  { label: 'Đứng, hai tay chữ V', bounds: [862, 134, 1069, 448] },
  { label: 'Ngồi đối diện', bounds: [1074, 134, 1295, 448] },
  { label: 'Ngồi xổm', bounds: [1300, 134, 1523, 448] },
  { label: 'Góc máy dưới lên', bounds: [862, 489, 1069, 764] },
  { label: 'Nằm ngửa', bounds: [1074, 489, 1295, 764] },
  { label: 'Nằm nghiêng', bounds: [1300, 489, 1523, 764] }
];
const TEMPLATE_WIDTH = 1536;
const TEMPLATE_HEIGHT = 1024;

function openImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được bảng REF-02.')); };
    image.src = url;
  });
}

function cropPose(image, bounds, index) {
  const canvas = document.createElement('canvas');
  const [x1, y1, x2, y2] = bounds;
  const sx = Math.round(x1 * image.naturalWidth / TEMPLATE_WIDTH);
  const sy = Math.round(y1 * image.naturalHeight / TEMPLATE_HEIGHT);
  const sw = Math.round((x2 - x1) * image.naturalWidth / TEMPLATE_WIDTH);
  const sh = Math.round((y2 - y1) * image.naturalHeight / TEMPLATE_HEIGHT);
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return new Promise(resolve => canvas.toBlob(blob => {
    if (!blob) return resolve(null);
    resolve({
      file: new File([blob], `pose-ref-${index + 1}.png`, { type: 'image/png' }),
      preview: canvas.toDataURL('image/jpeg', 0.75)
    });
  }, 'image/png'));
}

export default function PoseReferencePicker({ reference, onChange }) {
  const [choices, setChoices] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [message, setMessage] = useState('');
  const [directPreview, setDirectPreview] = useState('');

  const chooseBoard = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMessage('Đang tách 6 tư thế…');
    try {
      const image = await openImage(file);
      if (Math.abs(image.naturalWidth / image.naturalHeight - 1.5) > 0.08) {
        throw new Error('Bảng này khác bố cục REF-02 mẫu. Hãy chọn ảnh một tư thế riêng bên dưới.');
      }
      const cropped = await Promise.all(POSES.map((pose, index) => cropPose(image, pose.bounds, index)));
      if (cropped.some(item => !item)) throw new Error('Không cắt được ảnh tư thế.');
      setChoices(cropped);
      setSelectedIndex(-1);
      setDirectPreview('');
      onChange(null);
      setMessage('Chạm một tư thế để chọn.');
    } catch (error) {
      setMessage(error.message);
    }
  };

  const chooseDirect = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const image = await openImage(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Không đọc được ảnh tư thế.');
      setChoices([]);
      setSelectedIndex(-1);
      setDirectPreview(canvas.toDataURL('image/jpeg', 0.75));
      onChange({ file: new File([blob], 'pose-reference.png', { type: 'image/png' }), label: 'Ảnh tư thế riêng' });
      setMessage('Đã chọn ảnh tư thế riêng.');
    } catch (error) { setMessage(error.message); }
  };

  return (
    <section className="pose-reference-picker" aria-label="Chọn ảnh tham chiếu tư thế">
      <strong>Ảnh tham chiếu tư thế</strong>
      <p>Tải bảng REF-02 rồi chọn đúng một tư thế. App sẽ chỉ gửi ô ảnh đã cắt cho AI.</p>
      <div className="pose-reference-actions">
        <label className="secondary-btn">Tải bảng REF-02<input type="file" accept="image/*" onChange={chooseBoard} /></label>
        <label className="secondary-btn">Tải một ảnh tư thế<input type="file" accept="image/*" onChange={chooseDirect} /></label>
      </div>
      {choices.length > 0 && <div className="pose-reference-grid">
        {choices.map((choice, index) => <button key={POSES[index].label} type="button"
          className={selectedIndex === index ? 'active' : ''}
          aria-pressed={selectedIndex === index}
          onClick={() => { setSelectedIndex(index); onChange({ file: choice.file, label: POSES[index].label }); }}>
          <img src={choice.preview} alt="" />
          <span>{index + 1}. {POSES[index].label}</span>
        </button>)}
      </div>}
      {directPreview && <img className="pose-reference-direct" src={directPreview} alt="Tư thế đã chọn" />}
      <small role="status">{message || (reference ? `Đã chọn: ${reference.label}` : 'Chưa chọn tư thế.')}</small>
    </section>
  );
}
