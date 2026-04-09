#include "AudioEngine.h"

AudioEngine::AudioEngine()
{
    formatManager.registerBasicFormats();

    // Initialize device manager so device types are available for enumeration.
    // This registers ALSA, JACK, CoreAudio, ASIO etc. depending on platform.
    // We don't start audio yet — just make devices queryable.
    auto result = deviceManager.initialiseWithDefaultDevices(2, 2);
    if (result.isNotEmpty())
        std::cerr << "[AudioEngine] init note: " << result.toStdString() << std::endl;

    // Log available device types
    auto& availableTypes = deviceManager.getAvailableDeviceTypes();
    std::cerr << "[AudioEngine] Available device types: " << availableTypes.size() << std::endl;
    for (auto* type : availableTypes)
    {
        type->scanForDevices();
        std::cerr << "[AudioEngine]   " << type->getTypeName().toStdString()
                  << " - inputs: " << type->getDeviceNames(true).size()
                  << ", outputs: " << type->getDeviceNames(false).size() << std::endl;
    }
}

AudioEngine::~AudioEngine()
{
    stopAudio();
    stopBacking();
}

// ── Device Enumeration ────────────────────────────────────────────────────────

juce::Array<AudioEngine::DeviceTypeInfo> AudioEngine::getDeviceTypes()
{
    juce::Array<DeviceTypeInfo> types;

    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        DeviceTypeInfo info;
        info.name = type->getTypeName();

        // Use already-scanned device names (scanForDevices was called during init)
        info.inputDevices = type->getDeviceNames(true);
        info.outputDevices = type->getDeviceNames(false);

        types.add(std::move(info));
    }

    return types;
}

juce::Array<double> AudioEngine::getSampleRates()
{
    juce::Array<double> rates;
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        for (auto rate : device->getAvailableSampleRates())
            rates.add(rate);
    }
    return rates;
}

juce::Array<int> AudioEngine::getBufferSizes()
{
    juce::Array<int> sizes;
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        for (auto size : device->getAvailableBufferSizes())
            sizes.add(size);
    }
    return sizes;
}

juce::String AudioEngine::getCurrentDeviceType()
{
    if (auto* type = deviceManager.getCurrentDeviceTypeObject())
        return type->getTypeName();
    return {};
}

juce::String AudioEngine::getCurrentInputDevice()
{
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        auto setup = deviceManager.getAudioDeviceSetup();
        return setup.inputDeviceName;
    }
    return {};
}

juce::String AudioEngine::getCurrentOutputDevice()
{
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        auto setup = deviceManager.getAudioDeviceSetup();
        return setup.outputDeviceName;
    }
    return {};
}

double AudioEngine::getLatencyMs() const
{
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        int latencySamples = device->getCurrentBufferSizeSamples()
                           + device->getInputLatencyInSamples()
                           + device->getOutputLatencyInSamples();
        return (latencySamples / currentSampleRate) * 1000.0;
    }
    return 0.0;
}

// ── Device Selection ──────────────────────────────────────────────────────────

bool AudioEngine::setDeviceType(const juce::String& typeName)
{
    for (auto* type : deviceManager.getAvailableDeviceTypes())
    {
        if (type->getTypeName() == typeName)
        {
            deviceManager.setCurrentAudioDeviceType(typeName, true);
            return true;
        }
    }
    return false;
}

bool AudioEngine::setAudioDevice(const juce::String& inputName, const juce::String& outputName,
                                  double sampleRate, int bufferSize)
{
    fprintf(stderr, "[AudioEngine] setAudioDevice: in='%s' out='%s' sr=%.0f bs=%d\n",
            inputName.toRawUTF8(), outputName.toRawUTF8(), sampleRate, bufferSize);

    bool wasRunning = audioRunning;
    if (wasRunning) stopAudio();

    // Initialize device manager if needed
    if (deviceManager.getCurrentAudioDevice() == nullptr)
    {
        // Try to find a working device type
        bool initialized = false;
        for (auto* type : deviceManager.getAvailableDeviceTypes())
        {
            auto typeName = type->getTypeName();
            // Prefer JACK on Linux, CoreAudio on Mac, ASIO on Windows
#if JUCE_LINUX
            if (typeName == "JACK" || typeName == "ALSA")
#elif JUCE_MAC
            if (typeName == "CoreAudio")
#elif JUCE_WINDOWS
            if (typeName == "ASIO" || typeName == "Windows Audio")
#else
            if (true)
#endif
            {
                deviceManager.setCurrentAudioDeviceType(typeName, true);
                auto result = deviceManager.initialiseWithDefaultDevices(2, 2);
                if (result.isEmpty())
                {
                    initialized = true;
                    break;
                }
            }
        }

        if (!initialized)
        {
            auto result = deviceManager.initialiseWithDefaultDevices(2, 2);
            if (result.isNotEmpty())
            {
                DBG("Audio init error: " + result);
                return false;
            }
        }
    }

    // Configure specific devices
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager.getAudioDeviceSetup(setup);

    if (inputName.isNotEmpty()) setup.inputDeviceName = inputName;
    if (outputName.isNotEmpty()) setup.outputDeviceName = outputName;
    if (sampleRate > 0) setup.sampleRate = sampleRate;
    if (bufferSize > 0) setup.bufferSize = bufferSize;
    setup.inputChannels.setRange(0, 2, true);   // stereo input
    setup.outputChannels.setRange(0, 2, true);  // stereo output
    setup.useDefaultInputChannels = inputName.isEmpty();
    setup.useDefaultOutputChannels = outputName.isEmpty();

    auto result = deviceManager.setAudioDeviceSetup(setup, true);
    if (result.isNotEmpty())
    {
        fprintf(stderr, "[AudioEngine] Device setup error: %s\n", result.toRawUTF8());
        return false;
    }

    fprintf(stderr, "[AudioEngine] Device configured OK. Current device: %s\n",
            deviceManager.getCurrentAudioDevice() ? deviceManager.getCurrentAudioDevice()->getName().toRawUTF8() : "none");

    if (wasRunning) startAudio();
    return true;
}

// ── Audio Control ─────────────────────────────────────────────────────────────

void AudioEngine::startAudio()
{
    if (audioRunning) { fprintf(stderr, "[AudioEngine] startAudio: already running\n"); return; }
    deviceManager.addAudioCallback(this);
    audioRunning = true;
    fprintf(stderr, "[AudioEngine] startAudio: callback added, running=%d, device=%s\n",
            audioRunning, deviceManager.getCurrentAudioDevice() ? deviceManager.getCurrentAudioDevice()->getName().toRawUTF8() : "none");
}

void AudioEngine::stopAudio()
{
    if (!audioRunning) return;
    deviceManager.removeAudioCallback(this);
    audioRunning = false;
}

// ── Backing Track ─────────────────────────────────────────────────────────────

bool AudioEngine::loadBackingTrack(const juce::File& file)
{
    const juce::ScopedLock sl(backingLock);
    stopBacking();
    backingTransport.reset();
    backingSource.reset();

    auto* reader = formatManager.createReaderFor(file);
    if (!reader) return false;

    backingSource = std::make_unique<juce::AudioFormatReaderSource>(reader, true);
    backingTransport = std::make_unique<juce::AudioTransportSource>();
    backingTransport->setSource(backingSource.get(), 0, nullptr, reader->sampleRate);
    backingTransport->prepareToPlay(currentBlockSize, currentSampleRate);
    return true;
}

void AudioEngine::setBackingPosition(double seconds)
{
    const juce::ScopedLock sl(backingLock);
    if (backingTransport) backingTransport->setPosition(seconds);
}

void AudioEngine::startBacking()
{
    const juce::ScopedLock sl(backingLock);
    if (backingTransport)
    {
        backingTransport->start();
        backingPlaying.store(true);
    }
}

void AudioEngine::stopBacking()
{
    const juce::ScopedLock sl(backingLock);
    if (backingTransport)
    {
        backingTransport->stop();
        backingPlaying.store(false);
    }
}

double AudioEngine::getBackingPosition() const
{
    if (backingTransport)
        return backingTransport->getCurrentPosition();
    return 0.0;
}

void AudioEngine::resetPeaks()
{
    inputPeak.store(0.0f);
    outputPeak.store(0.0f);
}

// ── Audio Callback ────────────────────────────────────────────────────────────

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    currentSampleRate = device->getCurrentSampleRate();
    currentBlockSize = device->getCurrentBufferSizeSamples();

    signalChain.prepare(currentSampleRate, currentBlockSize);
    pitchDetector.prepare(currentSampleRate, currentBlockSize);

    const juce::ScopedLock sl(backingLock);
    if (backingTransport)
        backingTransport->prepareToPlay(currentBlockSize, currentSampleRate);
}

void AudioEngine::audioDeviceStopped()
{
    signalChain.releaseResources();
}

void AudioEngine::audioDeviceIOCallbackWithContext(
    const float* const* inputData, int numInputChannels,
    float* const* outputData, int numOutputChannels,
    int numSamples, const juce::AudioIODeviceCallbackContext&)
{
    // Work directly in output buffer
    juce::AudioBuffer<float> buffer(outputData, numOutputChannels, numSamples);

    float inGain = inputGain.load();
    int selectedCh = selectedInputChannel.load();

    // Copy input with gain, handling channel selection
    if (numInputChannels >= 2 && selectedCh >= 0 && selectedCh < numInputChannels)
    {
        // Single channel mode (e.g., dry from Valeton GP-5 left channel)
        for (int outCh = 0; outCh < numOutputChannels; ++outCh)
            for (int i = 0; i < numSamples; ++i)
                buffer.setSample(outCh, i, inputData[selectedCh][i] * inGain);
    }
    else
    {
        // Normal stereo or mono mix
        for (int ch = 0; ch < juce::jmin(numInputChannels, numOutputChannels); ++ch)
            for (int i = 0; i < numSamples; ++i)
                buffer.setSample(ch, i, inputData[ch][i] * inGain);
    }

    // Zero extra output channels
    for (int ch = numInputChannels; ch < numOutputChannels; ++ch)
        buffer.clear(ch, 0, numSamples);

    // Metering: input level (pre-processing)
    {
        float peak = 0.0f;
        for (int ch = 0; ch < numOutputChannels; ++ch)
            peak = juce::jmax(peak, buffer.getMagnitude(ch, 0, numSamples));
        currentInputLevel.store(peak);
        float prevPeak = inputPeak.load();
        if (peak > prevPeak) inputPeak.store(peak);
    }

    // Feed pitch detector (before processing so we detect the dry guitar signal)
    if (numOutputChannels > 0)
        pitchDetector.pushSamples(buffer.getReadPointer(0), numSamples);

    // Process through signal chain (VSTs, NAM, IR)
    bool hasProcessors = signalChain.getNumSlots() > 0;
    juce::MidiBuffer midi;
    signalChain.process(buffer, midi);

    // Monitor mute: silence the guitar pass-through when no processors are loaded.
    // This prevents hearing raw/amp-processed input when the user hasn't set up a chain yet.
    // Backing track still plays through.
    if (monitorMuted.load() && !hasProcessors)
        buffer.clear();

    // Mix backing track
    {
        const juce::ScopedTryLock sl(backingLock);
        if (sl.isLocked() && backingTransport && backingPlaying.load())
        {
            backingBuffer.setSize(numOutputChannels, numSamples, false, false, true);
            backingBuffer.clear();
            juce::AudioSourceChannelInfo info(&backingBuffer, 0, numSamples);
            backingTransport->getNextAudioBlock(info);

            float bVol = backingVolume.load();
            for (int ch = 0; ch < numOutputChannels; ++ch)
                buffer.addFrom(ch, 0, backingBuffer,
                               juce::jmin(ch, backingBuffer.getNumChannels() - 1),
                               0, numSamples, bVol);
        }
    }

    // Apply output gain
    float outGain = outputGain.load();
    buffer.applyGain(outGain);

    // Metering: output level (post-processing)
    {
        float peak = 0.0f;
        for (int ch = 0; ch < numOutputChannels; ++ch)
            peak = juce::jmax(peak, buffer.getMagnitude(ch, 0, numSamples));
        currentOutputLevel.store(peak);
        float prevPeak = outputPeak.load();
        if (peak > prevPeak) outputPeak.store(peak);
    }
}
