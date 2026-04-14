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

        // Restore saved signal chain (VSTs, NAM models, IRs)
        const savedChain = JSON.parse(localStorage.getItem('slopsmith-signal-chain') || '[]');
        for (const item of savedChain) {
            try {
                if (item.type === 'VST' && item.path) {
                    await api.loadVST(item.path);
                } else if (item.type === 'NAM' && item.path) {
                    await api.loadNAMModel(item.path);
                } else if (item.type === 'IR' && item.path) {
                    await api.loadIR(item.path);
                }
            } catch (e) {
                console.error('[audio-engine] Failed to restore chain item:', item, e);
            }
        }
        if (savedChain.length > 0) await refreshChain();
    }

    function saveChainState() {
        api.getChainState().then(chain => {
            const typeMap = { 0: 'VST', 1: 'NAM', 2: 'IR' };
            const items = chain.filter(s => s.type === 0 || s.type === 1 || s.type === 2).map(s => ({
                type: typeMap[s.type] || 'VST',
                path: s.path || '',
                name: s.name || '',
            }));
            localStorage.setItem('slopsmith-signal-chain', JSON.stringify(items));
        }).catch(() => {});
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
                ${slot.hasEditor ? `<button class="text-xs px-2 py-1 rounded bg-blue-600/50 hover:bg-blue-500"
                        onclick="_aeOpenEditor(${slot.id})">Edit</button>` : ''}
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
        await api.closePluginEditor(slotId);
        await api.removeProcessor(slotId);
        await refreshChain();
    };

    window._aeOpenEditor = async (slotId) => {
        await api.openPluginEditor(slotId);
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
            // Stop audio first to release the device before reconfiguring
            if (audioRunning) {
                await api.stopAudio();
                audioRunning = false;
            }
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
                if (slotId >= 0) { await refreshChain(); saveChainState(); }
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
                if (slotId >= 0) { await refreshChain(); saveChainState(); }
            }
        });

        // Clear chain
        clearChainBtn.addEventListener('click', async () => {
            await api.clearChain();
            await refreshChain();
            saveChainState();
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

        // Save preset with name
        savePresetBtn.addEventListener('click', async () => {
            // Show inline name input
            const existing = $('ae-preset-name-input');
            if (existing) { existing.focus(); return; }
            const wrapper = document.createElement('div');
            wrapper.id = 'ae-preset-name-input';
            wrapper.className = 'flex gap-2 mt-2';
            wrapper.innerHTML = `
                <input type="text" placeholder="Preset name..." class="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200" autofocus>
                <button class="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-sm">Save</button>
                <button class="px-3 py-1.5 rounded bg-slate-600 hover:bg-slate-500 text-sm">Cancel</button>
            `;
            savePresetBtn.parentElement.after(wrapper);
            const input = wrapper.querySelector('input');
            const [saveBtn, cancelBtn] = wrapper.querySelectorAll('button');
            input.focus();

            const doSave = async () => {
                const name = input.value.trim();
                if (!name) return;
                const nativePreset = await api.savePreset();
                if (!nativePreset) return;
                const chain = await api.getChainState();
                const items = chain.map(s => ({
                    type: s.type === 0 ? 'VST' : s.type === 1 ? 'NAM' : 'IR',
                    path: s.path || '',
                    name: s.name || '',
                }));
                const presets = JSON.parse(localStorage.getItem('slopsmith-chain-presets') || '{}');
                presets[name] = { nativePreset, items, created: Date.now() };
                localStorage.setItem('slopsmith-chain-presets', JSON.stringify(presets));
                wrapper.remove();
                renderPresetList();
                renderToneMappingUI();
                // Refresh floating panel if open
                const floatPanel = document.getElementById('ae-tone-panel-float');
                if (floatPanel) { floatPanel.remove(); toggleTonePanel(); }
            };

            saveBtn.addEventListener('click', doSave);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
            cancelBtn.addEventListener('click', () => wrapper.remove());
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

    // ── Preset Management ──────────────────────────────────────────────────────
    function getPresets() {
        return JSON.parse(localStorage.getItem('slopsmith-chain-presets') || '{}');
    }

    function renderPresetList() {
        const container = $('ae-preset-list');
        if (!container) return;
        const presets = getPresets();
        const names = Object.keys(presets);
        if (names.length === 0) {
            container.innerHTML = '<div class="text-xs text-slate-500 italic">No saved presets</div>';
            return;
        }
        container.innerHTML = '';
        for (const name of names) {
            const div = document.createElement('div');
            div.className = 'flex items-center gap-2 p-2 rounded bg-slate-800/50 text-sm';
            div.innerHTML = `
                <span class="flex-1 text-slate-300">${name}</span>
                <span class="text-xs text-slate-500">${presets[name].items.length} processors</span>
                <button class="text-xs px-2 py-1 rounded bg-emerald-600/50 hover:bg-emerald-500" data-preset="${name}" data-action="load">Load</button>
                <button class="text-xs px-2 py-1 rounded bg-red-600/50 hover:bg-red-500" data-preset="${name}" data-action="delete">Del</button>
            `;
            div.querySelector('[data-action="load"]').addEventListener('click', async () => {
                const p = getPresets()[name];
                if (!p) return;
                const result = await api.loadPreset(p.nativePreset);
                console.log('[audio-engine] Preset loaded:', name, result);
                await refreshChain();
                saveChainState();
            });
            div.querySelector('[data-action="delete"]').addEventListener('click', () => {
                const ps = getPresets();
                delete ps[name];
                localStorage.setItem('slopsmith-chain-presets', JSON.stringify(ps));
                renderPresetList();
                renderToneMappingUI();
            });
            container.appendChild(div);
        }
    }

    // ── Tone Switching ───────────────────────────────────────────────────────────
    let toneSwitcher = null;
    let toneMonitorInterval = null;
    let autoSwitchEnabled = localStorage.getItem('slopsmith-tone-auto-switch') === 'true';

    class ToneSwitcher {
        constructor() {
            this.toneSlotMap = {};  // { toneName: [slotId, ...] }
            this.activeTone = null;
        }

        async preloadForSong(toneChanges, toneBase, mappings) {
            // Get unique tone names
            const toneNames = new Set([toneBase]);
            for (const tc of toneChanges) toneNames.add(tc.name);

            const presets = getPresets();
            this.toneSlotMap = {};
            this.activeTone = null;

            // Clear chain first
            await api.clearChain();

            for (const toneName of toneNames) {
                const presetName = mappings[toneName] || mappings['$default'];
                if (!presetName || !presets[presetName]) continue;

                const preset = presets[presetName];
                // Load each item individually and track slot IDs
                const slotIds = [];
                for (const item of preset.items) {
                    let slotId = -1;
                    if (item.type === 'NAM' && item.path) {
                        slotId = await api.loadNAMModel(item.path);
                    } else if (item.type === 'IR' && item.path) {
                        slotId = await api.loadIR(item.path);
                    } else if (item.type === 'VST' && item.path) {
                        slotId = await api.loadVST(item.path);
                    }
                    if (slotId >= 0) slotIds.push(slotId);
                }
                this.toneSlotMap[toneName] = slotIds;

                // Bypass everything except the initial tone
                if (toneName !== toneBase) {
                    const changes = slotIds.map(id => ({ slotId: id, bypassed: true }));
                    if (changes.length > 0) await api.setMultiBypass(changes);
                }
            }

            this.activeTone = toneBase;
            await refreshChain();
            console.log('[tone-switcher] Preloaded tones:', Object.keys(this.toneSlotMap));
        }

        switchToTone(toneName) {
            if (toneName === this.activeTone) return;
            if (!this.toneSlotMap[toneName]) return;

            const changes = [];
            // Bypass old tone
            if (this.activeTone && this.toneSlotMap[this.activeTone]) {
                for (const id of this.toneSlotMap[this.activeTone])
                    changes.push({ slotId: id, bypassed: true });
            }
            // Unbypass new tone
            for (const id of this.toneSlotMap[toneName])
                changes.push({ slotId: id, bypassed: false });

            if (changes.length > 0) api.setMultiBypass(changes);
            this.activeTone = toneName;
            console.log('[tone-switcher] Switched to:', toneName);
        }

        async teardown() {
            this.toneSlotMap = {};
            this.activeTone = null;
        }
    }

    function getToneMappings(songKey) {
        const all = JSON.parse(localStorage.getItem('slopsmith-tone-mappings') || '{"global":{},"songs":{}}');
        const songMappings = songKey ? (all.songs[songKey] || {}) : {};
        return { ...all.global, ...songMappings };
    }

    function saveToneMappings(songKey, mappings) {
        const all = JSON.parse(localStorage.getItem('slopsmith-tone-mappings') || '{"global":{},"songs":{}}');
        if (songKey) {
            all.songs[songKey] = mappings;
        } else {
            all.global = mappings;
        }
        localStorage.setItem('slopsmith-tone-mappings', JSON.stringify(all));
    }

    function getMidiPCConfig(songKey) {
        const all = JSON.parse(localStorage.getItem('slopsmith-tone-mappings') || '{}');
        return all.midiPC?.[songKey] || null;
    }

    function saveMidiPCConfig(songKey, config) {
        const all = JSON.parse(localStorage.getItem('slopsmith-tone-mappings') || '{}');
        if (!all.midiPC) all.midiPC = {};
        all.midiPC[songKey] = config;
        localStorage.setItem('slopsmith-tone-mappings', JSON.stringify(all));
    }

    function renderToneMappingUI() {
        const container = $('ae-tone-mappings');
        const section = $('ae-tone-switching');
        if (!container || !section) return;

        // Get tone data from highway
        const hw = window.highway || window._slopsmithHighway;
        if (!hw) { section.classList.add('hidden'); return; }

        const toneChanges = hw.getToneChanges ? hw.getToneChanges() : [];
        const toneBase = hw.getToneBase ? hw.getToneBase() : '';
        if (toneChanges.length === 0 && !toneBase) { section.classList.add('hidden'); return; }

        section.classList.remove('hidden');
        const toneNames = new Set([toneBase]);
        for (const tc of toneChanges) toneNames.add(tc.name);

        const presets = getPresets();
        const presetNames = Object.keys(presets);
        const songKey = window._currentSongFile || document.title || '';
        const mappings = getToneMappings(songKey);

        container.innerHTML = '';
        for (const tone of toneNames) {
            if (!tone) continue;
            const div = document.createElement('div');
            div.className = 'flex items-center gap-2 mb-1';
            div.innerHTML = `
                <span class="text-xs text-slate-400 w-24 truncate" title="${tone}">${tone}</span>
                <select class="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300" data-tone="${tone}">
                    <option value="">-- none --</option>
                    ${presetNames.map(p => `<option value="${p}" ${mappings[tone] === p ? 'selected' : ''}>${p}</option>`).join('')}
                </select>
            `;
            div.querySelector('select').addEventListener('change', (e) => {
                const m = getToneMappings(songKey);
                if (e.target.value) m[tone] = e.target.value;
                else delete m[tone];
                saveToneMappings(songKey, m);
            });
            container.appendChild(div);
        }
    }

    function startToneMonitor() {
        if (toneMonitorInterval) clearInterval(toneMonitorInterval);
        toneMonitorInterval = setInterval(() => {
            if (!toneSwitcher || !autoSwitchEnabled) return;
            const hw = window.highway || window._slopsmithHighway;
            if (!hw || !hw.getTime) return;
            const t = hw.getTime();
            const changes = hw.getToneChanges ? hw.getToneChanges() : [];
            const base = hw.getToneBase ? hw.getToneBase() : '';

            let activeTone = base;
            for (const tc of changes) {
                if (tc.t <= t) activeTone = tc.name;
                else break;
            }
            if (activeTone) toneSwitcher.switchToTone(activeTone);
        }, 50);
    }

    function stopToneMonitor() {
        if (toneMonitorInterval) { clearInterval(toneMonitorInterval); toneMonitorInterval = null; }
    }

    // ── Floating Tone Panel in Player ──────────────────────────────────────────
    function injectPlayerToneButton() {
        const controls = document.getElementById('player-controls');
        if (!controls || document.getElementById('btn-chain-switch')) return;

        // Add button before the close button
        const closeBtn = controls.querySelector('button[onclick*="showScreen"]');
        const btn = document.createElement('button');
        btn.id = 'btn-chain-switch';
        btn.className = 'px-3 py-1.5 bg-orange-900/40 hover:bg-orange-900/60 rounded-lg text-xs text-orange-300 transition';
        btn.textContent = 'Chain';
        btn.onclick = () => toggleTonePanel();
        if (closeBtn) controls.insertBefore(btn, closeBtn);
        else controls.appendChild(btn);
    }

    window._toggleChainPanel = toggleTonePanel;
    async function toggleTonePanel() {
        let panel = document.getElementById('ae-tone-panel-float');
        if (panel) { panel.remove(); return; }

        const player = document.getElementById('player');
        if (!player) return;

        // Show panel immediately with loading state
        panel = document.createElement('div');
        panel.id = 'ae-tone-panel-float';
        panel.style.cssText = 'position:absolute;bottom:60px;right:12px;z-index:100;width:320px;max-height:400px;overflow-y:auto;';
        panel.className = 'bg-slate-900 border border-slate-700 rounded-xl p-4 shadow-2xl';
        panel.innerHTML = `<div class="flex items-center justify-between mb-3">
            <span class="text-sm font-semibold text-slate-200">Tone Switching</span>
            <button onclick="document.getElementById('ae-tone-panel-float').remove()" class="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
        </div><div class="text-xs text-slate-400 animate-pulse">Loading...</div>`;
        player.style.position = 'relative';
        player.appendChild(panel);

        const hw = window.highway || window._slopsmithHighway;
        const toneChanges = hw?.getToneChanges ? hw.getToneChanges() : [];
        const toneBase = hw?.getToneBase ? hw.getToneBase() : '';
        const presets = getPresets();
        const presetNames = Object.keys(presets);
        const songKey = window._currentSongFile || document.title || '';
        const mappings = getToneMappings(songKey);
        const midiConfig = getMidiPCConfig(songKey);
        const isMidiMode = midiConfig?.mode === 'midi';

        const toneNames = new Set();
        if (toneBase) toneNames.add(toneBase);
        for (const tc of toneChanges) toneNames.add(tc.name);

        // Get VST slots for MIDI mode dropdown (this is the slow part)
        const apiLocal = window.slopsmithDesktop?.audio;
        let vstSlots = [];
        if (apiLocal) {
            try {
                const chain = await apiLocal.getChainState();
                vstSlots = chain.filter(s => s.type === 0);
            } catch(e) {}
        }

        // Check if panel was closed while loading
        if (!document.getElementById('ae-tone-panel-float')) return;

        let html = `<div class="flex items-center justify-between mb-3">
            <span class="text-sm font-semibold text-slate-200">Tone Switching</span>
            <button onclick="document.getElementById('ae-tone-panel-float').remove()" class="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
        </div>`;

        if (toneNames.size === 0) {
            html += '<div class="text-xs text-slate-500 italic">No tone changes in this song</div>';
        } else {
            // Mode selector
            html += `<div class="flex items-center gap-2 mb-3">
                <label class="text-xs text-slate-400">Mode:</label>
                <select id="ae-tone-mode" class="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300">
                    <option value="bypass" ${!isMidiMode ? 'selected' : ''}>Preset Switch</option>
                    <option value="midi" ${isMidiMode ? 'selected' : ''}>MIDI Program Change</option>
                </select>
            </div>`;

            // Bypass mode (existing)
            html += `<div id="ae-bypass-mode" class="${isMidiMode ? 'hidden' : ''}">`;
            html += '<div class="space-y-2 mb-3">';
            for (const tone of toneNames) {
                if (!tone) continue;
                html += `<div class="flex items-center gap-2">
                    <span class="text-xs text-slate-400 w-24 truncate" title="${tone}">${tone}</span>
                    <select class="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300" data-tone="${tone}">
                        <option value="">-- none --</option>
                        ${presetNames.map(p => `<option value="${p}" ${mappings[tone] === p ? 'selected' : ''}>${p}</option>`).join('')}
                    </select>
                </div>`;
            }
            html += '</div></div>';

            // MIDI PC mode (new)
            const midiMappings = midiConfig?.mappings || {};
            html += `<div id="ae-midi-mode" class="${!isMidiMode ? 'hidden' : ''}">`;
            if (vstSlots.length === 0) {
                html += '<div class="text-xs text-slate-500 italic mb-2">No VST plugins loaded. Load a VST first.</div>';
            } else {
                html += `<div class="space-y-2 mb-3">
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-400 w-20">VST:</span>
                        <select id="ae-midi-vst" class="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300">
                            ${vstSlots.map(s => `<option value="${s.id}" ${midiConfig?.vstSlotId === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-400 w-20">Channel:</span>
                        <input type="number" id="ae-midi-ch" min="1" max="16" value="${midiConfig?.channel || 1}" class="w-16 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300">
                    </div>
                </div>`;
                html += '<div class="space-y-1 mb-3">';
                for (const tone of toneNames) {
                    if (!tone) continue;
                    html += `<div class="flex items-center gap-2">
                        <span class="text-xs text-slate-400 w-24 truncate" title="${tone}">${tone}</span>
                        <input type="number" min="0" max="127" value="${midiMappings[tone] ?? ''}" placeholder="PC#"
                            data-midi-tone="${tone}" class="w-16 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300">
                    </div>`;
                }
                html += '</div>';
                html += `<button id="ae-midi-save" class="px-3 py-1.5 rounded bg-emerald-600/50 hover:bg-emerald-500 text-xs text-slate-200">Save MIDI Mapping</button>`;
            }
            html += '</div>';
        }

        html += `<label class="flex items-center gap-2 text-xs text-slate-400 cursor-pointer mb-2 mt-2">
            <input type="checkbox" class="accent-blue-500" id="ae-float-auto-switch" ${autoSwitchEnabled ? 'checked' : ''}>
            Auto-switch during playback
        </label>`;
        html += `<div class="text-xs text-slate-600" id="ae-active-tone"></div>`;

        panel.innerHTML = html;
        player.style.position = 'relative';
        player.appendChild(panel);

        // Wire up select changes
        panel.querySelectorAll('select[data-tone]').forEach(sel => {
            sel.addEventListener('change', (e) => {
                const m = getToneMappings(songKey);
                if (e.target.value) m[e.target.dataset.tone] = e.target.value;
                else delete m[e.target.dataset.tone];
                saveToneMappings(songKey, m);
            });
        });

        // Wire mode toggle
        const modeSelect = panel.querySelector('#ae-tone-mode');
        if (modeSelect) {
            modeSelect.addEventListener('change', () => {
                const bypassDiv = panel.querySelector('#ae-bypass-mode');
                const midiDiv = panel.querySelector('#ae-midi-mode');
                if (modeSelect.value === 'midi') {
                    bypassDiv?.classList.add('hidden');
                    midiDiv?.classList.remove('hidden');
                } else {
                    bypassDiv?.classList.remove('hidden');
                    midiDiv?.classList.add('hidden');
                    // Clear MIDI config when switching to bypass mode
                    saveMidiPCConfig(songKey, null);
                }
            });
        }

        // Wire MIDI save button
        const midiSaveBtn = panel.querySelector('#ae-midi-save');
        if (midiSaveBtn) {
            midiSaveBtn.addEventListener('click', () => {
                const vstSelect = panel.querySelector('#ae-midi-vst');
                const chInput = panel.querySelector('#ae-midi-ch');
                const midiInputs = panel.querySelectorAll('[data-midi-tone]');
                const mappingsObj = {};
                midiInputs.forEach(inp => {
                    if (inp.value !== '') mappingsObj[inp.dataset.midiTone] = parseInt(inp.value);
                });
                saveMidiPCConfig(songKey, {
                    mode: 'midi',
                    vstSlotId: vstSelect ? parseInt(vstSelect.value) : -1,
                    channel: chInput ? parseInt(chInput.value) : 1,
                    mappings: mappingsObj,
                });
                // Apply MIDI mode immediately
                window._preloadedSongKey = null;
                const _liveApi = window.slopsmithDesktop?.audio;
                const _midiMappings = mappingsObj;
                const _midiVstSlot = vstSelect ? parseInt(vstSelect.value) : -1;
                const _midiCh = chInput ? parseInt(chInput.value) : 1;
                window._toneSwitcher = {
                    activeTone: null,
                    midiMode: true,
                    switchToTone(name) {
                        if (name === this.activeTone) return;
                        const program = _midiMappings[name];
                        if (program !== undefined && _liveApi?.sendMidiToSlot) {
                            _liveApi.sendMidiToSlot(_midiVstSlot, 0, _midiCh, program);
                            console.log('[tone-switcher] MIDI PC:', name, '-> program', program);
                        }
                        this.activeTone = name;
                    }
                };
                console.log('[tone-switcher] Saved & activated MIDI config:', mappingsObj);
                midiSaveBtn.textContent = 'Saved!';
                setTimeout(() => { midiSaveBtn.textContent = 'Save MIDI Mapping'; }, 1500);
            });
        }

        // Wire auto-switch checkbox
        const cb = panel.querySelector('#ae-float-auto-switch');
        if (cb) cb.addEventListener('change', () => {
            autoSwitchEnabled = cb.checked;
            localStorage.setItem('slopsmith-tone-auto-switch', String(autoSwitchEnabled));
            const settingsCb = $('ae-auto-switch');
            if (settingsCb) settingsCb.checked = autoSwitchEnabled;
            if (!autoSwitchEnabled) stopToneMonitor();
        });

        // Show active tone indicator
        if (toneMonitorInterval) {
            const updateActive = setInterval(() => {
                const el = document.getElementById('ae-active-tone');
                if (!el) { clearInterval(updateActive); return; }
                if (toneSwitcher?.activeTone) el.textContent = 'Active: ' + toneSwitcher.activeTone;
            }, 200);
        }
    }

    // Hook playSong for tone switching setup
    const _origPlaySong = window.playSong;
    if (_origPlaySong) {
        window.playSong = async function(filename, arrangement) {
            stopToneMonitor();
            await _origPlaySong(filename, arrangement);
            // Inject tones button into player controls
            setTimeout(() => injectPlayerToneButton(), 500);
            // Wait a moment for tone data to arrive via WebSocket
            setTimeout(() => {
                renderToneMappingUI();
                if (autoSwitchEnabled) {
                    // Skip inner IIFE preload if MIDI mode is active (outer IIFE handles it)
                    const songKey = window._currentSongFile || document.title || '';
                    const allData = JSON.parse(localStorage.getItem('slopsmith-tone-mappings') || '{}');
                    const midiCfg = allData.midiPC?.[songKey];
                    if (midiCfg?.mode === 'midi') {
                        console.log('[tone-switcher] MIDI mode active, skipping bypass preload');
                    } else {
                        const hw = window.highway || window._slopsmithHighway;
                        if (!hw) return;
                        const toneChanges = hw.getToneChanges ? hw.getToneChanges() : [];
                        const toneBase = hw.getToneBase ? hw.getToneBase() : '';
                        if (toneChanges.length > 0) {
                            const mappings = getToneMappings(songKey);
                            if (Object.keys(mappings).length > 0) {
                                toneSwitcher = new ToneSwitcher();
                                window._toneSwitcher = toneSwitcher;
                                toneSwitcher.preloadForSong(toneChanges, toneBase, mappings)
                                    .then(() => startToneMonitor())
                                    .catch(e => console.error('[tone-switcher] Preload error:', e));
                            }
                        }
                    }
                }
            }, 2000);
        };
    }

    // Auto-switch toggle
    const autoSwitchEl = $('ae-auto-switch');
    if (autoSwitchEl) {
        autoSwitchEl.checked = autoSwitchEnabled;
        autoSwitchEl.addEventListener('change', () => {
            autoSwitchEnabled = autoSwitchEl.checked;
            localStorage.setItem('slopsmith-tone-auto-switch', String(autoSwitchEnabled));
            if (!autoSwitchEnabled) stopToneMonitor();
        });
    }

    // ── Start ─────────────────────────────────────────────────────────────────
    init().then(() => renderPresetList()).catch(e => console.error('[audio-engine] init error:', e));
})();

// ── Chain button + tone auto-switch (runs outside IIFE so it works without audio API) ──
(function() {
    const origPS = window.playSong;
    if (!origPS) return;

    let _toneMonitor = null;
    let _lastTone = null;
    let _preloadedSongKey = null;

    function showToneToast(name) {
        let toast = document.getElementById('tone-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'tone-toast';
            toast.style.cssText = 'position:fixed;top:60px;right:20px;z-index:9999;padding:8px 16px;border-radius:8px;background:rgba(234,88,12,0.9);color:white;font-size:13px;font-weight:600;pointer-events:none;transition:opacity 0.5s;opacity:0;';
            document.body.appendChild(toast);
        }
        toast.textContent = 'Tone: ' + name;
        toast.style.opacity = '1';
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
    }

    function startToneAutoSwitch() {
        if (_toneMonitor) clearInterval(_toneMonitor);
        _lastTone = null;

        _toneMonitor = setInterval(() => {
            const hw = window.highway;
            if (!hw || !hw.getTime) return;

            const autoOn = localStorage.getItem('slopsmith-tone-auto-switch') === 'true';
            if (!autoOn) return;

            const t = hw.getTime();
            const changes = hw.getToneChanges ? hw.getToneChanges() : [];
            const base = hw.getToneBase ? hw.getToneBase() : '';
            if (changes.length === 0) return;

            let activeTone = base;
            for (const tc of changes) {
                if (tc.t <= t) activeTone = tc.name;
                else break;
            }

            if (activeTone && activeTone !== _lastTone) {
                _lastTone = activeTone;
                showToneToast(activeTone);

                // Trigger preset switch if ToneSwitcher is available
                if (window._toneSwitcher) {
                    window._toneSwitcher.switchToTone(activeTone);
                } else {
                    console.log('[tone-switcher] WARNING: _toneSwitcher is null at switch time');
                }
            }
        }, 50);
    }

    window.playSong = async function(filename, arrangement) {
        if (_toneMonitor) { clearInterval(_toneMonitor); _toneMonitor = null; }
        _lastTone = null;
        window._currentSongFile = decodeURIComponent(filename);
        // Reset preload tracking for new song
        if (_preloadedSongKey && _preloadedSongKey !== window._currentSongFile) {
            _preloadedSongKey = null;
            window._toneSwitcher = null;
        }

        await origPS(filename, arrangement);

        // Inject Chain button
        setTimeout(() => {
            const controls = document.getElementById('player-controls');
            if (!controls || document.getElementById('btn-chain-switch')) return;
            const closeBtn = controls.querySelector('button[onclick*="showScreen"]');
            const btn = document.createElement('button');
            btn.id = 'btn-chain-switch';
            btn.className = 'px-3 py-1.5 bg-orange-900/40 hover:bg-orange-900/60 rounded-lg text-xs text-orange-300 transition';
            btn.textContent = 'Chain';
            btn.onclick = () => window._toggleChainPanel && window._toggleChainPanel();
            if (closeBtn) controls.insertBefore(btn, closeBtn);
            else controls.appendChild(btn);
        }, 500);

        // Start tone monitoring and preload presets after WebSocket delivers tone data
        setTimeout(async () => {
            startToneAutoSwitch();

            // Preload presets for tone switching
            const autoOn = localStorage.getItem('slopsmith-tone-auto-switch') === 'true';
            const api = window.slopsmithDesktop?.audio;
            const hw = window.highway;
            if (!autoOn || !api || !hw) return;

            const toneChanges = hw.getToneChanges ? hw.getToneChanges() : [];
            const toneBase = hw.getToneBase ? hw.getToneBase() : '';
            if (toneChanges.length === 0) return;

            const songKey = window._currentSongFile || document.title || '';

            // Check for MIDI PC mode
            const allMappingsData = JSON.parse(localStorage.getItem('slopsmith-tone-mappings') || '{}');
            const midiConfig = allMappingsData.midiPC?.[songKey];
            const wantsMidi = midiConfig?.mode === 'midi';

            // Check if MIDI config was just saved (clears window._preloadedSongKey)
            if (window._preloadedSongKey === null) _preloadedSongKey = null;

            // Skip if already preloaded for this song with the same mode
            if (_preloadedSongKey === songKey && window._toneSwitcher) {
                const currentIsMidi = !!window._toneSwitcher.midiMode;
                if (currentIsMidi === wantsMidi) {
                    window._toneSwitcher.switchToTone(toneBase);
                    return;
                }
                // Mode changed — reset and re-preload
                _preloadedSongKey = null;
                window._toneSwitcher = null;
            }

            console.log('[tone-switcher] Mode:', wantsMidi ? 'MIDI' : 'bypass', 'config:', JSON.stringify(midiConfig));

            if (midiConfig?.mode === 'midi' && midiConfig.vstSlotId >= 0) {
                // MIDI PC mode — send program changes to a single VST
                const midiMappings = midiConfig.mappings || {};
                window._toneSwitcher = {
                    activeTone: null,
                    midiMode: true,
                    switchToTone(name) {
                        console.log('[tone-switcher] switchToTone called:', name, 'current:', this.activeTone, 'midiMode:', this.midiMode);
                        if (name === this.activeTone) return;
                        const program = midiMappings[name];
                        const _api = window.slopsmithDesktop?.audio;
                        console.log('[tone-switcher] program:', program, 'api:', !!_api, 'sendMidi:', !!_api?.sendMidiToSlot, 'slotId:', midiConfig.vstSlotId);
                        if (program !== undefined && _api?.sendMidiToSlot) {
                            _api.sendMidiToSlot(midiConfig.vstSlotId, 0, midiConfig.channel || 1, program);
                            console.log('[tone-switcher] MIDI PC SENT:', name, '-> program', program);
                        }
                        this.activeTone = name;
                    }
                };
                // Send initial PC for base tone
                const _apiInit = window.slopsmithDesktop?.audio;
                if (midiMappings[toneBase] !== undefined && _apiInit?.sendMidiToSlot) {
                    _apiInit.sendMidiToSlot(midiConfig.vstSlotId, 0, midiConfig.channel || 1, midiMappings[toneBase]);
                }
                _preloadedSongKey = songKey;
                console.log('[tone-switcher] MIDI PC mode for:', Object.keys(midiMappings));
            } else {
                // Bypass-toggle mode — preload all presets
                const mappings = { ...(allMappingsData.global || {}), ...(allMappingsData.songs?.[songKey] || {}) };
                if (Object.keys(mappings).length === 0) return;

                const presets = JSON.parse(localStorage.getItem('slopsmith-chain-presets') || '{}');
                const toneNames = new Set([toneBase]);
                for (const tc of toneChanges) toneNames.add(tc.name);

                await api.clearChain();
                window._toneSwitcher = null;
                const toneSlotMap = {};

                for (const toneName of toneNames) {
                    const presetName = mappings[toneName] || mappings['$default'];
                    if (!presetName || !presets[presetName]) continue;
                    const slotIds = [];
                    for (const item of presets[presetName].items) {
                        let slotId = -1;
                        if (item.type === 'NAM' && item.path) slotId = await api.loadNAMModel(item.path);
                        else if (item.type === 'IR' && item.path) slotId = await api.loadIR(item.path);
                        else if (item.type === 'VST' && item.path) slotId = await api.loadVST(item.path);
                        if (slotId >= 0) slotIds.push(slotId);
                    }
                    toneSlotMap[toneName] = slotIds;
                    if (toneName !== toneBase && slotIds.length > 0) {
                        await api.setMultiBypass(slotIds.map(id => ({ slotId: id, bypassed: true })));
                    }
                }

                window._toneSwitcher = {
                    activeTone: toneBase,
                    toneSlotMap,
                    switchToTone(name) {
                        if (name === this.activeTone || !this.toneSlotMap[name]) return;
                        const changes = [];
                        if (this.activeTone && this.toneSlotMap[this.activeTone]) {
                            for (const id of this.toneSlotMap[this.activeTone]) changes.push({ slotId: id, bypassed: true });
                        }
                        for (const id of this.toneSlotMap[name]) changes.push({ slotId: id, bypassed: false });
                        if (changes.length > 0) api.setMultiBypass(changes);
                        this.activeTone = name;
                        console.log('[tone-switcher] Switched to:', name);
                    }
                };
                _preloadedSongKey = songKey;
                console.log('[tone-switcher] Bypass mode preloaded:', Object.keys(toneSlotMap));
            }
        }, 3000);
    };
})();
