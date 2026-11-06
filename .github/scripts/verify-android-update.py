"""Reject APK updates signed with a different key than the published application."""
import os
import re
import subprocess
import tempfile
from pathlib import Path


def certificate_digests(output):
    # Recent build-tools use "Signer (minSdkVersion=..., maxSdkVersion=...)"
    # where older apksigner versions printed "Signer #1".
    digests = re.findall(r'^Signer[^\r\n]*certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\s*$', output, re.MULTILINE)
    if not digests:
        raise RuntimeError('Keine überprüfbare APK-Signatur in der apksigner-Ausgabe.')
    return sorted(set(digest.lower() for digest in digests))


def certificate(apk, signer):
    result = subprocess.run([str(signer), 'verify', '--print-certs', str(apk)], text=True, capture_output=True, check=True)
    return certificate_digests(result.stdout)


def main():
    sdk = Path(os.environ.get('ANDROID_HOME') or os.environ['ANDROID_SDK_ROOT'])
    tools = sorted(sdk.glob('build-tools/*/apksigner'))
    if not tools:
        raise SystemExit('::error::apksigner ist im Android-SDK nicht verfügbar.')
    with tempfile.TemporaryDirectory(prefix='previous-android-', dir=os.environ['RUNNER_TEMP']) as tmp:
        subprocess.run(['gh', 'release', 'download', 'android-latest', '--repo', os.environ['GITHUB_REPOSITORY'],
                        '--pattern', 'watchparty*.apk', '--dir', tmp], check=True)
        for name in ['watchparty.apk', 'watchparty-tv.apk']:
            previous = Path(tmp) / name
            if not previous.exists():
                raise SystemExit('::error::Die bisherige APK fehlt: ' + name)
            if certificate(previous, tools[-1]) != certificate(Path(name), tools[-1]):
                raise SystemExit('::error::' + name + ' wurde mit einem anderen Schlüssel signiert. Für installierbare Updates muss der bisherige Signierschlüssel verwendet werden.')
            print(name + ': Signatur mit bisherigem Release kompatibel.')


if __name__ == '__main__':
    main()
