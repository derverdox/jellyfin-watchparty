"""
Watchparty: RIFE-Zwischenbilder für mpv (über vs-mlrt + TensorRT).

Wird von rife.vpy (in mpv) und build_engine.vpy (vorab die TensorRT-Engine
bauen) benutzt. Beide müssen exakt dieselben Parameter verwenden, sonst baut
TensorRT beim Abspielen eine neue Engine und das Bild hängt minutenlang.
"""
from fractions import Fraction
import base64
import json

import vapoursynth as vs
from vapoursynth import core

PADDING = {"v4_26": 64, "v4_25_lite": 128, "v4_22_lite": 32}


def decode(data):
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    return json.loads(base64.b64decode(data).decode("utf-8")) if data else {}


def backend(cfg):
    import vsmlrt
    return vsmlrt.Backend.TRT(
        fp16=True,
        output_format=1,
        use_cuda_graph=True,
        num_streams=int(cfg.get("streams", 2)),
        device_id=int(cfg.get("device", 0)),
        static_shape=True,
    )


def padded_size(width, height, model):
    m = PADDING.get(model, 64)
    return (width + m - 1) // m * m, (height + m - 1) // m * m


def interpolate(clip, cfg):
    """clip: YUV-Video mit korrekter fps. Gibt YUV im selben Format zurück."""
    import vsmlrt

    model_key = cfg.get("model", "v4_26")
    model = getattr(vsmlrt.RIFEModel, model_key)
    multi = Fraction(int(cfg["num"]), int(cfg["den"]))
    if multi <= 1:
        return clip

    matrix = cfg.get("matrix", "709")
    rng = cfg.get("range", "limited")
    w, h = clip.width, clip.height
    pw, ph = padded_size(w, h, model_key)

    rgb = core.resize.Bicubic(clip, format=vs.RGBH, matrix_in_s=matrix, range_in_s=rng)
    if (pw, ph) != (w, h):
        rgb = core.std.AddBorders(rgb, right=pw - w, bottom=ph - h)

    # Szenenwechsel erkennen, damit keine Zwischenbilder über Schnitte gerechnet werden
    sc = float(cfg.get("scene", 0.12))
    if sc > 0:
        if hasattr(core, "misc") and hasattr(core.misc, "SCDetect"):
            rgb = core.misc.SCDetect(rgb, threshold=sc)
        elif hasattr(core.std, "SCDetect"):
            rgb = core.std.SCDetect(rgb, threshold=sc)

    out = vsmlrt.RIFE(rgb, multi=multi, model=model, backend=backend(cfg), video_player=True)

    if (pw, ph) != (w, h):
        out = core.std.Crop(out, right=pw - w, bottom=ph - h)

    out = core.resize.Bicubic(out, format=clip.format.id, matrix_s=matrix, range_s=rng)

    # mpv berechnet die Zeitstempel aus _DurationNum/_DurationDen
    fps = Fraction(clip.fps_num, clip.fps_den) * multi
    out = core.std.AssumeFPS(out, fpsnum=fps.numerator, fpsden=fps.denominator)
    out = core.std.SetFrameProps(out, _DurationNum=fps.denominator, _DurationDen=fps.numerator)
    return out
