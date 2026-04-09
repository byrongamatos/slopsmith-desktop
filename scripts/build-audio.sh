#!/bin/bash
# Build the JUCE audio engine as a Node.js native addon
# Usage: ./scripts/build-audio.sh [debug|release]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_TYPE="${1:-Release}"

cd "$PROJECT_DIR"

# Ensure JUCE submodule is available
if [ ! -f "JUCE/CMakeLists.txt" ]; then
    echo "Initializing JUCE submodule..."
    git submodule update --init --recursive
fi

# Ensure node_modules exist (for node-addon-api headers)
if [ ! -d "node_modules" ]; then
    echo "Installing npm dependencies..."
    npm install
fi

# Get Electron version
ELECTRON_VERSION=$(npx electron --version 2>/dev/null | tr -d 'v' || echo "35.0.0")

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64) CMAKE_ARCH="x64" ;;
    aarch64|arm64) CMAKE_ARCH="arm64" ;;
    *) CMAKE_ARCH="$ARCH" ;;
esac

echo "Building audio engine..."
echo "  Platform: $(uname -s)"
echo "  Arch: $CMAKE_ARCH"
echo "  Electron: $ELECTRON_VERSION"
echo "  Build type: $BUILD_TYPE"

npx cmake-js build \
    --runtime electron \
    --runtime-version "$ELECTRON_VERSION" \
    --arch "$CMAKE_ARCH" \
    -- \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE"

echo ""
echo "Build complete!"
if [ -f "build/Release/slopsmith_audio.node" ]; then
    echo "Output: build/Release/slopsmith_audio.node"
    ls -lh "build/Release/slopsmith_audio.node"
else
    echo "Warning: slopsmith_audio.node not found in expected location"
    find build -name "*.node" 2>/dev/null
fi
