#include "VSTHost.h"

VSTHost::VSTHost()
{
    formatManager.addFormat(std::make_unique<juce::VST3PluginFormat>());

#if JUCE_PLUGINHOST_AU
    formatManager.addFormat(std::make_unique<juce::AudioUnitPluginFormat>());
#endif

#if JUCE_PLUGINHOST_LV2
    formatManager.addFormat(std::make_unique<juce::LV2PluginFormat>());
#endif
}

VSTHost::~VSTHost()
{
    cancelScan();
}

// ── Scanning ──────────────────────────────────────────────────────────────────

juce::StringArray VSTHost::getDefaultScanDirectories()
{
    juce::StringArray dirs;

#if JUCE_LINUX
    dirs.add(juce::File::getSpecialLocation(juce::File::userHomeDirectory)
             .getChildFile(".vst3").getFullPathName());
    dirs.add("/usr/lib/vst3");
    dirs.add("/usr/local/lib/vst3");
    // LV2
    dirs.add(juce::File::getSpecialLocation(juce::File::userHomeDirectory)
             .getChildFile(".lv2").getFullPathName());
    dirs.add("/usr/lib/lv2");
    dirs.add("/usr/local/lib/lv2");
#elif JUCE_MAC
    dirs.add(juce::File::getSpecialLocation(juce::File::userHomeDirectory)
             .getChildFile("Library/Audio/Plug-Ins/VST3").getFullPathName());
    dirs.add("/Library/Audio/Plug-Ins/VST3");
    dirs.add(juce::File::getSpecialLocation(juce::File::userHomeDirectory)
             .getChildFile("Library/Audio/Plug-Ins/Components").getFullPathName());
    dirs.add("/Library/Audio/Plug-Ins/Components");
#elif JUCE_WINDOWS
    dirs.add("C:\\Program Files\\Common Files\\VST3");
    dirs.add("C:\\Program Files (x86)\\Common Files\\VST3");
    auto localAppData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
    dirs.add(localAppData.getChildFile("VST3").getFullPathName());
#endif

    return dirs;
}

void VSTHost::scanDefaultDirectories(ScanProgressCallback callback)
{
    scanDirectories(getDefaultScanDirectories(), std::move(callback));
}

void VSTHost::scanDirectories(const juce::StringArray& directories, ScanProgressCallback callback)
{
    if (scanning.load()) return;

    scanning.store(true);
    scanCancelled.store(false);

    // Collect all plugin files first
    juce::StringArray filesToScan;
    for (auto& dir : directories)
    {
        juce::File d(dir);
        if (!d.isDirectory()) continue;

        // VST3
        for (auto& f : d.findChildFiles(juce::File::findFilesAndDirectories, true, "*.vst3"))
            filesToScan.addIfNotAlreadyThere(f.getFullPathName());

        // AU (macOS bundles)
#if JUCE_MAC
        for (auto& f : d.findChildFiles(juce::File::findFilesAndDirectories, true, "*.component"))
            filesToScan.addIfNotAlreadyThere(f.getFullPathName());
#endif

        // LV2
#if JUCE_PLUGINHOST_LV2
        for (auto& f : d.findChildFiles(juce::File::findDirectories, true, "*.lv2"))
            filesToScan.addIfNotAlreadyThere(f.getFullPathName());
#endif
    }

    int totalFiles = filesToScan.size();
    int scannedCount = 0;

    for (auto& file : filesToScan)
    {
        if (scanCancelled.load()) break;

        juce::String pluginName = juce::File(file).getFileNameWithoutExtension();

        for (auto* format : formatManager.getFormats())
        {
            if (scanCancelled.load()) break;

            juce::OwnedArray<juce::PluginDescription> found;
            {
                const juce::ScopedLock sl(listLock);
                knownPlugins.scanAndAddFile(file, true, found, *format);
            }

            for (auto* desc : found)
                pluginName = desc->name;
        }

        scannedCount++;
        float progress = totalFiles > 0 ? (float)scannedCount / (float)totalFiles : 1.0f;
        if (callback) callback(progress, pluginName);
    }

    scanning.store(false);
}

// ── Plugin Access ─────────────────────────────────────────────────────────────

juce::Array<VSTHost::PluginInfo> VSTHost::getKnownPlugins() const
{
    juce::Array<PluginInfo> result;
    const juce::ScopedLock sl(listLock);

    for (auto& desc : knownPlugins.getTypes())
    {
        PluginInfo info;
        info.name = desc.name;
        info.manufacturer = desc.manufacturerName;
        info.category = desc.category;
        info.formatName = desc.pluginFormatName;
        info.fileOrIdentifier = desc.fileOrIdentifier;
        info.uid = desc.createIdentifierString();
        info.isInstrument = desc.isInstrument;
        result.add(info);
    }

    return result;
}

std::unique_ptr<juce::AudioPluginInstance> VSTHost::loadPlugin(
    const juce::String& fileOrIdentifier,
    double sampleRate, int blockSize,
    juce::String& errorMessage)
{
    // Find matching description
    juce::PluginDescription matchedDesc;
    bool found = false;

    {
        const juce::ScopedLock sl(listLock);
        for (auto& desc : knownPlugins.getTypes())
        {
            if (desc.fileOrIdentifier == fileOrIdentifier ||
                desc.createIdentifierString() == fileOrIdentifier)
            {
                matchedDesc = desc;
                found = true;
                break;
            }
        }
    }

    if (!found)
    {
        // Try scanning the file directly if not in known list
        juce::OwnedArray<juce::PluginDescription> descs;
        for (auto* format : formatManager.getFormats())
        {
            const juce::ScopedLock sl(listLock);
            knownPlugins.scanAndAddFile(fileOrIdentifier, true, descs, *format);
        }

        if (descs.isEmpty())
        {
            errorMessage = "Plugin not found: " + fileOrIdentifier;
            return nullptr;
        }

        matchedDesc = *descs[0];
    }

    // Create instance synchronously
    juce::String error;
    auto instance = formatManager.createPluginInstance(
        matchedDesc, sampleRate, blockSize, error);

    if (!instance)
    {
        errorMessage = error.isNotEmpty() ? error : "Failed to create plugin instance";
        return nullptr;
    }

    return instance;
}

// ── Persistence ───────────────────────────────────────────────────────────────

void VSTHost::savePluginList(const juce::File& xmlFile)
{
    const juce::ScopedLock sl(listLock);
    if (auto xml = knownPlugins.createXml())
        xml->writeTo(xmlFile);
}

void VSTHost::loadPluginList(const juce::File& xmlFile)
{
    if (!xmlFile.existsAsFile()) return;

    if (auto xml = juce::XmlDocument::parse(xmlFile))
    {
        const juce::ScopedLock sl(listLock);
        knownPlugins.recreateFromXml(*xml);
    }
}
