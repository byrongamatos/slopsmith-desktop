#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>

// Represents a single processor slot in the signal chain.
// Can hold a VST3/AU/LV2 plugin, NAM model, or IR loader.
struct ProcessorSlot
{
    enum class Type { VST, NAM, IR, Empty };

    Type type = Type::Empty;
    std::unique_ptr<juce::AudioProcessor> processor;
    juce::String name;
    juce::String path; // plugin file path, NAM model path, or IR file path
    bool bypassed = false;
    int id = 0;

    // For VST plugins — their state as base64 for preset save/load
    juce::MemoryBlock getState() const;
    void setState(const juce::MemoryBlock& state);
};

class SignalChain
{
public:
    SignalChain();
    ~SignalChain();

    void prepare(double sampleRate, int blockSize);
    void releaseResources();
    void process(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi);

    // Chain management
    int addProcessor(std::unique_ptr<juce::AudioProcessor> processor,
                     ProcessorSlot::Type type,
                     const juce::String& name,
                     const juce::String& path);
    void removeProcessor(int slotId);
    void moveProcessor(int fromIndex, int toIndex);
    void setBypass(int slotId, bool bypassed);
    void clear();

    // Info
    int getNumSlots() const;
    const ProcessorSlot* getSlot(int slotId) const;
    juce::Array<const ProcessorSlot*> getAllSlots() const;

    // Parameters for a specific slot
    struct ParamInfo
    {
        int index;
        juce::String name;
        float value;
        juce::String label;
        juce::String text;
    };
    juce::Array<ParamInfo> getParameters(int slotId) const;
    void setParameter(int slotId, int paramIndex, float value);

    // Preset serialization
    juce::String savePreset() const;
    void loadPreset(const juce::String& json);

private:
    int findSlotIndex(int slotId) const;

    juce::OwnedArray<ProcessorSlot> slots;
    juce::CriticalSection lock;
    int nextSlotId = 1;

    double currentSampleRate = 48000.0;
    int currentBlockSize = 256;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SignalChain)
};
