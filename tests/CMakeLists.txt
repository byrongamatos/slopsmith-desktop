# Tests for the sandbox audio path. Win32-only because AudioChannel.cpp is.
# Built by default alongside the addon — opt-out with -DSLOPSMITH_BUILD_TESTS=OFF.
#
# Run from the build directory: ./Release/audio_channel_midi_test (exit 0 = pass).

# Declare the option BEFORE the WIN32 guard so it shows up in cmake-gui /
# ccmake on non-Windows hosts too — discoverable, even if non-Windows builds
# always skip the actual targets.
option(SLOPSMITH_BUILD_TESTS "Build sandbox unit tests" ON)

if(NOT WIN32)
    return()
endif()

if(NOT SLOPSMITH_BUILD_TESTS)
    return()
endif()

add_subdirectory(sandbox)
