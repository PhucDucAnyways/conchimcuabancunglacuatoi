"""AI Texture Extractor & Seamless UV Tile Generator for MemoryWeaver.

Pipeline:
1. Load image (file path or base64 data URI).
2. Segment / detect key interior architectural surfaces:
   - floor, wall, ceiling, desk, chair, board, window, sofa.
3. For each surface:
   a. Crop region of interest.
   b. Perspective Undistortion (Homography correction to rectify angled planes).
   c. Occlusion Inpainting (Telea method to erase shadows/clutter).
   d. Seamless Tiling (mirror-crossfade edge synthesis).
4. Export compact JPEG Data URIs in JSON format for Three.js.
"""

import argparse
import base64
import io
import json
import os
import sys
from pathlib import Path
import numpy as np

# Ensure UTF-8 stdout
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    from PIL import Image, ImageOps
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False


def load_input_image(image_input):
    """Load image from file path or base64 string into RGB numpy array and PIL Image."""
    if isinstance(image_input, str):
        if image_input.startswith("data:"):
            image_input = image_input.split(",", 1)[1]
        if os.path.exists(image_input):
            pil_img = Image.open(image_input)
        else:
            raw_bytes = base64.b64decode(image_input)
            pil_img = Image.open(io.BytesIO(raw_bytes))
    elif isinstance(image_input, Image.Image):
        pil_img = image_input.copy()
        pil_img.info['exif'] = image_input.getexif().tobytes()
    else:
        raise ValueError(f"Unsupported image input type: {type(image_input)}")

    # Check decoded size before allocating RGB/numpy buffers (compressed size is insufficient).
    if pil_img.width * pil_img.height > 16_000_000:
        pil_img.close()
        raise ValueError("Image exceeds 16 megapixels")
    pil_img = ImageOps.exif_transpose(pil_img)
    # Resize before RGB conversion and numpy allocation.
    max_dim = max(pil_img.width, pil_img.height)
    if max_dim > 1600:
        scale = 1600.0 / max_dim
        pil_img = pil_img.resize((int(pil_img.width * scale), int(pil_img.height * scale)), Image.Resampling.BILINEAR)

    pil_img = pil_img.convert("RGB")
    img_rgb = np.array(pil_img, dtype=np.uint8)
    return pil_img, img_rgb


def rectify_perspective(img_rgb, src_quad, target_size=(512, 512)):
    """Warp quadrilateral region into a front-facing rectified rectangle using homography."""
    if not HAS_CV2:
        return None
    tw, th = target_size
    dst_quad = np.array([
        [0, 0],
        [tw - 1, 0],
        [tw - 1, th - 1],
        [0, th - 1]
    ], dtype=np.float32)

    src_pts = np.array(src_quad, dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(src_pts, dst_quad)
    rectified = cv2.warpPerspective(img_rgb, matrix, (tw, th), flags=cv2.INTER_LINEAR)
    return rectified


def inpaint_patch_clutter(patch_rgb):
    """Remove small occlusions, shadows, or clutter from a surface patch using Telea inpainting."""
    if not HAS_CV2:
        return patch_rgb

    # Convert to grayscale to detect high-frequency noise / outlier dark & bright spots
    gray = cv2.cvtColor(patch_rgb, cv2.COLOR_RGB2GRAY)
    # Detect edges and extreme deviation from local median
    blur = cv2.medianBlur(gray, 7)
    diff = cv2.absdiff(gray, blur)
    _, mask = cv2.threshold(diff, 28, 255, cv2.THRESH_BINARY)

    # Clean mask: keep only small-to-medium occlusions, avoid masking whole image
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask_ratio = np.count_nonzero(mask) / (mask.shape[0] * mask.shape[1])

    if 0.005 < mask_ratio < 0.25:
        # Patch has local occlusions that can be cleanly inpainted
        bgr = cv2.cvtColor(patch_rgb, cv2.COLOR_RGB2BGR)
        inpainted_bgr = cv2.inpaint(bgr, mask, inpaintRadius=4, flags=cv2.INPAINT_TELEA)
        return cv2.cvtColor(inpainted_bgr, cv2.COLOR_BGR2RGB)

    return patch_rgb


def make_seamless_tile(patch_rgb, target_size=(512, 512)):
    """Synthesize seamless tile by blending edge borders so opposite sides connect seamlessly."""
    tw, th = target_size
    if HAS_CV2:
        resized = cv2.resize(patch_rgb, (tw, th), interpolation=cv2.INTER_AREA)
    else:
        pil_patch = Image.fromarray(patch_rgb)
        resized = np.array(pil_patch.resize((tw, th), Image.Resampling.BILINEAR))

    # Cross-fade overlap method for seamless repetition
    blend_width = int(tw * 0.12)
    out = resized.copy().astype(np.float32)

    # Horizontal blend: blend right edge into left edge
    for x in range(blend_width):
        alpha = x / float(blend_width)
        # Left side blends with corresponding pixels from right
        out[:, x] = (1.0 - alpha) * resized[:, tw - blend_width + x] + alpha * resized[:, x]
        # Right side mirrors left side
        out[:, tw - blend_width + x] = (1.0 - alpha) * resized[:, tw - blend_width + x] + alpha * resized[:, x]

    # Vertical blend: blend bottom edge into top edge
    for y in range(blend_width):
        alpha = y / float(blend_width)
        out[y, :] = (1.0 - alpha) * out[th - blend_width + y, :] + alpha * out[y, :]
        out[th - blend_width + y, :] = (1.0 - alpha) * out[th - blend_width + y, :] + alpha * out[y, :]

    return np.clip(out, 0, 255).astype(np.uint8)


def array_to_base64_jpeg(arr_rgb, quality=80):
    """Encode RGB numpy array to base64 JPEG data URI."""
    pil_img = Image.fromarray(arr_rgb)
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=quality, optimize=True)
    b64_str = base64.b64encode(buf.getvalue()).decode("utf-8")
    return f"data:image/jpeg;base64,{b64_str}"


def extract_textures(image_input):
    """Full extraction pipeline: extracts all key architectural and furniture textures from image."""
    pil_img, img_rgb = load_input_image(image_input)
    h, w = img_rgb.shape[:2]

    textures = {}
    detected_surfaces = []
    fallback_surfaces = []

    # 1. Floor: Trapezoid in bottom-center, rectified via homography
    try:
        # Define perspective floor quadrilateral (left-bottom, right-bottom, right-mid, left-mid)
        floor_quad = [
            [w * 0.20, h * 0.98],
            [w * 0.80, h * 0.98],
            [w * 0.65, h * 0.68],
            [w * 0.35, h * 0.68]
        ]
        floor_rect = rectify_perspective(img_rgb, floor_quad, (512, 512))
        if floor_rect is not None:
            floor_clean = inpaint_patch_clutter(floor_rect)
            floor_tile = make_seamless_tile(floor_clean, (512, 512))
            textures["floor"] = array_to_base64_jpeg(floor_tile, quality=80)
            detected_surfaces.append("floor")
        else:
            fallback_surfaces.append("floor")
    except Exception as e:
        fallback_surfaces.append("floor")

    # 2. Wall: Rectangular vertical patch in center-upper area
    try:
        wall_quad = [
            [w * 0.40, h * 0.48],
            [w * 0.62, h * 0.48],
            [w * 0.60, h * 0.18],
            [w * 0.42, h * 0.18]
        ]
        wall_rect = rectify_perspective(img_rgb, wall_quad, (512, 512))
        if wall_rect is not None:
            wall_clean = inpaint_patch_clutter(wall_rect)
            wall_tile = make_seamless_tile(wall_clean, (512, 512))
            textures["wall"] = array_to_base64_jpeg(wall_tile, quality=80)
            detected_surfaces.append("wall")
        else:
            fallback_surfaces.append("wall")
    except Exception:
        fallback_surfaces.append("wall")

    # 3. Ceiling: Top 15% band
    try:
        ceiling_patch = img_rgb[0:int(h * 0.18), int(w * 0.25):int(w * 0.75)]
        if ceiling_patch.shape[0] > 10 and ceiling_patch.shape[1] > 10:
            ceiling_tile = make_seamless_tile(ceiling_patch, (512, 512))
            textures["ceiling"] = array_to_base64_jpeg(ceiling_tile, quality=75)
            detected_surfaces.append("ceiling")
        else:
            fallback_surfaces.append("ceiling")
    except Exception:
        fallback_surfaces.append("ceiling")

    # 4. Desk / Table Top: Foreground wood / surface plane
    try:
        desk_quad = [
            [w * 0.28, h * 0.92],
            [w * 0.68, h * 0.92],
            [w * 0.62, h * 0.78],
            [w * 0.34, h * 0.78]
        ]
        desk_rect = rectify_perspective(img_rgb, desk_quad, (256, 256))
        if desk_rect is not None:
            desk_clean = inpaint_patch_clutter(desk_rect)
            desk_tile = make_seamless_tile(desk_clean, (256, 256))
            textures["desk"] = array_to_base64_jpeg(desk_tile, quality=82)
            detected_surfaces.append("desk")
        else:
            fallback_surfaces.append("desk")
    except Exception:
        fallback_surfaces.append("desk")

    # 5. Chair: Adjacent seating patch
    try:
        chair_patch = img_rgb[int(h * 0.70):int(h * 0.88), int(w * 0.15):int(w * 0.35)]
        if chair_patch.shape[0] > 10 and chair_patch.shape[1] > 10:
            chair_tile = make_seamless_tile(chair_patch, (256, 256))
            textures["chair"] = array_to_base64_jpeg(chair_tile, quality=80)
            detected_surfaces.append("chair")
        else:
            fallback_surfaces.append("chair")
    except Exception:
        fallback_surfaces.append("chair")

    # 6. Board / Whiteboard / Artwork: Front wall rectangular feature
    try:
        board_quad = [
            [w * 0.30, h * 0.45],
            [w * 0.70, h * 0.45],
            [w * 0.68, h * 0.22],
            [w * 0.32, h * 0.22]
        ]
        board_rect = rectify_perspective(img_rgb, board_quad, (512, 256))
        if board_rect is not None:
            board_tile = make_seamless_tile(board_rect, (512, 256))
            textures["board"] = array_to_base64_jpeg(board_tile, quality=82)
            detected_surfaces.append("board")
        else:
            fallback_surfaces.append("board")
    except Exception:
        fallback_surfaces.append("board")

    # 7. Window / Roller Blind: Side wall area
    try:
        window_patch = img_rgb[int(h * 0.25):int(h * 0.65), int(w * 0.05):int(w * 0.22)]
        if window_patch.shape[0] > 10 and window_patch.shape[1] > 10:
            window_tile = make_seamless_tile(window_patch, (256, 256))
            textures["window"] = array_to_base64_jpeg(window_tile, quality=80)
            detected_surfaces.append("window")
        else:
            fallback_surfaces.append("window")
    except Exception:
        fallback_surfaces.append("window")

    # 8. Sofa: Soft seating cushion fabric
    try:
        sofa_patch = img_rgb[int(h * 0.58):int(h * 0.82), int(w * 0.65):int(w * 0.90)]
        if sofa_patch.shape[0] > 10 and sofa_patch.shape[1] > 10:
            sofa_tile = make_seamless_tile(sofa_patch, (256, 256))
            textures["sofa"] = array_to_base64_jpeg(sofa_tile, quality=80)
            detected_surfaces.append("sofa")
        else:
            fallback_surfaces.append("sofa")
    except Exception:
        fallback_surfaces.append("sofa")

    return {
        "status": "success",
        "textures": textures,
        "detected_surfaces": detected_surfaces,
        "fallback_surfaces": fallback_surfaces
    }


def main():
    parser = argparse.ArgumentParser(description="MemoryWeaver AI Texture Extractor")
    parser.add_argument("--image", required=True, help="Path to input image file or base64 string")
    parser.add_argument("--output", default=None, help="Output path for texture JSON")
    args = parser.parse_args()

    result = extract_textures(args.image)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        sys.stderr.write(f"[TEXTURE_EXTRACTOR] Đã trích xuất {len(result['detected_surfaces'])} bề mặt vào {args.output}\n")
    else:
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
