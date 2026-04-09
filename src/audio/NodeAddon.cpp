// Slopsmith Audio Engine — Node.js Native Addon (N-API)
// Bridges the JUCE-based C++ audio engine to Electron via node-addon-api.
// All audio processing happens in C++; JS communicates via IPC.

#include <napi.h>
#include <thread>
#include <atomic>

#include "AudioEngine.h"
#include "VSTHost.h"
#include "NAMProcessor.h"
#include "IRLoader.h"

#include <juce_events/juce_events.h>

static std::unique_ptr<AudioEngine> engine;
static std::unique_ptr<VSTHost> vstHost;
static std::thread juceMessageThread;
static std::atomic<bool> juceRunning{false};

// ── JUCE Message Thread ───────────────────────────────────────────────────────
// JUCE requires a message thread for plugin loading, audio device management, etc.
// We pump it in a dedicated thread.

static void startJuceMessageThread()
{
    if (juceRunning.load()) return;
    juceRunning.store(true);

    juceMessageThread = std::thread([]() {
        juce::MessageManager::getInstance();
        while (juceRunning.load())
        {
            juce::MessageManager::getInstance()->runDispatchLoopUntil(50);
        }
        juce::MessageManager::deleteInstance();
    });
}

static void stopJuceMessageThread()
{
    juceRunning.store(false);
    if (juceMessageThread.joinable())
        juceMessageThread.join();
}

// ── Helper: dispatch on JUCE message thread ───────────────────────────────────

template <typename Func>
static void dispatchOnMessageThread(Func&& func)
{
    juce::WaitableEvent done;
    juce::MessageManager::callAsync([&]() {
        func();
        done.signal();
    });
    done.wait(15000);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

static Napi::Value Init(const Napi::CallbackInfo& info)
{
    auto env = info.Env();

    // Start JUCE message thread first
    startJuceMessageThread();

    // Small delay to ensure message thread is pumping
    std::this_thread::sleep_for(std::chrono::milliseconds(200));

    // Create engine on the JUCE message thread
    juce::WaitableEvent done;
    juce::MessageManager::callAsync([&]() {
        engine = std::make_unique<AudioEngine>();
        vstHost = std::make_unique<VSTHost>();

        // Log what we got
        auto types = engine->getDeviceTypes();
        fprintf(stderr, "[audio-native] Init complete. Device types: %d\n", types.size());
        for (int i = 0; i < types.size(); ++i)
            fprintf(stderr, "[audio-native]   %s: %d inputs, %d outputs\n",
                    types[i].name.toRawUTF8(),
                    types[i].inputDevices.size(),
                    types[i].outputDevices.size());

        done.signal();
    });

    if (!done.wait(15000))
        fprintf(stderr, "[audio-native] WARNING: Init timed out!\n");

    return env.Undefined();
}

static Napi::Value Shutdown(const Napi::CallbackInfo& info)
{
    dispatchOnMessageThread([]() {
        if (engine) { engine->stopAudio(); engine.reset(); }
        vstHost.reset();
    });

    stopJuceMessageThread();
    return info.Env().Undefined();
}

// ── Device Enumeration ────────────────────────────────────────────────────────

static Napi::Value GetDeviceTypes(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine) return env.Null();

    // Device types are already scanned during init — safe to read from any thread
    auto types = engine->getDeviceTypes();

    auto result = Napi::Array::New(env, types.size());

    for (int i = 0; i < types.size(); ++i)
    {
        auto obj = Napi::Object::New(env);
        obj.Set("name", types[i].name.toStdString());

        auto inputs = Napi::Array::New(env, types[i].inputDevices.size());
        for (int j = 0; j < types[i].inputDevices.size(); ++j)
            inputs.Set((uint32_t)j, types[i].inputDevices[j].toStdString());
        obj.Set("inputs", inputs);

        auto outputs = Napi::Array::New(env, types[i].outputDevices.size());
        for (int j = 0; j < types[i].outputDevices.size(); ++j)
            outputs.Set((uint32_t)j, types[i].outputDevices[j].toStdString());
        obj.Set("outputs", outputs);

        result.Set((uint32_t)i, obj);
    }

    return result;
}

static Napi::Value GetSampleRates(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine) return Napi::Array::New(env);

    auto rates = engine->getSampleRates();
    auto result = Napi::Array::New(env, rates.size());
    for (int i = 0; i < rates.size(); ++i)
        result.Set((uint32_t)i, rates[i]);
    return result;
}

static Napi::Value GetBufferSizes(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine) return Napi::Array::New(env);

    auto sizes = engine->getBufferSizes();
    auto result = Napi::Array::New(env, sizes.size());
    for (int i = 0; i < sizes.size(); ++i)
        result.Set((uint32_t)i, sizes[i]);
    return result;
}

static Napi::Value GetCurrentDevice(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine) return env.Null();

    auto obj = Napi::Object::New(env);
    obj.Set("type", engine->getCurrentDeviceType().toStdString());
    obj.Set("input", engine->getCurrentInputDevice().toStdString());
    obj.Set("output", engine->getCurrentOutputDevice().toStdString());
    obj.Set("sampleRate", engine->getCurrentSampleRate());
    obj.Set("blockSize", engine->getCurrentBlockSize());
    obj.Set("latencyMs", engine->getLatencyMs());
    return obj;
}

// ── Device Selection ──────────────────────────────────────────────────────────

static Napi::Value SetDeviceType(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine || info.Length() < 1) return Napi::Boolean::New(env, false);

    auto typeName = info[0].As<Napi::String>().Utf8Value();
    bool result = engine->setDeviceType(juce::String(typeName));
    return Napi::Boolean::New(env, result);
}

static Napi::Value SetDevice(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine) return Napi::Boolean::New(env, false);

    auto input = info.Length() > 0 && !info[0].IsNull() ? info[0].As<Napi::String>().Utf8Value() : "";
    auto output = info.Length() > 1 && !info[1].IsNull() ? info[1].As<Napi::String>().Utf8Value() : "";
    double sr = info.Length() > 2 && !info[2].IsUndefined() ? info[2].As<Napi::Number>().DoubleValue() : 48000.0;
    int bs = info.Length() > 3 && !info[3].IsUndefined() ? info[3].As<Napi::Number>().Int32Value() : 256;

    bool result = engine->setAudioDevice(juce::String(input), juce::String(output), sr, bs);
    return Napi::Boolean::New(env, result);
}

// ── Audio Control ─────────────────────────────────────────────────────────────

static Napi::Value StartAudio(const Napi::CallbackInfo& info)
{
    if (engine) engine->startAudio();
    return info.Env().Undefined();
}

static Napi::Value StopAudio(const Napi::CallbackInfo& info)
{
    if (engine) engine->stopAudio();
    return info.Env().Undefined();
}

static Napi::Value IsAudioRunning(const Napi::CallbackInfo& info)
{
    return Napi::Boolean::New(info.Env(), engine ? engine->isAudioRunning() : false);
}

// ── Gain ──────────────────────────────────────────────────────────────────────

static Napi::Value SetGain(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine || info.Length() < 2) return env.Undefined();

    auto which = info[0].As<Napi::String>().Utf8Value();
    float value = info[1].As<Napi::Number>().FloatValue();

    if (which == "input") engine->setInputGain(value);
    else if (which == "output") engine->setOutputGain(value);
    else if (which == "backing") engine->setBackingVolume(value);

    return env.Undefined();
}

static Napi::Value SetInputChannel(const Napi::CallbackInfo& info)
{
    if (engine && info.Length() > 0)
        engine->setInputChannel(info[0].As<Napi::Number>().Int32Value());
    return info.Env().Undefined();
}

static Napi::Value SetMonitorMute(const Napi::CallbackInfo& info)
{
    if (engine && info.Length() > 0)
        engine->setMonitorMute(info[0].As<Napi::Boolean>().Value());
    return info.Env().Undefined();
}

static Napi::Value IsMonitorMuted(const Napi::CallbackInfo& info)
{
    return Napi::Boolean::New(info.Env(), engine ? engine->isMonitorMuted() : true);
}

// ── Metering (polled — read atomics) ──────────────────────────────────────────

static Napi::Value GetLevels(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    auto obj = Napi::Object::New(env);

    if (engine)
    {
        obj.Set("inputLevel", engine->getInputLevel());
        obj.Set("outputLevel", engine->getOutputLevel());
        obj.Set("inputPeak", engine->getInputPeak());
        obj.Set("outputPeak", engine->getOutputPeak());
    }
    else
    {
        obj.Set("inputLevel", 0.0);
        obj.Set("outputLevel", 0.0);
        obj.Set("inputPeak", 0.0);
        obj.Set("outputPeak", 0.0);
    }

    return obj;
}

static Napi::Value ResetPeaks(const Napi::CallbackInfo& info)
{
    if (engine) engine->resetPeaks();
    return info.Env().Undefined();
}

// ── Pitch Detection (polled) ──────────────────────────────────────────────────

static Napi::Value GetPitchDetection(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    auto obj = Napi::Object::New(env);

    if (engine)
    {
        auto det = engine->getPitchDetector().getLatestDetection();
        obj.Set("frequency", det.frequency);
        obj.Set("confidence", det.confidence);
        obj.Set("midiNote", det.midiNote);
        obj.Set("cents", det.cents);
        obj.Set("noteName", det.noteName.toStdString());
    }
    else
    {
        obj.Set("frequency", -1.0);
        obj.Set("confidence", 0.0);
        obj.Set("midiNote", -1);
        obj.Set("cents", 0.0);
        obj.Set("noteName", "");
    }

    return obj;
}

// ── VST Plugin Scanning ──────────────────────────────────────────────────────

class ScanPluginsWorker : public Napi::AsyncWorker
{
public:
    ScanPluginsWorker(Napi::Env env, Napi::Promise::Deferred deferred, juce::StringArray dirs)
        : Napi::AsyncWorker(env), deferred(deferred), directories(std::move(dirs)) {}

    void Execute() override
    {
        if (!vstHost) return;
        vstHost->scanDirectories(directories, [](float, const juce::String&) {});
    }

    void OnOK() override
    {
        auto env = Env();
        auto result = Napi::Array::New(env);

        if (vstHost)
        {
            auto plugins = vstHost->getKnownPlugins();
            for (int i = 0; i < plugins.size(); ++i)
            {
                auto obj = Napi::Object::New(env);
                obj.Set("name", plugins[i].name.toStdString());
                obj.Set("manufacturer", plugins[i].manufacturer.toStdString());
                obj.Set("category", plugins[i].category.toStdString());
                obj.Set("format", plugins[i].formatName.toStdString());
                obj.Set("path", plugins[i].fileOrIdentifier.toStdString());
                obj.Set("uid", plugins[i].uid.toStdString());
                obj.Set("isInstrument", plugins[i].isInstrument);
                result.Set((uint32_t)i, obj);
            }
        }

        deferred.Resolve(result);
    }

    void OnError(const Napi::Error& error) override
    {
        deferred.Reject(error.Value());
    }

private:
    Napi::Promise::Deferred deferred;
    juce::StringArray directories;
};

static Napi::Value ScanPlugins(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    juce::StringArray dirs;
    if (info.Length() > 0 && info[0].IsArray())
    {
        auto arr = info[0].As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); ++i)
            dirs.add(juce::String(arr.Get(i).As<Napi::String>().Utf8Value()));
    }
    else
    {
        dirs = VSTHost::getDefaultScanDirectories();
    }

    auto worker = new ScanPluginsWorker(env, deferred, dirs);
    worker->Queue();
    return deferred.Promise();
}

static Napi::Value GetKnownPlugins(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    auto result = Napi::Array::New(env);

    if (vstHost)
    {
        auto plugins = vstHost->getKnownPlugins();
        for (int i = 0; i < plugins.size(); ++i)
        {
            auto obj = Napi::Object::New(env);
            obj.Set("name", plugins[i].name.toStdString());
            obj.Set("manufacturer", plugins[i].manufacturer.toStdString());
            obj.Set("category", plugins[i].category.toStdString());
            obj.Set("format", plugins[i].formatName.toStdString());
            obj.Set("path", plugins[i].fileOrIdentifier.toStdString());
            obj.Set("uid", plugins[i].uid.toStdString());
            obj.Set("isInstrument", plugins[i].isInstrument);
            result.Set((uint32_t)i, obj);
        }
    }

    return result;
}

static Napi::Value SavePluginList(const Napi::CallbackInfo& info)
{
    if (vstHost && info.Length() > 0)
        vstHost->savePluginList(juce::File(juce::String(info[0].As<Napi::String>().Utf8Value())));
    return info.Env().Undefined();
}

static Napi::Value LoadPluginList(const Napi::CallbackInfo& info)
{
    if (vstHost && info.Length() > 0)
        vstHost->loadPluginList(juce::File(juce::String(info[0].As<Napi::String>().Utf8Value())));
    return info.Env().Undefined();
}

// ── Signal Chain Management ──────────────────────────────────────────────────

static Napi::Value LoadVST(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine || !vstHost || info.Length() < 1)
        return Napi::Number::New(env, -1);

    auto pluginPath = info[0].As<Napi::String>().Utf8Value();
    int slotId = -1;

    juce::String error;
    auto instance = vstHost->loadPlugin(
        juce::String(pluginPath),
        engine->getCurrentSampleRate(),
        engine->getCurrentBlockSize(),
        error);

    if (instance)
    {
        auto name = instance->getName();
        slotId = engine->getSignalChain().addProcessor(
            std::move(instance),
            ProcessorSlot::Type::VST,
            name,
            juce::String(pluginPath));
    }

    return Napi::Number::New(env, slotId);
}

static Napi::Value LoadNAMModel(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine || info.Length() < 1)
        return Napi::Number::New(env, -1);

    auto modelPath = info[0].As<Napi::String>().Utf8Value();
    int slotId = -1;

    auto processor = std::make_unique<NAMProcessor>();
    if (processor->loadModel(juce::File(juce::String(modelPath))))
    {
        auto name = processor->getModelName();
        slotId = engine->getSignalChain().addProcessor(
            std::move(processor),
            ProcessorSlot::Type::NAM,
            "NAM: " + name,
            juce::String(modelPath));
    }

    return Napi::Number::New(env, slotId);
}

static Napi::Value LoadIR(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine || info.Length() < 1)
        return Napi::Number::New(env, -1);

    auto irPath = info[0].As<Napi::String>().Utf8Value();
    int slotId = -1;

    auto processor = std::make_unique<IRLoader>();
    processor->setPlayConfigDetails(2, 2, engine->getCurrentSampleRate(), engine->getCurrentBlockSize());
    processor->prepareToPlay(engine->getCurrentSampleRate(), engine->getCurrentBlockSize());
    if (processor->loadIR(juce::File(juce::String(irPath))))
    {
        auto name = processor->getIRName();
        slotId = engine->getSignalChain().addProcessor(
                std::move(processor),
                ProcessorSlot::Type::IR,
                "IR: " + name,
                juce::String(irPath));
    }

    return Napi::Number::New(env, slotId);
}

static Napi::Value RemoveProcessor(const Napi::CallbackInfo& info)
{
    if (engine && info.Length() > 0)
    {
        int slotId = info[0].As<Napi::Number>().Int32Value();
        engine->getSignalChain().removeProcessor(slotId);
    }
    return info.Env().Undefined();
}

static Napi::Value MoveProcessor(const Napi::CallbackInfo& info)
{
    if (engine && info.Length() >= 2)
    {
        int from = info[0].As<Napi::Number>().Int32Value();
        int to = info[1].As<Napi::Number>().Int32Value();
        engine->getSignalChain().moveProcessor(from, to);
    }
    return info.Env().Undefined();
}

static Napi::Value SetBypass(const Napi::CallbackInfo& info)
{
    if (engine && info.Length() >= 2)
    {
        int slotId = info[0].As<Napi::Number>().Int32Value();
        bool bypassed = info[1].As<Napi::Boolean>().Value();
        engine->getSignalChain().setBypass(slotId, bypassed);
    }
    return info.Env().Undefined();
}

static Napi::Value ClearChain(const Napi::CallbackInfo& info)
{
    if (engine) engine->getSignalChain().clear();
    return info.Env().Undefined();
}

// ── Chain State ───────────────────────────────────────────────────────────────

static Napi::Value GetChainState(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    auto result = Napi::Array::New(env);

    if (engine)
    {
        auto slots = engine->getSignalChain().getAllSlots();
        for (int i = 0; i < slots.size(); ++i)
        {
            auto obj = Napi::Object::New(env);
            obj.Set("id", slots[i]->id);
            obj.Set("type", (int)slots[i]->type);
            obj.Set("name", slots[i]->name.toStdString());
            obj.Set("path", slots[i]->path.toStdString());
            obj.Set("bypassed", slots[i]->bypassed);
            result.Set((uint32_t)i, obj);
        }
    }

    return result;
}

// ── Parameters ────────────────────────────────────────────────────────────────

static Napi::Value GetParameters(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine || info.Length() < 1) return Napi::Array::New(env);

    int slotId = info[0].As<Napi::Number>().Int32Value();
    auto params = engine->getSignalChain().getParameters(slotId);
    auto result = Napi::Array::New(env, params.size());

    for (int i = 0; i < params.size(); ++i)
    {
        auto obj = Napi::Object::New(env);
        obj.Set("index", params[i].index);
        obj.Set("name", params[i].name.toStdString());
        obj.Set("value", params[i].value);
        obj.Set("label", params[i].label.toStdString());
        obj.Set("text", params[i].text.toStdString());
        result.Set((uint32_t)i, obj);
    }

    return result;
}

static Napi::Value SetParameter(const Napi::CallbackInfo& info)
{
    if (engine && info.Length() >= 3)
    {
        int slotId = info[0].As<Napi::Number>().Int32Value();
        int paramIdx = info[1].As<Napi::Number>().Int32Value();
        float value = info[2].As<Napi::Number>().FloatValue();
        engine->getSignalChain().setParameter(slotId, paramIdx, value);
    }
    return info.Env().Undefined();
}

// ── Backing Track ─────────────────────────────────────────────────────────────

static Napi::Value LoadBackingTrack(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine || info.Length() < 1) return Napi::Boolean::New(env, false);

    auto path = info[0].As<Napi::String>().Utf8Value();
    bool result = engine->loadBackingTrack(juce::File(juce::String(path)));
    return Napi::Boolean::New(env, result);
}

static Napi::Value StartBacking(const Napi::CallbackInfo& info)
{
    if (engine) engine->startBacking();
    return info.Env().Undefined();
}

static Napi::Value StopBacking(const Napi::CallbackInfo& info)
{
    if (engine) engine->stopBacking();
    return info.Env().Undefined();
}

static Napi::Value SeekBacking(const Napi::CallbackInfo& info)
{
    if (engine && info.Length() > 0)
        engine->setBackingPosition(info[0].As<Napi::Number>().DoubleValue());
    return info.Env().Undefined();
}

// ── Presets ───────────────────────────────────────────────────────────────────

static Napi::Value SavePreset(const Napi::CallbackInfo& info)
{
    auto env = info.Env();
    if (!engine) return env.Null();
    auto json = engine->getSignalChain().savePreset();
    return Napi::String::New(env, json.toStdString());
}

// ── Module Registration ───────────────────────────────────────────────────────

static Napi::Object InitModule(Napi::Env env, Napi::Object exports)
{
    // Lifecycle
    exports.Set("init", Napi::Function::New(env, Init));
    exports.Set("shutdown", Napi::Function::New(env, Shutdown));

    // Devices
    exports.Set("getDeviceTypes", Napi::Function::New(env, GetDeviceTypes));
    exports.Set("getSampleRates", Napi::Function::New(env, GetSampleRates));
    exports.Set("getBufferSizes", Napi::Function::New(env, GetBufferSizes));
    exports.Set("getCurrentDevice", Napi::Function::New(env, GetCurrentDevice));
    exports.Set("setDeviceType", Napi::Function::New(env, SetDeviceType));
    exports.Set("setDevice", Napi::Function::New(env, SetDevice));

    // Audio control
    exports.Set("startAudio", Napi::Function::New(env, StartAudio));
    exports.Set("stopAudio", Napi::Function::New(env, StopAudio));
    exports.Set("isAudioRunning", Napi::Function::New(env, IsAudioRunning));

    // Gain
    exports.Set("setGain", Napi::Function::New(env, SetGain));
    exports.Set("setInputChannel", Napi::Function::New(env, SetInputChannel));
    exports.Set("setMonitorMute", Napi::Function::New(env, SetMonitorMute));
    exports.Set("isMonitorMuted", Napi::Function::New(env, IsMonitorMuted));

    // Metering
    exports.Set("getLevels", Napi::Function::New(env, GetLevels));
    exports.Set("resetPeaks", Napi::Function::New(env, ResetPeaks));

    // Pitch detection
    exports.Set("getPitchDetection", Napi::Function::New(env, GetPitchDetection));

    // VST scanning
    exports.Set("scanPlugins", Napi::Function::New(env, ScanPlugins));
    exports.Set("getKnownPlugins", Napi::Function::New(env, GetKnownPlugins));
    exports.Set("savePluginList", Napi::Function::New(env, SavePluginList));
    exports.Set("loadPluginList", Napi::Function::New(env, LoadPluginList));

    // Signal chain
    exports.Set("loadVST", Napi::Function::New(env, LoadVST));
    exports.Set("loadNAMModel", Napi::Function::New(env, LoadNAMModel));
    exports.Set("loadIR", Napi::Function::New(env, LoadIR));
    exports.Set("removeProcessor", Napi::Function::New(env, RemoveProcessor));
    exports.Set("moveProcessor", Napi::Function::New(env, MoveProcessor));
    exports.Set("setBypass", Napi::Function::New(env, SetBypass));
    exports.Set("clearChain", Napi::Function::New(env, ClearChain));
    exports.Set("getChainState", Napi::Function::New(env, GetChainState));

    // Parameters
    exports.Set("getParameters", Napi::Function::New(env, GetParameters));
    exports.Set("setParameter", Napi::Function::New(env, SetParameter));

    // Backing track
    exports.Set("loadBackingTrack", Napi::Function::New(env, LoadBackingTrack));
    exports.Set("startBacking", Napi::Function::New(env, StartBacking));
    exports.Set("stopBacking", Napi::Function::New(env, StopBacking));
    exports.Set("seekBacking", Napi::Function::New(env, SeekBacking));

    // Presets
    exports.Set("savePreset", Napi::Function::New(env, SavePreset));

    return exports;
}

NODE_API_MODULE(slopsmith_audio, InitModule)
