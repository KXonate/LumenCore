import os
import io
import json
import glob
import zlib
import struct
import shutil
import subprocess
import numpy as np
from PIL import Image
from flask import Flask, request, jsonify, send_from_directory, send_file

app = Flask(__name__, static_folder="static", static_url_path="")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_DIR = os.path.join(BASE_DIR, "workspace")
os.makedirs(WORKSPACE_DIR, exist_ok=True)


def find_blender_executable(custom_path=None):
    if custom_path and os.path.isfile(custom_path):
        return custom_path
    in_path = shutil.which("blender")
    if in_path:
        return in_path
    candidates = glob.glob(r"C:\Program Files\Blender Foundation\Blender*\blender.exe")
    candidates.sort(reverse=True)
    return candidates[0] if candidates else ""


def encode_png_16bit(rgba_float: np.ndarray) -> bytes:
    h, w, _ = rgba_float.shape
    u16 = np.clip(rgba_float * 65535.0 + 0.5, 0, 65535).astype(">u2")
    raw_rows = b"".join(b"\x00" + u16[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", w, h, 16, 6, 0, 0, 0)
    idat = zlib.compress(raw_rows, level=6)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def encode_exr_32bit(rgba_float: np.ndarray) -> bytes:
    h, w, _ = rgba_float.shape
    rgba = np.ascontiguousarray(rgba_float, dtype="<f4")

    out = bytearray()
    out += struct.pack("<II", 20000630, 2)

    def write_attr(name: bytes, atype: bytes, val: bytes):
        out.extend(name + b"\x00" + atype + b"\x00" + struct.pack("<I", len(val)) + val)

    chlist = bytearray()
    for ch in (b"A", b"B", b"G", b"R"):
        chlist += ch + b"\x00" + struct.pack("<IB3xII", 2, 0, 1, 1)
    chlist += b"\x00"

    write_attr(b"channels", b"chlist", bytes(chlist))
    write_attr(b"compression", b"compression", struct.pack("<B", 0))
    box = struct.pack("<iiii", 0, 0, w - 1, h - 1)
    write_attr(b"dataWindow", b"box2i", box)
    write_attr(b"displayWindow", b"box2i", box)
    write_attr(b"lineOrder", b"lineOrder", struct.pack("<B", 0))
    write_attr(b"pixelAspectRatio", b"float", struct.pack("<f", 1.0))
    write_attr(b"screenWindowCenter", b"v2f", struct.pack("<ff", 0.0, 0.0))
    write_attr(b"screenWindowWidth", b"float", struct.pack("<f", 1.0))
    out += b"\x00"

    row_bytes = w * 4 * 4
    scanline_chunk_size = 8 + row_bytes
    data_start = len(out) + h * 8
    for y in range(h):
        out += struct.pack("<Q", data_start + y * scanline_chunk_size)

    for y in range(h):
        out += struct.pack("<ii", y, row_bytes)
        row = rgba[y]
        out += row[:, 3].tobytes()
        out += row[:, 2].tobytes()
        out += row[:, 1].tobytes()
        out += row[:, 0].tobytes()

    return bytes(out)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/status")
def status():
    return jsonify({"blender_path": find_blender_executable()})


@app.route("/api/upload_blend", methods=["POST"])
def upload_blend():
    if "file" not in request.files:
        return jsonify({"error": "No .blend file provided"}), 400

    blend_file = request.files["file"]
    if not blend_file.filename.lower().endswith(".blend"):
        return jsonify({"error": "Only .blend files are accepted"}), 400

    blender_exe = find_blender_executable(request.form.get("blender_path", "").strip())
    if not blender_exe:
        return jsonify({"error": "Blender executable not found. Please specify blender.exe path."}), 400

    blend_path = os.path.join(WORKSPACE_DIR, "input.blend")
    blend_file.save(blend_path)

    extractor = os.path.join(BASE_DIR, "blender_extractor.py")
    cmd = [blender_exe, "-b", blend_path, "--python", extractor, "--", WORKSPACE_DIR]

    print(f"\n[LumenCore] Running Blender extraction for {blend_file.filename}...", flush=True)
    try:
        proc = subprocess.run(cmd, timeout=600)
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Blender extraction timed out (>600s)."}), 500

    meta_path = os.path.join(WORKSPACE_DIR, "scene_meta.json")
    glb_path = os.path.join(WORKSPACE_DIR, "scene.glb")
    if proc.returncode != 0 or not os.path.exists(meta_path) or not os.path.exists(glb_path):
        return jsonify({"error": "Blender extraction failed. Check terminal output for details."}), 500

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    return jsonify({"ok": True, "meta": meta, "glb_url": "/workspace/scene.glb"})


@app.route("/workspace/<path:filename>")
def serve_workspace(filename):
    return send_from_directory(WORKSPACE_DIR, filename)


@app.route("/api/export", methods=["POST"])
def export_render():
    w = int(request.headers.get("X-Width", 1280))
    h = int(request.headers.get("X-Height", 720))
    fmt = request.headers.get("X-Format", "png").lower()
    depth = int(request.headers.get("X-Depth", 16))

    raw = request.get_data()
    expected = w * h * 4 * 4
    if len(raw) != expected:
        return jsonify({"error": f"Buffer mismatch: got {len(raw)}, expected {expected}"}), 400

    arr = np.frombuffer(raw, dtype="<f4").reshape((h, w, 4))
    arr = np.flipud(arr).copy()

    if fmt == "exr" or depth == 32:
        data = encode_exr_32bit(arr)
        return send_file(io.BytesIO(data), mimetype="application/octet-stream",
                         as_attachment=True, download_name="lumencore_32f.exr")

    if fmt == "png" and depth == 16:
        data = encode_png_16bit(arr)
        return send_file(io.BytesIO(data), mimetype="image/png",
                         as_attachment=True, download_name="lumencore_16bit.png")

    u8 = np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8)
    buf = io.BytesIO()
    if fmt in ("jpg", "jpeg"):
        Image.fromarray(u8[:, :, :3], "RGB").save(buf, format="JPEG", quality=96, subsampling=0)
        mime, ext = "image/jpeg", "jpg"
    elif fmt == "webp":
        Image.fromarray(u8, "RGBA").save(buf, format="WEBP", quality=95)
        mime, ext = "image/webp", "webp"
    else:
        Image.fromarray(u8, "RGBA").save(buf, format="PNG")
        mime, ext = "image/png", "png"

    buf.seek(0)
    return send_file(buf, mimetype=mime, as_attachment=True, download_name=f"lumencore_8bit.{ext}")


if __name__ == "__main__":
    print("LumenCore Engine Server running at http://127.0.0.1:5055")
    app.run(host="127.0.0.1", port=5055, debug=False, threaded=True)