"""Reject APK updates signed with a different key than the published application."""
import os
import re
import subprocess
import tempfile
from pathlib import Path

sdk = Path(os.environ.get('ANDROID_HOME') or os.environ['ANDROID_SDK_ROOT'])
tools = sorted(sdk.glob('build-tools/*/apksigner'))
if not tools:
    raise SystemExit('::error::apksigner ist im Android-SDK nicht verfügbar.')

def certificate(apk):
    result = subprocess.run([str(tools[-1]), 'verify', '--print-certs', str(apk)], text=True, capture_output=True, check=True)
    digests = re.findall(r'^Signer #\d+ certificate SHA-256 digest: (\w+)$', result.stdout, re.MULTILINE)
    if not digests:
        raise RuntimeError('Keine überprüfbare APK-Signatur: ' + str(apk))
    return sorted(digests)

with tempfile.TemporaryDirectory(prefix='previous-android-', dir=os.environ['RUNNER_TEMP']) as tmp:
    # The existing release is the updater endpoint; a failed download is not proof of compatibility.
    subprocess.run(['gh', 'release', 'download', 'android-latest', '--repo', os.environ['GITHUB_REPOSITORY'],
                    '--pattern', 'watchparty*.apk', '--dir', tmp], check=True)
    for name in ['watchparty.apk', 'watchparty-tv.apk']:
        previous = Path(tmp) / name
        if not previous.exists():
            raise SystemExit('::error::Die bisherige APK fehlt: ' + name)
        if certificate(previous) != certificate(Path(name)):
            raise SystemExit('::error::' + name + ' wurde mit einem anderen Schlüssel signiert. Für installierbare Updates muss der bisherige Signierschlüssel verwendet werden.')
        print(name + ': Signatur mit bisherigem Release kompatibel.')
