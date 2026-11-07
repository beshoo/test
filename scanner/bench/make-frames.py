"""Compose small barcodes into 1920x1080 frames and apply camera-like degradations."""
import json, sys, zlib
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

base, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
W, H = 1920, 1080
CODES = {'ean13': [2, 3], 'code128': [2, 3], 'qr': [3, 4], 'gs1dm': [3, 4]}  # px per module

def motion(a, k):
    ker = np.ones(k) / k
    return np.apply_along_axis(lambda r: np.convolve(r, ker, mode='same'), 1, a)

def degrade(a, kind, rng):
    img = lambda x: Image.fromarray(np.clip(x, 0, 255).astype(np.uint8))
    arr = lambda im: np.asarray(im).astype(np.float32)
    if kind == 'clean': return a
    if kind == 'blur1.5': return arr(img(a).filter(ImageFilter.GaussianBlur(1.5)))
    if kind == 'blur2.5': return arr(img(a).filter(ImageFilter.GaussianBlur(2.5)))
    if kind == 'motion9': return motion(a, 9)
    if kind == 'lowcontrast': return 110 + a * (50 / 255)
    if kind == 'noise25': return a + rng.normal(0, 25, a.shape)
    if kind == 'gradient': return a * np.linspace(0.3, 1.0, a.shape[1])[None, :]
    if kind == 'glare':
        yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
        cy, cx = H / 2 + rng.uniform(-30, 30), W / 2 + rng.uniform(-30, 30)
        return a + 200 * np.exp(-(((yy - cy) ** 2 + (xx - cx) ** 2) / (2 * 45 ** 2)))
    if kind == 'combo':
        b = arr(img(a).filter(ImageFilter.GaussianBlur(1.3)))
        return 100 + b * (70 / 255) + rng.normal(0, 12, a.shape)
    raise ValueError(kind)

KINDS = ['clean', 'blur1.5', 'blur2.5', 'motion9', 'lowcontrast', 'noise25', 'gradient', 'glare', 'combo']
manifest = []
for name, mods in CODES.items():
    code = Image.open(base / f'{name}.png').convert('L')
    for m in mods:
        c = code.resize((code.width * m, code.height * m), Image.NEAREST)
        for kind in KINDS:
            for seed in range(3):
                rng = np.random.default_rng(zlib.crc32(f"{name}{m}{kind}{seed}".encode()))
                frame = Image.new('L', (W, H), 235)
                angle = rng.uniform(-12, 12)
                cr = c.rotate(angle, expand=True, fillcolor=235, resample=Image.BILINEAR)
                x = int(W / 2 - cr.width / 2 + rng.uniform(-150, 150))
                y = int(H / 2 - cr.height / 2 + rng.uniform(-80, 80))
                frame.paste(cr, (x, y))
                a = degrade(np.asarray(frame).astype(np.float32), kind, rng)
                g = np.clip(a, 0, 255).astype(np.uint8)
                rgba = np.dstack([g, g, g, np.full_like(g, 255)])
                fn = f'{name}_m{m}_{kind}_{seed}.rgba'
                (out / fn).write_bytes(rgba.tobytes())
                manifest.append({'file': fn, 'code': name, 'module': m, 'kind': kind, 'w': W, 'h': H})
(out / 'manifest.json').write_text(json.dumps(manifest))
Image.fromarray(g).save(out / 'sample_last.png')
print(len(manifest), 'frames')
