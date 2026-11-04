# Watchparty: wird von mpv als Videofilter geladen (vf=vapoursynth).
# Einstellungen kommen Base64-kodiert über user-data vom Client.
from fractions import Fraction

import vapoursynth as vs
from vapoursynth import core

import wp_rife

cfg = wp_rife.decode(user_data)  # noqa: F821 (von mpv gesetzt)
clip = video_in  # noqa: F821

src = Fraction(int(cfg["src_num"]), int(cfg["src_den"]))
clip = core.std.AssumeFPS(clip, fpsnum=src.numerator, fpsden=src.denominator)

wp_rife.interpolate(clip, cfg).set_output()
