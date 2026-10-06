// CanvasImageSource dimensions differ between HTML images and canvases.
export function layerMetrics(layer, source, width, height) {
  const sourceWidth = source.naturalWidth ?? source.width;
  const sourceHeight = source.naturalHeight ?? source.height;
  if (!(sourceWidth > 0 && sourceHeight > 0)) {
    throw new Error('Không đọc được kích thước lớp ảnh.');
  }
  const factor = layer.scale * Math.min(width, height) / Math.max(sourceWidth, sourceHeight);
  return {
    x: layer.x * width,
    y: layer.y * height,
    width: sourceWidth * factor,
    height: sourceHeight * factor,
    rotation: layer.rotation * Math.PI / 180
  };
}
