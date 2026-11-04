# Watchparty: baut die TensorRT-Engine für eine Bildgröße vorab.
# Aufruf: VSPipe.exe -a cfg=<base64> build_engine.vpy -e 2 .
import vapoursynth as vs
from vapoursynth import core

import wp_rife

cfg = wp_rife.decode(cfg)  # noqa: F821 (von vspipe -a gesetzt)
fmt = vs.YUV420P10 if int(cfg.get("bits", 8)) > 8 else vs.YUV420P8
clip = core.std.BlankClip(format=fmt, width=int(cfg["width"]), height=int(cfg["height"]),
                          fpsnum=24000, fpsden=1001, length=12)
wp_rife.interpolate(clip, cfg).set_output()
