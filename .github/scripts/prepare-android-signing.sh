#!/usr/bin/env bash
# Source this script in the APK build step. Never print passwords or private key data.
if [ -z "${APP_KEYSTORE_B64:-}" ]; then
  if [ "${GITHUB_EVENT_NAME:-}" = pull_request ]; then
    echo '::notice::PR-Build verwendet den Debug-Schlüssel.'
    return 0
  fi
  echo '::error::APP_KEYSTORE_B64 fehlt. Ein veröffentlichtes Update benötigt den bestehenden Signierschlüssel.'
  return 1
fi
export APP_KEYSTORE="$RUNNER_TEMP/app.jks"
if ! printf '%s' "$APP_KEYSTORE_B64" | tr -d '\r\n' | base64 -d > "$APP_KEYSTORE" 2>/dev/null || [ ! -s "$APP_KEYSTORE" ]; then
  echo '::error::APP_KEYSTORE_B64 enthält keinen gültigen base64-Keystore.'
  return 1
fi
# An accidental trailing newline in a GitHub secret must not change the password.
if ! keytool -J-Duser.language=en -J-Duser.country=US -list -v -keystore "$APP_KEYSTORE" -storepass:env APP_KEYSTORE_PASSWORD > "$RUNNER_TEMP/signing-info.txt" 2>/dev/null; then
  export signing_clean_password="$(printf '%s' "${APP_KEYSTORE_PASSWORD:-}" | tr -d '\r\n')"
  if [ "$signing_clean_password" != "${APP_KEYSTORE_PASSWORD:-}" ] && keytool -J-Duser.language=en -J-Duser.country=US -list -v -keystore "$APP_KEYSTORE" -storepass:env signing_clean_password > "$RUNNER_TEMP/signing-info.txt" 2>/dev/null; then
    export APP_KEYSTORE_PASSWORD="$signing_clean_password"
    echo '::notice::Unbeabsichtigte Zeilenumbrüche im Keystore-Passwort entfernt.'
  else
    unset signing_clean_password
    echo '::error::APP_KEYSTORE_PASSWORD kann den hinterlegten Keystore nicht öffnen. Passwort und APP_KEYSTORE_B64 müssen zum bestehenden Signierschlüssel passen.'
    return 1
  fi
  unset signing_clean_password
fi
# Derive an omitted alias only when the keystore contains exactly one signing key.
if [ -z "${APP_KEY_ALIAS:-}" ]; then
  mapfile -t signing_aliases < <(awk '/^Alias name: /{alias=substr($0,13)} /^Entry type: PrivateKeyEntry/{print alias}' "$RUNNER_TEMP/signing-info.txt")
  if [ "${#signing_aliases[@]}" -ne 1 ]; then
    echo '::error::APP_KEY_ALIAS fehlt und der Keystore enthält nicht genau einen privaten Schlüssel.'
    return 1
  fi
  export APP_KEY_ALIAS="${signing_aliases[0]}"
fi
if ! keytool -list -keystore "$APP_KEYSTORE" -storepass:env APP_KEYSTORE_PASSWORD -alias "$APP_KEY_ALIAS" >/dev/null 2>&1; then
  echo '::error::APP_KEY_ALIAS wurde im Keystore nicht gefunden.'
  return 1
fi
export APP_KEY_PASSWORD="${APP_KEY_PASSWORD:-$APP_KEYSTORE_PASSWORD}"
echo 'Signier-Keystore und Alias erfolgreich geprüft.'
