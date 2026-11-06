"""Reject APK updates signed with a different key than the published application."""
import os
import re
import subprocess
import tempfile
import sys
from pathlib import Path

# Approved migration from the ephemeral runner debug key to the permanent
# keystore in GitHub Secrets. Existing debug-signed installs need reinstalling.
LEGACY_DEBUG_CERTIFICATE = 'b2fedcc79f5793a8bf7cbe762b563f8953f4d6de179f8903eda48117730eba0a'
RELEASE_CERTIFICATE = 'df67a7193375424ff46dc80c33a5fb3c96b1e0cfe73fadad4d343169d9602815'


def requires_reinstall(old, new):
    if new != [RELEASE_CERTIFICATE]:
        raise RuntimeError('Die neue APK muss mit dem festgelegten Release-Schlüssel signiert sein.')
    if old == new:
        return False
    if old == [LEGACY_DEBUG_CERTIFICATE]:
        return True
    raise RuntimeError('Nicht freigegebener Wechsel des Android-Signierschlüssels.')


def certificate_digests(output):
    # Recent build-tools use "Signer (minSdkVersion=..., maxSdkVersion=...)"
    # where older apksigner versions printed "Signer #1".
    digests = re.findall(r'^Signer[^\r\n]*certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\s*$', output, re.MULTILINE)
    if not digests:
        raise RuntimeError('Keine überprüfbare APK-Signatur in der apksigner-Ausgabe.')
    return sorted(set(digest.lower() for digest in digests))


def certificate(apk, signer):
    java = str(Path(os.environ['JAVA_HOME']) / 'bin/java')
    result = subprocess.run([java, '-jar', str(signer), 'verify', '--print-certs', str(apk)], text=True, capture_output=True, check=True)
    try:
        return certificate_digests(result.stdout)
    except RuntimeError:
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        raise


def main():
    sdk = Path(os.environ.get('ANDROID_HOME') or os.environ['ANDROID_SDK_ROOT'])
    signer = sdk / 'build-tools/35.0.0/lib/apksigner.jar'
    if not signer.is_file():
        raise SystemExit('::error::Android Build Tools 35.0.0 fehlen für die Signaturprüfung.')
    print('Signaturprüfung mit Android Build Tools 35.0.0', flush=True)
    with tempfile.TemporaryDirectory(prefix='previous-android-', dir=os.environ['RUNNER_TEMP']) as tmp:
        subprocess.run(['gh', 'release', 'download', 'android-latest', '--repo', os.environ['GITHUB_REPOSITORY'],
                        '--pattern', 'watchparty*.apk', '--dir', tmp], check=True)
        for name in ['watchparty.apk', 'watchparty-tv.apk']:
            previous = Path(tmp) / name
            if not previous.exists():
                raise SystemExit('::error::Die bisherige APK fehlt: ' + name)
            old = certificate(previous, signer)
            new = certificate(Path(name), signer)
            print(name + ': bisherige Signatur ' + ', '.join(old) + '; neue Signatur ' + ', '.join(new), flush=True)
            try:
                reinstall = requires_reinstall(old, new)
            except RuntimeError as error:
                raise SystemExit('::error::' + name + ': ' + str(error))
            if reinstall:
                print('::warning::' + name + ': Freigegebener Wechsel vom alten Debug-Schlüssel. Bestehende Installationen müssen einmal deinstalliert und neu installiert werden; lokale App-Daten gehen verloren.')
            else:
                print(name + ': Signatur mit bisherigem Release kompatibel.')


if __name__ == '__main__':
    main()
