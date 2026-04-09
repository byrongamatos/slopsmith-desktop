#include "IRLoader.h"

IRLoader::IRLoader()
    : AudioProcessor(BusesProperties()
          .withInput("Input", juce::AudioChannelSet::stereo(), true)
          .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

IRLoader::~IRLoader() {}

bool IRLoader::loadIR(const juce::File& irFile)
{
    if (!irFile.existsAsFile()) return false;

    try
    {
        // Use JUCE's file-based loading — it handles WAV reading internally
        convolution.loadImpulseResponse(
            irFile,
            juce::dsp::Convolution::Stereo::yes,
            juce::dsp::Convolution::Trim::yes,
            0 // use full IR
        );

        currentIRName = irFile.getFileNameWithoutExtension();
        currentIRPath = irFile.getFullPathName();

        // Mark as ready immediately — JUCE's convolution handles
        // the background loading internally and will start processing
        // once the IR is ready.
        irLoaded.store(true);
        return true;
    }
    catch (const std::exception& e)
    {
        fprintf(stderr, "[IRLoader] Exception: %s\n", e.what());
        return false;
    }
    catch (...)
    {
        fprintf(stderr, "[IRLoader] Unknown exception\n");
        return false;
    }
}

void IRLoader::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    currentSampleRate = sampleRate;
    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = (juce::uint32)samplesPerBlock;
    spec.numChannels = 2;
    convolution.prepare(spec);
}

void IRLoader::releaseResources()
{
    convolution.reset();
}

void IRLoader::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    if (!irLoaded.load()) return;

    int numSamples = buffer.getNumSamples();
    int numChannels = juce::jmin(buffer.getNumChannels(), 2);

    // Ensure we only process up to 2 channels (what convolution was prepared for)
    juce::dsp::AudioBlock<float> block(buffer.getArrayOfWritePointers(), (size_t)numChannels, (size_t)numSamples);
    juce::dsp::ProcessContextReplacing<float> context(block);
    convolution.process(context);

    // Output gain
    float gain = outputGain.load();
    if (std::abs(gain - 1.0f) > 0.001f)
        buffer.applyGain(gain);
}

void IRLoader::getStateInformation(juce::MemoryBlock& destData)
{
    auto state = new juce::DynamicObject();
    state->setProperty("irPath", currentIRPath);
    state->setProperty("mix", (double)dryWetMix.load());
    state->setProperty("gain", (double)outputGain.load());
    auto json = juce::JSON::toString(juce::var(state));
    destData.append(json.toRawUTF8(), json.getNumBytesAsUTF8());
}

void IRLoader::setStateInformation(const void* data, int sizeInBytes)
{
    auto json = juce::String::fromUTF8((const char*)data, sizeInBytes);
    auto parsed = juce::JSON::parse(json);

    if (auto* obj = parsed.getDynamicObject())
    {
        auto path = obj->getProperty("irPath").toString();
        if (path.isNotEmpty())
            loadIR(juce::File(path));

        if (obj->hasProperty("mix"))
            dryWetMix.store((float)(double)obj->getProperty("mix"));
        if (obj->hasProperty("gain"))
            outputGain.store((float)(double)obj->getProperty("gain"));
    }
}
