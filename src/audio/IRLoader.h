#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_dsp/juce_dsp.h>

// Cabinet impulse response loader using JUCE's convolution engine.
// Loads .wav/.ir files and applies them in real-time.
class IRLoader : public juce::AudioProcessor
{
public:
    IRLoader();
    ~IRLoader() override;

    // Load an impulse response file (.wav, .aif, .ir)
    bool loadIR(const juce::File& irFile);
    bool hasIR() const { return irLoaded.load(); }
    juce::String getIRName() const { return currentIRName; }
    juce::String getIRPath() const { return currentIRPath; }

    // Dry/wet mix (0.0 = fully dry, 1.0 = fully wet)
    void setMix(float mix) { dryWetMix.store(juce::jlimit(0.0f, 1.0f, mix)); }
    float getMix() const { return dryWetMix.load(); }

    // Output gain
    void setGain(float gain) { outputGain.store(gain); }
    float getGain() const { return outputGain.load(); }

    // AudioProcessor interface
    const juce::String getName() const override { return "IR Loader"; }
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    double getTailLengthSeconds() const override { return 0.5; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }

    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

private:
    juce::dsp::Convolution convolution;
    juce::AudioBuffer<float> dryBuffer; // for dry/wet mixing

    std::atomic<bool> irLoaded{false};
    std::atomic<float> dryWetMix{1.0f};
    std::atomic<float> outputGain{1.0f};

    juce::String currentIRName;
    juce::String currentIRPath;

    double currentSampleRate = 48000.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(IRLoader)
};
