#pragma once
#include <juce_audio_processors/juce_audio_processors.h>

#if SLOPSMITH_NAM_SUPPORT
#include "NAM/get_dsp.h"
#endif

// Neural Amp Modeler processor — wraps a .nam model file
// for real-time guitar amp simulation.
class NAMProcessor : public juce::AudioProcessor
{
public:
    NAMProcessor();
    ~NAMProcessor() override;

    // Load a .nam model file (async-safe: prepares new model, then swaps atomically)
    bool loadModel(const juce::File& namFile);
    bool hasModel() const { return modelLoaded.load(); }
    juce::String getModelName() const { return currentModelName; }
    juce::String getModelPath() const { return currentModelPath; }

    // AudioProcessor interface
    const juce::String getName() const override { return "NAM"; }
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    double getTailLengthSeconds() const override { return 0.0; }
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

    // Parameters
    float getInputLevel() const { return inputLevel.load(); }
    void setInputLevel(float v) { inputLevel.store(v); }
    float getOutputLevel() const { return outputLevel.load(); }
    void setOutputLevel(float v) { outputLevel.store(v); }

private:
#if SLOPSMITH_NAM_SUPPORT
    std::unique_ptr<nam::DSP> model;
    std::unique_ptr<nam::DSP> pendingModel; // staged for swap
#endif

    std::atomic<bool> modelLoaded{false};
    std::atomic<float> inputLevel{1.0f};
    std::atomic<float> outputLevel{1.0f};
    juce::String currentModelName;
    juce::String currentModelPath;

    double currentSampleRate = 48000.0;
    int currentBlockSize = 256;

    // Mono processing buffer (NAM is mono in/mono out)
    std::vector<float> monoBuffer;

    juce::CriticalSection modelLock;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(NAMProcessor)
};
