"""Print source-face bounding boxes as JSON for Qwen face-reference conditioning."""

import json
import os
import sys

import cv2

COMFY_ROOT = os.environ.get(
    "COMFYUI_ROOT", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "ComfyUI"))
)
REACTOR_ROOT = os.path.join(COMFY_ROOT, "custom_nodes", "comfyui-reactor")
INSIGHTFACE_ROOT = os.path.join(COMFY_ROOT, "models", "insightface")

sys.path.insert(0, REACTOR_ROOT)
from reactor_core.inswap import SCRFD  # noqa: E402


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: detect_faces.py IMAGE_PATH")

    image = cv2.imread(sys.argv[1])
    if image is None:
        raise SystemExit("Cannot read source image")

    detector_path = os.path.join(INSIGHTFACE_ROOT, "models", "buffalo_l", "det_10g.onnx")
    detector = SCRFD(detector_path, providers=["CPUExecutionProvider"])
    detections, _ = detector.detect(image, det_thresh=0.5, input_size=(640, 640))
    faces = []
    for detection in detections:
        x1, y1, x2, y2 = [float(value) for value in detection[:4]]
        faces.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2})

    print(json.dumps({"faces": faces}))


if __name__ == "__main__":
    main()
