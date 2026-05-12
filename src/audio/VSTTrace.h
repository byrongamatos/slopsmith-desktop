// Diagnostic logger for VST3 host ↔ plugin handshake.
//
// Defined in a header so it's reachable from both the addon
// (NodeAddon.cpp, VSTHost.cpp) and the vendored JUCE VST3 host context
// (juce_VST3PluginFormatImpl.h). Writes every call to a file + stderr
// with immediate flush so a process abort (e.g. `__fastfail` from a
// crashy plugin) doesn't lose the last few lines.
//
// Throwaway diagnostic — do not ship in a release build.

#pragma once

#include <cstdio>
#include <cstdarg>
#include <cstdlib>
#include <ctime>
#include <mutex>

#if defined(_WIN32)
  #include <windows.h>
#else
  #include <unistd.h>
#endif

namespace slopsmith_vst_trace {

inline std::FILE* logFile()
{
    static std::FILE* f = []() -> std::FILE* {
        char path[1024] = {0};
#if defined(_WIN32)
        DWORD n = GetEnvironmentVariableA("TEMP", path, sizeof(path));
        if (n == 0 || n >= sizeof(path)) {
            std::snprintf(path, sizeof(path), "C:\\slopsmith-vst-trace.log");
        } else {
            std::strncat(path, "\\slopsmith-vst-trace.log", sizeof(path) - n - 1);
        }
#else
        std::snprintf(path, sizeof(path), "/tmp/slopsmith-vst-trace.log");
#endif
        std::FILE* fp = std::fopen(path, "a");
        if (fp) {
            std::fprintf(fp, "\n========== slopsmith-vst-trace opened (pid=%lu) ==========\n",
                         (unsigned long)
#if defined(_WIN32)
                         GetCurrentProcessId()
#else
                         (unsigned long) getpid()
#endif
                        );
            std::fflush(fp);
        }
        return fp;
    }();
    return f;
}

inline std::mutex& logMutex()
{
    static std::mutex m;
    return m;
}

inline void writef(const char* fmt, ...)
{
    std::lock_guard<std::mutex> lock(logMutex());

    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    auto* fp = logFile();
    if (fp) {
        std::fputs(buf, fp);
        std::fputc('\n', fp);
        std::fflush(fp);
    }
    std::fputs("[vst-trace] ", stderr);
    std::fputs(buf, stderr);
    std::fputc('\n', stderr);
    std::fflush(stderr);
}

// Format 16 hex bytes of a TUID. The Steinberg TUID type is `char[16]`.
inline const char* tuidHex(const void* tuid)
{
    static thread_local char out[40];
    const unsigned char* b = static_cast<const unsigned char*>(tuid);
    std::snprintf(out, sizeof(out),
                  "%02x%02x%02x%02x-%02x%02x%02x%02x-%02x%02x%02x%02x-%02x%02x%02x%02x",
                  b[0], b[1], b[2], b[3],   b[4], b[5], b[6], b[7],
                  b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
    return out;
}

} // namespace slopsmith_vst_trace

#define VST_TRACE(...) ::slopsmith_vst_trace::writef(__VA_ARGS__)
