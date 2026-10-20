#!/usr/bin/env python3
"""Build every image the site serves from the source photos in assets/.

Outputs (all committed, the site has no build step at deploy time):
  assets/img/<stem>-<width>.jpg    progressive JPEG, EXIF orientation baked in, metadata stripped
  assets/img/<stem>-<width>.webp   same frame as WebP
  assets/brand/                    logo cut-outs, PWA icons, apple-touch-icon, the social card

Run from anywhere:   python3 tools/build-assets.py            (all)
                     python3 tools/build-assets.py hero-cut   (one stem)
Video encodes live in tools/build-video.sh.

Needs Pillow (`pip3 install pillow`). Sizes are chosen per image from how large
it renders: gallery plates top out around 600 CSS px, the hero fills the
viewport, so it gets a 2000 px rung for 2x desktop screens. The interior renders
about 400 px wide on 1x desktops, so it gets a 480 rung. The booking buttons'
52 px circles get their own 160 px face crops (FACES), 3x of 52.
"""

import sys
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "img"
BRAND = ROOT / "assets" / "brand"

JPEG_QUALITY = 82
WEBP_QUALITY = 80

GALLERY = (480, 800, 1200)
WIDE = (480, 800, 1200, 1600, 2000)
PORTRAIT_HERO = (480, 800, 1200, 1600, 2000)

# stem -> (source, widths)
SOURCES = {
    # hero
    "hero-cut":          ("assets/Haircuts/cut-pomp-skin-fade.jpg", PORTRAIT_HERO),
    # inside the shop
    "interior":          ("assets/FadeEmpireStore/interior-billiards.jpg", WIDE),
    "storefront":        ("assets/FadeEmpireStore/FadeEmpireStoreFront.JPG", GALLERY),
    "price-wall":        ("assets/Haircuts/cut-price-list-wall.jpg", GALLERY),
    # barbers
    "hassan":            ("assets/Barbers/Hassan/HassanBarber.png", GALLERY),
    "larry":             ("assets/Barbers/Larry/LarryBarber.jpg", GALLERY),
    # gallery, newest first
    "cut-textured-taper":  ("assets/Haircuts/cut-textured-taper.jpg", GALLERY),
    "cut-curls-full-beard":("assets/Haircuts/cut-curls-full-beard.jpg", GALLERY),
    "cut-crop-goatee":     ("assets/Haircuts/cut-crop-goatee.jpg", GALLERY),
    "cut-beard-recline":   ("assets/Haircuts/cut-beard-recline.jpg", GALLERY),
    "cut-mid-fade-lineup": ("assets/Haircuts/IMG_2573.jpg", GALLERY),
    "cut-beard-shape":     ("assets/Haircuts/IMG_2607.jpg", GALLERY),
    "cut-designed-part":   ("assets/Haircuts/IMG_2609.jpg", GALLERY),
    "cut-kids-high-fade":  ("assets/Haircuts/IMG_2696.jpg", GALLERY),
    "cut-curls-skin-fade": ("assets/Haircuts/IMG_2781.jpg", GALLERY),
    "cut-razor-design":    ("assets/Haircuts/IMG_8034.jpg", GALLERY),
    "cut-beard-shape-up":  ("assets/Haircuts/IMG_8232.jpg", GALLERY),
    "cut-low-fade":        ("assets/Haircuts/IMG_9449.jpg", GALLERY),
    "cut-high-fade-texture": ("assets/Haircuts/IMG_0063.jpg", GALLERY),
}

# stem -> square crop box (left, top, right, bottom) in source pixels around the
# barber's face, written as <stem>-face-160. Hassan's portrait also has a
# customer in it; the box takes Hassan only.
FACES = {
    "hassan": (415, 230, 1095, 910),
    "larry":  (644, 1151, 1504, 2011),
}
FACE_SIZE = 160

LOGO = ROOT / "assets/FadeEmpireStore/fadeempirelogo.png"
INK = (10, 9, 8)
BONE = (237, 230, 214)


def load(path: Path) -> Image.Image:
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)      # bake the phone's rotation into the pixels
    return im.convert("RGB")


def write_variants(stem: str, src: str, widths) -> None:
    im = load(ROOT / src)
    for w in widths:
        if w > im.width:
            continue
        h = round(im.height * w / im.width)
        frame = im.resize((w, h), Image.LANCZOS)
        frame.save(OUT / f"{stem}-{w}.jpg", "JPEG", quality=JPEG_QUALITY,
                   optimize=True, progressive=True)
        frame.save(OUT / f"{stem}-{w}.webp", "WEBP", quality=WEBP_QUALITY, method=6)
    print(f"  {stem:<24} {im.width}x{im.height} -> {[w for w in widths if w <= im.width]}")


def write_face(stem: str, box) -> None:
    im = load(ROOT / SOURCES[stem][0])
    frame = im.crop(box).resize((FACE_SIZE, FACE_SIZE), Image.LANCZOS)
    frame.save(OUT / f"{stem}-face-{FACE_SIZE}.jpg", "JPEG", quality=JPEG_QUALITY,
               optimize=True, progressive=True)
    frame.save(OUT / f"{stem}-face-{FACE_SIZE}.webp", "WEBP", quality=WEBP_QUALITY, method=6)
    print(f"  {stem + '-face':<24} {box} -> {FACE_SIZE}x{FACE_SIZE}")


def logo_alpha() -> Image.Image:
    """The logo PNG is light-grey art on a near-black noisy background.
    Turn luminance into alpha so the mark can sit on any dark surface."""
    grey = ImageOps.grayscale(Image.open(LOGO).convert("RGB"))
    lut = [0 if v < 48 else (255 if v > 140 else round((v - 48) * 255 / 92)) for v in range(256)]
    return grey.point(lut).filter(ImageFilter.GaussianBlur(0.6))


def tinted(alpha: Image.Image, rgb) -> Image.Image:
    layer = Image.new("RGBA", alpha.size, rgb + (0,))
    layer.putalpha(alpha)
    return layer


def build_brand() -> None:
    alpha = logo_alpha()
    full = tinted(alpha, BONE)
    full = full.crop(alpha.getbbox())
    full.save(BRAND / "logo-full.png", optimize=True)
    # The footer shows it 120-150 px wide: 240 for 1x, 480 up to 3x. The art is
    # one colour, so a palette PNG of bone at every alpha level is exact and
    # 40% of the RGBA size.
    for w in (240, 480):
        small = full.resize((w, round(full.height * w / full.width)), Image.LANCZOS).getchannel("A")
        pal = Image.frombytes("P", small.size, small.tobytes())
        pal.putpalette(list(BONE) * 256)
        pal.save(BRAND / f"logo-full-{w}.png", optimize=True, transparency=bytes(range(256)))

    # The knight helmet alone is the monogram (the wordmark on the site is set
    # in Fraunces, and the pole runs the full height beside the text).
    mark = tinted(alpha, BONE).crop((340, 60, 840, 545))
    mark = mark.crop(mark.getbbox())
    mark.save(BRAND / "logo-mark.png", optimize=True)
    mark.resize((mark.width // 4, mark.height // 4), Image.LANCZOS).save(BRAND / "logo-mark-240.png", optimize=True)

    # PWA icons: mark centred on ink. Maskable needs the art inside the safe
    # zone (inner 80%), so it gets more padding.
    for size, pad, name in ((512, 0.14, "icon-512.png"), (192, 0.14, "icon-192.png"),
                            (512, 0.22, "icon-maskable-512.png"), (180, 0.14, "apple-touch-icon.png")):
        canvas = Image.new("RGBA", (size, size), INK + (255,))
        box = round(size * (1 - 2 * pad))
        art = mark.copy()
        art.thumbnail((box, box), Image.LANCZOS)
        canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
        canvas.convert("RGB").save(BRAND / name, optimize=True)

    # Social card: the hero photo cropped to 1200x630 with a dark gradient and the mark.
    hero = load(ROOT / SOURCES["hero-cut"][0])
    card = ImageOps.fit(hero, (1200, 630), Image.LANCZOS, centering=(0.5, 0.32))
    shade = Image.new("RGBA", card.size, (0, 0, 0, 0))
    for y in range(630):
        a = int(min(1.0, max(0.0, (y - 200) / 430)) * 235)
        shade.paste((10, 9, 8, a), (0, y, 1200, y + 1))
    card = Image.alpha_composite(card.convert("RGBA"), shade)
    badge = full.copy()
    badge.thumbnail((360, 360), Image.LANCZOS)
    card.alpha_composite(badge, (72, 630 - badge.height - 56))
    card.convert("RGB").save(BRAND / "og-cover.jpg", "JPEG", quality=86, optimize=True, progressive=True)
    print("  brand: logo-full(-240, -480), logo-mark, icons, apple-touch-icon, og-cover")


def main(argv) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    BRAND.mkdir(parents=True, exist_ok=True)
    only = set(argv[1:])
    print("Building images:")
    for stem, (src, widths) in SOURCES.items():
        if only and stem not in only:
            continue
        write_variants(stem, src, widths)
        if stem in FACES:
            write_face(stem, FACES[stem])
    if not only or "brand" in only:
        build_brand()


if __name__ == "__main__":
    main(sys.argv)
