// Slopsmith Audio Engine Plugin — Frontend
// Communicates with the JUCE audio engine via window.slopsmithDesktop.audio
// Desktop audio engine plugin

(function() {
    'use strict';

    const api = window.slopsmithDesktop?.audio;
    if (!api) {
        console.error('[audio-engine] Desktop audio API not available — running in browser mode');
        const panel = document.getElementById('audio-engine-panel');
        if (panel) panel.innerHTML = '<div class="p-8 text-center text-slate-400">Audio engine is only available in the Slopsmith Desktop app.</div>';
        return;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let audioRunning = false;
    let meterAnimFrame = null;
    let knownPlugins = [];
    let currentDeviceTypes = [];

    // ── Elements ──────────────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    const statusDot = $('ae-status-dot');
    const statusText = $('ae-status-text');
    const latencyEl = $('ae-latency');
    const toggleBtn = $('ae-toggle');
    const deviceTypeSelect = $('ae-device-type');
    const inputDeviceSelect = $('ae-input-device');
    const outputDeviceSelect = $('ae-output-device');
    const sampleRateSelect = $('ae-sample-rate');
    const bufferSizeSelect = $('ae-buffer-size');
    const inputChannelSelect = $('ae-input-channel');
    const applyDeviceBtn = $('ae-apply-device');
    const meterInput = $('ae-meter-input');
    const meterOutput = $('ae-meter-output');
    const inputGainSlider = $('ae-input-gain');
    const outputGainSlider = $('ae-output-gain');
    const inputGainLabel = $('ae-input-gain-label');
    const outputGainLabel = $('ae-output-gain-label');
    const monitorMuteCheckbox = $('ae-monitor-mute');
    const chainContainer = $('ae-chain');
    const addVstBtn = $('ae-add-vst');
    const addNamBtn = $('ae-add-nam');
    const addIrBtn = $('ae-add-ir');
    const clearChainBtn = $('ae-clear-chain');
    const vstBrowser = $('ae-vst-browser');
    const scanVstsBtn = $('ae-scan-vsts');
    const vstSearch = $('ae-vst-search');
    const vstList = $('ae-vst-list');
    const pitchNote = $('ae-pitch-note');
    const pitchFreq = $('ae-pitch-freq');
    const pitchCentsBar = $('ae-pitch-cents');
    const savePresetBtn = $('ae-save-preset');

    // ── Persistence ─────────────────────────────────────────────────────────
    function saveDeviceSettings() {
        localStorage.setItem('slopsmith-audio-device', JSON.stringify({
            type: deviceTypeSelect.value,
            input: inputDeviceSelect.value,
            output: outputDeviceSelect.value,
            sampleRate: sampleRateSelect.value,
            bufferSize: bufferSizeSelect.value,
            inputChannel: inputChannelSelect.value,
            monitorMute: monitorMuteCheckbox.checked,
        }));
    }

    function loadDeviceSettings() {
        try {
            const raw = localStorage.getItem('slopsmith-audio-device');
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    async function init() {
        const available = await api.isAvailable();
        if (!available) {
            statusText.textContent = 'Audio engine not loaded (build with npm run build:audio)';
            return;
        }

        statusDot.className = 'w-3 h-3 rounded-full bg-yellow-500';
        statusText.textContent = 'Audio engine ready — not started';
        toggleBtn.disabled = false;

        await loadDeviceTypes();
        await refreshChain();
        api.loadPluginList();
        setupEvents();
        startMetering();

        // Restore saved device settings and auto-start
        const saved = loadDeviceSettings();
        if (saved) {
            if (saved.type && deviceTypeSelect.querySelector(`option[value="${saved.type}"]`)) {
                deviceTypeSelect.value = saved.type;
                const typeInfo = currentDeviceTypes.find(t => t.name === saved.type);
                if (typeInfo) updateDeviceDropdowns(typeInfo);
            }
            if (saved.input) inputDeviceSelect.value = saved.input;
            if (saved.output) outputDeviceSelect.value = saved.output;
            if (saved.sampleRate) sampleRateSelect.value = saved.sampleRate;
            if (saved.bufferSize) bufferSizeSelect.value = saved.bufferSize;
            if (saved.inputChannel) inputChannelSelect.value = saved.inputChannel;
            if (saved.monitorMute !== undefined) monitorMuteCheckbox.checked = saved.monitorMute;

            // Auto-apply and start
            await api.setDeviceType(saved.type);
            const ok = await api.setDevice(
                saved.input || '', saved.output || '',
                parseFloat(saved.sampleRate || '48000'),
                parseInt(saved.bufferSize || '256')
            );
            if (ok) {
                if (saved.inputChannel) api.setInputChannel(parseInt(saved.inputChannel));
                if (saved.monitorMute !== undefined) api.setMonitorMute(saved.monitorMute);
                await api.startAudio();
                audioRunning = true;
                toggleBtn.textContent = 'Stop';
                statusDot.className = 'w-3 h-3 rounded-full bg-emerald-500';
                statusText.textContent = 'Audio running';
            }
        }
    }

    // ── Device Types ──────────────────────────────────────────────────────────
    async function loadDeviceTypes() {
        currentDeviceTypes = await api.getDeviceTypes();
        deviceTypeSelect.innerHTML = '';

        for (const type of currentDeviceTypes) {
            const opt = document.createElement('option');
            opt.value = type.name;
            opt.textContent = type.name;
            deviceTypeSelect.appendChild(opt);
        }

        if (currentDeviceTypes.length > 0) {
            updateDeviceDropdowns(currentDeviceTypes[0]);
        }

        // Load current device info
        const current = await api.getCurrentDevice();
        if (current && current.type) {
            deviceTypeSelect.value = current.type;
            const typeInfo = currentDeviceTypes.find(t => t.name === current.type);
            if (typeInfo) updateDeviceDropdowns(typeInfo);
            if (current.input) inputDeviceSelect.value = current.input;
            if (current.output) outputDeviceSelect.value = current.output;
        }
    }

    function updateDeviceDropdowns(typeInfo) {
        inputDeviceSelect.innerHTML = '<option value="">Default</option>';
        for (const name of typeInfo.inputs) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            inputDeviceSelect.appendChild(opt);
        }

        outputDeviceSelect.innerHTML = '<option value="">Default</option>';
        for (const name of typeInfo.outputs) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            outputDeviceSelect.appendChild(opt);
        }
    }

    // ── Signal Chain ──────────────────────────────────────────────────────────
    async function refreshChain() {
        const chain = await api.getChainState();
        chainContainer.innerHTML = '';

        if (chain.length === 0) {
            chainContainer.innerHTML = '<div class="text-sm text-slate-500 italic">No processors loaded — add a VST, NAM model, or cabinet IR</div>';
            return;
        }

        const typeNames = { 0: 'VST', 1: 'NAM', 2: 'IR' };
        const typeColors = { 0: 'purple', 1: 'orange', 2: 'cyan' };

        for (const slot of chain) {
            const color = typeColors[slot.type] || 'slate';
            const div = document.createElement('div');
            div.className = `flex items-center gap-3 p-3 rounded bg-slate-800/50 border border-${color}-500/30`;
            div.innerHTML = `
                <span class="text-xs font-medium px-2 py-0.5 rounded bg-${color}-500/20 text-${color}-400">
                    ${typeNames[slot.type] || '?'}
                </span>
                <span class="flex-1 text-sm ${slot.bypassed ? 'line-through text-slate-500' : 'text-slate-200'}">${slot.name}</span>
                <button class="text-xs px-2 py-1 rounded ${slot.bypassed ? 'bg-yellow-600' : 'bg-slate-600'} hover:opacity-80"
                        onclick="_aeToggleBypass(${slot.id}, ${!slot.bypassed})">
                    ${slot.bypassed ? 'Enable' : 'Bypass'}
                </button>
                <button class="text-xs px-2 py-1 rounded bg-red-600/50 hover:bg-red-500"
                        onclick="_aeRemoveSlot(${slot.id})">Remove</button>
            `;
            chainContainer.appendChild(div);
        }
    }

    // Global functions for inline onclick handlers
    window._aeToggleBypass = async (slotId, bypassed) => {
        await api.setBypass(slotId, bypassed);
        await refreshChain();
    };

    window._aeRemoveSlot = async (slotId) => {
        await api.removeProcessor(slotId);
        await refreshChain();
    };

    // ── VST Browser ───────────────────────────────────────────────────────────
    function renderVSTList(filter = '') {
        vstList.innerHTML = '';
        const filtered = filter
            ? knownPlugins.filter(p => (p.name + p.manufacturer + p.category).toLowerCase().includes(filter.toLowerCase()))
            : knownPlugins;

        if (filtered.length === 0) {
            vstList.innerHTML = '<div class="text-sm text-slate-500 italic">No plugins found</div>';
            return;
        }

        for (const plugin of filtered) {
            const div = document.createElement('div');
            div.className = 'flex items-center gap-3 p-2 rounded hover:bg-slate-700/50 cursor-pointer';
            div.innerHTML = `
                <div class="flex-1">
                    <div class="text-sm text-slate-200">${plugin.name}</div>
                    <div class="text-xs text-slate-400">${plugin.manufacturer} · ${plugin.format}</div>
                </div>
            `;
            div.addEventListener('click', async () => {
                const slotId = await api.loadVST(plugin.path);
                if (slotId >= 0) {
                    vstBrowser.classList.add('hidden');
                    await refreshChain();
                }
            });
            vstList.appendChild(div);
        }
    }

    // ── Metering ──────────────────────────────────────────────────────────────
    let meterPollInterval = null;

    function startMetering() {
        // Use setInterval at ~30fps instead of rAF to avoid overwhelming IPC
        if (meterPollInterval) clearInterval(meterPollInterval);

        meterPollInterval = setInterval(async () => {
            if (!audioRunning) {
                meterInput.style.width = '0%';
                meterOutput.style.width = '0%';
                return;
            }

            try {
                const levels = await api.getLevels();
                // Convert linear amplitude to dB-like scale for better visibility
                // Maps 0.001 (-60dB) to 0%, 1.0 (0dB) to 100%
                const toMeterPct = (v) => Math.max(0, Math.min(100, (1 + Math.log10(Math.max(v, 0.001)) / 3) * 100));
                const inPct = toMeterPct(levels.inputLevel);
                const outPct = toMeterPct(levels.outputLevel);
                meterInput.style.width = inPct + '%';
                meterOutput.style.width = outPct + '%';

                // Clipping indicator
                meterInput.className = levels.inputLevel > 0.95
                    ? 'h-full bg-red-500 transition-all duration-75'
                    : 'h-full bg-emerald-500 transition-all duration-75';

                // Pitch detection
                const pitch = await api.getPitchDetection();
                if (pitch.midiNote >= 0) {
                    pitchNote.textContent = pitch.noteName;
                    pitchFreq.textContent = pitch.frequency.toFixed(1) + ' Hz';
                    const pos = 50 + (pitch.cents / 50) * 50;
                    pitchCentsBar.style.left = Math.max(0, Math.min(100, pos)) + '%';
                    pitchCentsBar.className = Math.abs(pitch.cents) < 10
                        ? 'absolute top-1 bottom-1 w-2 bg-emerald-400 rounded transition-all duration-75'
                        : 'absolute top-1 bottom-1 w-2 bg-yellow-400 rounded transition-all duration-75';
                } else {
                    pitchNote.textContent = '--';
                    pitchFreq.textContent = '-- Hz';
                }
            } catch (e) { /* ignore polling errors */ }
        }, 33); // ~30fps

        // Latency: poll less frequently
        setInterval(async () => {
            if (!audioRunning) return;
            try {
                const device = await api.getCurrentDevice();
                if (device?.latencyMs) latencyEl.textContent = device.latencyMs.toFixed(1) + 'ms';
            } catch (e) { /* ignore */ }
        }, 1000);
    }

    // ── Events ────────────────────────────────────────────────────────────────
    function setupEvents() {
        // Start/Stop audio
        toggleBtn.addEventListener('click', async () => {
            if (audioRunning) {
                await api.stopAudio();
                audioRunning = false;
                toggleBtn.textContent = 'Start';
                statusDot.className = 'w-3 h-3 rounded-full bg-yellow-500';
                statusText.textContent = 'Audio stopped';
            } else {
                await api.startAudio();
                audioRunning = true;
                toggleBtn.textContent = 'Stop';
                statusDot.className = 'w-3 h-3 rounded-full bg-emerald-500';
                statusText.textContent = 'Audio running';
            }
        });

        // Device type change
        deviceTypeSelect.addEventListener('change', () => {
            const typeInfo = currentDeviceTypes.find(t => t.name === deviceTypeSelect.value);
            if (typeInfo) updateDeviceDropdowns(typeInfo);
        });

        // Apply device settings and start audio
        applyDeviceBtn.addEventListener('click', async () => {
            statusText.textContent = 'Configuring device...';
            const typeName = deviceTypeSelect.value;
            await api.setDeviceType(typeName);
            const ok = await api.setDevice(
                inputDeviceSelect.value,
                outputDeviceSelect.value,
                parseFloat(sampleRateSelect.value),
                parseInt(bufferSizeSelect.value)
            );
            if (ok) {
                await api.startAudio();
                audioRunning = true;
                toggleBtn.textContent = 'Stop';
                statusDot.className = 'w-3 h-3 rounded-full bg-emerald-500';
                statusText.textContent = 'Audio running';
                saveDeviceSettings();
            } else {
                statusText.textContent = 'Failed to configure device';
                statusDot.className = 'w-3 h-3 rounded-full bg-red-500';
            }
        });

        // Input channel
        inputChannelSelect.addEventListener('change', () => {
            api.setInputChannel(parseInt(inputChannelSelect.value));
        });

        // Monitor mute
        monitorMuteCheckbox.addEventListener('change', () => {
            api.setMonitorMute(monitorMuteCheckbox.checked);
        });

        // Gain sliders
        inputGainSlider.addEventListener('input', () => {
            const val = parseFloat(inputGainSlider.value);
            api.setGain('input', val);
            inputGainLabel.textContent = val.toFixed(1) + 'x';
        });

        outputGainSlider.addEventListener('input', () => {
            const val = parseFloat(outputGainSlider.value);
            api.setGain('output', val);
            outputGainLabel.textContent = val.toFixed(1) + 'x';
        });

        // Add VST
        addVstBtn.addEventListener('click', () => {
            vstBrowser.classList.toggle('hidden');
            if (!vstBrowser.classList.contains('hidden') && knownPlugins.length > 0) {
                renderVSTList();
            }
        });

        // Add NAM model
        addNamBtn.addEventListener('click', async () => {
            const filePath = await window.slopsmithDesktop.pickFile([
                { name: 'NAM Models', extensions: ['nam'] }
            ]);
            if (filePath) {
                const slotId = await api.loadNAMModel(filePath);
                if (slotId >= 0) await refreshChain();
            }
        });

        // Add IR
        addIrBtn.addEventListener('click', async () => {
            console.error('[audio-engine] IR button clicked, opening picker...');
            const filePath = await window.slopsmithDesktop.pickFile([
                { name: 'Impulse Responses', extensions: ['wav', 'aif', 'ir'] },
                { name: 'All Files', extensions: ['*'] }
            ]);
            console.error('[audio-engine] IR picker returned:', filePath);
            if (filePath) {
                const slotId = await api.loadIR(filePath);
                console.error('[audio-engine] loadIR returned slotId:', slotId);
                if (slotId >= 0) await refreshChain();
            }
        });

        // Clear chain
        clearChainBtn.addEventListener('click', async () => {
            await api.clearChain();
            await refreshChain();
        });

        // Scan VSTs
        scanVstsBtn.addEventListener('click', async () => {
            scanVstsBtn.disabled = true;
            scanVstsBtn.textContent = 'Scanning...';
            try {
                knownPlugins = await api.scanPlugins();
                await api.savePluginList();
                renderVSTList();
                scanVstsBtn.textContent = `Scan (${knownPlugins.length} found)`;
            } catch (e) {
                scanVstsBtn.textContent = 'Scan Failed';
            }
            scanVstsBtn.disabled = false;
        });

        // VST search
        vstSearch.addEventListener('input', () => {
            renderVSTList(vstSearch.value);
        });

        // Save preset
        savePresetBtn.addEventListener('click', async () => {
            const preset = await api.savePreset();
            if (preset) {
                console.log('[audio-engine] Preset saved:', preset);
            }
        });

        // Sync offset (in settings panel — innerHTML doesn't run scripts, so we bind here)
        const syncSlider = document.getElementById('ae-sync-offset');
        const syncLabel = document.getElementById('ae-sync-offset-label');
        if (syncSlider && syncLabel) {
            const saved = localStorage.getItem('slopsmith-sync-offset');
            if (saved !== null) {
                syncSlider.value = parseFloat(saved);
                window._slopsmithSyncOffset = parseFloat(saved);
                syncLabel.textContent = Math.round(parseFloat(saved) * 1000) + 'ms';
            }
            syncSlider.addEventListener('input', () => {
                const val = parseFloat(syncSlider.value);
                window._slopsmithSyncOffset = val;
                syncLabel.textContent = Math.round(val * 1000) + 'ms';
                localStorage.setItem('slopsmith-sync-offset', String(val));
            });
        }
    }

    // ── Settings path pickers ──────────────────────────────────────────────────
    function setupPathPickers() {
        const pickers = [
            { btn: 'ae-pick-dlc', input: 'ae-dlc-path', key: 'dlcDir' },
            { btn: 'ae-pick-nam', input: 'ae-nam-path', key: 'namDir' },
            { btn: 'ae-pick-ir', input: 'ae-ir-path', key: 'irDir' },
        ];
        for (const { btn, input, key } of pickers) {
            const btnEl = $(btn);
            const inputEl = $(input);
            if (!btnEl || !inputEl) continue;

            // Load saved value
            const saved = localStorage.getItem('slopsmith-' + key);
            if (saved) inputEl.value = saved;

            btnEl.addEventListener('click', async () => {
                const dir = await window.slopsmithDesktop.pickDirectory();
                if (dir) {
                    inputEl.value = dir;
                    localStorage.setItem('slopsmith-' + key, dir);
                    // If it's the DLC dir, also update the server
                    if (key === 'dlcDir') {
                        await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ dlc_dir: dir }),
                        });
                    }
                }
            });
        }
    }
    setupPathPickers();

    // ── Start ─────────────────────────────────────────────────────────────────
    init().catch(e => console.error('[audio-engine] init error:', e));
})();
