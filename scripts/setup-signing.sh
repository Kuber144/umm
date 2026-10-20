#!/bin/bash
# creates a self-signed "umm local signing" certificate in your login keychain, so macOS keeps
# Screen Recording and Microphone permissions across rebuilds. Remove it with scripts/remove-signing.sh
set -e
NAME="umm local signing"
if security find-identity -p codesigning | grep -q "\"$NAME\""; then
  echo "\"$NAME\" already exists, nothing to do"
  exit 0
fi
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
echo "creating a self-signed code signing certificate \"$NAME\" (valid 10 years) in your login keychain"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$NAME" \
  -addext keyUsage=critical,digitalSignature -addext extendedKeyUsage=critical,codeSigning \
  -keyout "$T/key.pem" -out "$T/cert.pem" 2> /dev/null
# OpenSSL 3 needs -legacy so the keychain can read the file, LibreSSL (macOS) has no such flag
openssl pkcs12 -export -legacy -inkey "$T/key.pem" -in "$T/cert.pem" -out "$T/cert.p12" -passout pass:umm 2> /dev/null ||
  openssl pkcs12 -export -inkey "$T/key.pem" -in "$T/cert.pem" -out "$T/cert.p12" -passout pass:umm
security import "$T/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P umm -T /usr/bin/codesign
echo "done. The next ./start.sh signs build/umm.app with it. Grant the permissions once more after that rebuild."
echo "to remove it: scripts/remove-signing.sh"
