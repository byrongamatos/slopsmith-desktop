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

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        CMAKE_ARCH="x64"
        ;;
    aarch64|arm64)
        CMAKE_ARCH="arm64"
        ;;
    *)
        CMAKE_ARCH="$ARCH"
        ;;
esac

# Get Electron version - trim whitespace properly for Windows
echo "Detecting Electron version..."
RAW_VERSION=$(npx electron --version 2>/dev/null || echo "v35.0.0")
echo "Raw version: '$RAW_VERSION'"
ELECTRON_VERSION=$(echo "$RAW_VERSION" | sed 's/[^0-9.]//g' | tr -d '[:space:]')
echo "Cleaned version: '$ELECTRON_VERSION'"

# Clear any cached cmake-js configuration to ensure fresh build
if [ -d "$HOME/.cmake-js" ]; then
    echo "Clearing cmake-js cache..."
    rm -rf "$HOME/.cmake-js"
fi

# Set npm configuration for Electron headers
# Using npm config instead of exports to ensure it's properly set
npm config set runtime electron
npm config set target "$ELECTRON_VERSION"
npm config set arch "$CMAKE_ARCH"
npm config set disturl https://artifacts.electronjs.org/headers/dist

echo "Building audio engine..."
echo "  Platform: $(uname -s)"
echo "  Arch: $CMAKE_ARCH"
echo "  Electron: $ELECTRON_VERSION"
echo "  Build type: $BUILD_TYPE"

# Debug npm config
echo ""
echo "npm config values:"
npm config get runtime
npm config get target
npm config get arch
npm config get disturl

npx cmake-js build \
    --runtime electron \
    --runtime-version "$ELECTRON_VERSION" \
    --arch "$CMAKE_ARCH" \
    --CDCMAKE_BUILD_TYPE="$BUILD_TYPE"

echo ""
echo "Build complete!"
if [ -f "build/Release/slopsmith_audio.node" ]; then
    echo "Output: build/Release/slopsmith_audio.node"
    ls -lh "build/Release/slopsmith_audio.node"
else
    echo "Warning: slopsmith_audio.node not found in expected location"
    find build -name "*.node" 2>/dev/null
fi
