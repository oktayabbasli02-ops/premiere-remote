// Executes catalogue commands through the documented Premiere API (via the UXP panel) or, where no
// API exists, through the user's shortcut profile with focus verification. Results are honest:
// "verified" is only true when the effect was observed.

import { COMMANDS, Impl, validateCommandArgs } from '@premiere-remote/shared/commands';
import { AckStatus, ErrorCode } from '@premiere-remote/shared/protocol';

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export class CommandExecutor {
  /**
   * @param {{desktop:any, plugin:any, getProfile:() => {shortcuts:Record<string,string>}, sleep?:(ms:number)=>Promise<void>}} deps
   */
  constructor(deps) {
    this.desktop = deps.desktop;
    this.plugin = deps.plugin;
    this.getProfile = deps.getProfile;
    this.sleep = deps.sleep ?? sleepDefault;
  }

  /**
   * @param {string} action
   * @param {object} args
   * @param {{expect?:{sequenceGuid?:string}}} ctx
   * @returns {Promise<{status:string, via?:string, verified?:boolean, data?:any, note?:string, error?:{code:string,message:string}}>}
   */
  async execute(action, args = {}, ctx = {}) {
    const def = COMMANDS[action];
    const bad = validateCommandArgs(action, args);
    if (bad) return { status: AckStatus.ERROR, error: { code: ErrorCode.BAD_REQUEST, message: bad } };
    if (def.impl === Impl.UNSUPPORTED) return { status: AckStatus.UNSUPPORTED, error: { code: 'unsupported', message: def.note ?? 'Not supported' } };

    try {
      if (def.impl === Impl.API) {
        const data = await this.plugin.request(action, { ...args, expect: ctx.expect ?? null });
        return { status: AckStatus.OK, via: Impl.API, verified: true, data };
      }
      return await this.viaKeyboard(action, def, ctx);
    } catch (e) {
      return { status: AckStatus.ERROR, via: def.impl, error: { code: e.code ?? ErrorCode.INTERNAL, message: e.message, details: e.details } };
    }
  }

  async viaKeyboard(action, def, ctx) {
    const profile = this.getProfile();
    const combo = profile.shortcuts[def.shortcut];
    if (!combo) {
      return { status: AckStatus.UNSUPPORTED, error: { code: ErrorCode.SHORTCUT_NOT_CONFIGURED, message: `No shortcut configured for "${def.shortcut}" in profile "${profile.name ?? profile.id}"` } };
    }

    const pluginUp = this.plugin.connected;
    // Project/sequence guard for destructive keyboard commands (API commands check inside the panel).
    if (def.destructive && pluginUp && ctx.expect?.sequenceGuid) {
      const st = await this.plugin.request('status', {});
      if (!st.sequence) throw Object.assign(new Error('No active sequence in Premiere.'), { code: ErrorCode.NO_SEQUENCE });
      if (st.sequence.guid !== ctx.expect.sequenceGuid) {
        throw Object.assign(new Error(`Active sequence changed to "${st.sequence.name}". Refresh and retry deliberately.`), { code: 'sequence_changed' });
      }
    }

    let before = null;
    if (def.verify === 'trackItemCount' && pluginUp) before = await this.plugin.request('countTrackItems', {});
    let playingBefore = null;
    if (action === 'playPause' && pluginUp) playingBefore = await this.samplePlaying();

    await this.desktop.ensurePremiereFocused();
    if (def.requiresTimelineFocus) {
      const focusCombo = profile.shortcuts.focusTimeline;
      if (focusCombo) {
        await this.desktop.sendCombo(focusCombo);
        await this.sleep(80);
      }
    }
    await this.desktop.sendCombo(combo);

    if (def.verify === 'trackItemCount') {
      if (before === null) return { status: AckStatus.OK, via: Impl.KEYBOARD, verified: false, note: 'Shortcut sent; panel not connected so the result could not be verified.' };
      // Premiere applies the edit asynchronously; poll briefly
      for (let i = 0; i < 6; i++) {
        await this.sleep(100);
        const after = await this.plugin.request('countTrackItems', {});
        if (after.total > before.total) return { status: AckStatus.OK, via: Impl.KEYBOARD, verified: true, data: { clipsBefore: before.total, clipsAfter: after.total } };
      }
      return {
        status: AckStatus.ERROR,
        via: Impl.KEYBOARD,
        error: { code: 'no_effect', message: 'Shortcut was sent but no clip was split. Is the playhead over a clip on a targeted track?' },
      };
    }

    if (action === 'playPause' && playingBefore !== null) {
      const playingAfter = await this.samplePlaying();
      if (playingAfter === playingBefore) {
        return { status: AckStatus.OK, via: Impl.KEYBOARD, verified: false, data: { playing: playingAfter }, note: 'Shortcut sent but playback state did not visibly change.' };
      }
      return { status: AckStatus.OK, via: Impl.KEYBOARD, verified: true, data: { playing: playingAfter } };
    }

    return { status: AckStatus.OK, via: Impl.KEYBOARD, verified: false, note: 'Shortcut sent to Premiere; this action cannot be verified through the API.' };
  }

  /** Playback detection: the playhead moves between two samples ~150 ms apart. */
  async samplePlaying() {
    try {
      const a = await this.plugin.request('playerPosition', {});
      await this.sleep(150);
      const b = await this.plugin.request('playerPosition', {});
      return a.ticks !== b.ticks;
    } catch {
      return null;
    }
  }
}
