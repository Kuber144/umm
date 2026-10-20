#!/bin/bash
# builds build/umm.app, skips when nothing in app/ changed
set -e
cd "$(dirname "$0")/.."
APP=build/umm.app
[ -d backend/.venv ] || (cd backend && uv sync)
[ -d ui/dist ] || (cd ui && npm install && npm run build)
BIN=$APP/Contents/MacOS/umm
if [ -x $BIN ] && [ -z "$(find app -type f -newer $BIN)" ]; then exit 0; fi
rm -rf $APP
mkdir -p $APP/Contents/MacOS $APP/Contents/Resources
swiftc -O ${UMM_SWIFT_FLAGS} app/*.swift -o $BIN
# git worktree builds get their own id, or macOS mixes them up with the real app (permissions, relaunch)
ID_SUFFIX=$(git rev-parse --git-dir 2>/dev/null | grep -q "/worktrees/" && echo ".worktree")
sed -e "s|__ROOT__|$PWD|" -e "s|<string>local.umm</string>|<string>local.umm$ID_SUFFIX</string>|" app/Info.plist > $APP/Contents/Info.plist
for f in AppIcon.icns StatusIcon.png; do [ -f app/$f ] && cp app/$f $APP/Contents/Resources/; done || true
# a stable "umm local signing" certificate keeps macOS permissions across rebuilds, else sign ad hoc
ID=$(security find-identity -p codesigning 2>/dev/null | awk '/"umm local signing"/{print $2; exit}')
codesign -s "${ID:--}" --force --deep $APP
echo "built $APP"
