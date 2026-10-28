import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default async function hostLifecycle(pi) {
  const directory = process.env.OMP_TELEGRAM_SESSION_DIR;
  if (!directory) return;
  let server;
  let socketPath;
  let timer;
  let descriptor;
  let commandTail;
  let findScopedSettings;
  let settingsError;
  let getActiveSkills;
  let skillsError;
  try {
    ({ getActiveSkills } = await import('@oh-my-pi/pi-coding-agent/extensibility/skills'));
  } catch (error) {
    skillsError = error;
  }
  // Native module exports depend on the installed OMP host and can be absent on older hosts.
  try {
    ({ findScopedSettings } = await import('@oh-my-pi/pi-coding-agent/config/settings'));
  } catch (error) {
    settingsError = error;
  }
  pi.on('session_start', async (_event, context) => {
    if (context.agent.kind !== 'main' || server) return;
    const settings = findScopedSettings?.(context.cwd);
    const sessionId = context.sessionManager.getSessionId();
    const startupPreset = process.env.OMP_TELEGRAM_DEFAULT_PRESET;
    let startupReady;
    if (startupPreset) {
      const publish = result => {
        const filename = join(directory, 'startup-preset.json');
        const temporary = `${filename}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify({ sessionId, pid: process.pid, preset: startupPreset, ...result }), { mode: 0o600 });
        renameSync(temporary, filename);
      };
      try {
        if (settingsError) throw settingsError;
        if (!settings) throw new Error('OMP host scoped settings are unavailable for the forum default model preset');
        const [presets, resolver, modelSettings, sessionSettings] = await Promise.all([
          import('@oh-my-pi/pi-coding-agent/config/model-presets'),
          import('@oh-my-pi/pi-coding-agent/config/model-resolver'),
          import('@oh-my-pi/pi-coding-agent/config/model-settings'),
          import('@oh-my-pi/pi-coding-agent/session/settings'),
        ]);
        const lookup = presets.getModelPreset(settings, startupPreset);
        if (lookup.kind !== 'found') throw new Error(presets.formatModelPresetSwitch(startupPreset, lookup));
        const preset = lookup.preset;
        modelSettings.cfgModelRoles.override(settings, Object.fromEntries([
          ...Object.keys(modelSettings.cfgModelRoles.get(settings)).map(role => [role, null]),
          ...Object.entries(preset.modelRoles),
        ]));
        if (preset.defaultThinkingLevel !== undefined) {
          sessionSettings.cfgDefaultThinkingLevel.override(settings, preset.defaultThinkingLevel);
        }
        const overlayFile = join(directory, 'runtime.yml');
        const overlay = JSON.parse(readFileSync(overlayFile, 'utf8'));
        delete overlay.modelRoles;
        delete overlay.defaultThinkingLevel;
        const temporaryOverlay = `${overlayFile}.${process.pid}.tmp`;
        writeFileSync(temporaryOverlay, JSON.stringify(overlay), { mode: 0o600 });
        renameSync(temporaryOverlay, overlayFile);
        await settings.reloadForCwd(context.cwd);
        const enabled = modelSettings.cfgEnabledModels.get(settings);
        const candidates = enabled?.length
          ? resolver.filterAvailableModelsByEnabledPatterns(context.models.list(), enabled, settings)
          : context.models.list();
        const selector = settings.getModelRole('default');
        const resolved = selector
          ? resolver.resolveModelRoleValue(selector, candidates, { settings })
          : { model: resolver.pickDefaultAvailableModel(
              candidates.filter(model => context.modelRegistry.hasConfiguredAuth(model)),
              provider => context.modelRegistry.hasConcreteAuth(provider),
            ) };
        if (!resolved.model) {
          const reason = selector ? `default model \`${selector}\` is not available` : 'no model with configured credentials is available';
          throw new Error(presets.formatModelPresetSwitch(startupPreset, { kind: 'unavailable', reason }));
        }
        if (!await pi.setModel(resolved.model)) throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
        pi.setThinkingLevel(resolved.explicitThinkingLevel
          ? resolved.thinkingLevel
          : sessionSettings.cfgDefaultThinkingLevel.get(settings));
        startupReady = () => publish({ ready: true });
      } catch (error) {
        publish({ error: error instanceof Error ? error.message : String(error) });
        context.shutdown();
        return;
      }
    }
    const assertAvailable = request => {
      if (request.sessionId !== sessionId || context.sessionManager.getSessionId() !== sessionId) {
        throw new Error('OMP session identity changed during model preset control');
      }
      if (descriptor?.retiring) throw new Error('OMP host is retiring');
      if (Date.now() >= request.deadline) throw new Error('OMP model preset request expired before execution');
    };
    const runPresets = async request => {
      assertAvailable(request);
      if (settingsError) throw settingsError;
      if (!settings) throw new Error('OMP host scoped settings are unavailable; restart this managed host');
      const presets = await import('@oh-my-pi/pi-coding-agent/config/model-presets');
      if (request.name === undefined) {
        assertAvailable(request);
        const names = presets.getModelPresetNames(settings);
        return names.length > 0 ? `Model presets: ${names.join(', ')}` : 'No model presets saved. Use /modelpreset save <name> to create one.';
      }
      if (!context.isIdle() || context.hasPendingMessages()) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching model presets');
      const [resolver, modelSettings, cli, sessionSettings] = await Promise.all([
        import('@oh-my-pi/pi-coding-agent/config/model-resolver'),
        import('@oh-my-pi/pi-coding-agent/config/model-settings'),
        import('@oh-my-pi/pi-coding-agent/cli/args'),
        import('@oh-my-pi/pi-coding-agent/session/settings'),
      ]);
      const patterns = cli.parseArgs(process.argv.slice(2)).models ?? modelSettings.cfgEnabledModels.get(settings);
      const scopedModels = patterns?.length
        ? await resolver.resolveModelScope(patterns, context.modelRegistry, resolver.getModelMatchPreferences(settings), settings)
        : [];
      const lookup = presets.getModelPreset(settings, request.name);
      if (lookup.kind !== 'found') return presets.formatModelPresetSwitch(request.name, lookup);
      const preset = lookup.preset;
      const modelRoles = Object.fromEntries([
        ...Object.keys(modelSettings.cfgModelRoles.get(settings)).map(role => [role, null]),
        ...Object.entries(preset.modelRoles),
      ]);
      const nextThinking = preset.defaultThinkingLevel ?? sessionSettings.cfgDefaultThinkingLevel.get(settings);
      const candidateSettings = settings.overlay({ modelRoles, defaultThinkingLevel: nextThinking });
      const enabled = modelSettings.cfgEnabledModels.get(candidateSettings);
      const available = enabled?.length
        ? resolver.filterAvailableModelsByEnabledPatterns(context.models.list(), enabled, candidateSettings)
        : context.models.list();
      const candidates = scopedModels.length ? scopedModels.map(entry => entry.model) : available;
      const selector = candidateSettings.getModelRole('default');
      const resolved = selector
        ? resolver.resolveModelRoleValue(selector, candidates, { settings: candidateSettings })
        : { model: resolver.pickDefaultAvailableModel(
            candidates.filter(model => context.modelRegistry.hasConfiguredAuth(model)),
            provider => context.modelRegistry.hasConcreteAuth(provider),
          ) };
      if (!resolved.model) {
        const reason = selector ? `default model \`${selector}\` is not available` : 'no model with configured credentials is available';
        return presets.formatModelPresetSwitch(request.name, { kind: 'unavailable', reason });
      }
      if (!context.modelRegistry.hasConfiguredAuth(resolved.model)) {
        return presets.formatModelPresetSwitch(request.name, { kind: 'unavailable', reason: `no credentials for ${resolved.model.provider}/${resolved.model.id}` });
      }
      assertAvailable(request);
      if (!context.isIdle() || context.hasPendingMessages()) throw new Error('OMP host is busy; wait for the current turn and queued messages to finish before switching model presets');
      const previousOverrides = settings.overlayLayers().overrides;
      const level = resolved.explicitThinkingLevel ? resolved.thinkingLevel : nextThinking;
      let switched = false;
      try {
        modelSettings.cfgModelRoles.override(settings, modelRoles);
        sessionSettings.cfgDefaultThinkingLevel.override(settings, nextThinking);
        if (!await pi.setModel(resolved.model)) throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
        pi.setThinkingLevel(level);
        switched = true;
        return presets.formatModelPresetSwitch(request.name, {
          kind: 'switched', model: resolved.model, thinkingLevel: level, shadowed: [], shadowedThinking: undefined,
        });
      } catch (error) {
        return presets.formatModelPresetSwitch(request.name, {
          kind: 'failed', reason: error instanceof Error ? error.message : String(error), shadowed: [],
        });
      } finally {
        if (!switched) {
          modelSettings.cfgModelRoles.override(settings, previousOverrides.modelRoles);
          sessionSettings.cfgDefaultThinkingLevel.override(settings, previousOverrides.defaultThinkingLevel);
        }
      }
    };
    socketPath = join(tmpdir(), `omp-tg-${randomBytes(12).toString('hex')}.sock`);
    server = createServer(socket => {
      socket.setEncoding('utf8');
      const timeout = setTimeout(() => socket.destroy(), 2000);
      socket.once('close', () => clearTimeout(timeout));
      let input = '';
      let received = false;
      socket.on('data', part => {
        if (received) return;
        if (Buffer.byteLength(input) + Buffer.byteLength(part) > 16384) { socket.destroy(); return; }
        input += part;
        if (!input.includes('\n')) return;
        received = true;
        if (input.trim() !== 'retire') {
          let request;
          const respond = result => {
            if (socket.destroyed) return;
            const response = JSON.stringify({ requestId: request?.requestId, sessionId, pid: process.pid, ...result });
            socket.end(Buffer.byteLength(response) <= 262143 ? `${response}\n` : `${JSON.stringify({ requestId: request?.requestId, sessionId, pid: process.pid, error: 'OMP model preset response is too large' })}\n`);
          };
          try {
            request = JSON.parse(input.trim());
            if (!request || !['model_presets', 'list_skills'].includes(request.type) || typeof request.requestId !== 'string' ||
                request.requestId.length > 128 || typeof request.sessionId !== 'string' ||
                (request.name !== undefined && typeof request.name !== 'string') ||
                !Number.isSafeInteger(request.deadline) || request.deadline > Date.now() + 15000) {
              throw new Error('Invalid OMP model preset request');
            }
            assertAvailable(request);
          } catch (error) {
            respond({ error: error instanceof Error ? error.message : String(error) });
            return;
          }
          clearTimeout(timeout);
          const commandTimeout = setTimeout(() => socket.destroy(), Math.max(1, request.deadline - Date.now()));
          socket.once('close', () => clearTimeout(commandTimeout));
          const operation = (commandTail ?? Promise.resolve()).then(() => {
            if (socket.destroyed) throw new Error('OMP model preset request disconnected before execution');
            if (request.type === 'list_skills') {
              assertAvailable(request);
              if (skillsError) throw skillsError;
              if (typeof getActiveSkills !== 'function') throw new Error('OMP host skill discovery is unavailable');
              return JSON.stringify(getActiveSkills().map(skill => ({ name: skill.name, description: skill.description ?? '' })));
            }
            return runPresets(request);
          });
          commandTail = operation.then(() => {}, () => {});
          void operation.then(text => respond({ text }), error => respond({ error: error instanceof Error ? error.message : String(error) }));
          return;
        }
        descriptor.retiring = true;
        writeFileSync(join(directory, 'lifecycle.json'), JSON.stringify(descriptor), { mode: 0o600 });
        socket.end('requested\n');
        if (!timer) {
          timer = context.setInterval(() => context.shutdown(), 1000);
          context.shutdown();
        }
      });
      socket.on('error', () => {});
    });
    server.on('error', () => {});
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      descriptor = {
        pid: process.pid,
        supervisorPid: Number(process.env.OMP_TELEGRAM_SUPERVISOR_PID),
        sessionId: context.sessionManager.getSessionId(),
        socketPath,
        modelPresets: 2,
        skills: true,
      };
      writeFileSync(join(directory, 'lifecycle.json'), JSON.stringify(descriptor), { mode: 0o600 });
      startupReady?.();
    });
  });
  pi.on('session_shutdown', () => {
    if (!server) return;
    server.close();
    for (const filename of [socketPath, join(directory, 'lifecycle.json')]) {
      if (!filename) continue;
      try { unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  });
}
