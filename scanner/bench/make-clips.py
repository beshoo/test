"""Synthetic phone-like test clips: rotation, motion blur, hand shake, focus pull.

  python make-clips.py <codesDir> <outDir>      (codesDir from make-codes.mjs)
  node clip-bench.mjs <repoRoot> <outDir>       (scores them like live box passes)

Each frame averages 8 sub-frames over the exposure time, so moving codes get real
motion blur in the direction they move. The camera is 1280x720; each clip is saved
as the scanner's target box (central 76% x 64%) at 15 frames per second, as raw
8-bit greyscale. The code appears after 0.5 s, so time to first read is measured
from a known start. (Real phone recordings go through replay.html instead.)
"""
import json, sys
from pathlib import Path
import numpy as np
import cv2

base, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
W, H, FPS, SUB = 1280, 720, 15, 8
BX, BY, BW, BH = round(W * 0.12), round(H * 0.18), round(W * 0.76), round(H * 0.64)  # target box
BG = 200


def load(name, module):
    img = cv2.imread(str(base / f'{name}.png'), cv2.IMREAD_GRAYSCALE)
    img = cv2.resize(img, (img.shape[1] * module, img.shape[0] * module), interpolation=cv2.INTER_NEAREST)
    pad = 6 * module  # white label around the code
    return cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)


def place(code, cx, cy, angle):
    """Return the frame with the code centred at (cx, cy), rotated by angle degrees."""
    h, w = code.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    m[0, 2] += cx - w / 2
    m[1, 2] += cy - h / 2
    frame = np.full((H, W), BG, np.float32)
    mask = cv2.warpAffine(np.ones_like(code, np.float32), m, (W, H), flags=cv2.INTER_LINEAR)
    warped = cv2.warpAffine(code.astype(np.float32), m, (W, H), flags=cv2.INTER_LINEAR)
    return frame * (1 - mask) + warped * mask


def clip(name, code, seconds, pose, focus=lambda t: 0.6, exposure=1 / 60, noise=5, seed=0):
    """pose(t) -> (cx, cy, angle) or None (code not in view); focus(t) -> Gaussian sigma in px."""
    rng = np.random.default_rng(seed)
    path = out / f'{name}.grey'
    frames = []
    for i in range(int(seconds * FPS)):
        t = i / FPS
        acc = np.zeros((H, W), np.float32)
        for k in range(SUB):
            p = pose(t + exposure * k / SUB)
            acc += place(code, *p) if p else np.full((H, W), BG, np.float32)
        f = acc / SUB
        s = focus(t)
        if s > 0.3:
            f = cv2.GaussianBlur(f, (0, 0), s)
        f = f + rng.normal(0, noise, f.shape)
        frames.append(np.clip(f, 0, 255).astype(np.uint8)[BY:BY + BH, BX:BX + BW])
    path.write_bytes(np.stack(frames).tobytes())
    return {'clip': path.name, 'appearsAt': 0.5, 'fps': FPS, 'frames': len(frames), 'w': BW, 'h': BH}


KEY = {'ean13': '4006381333931', 'code128': 'LOT-2027-AB12C-998877', 'qr': 'example.com/p/09506000134352', 'gs1dm': 'SN998877'}
ean, c128, qr, dm = load('ean13', 3), load('code128', 2), load('qr', 4), load('gs1dm', 5)
show = lambda f: (lambda t: f(t) if t >= 0.5 else None)
manifest = []


def add(name, code, key, **kw):
    manifest.append({**clip(name, code, **kw), 'expected': KEY[key]})


# Turning slowly through every angle
add('ean-rotating', ean, 'ean13', seconds=4, pose=show(lambda t: (640, 360, 20 + 60 * t)))
add('code128-rotating', c128, 'code128', seconds=4, pose=show(lambda t: (640, 360, 20 + 60 * t)))
add('dm-rotating', dm, 'gs1dm', seconds=4, pose=show(lambda t: (640, 360, 20 + 60 * t)))
# Sweeping across the view: motion blur across the bars (the hard direction for 1D codes)
for speed in (400, 800, 1200):  # px per second; at 1/60 s exposure: ~7, 13, 20 px of blur
    add(f'ean-sweep-{speed}', ean, 'ean13', seconds=3, exposure=1 / 60,
        pose=show(lambda t, v=speed: (640 + ((v * (t - 0.5)) % 900) - 450, 360, 10)))
add('code128-sweep-600', c128, 'code128', seconds=3,
    pose=show(lambda t: (640 + ((600 * (t - 0.5)) % 700) - 350, 360, 5)))
# Hand shake: small fast random motion plus a slow drift and tilt
def shake(t, seed=3):
    r = np.random.default_rng(int(t * FPS * SUB) + seed)
    return (640 + 25 * np.sin(9 * t) + r.normal(0, 3), 360 + 18 * np.cos(11 * t) + r.normal(0, 3), 35 + 8 * np.sin(2 * t))
add('ean-shaky', ean, 'ean13', seconds=3, pose=show(shake), exposure=1 / 30)
add('qr-shaky', qr, 'qr', seconds=3, pose=show(shake), exposure=1 / 30)
# Focus pull: starts badly defocused, sharpens over 2.5 s (how early does it read?)
add('ean-focus-pull', ean, 'ean13', seconds=3.5, pose=show(lambda t: (640, 360, 25)),
    focus=lambda t: max(0.5, 6 - 2.2 * max(0, t - 0.5)))
add('code128-focus-pull', c128, 'code128', seconds=3.5, pose=show(lambda t: (640, 360, -15)),
    focus=lambda t: max(0.5, 5 - 1.8 * max(0, t - 0.5)))

(out / 'manifest.json').write_text(json.dumps(manifest, indent=1))
print(len(manifest), 'clips ->', out)
