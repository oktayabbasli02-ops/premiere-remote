// Editing command catalogue. Every command declares HOW it is implemented so the phone UI
// can show it honestly and the host never pretends a stub worked.
//
//   impl: 'api'         -> documented Premiere UXP DOM API (premierepro module, v25.6+ / verified against @adobe/premierepro 26.5.0 types)
//         'keyboard'    -> Windows SendInput of a user-configurable Premiere shortcut (profile key = shortcut)
//         'unsupported' -> no documented API and no default shortcut; button is hidden/disabled
//
//   destructive: true -> changes the project; never auto-retried after reconnect
//   verify: how the host confirms success ('api' result, 'trackItemCount' diff, or 'none' = reported as unverified)

export const Impl = Object.freeze({ API: 'api', KEYBOARD: 'keyboard', UNSUPPORTED: 'unsupported' });

export const COMMANDS = Object.freeze({
  // --- transport ---
  playPause: {
    impl: Impl.KEYBOARD, shortcut: 'playPause', destructive: false, verify: 'none', stage: 1,
    note: 'No documented Program Monitor play/pause API (SourceMonitor.play only targets the Source Monitor).',
  },
  stepFrames: {
    impl: Impl.API, destructive: false, verify: 'api', stage: 1,
    api: 'Sequence.getPlayerPosition + SequenceSettings.getVideoFrameRate + TickTime.createWithFrameAndFrameRate + Sequence.setPlayerPosition',
    args: { frames: 'integer, -600..600, non-zero' },
  },
  goToStart: { impl: Impl.API, destructive: false, verify: 'api', stage: 1, api: 'Sequence.getZeroPoint + setPlayerPosition' },
  goToEnd: { impl: Impl.API, destructive: false, verify: 'api', stage: 1, api: 'Sequence.getEndTime + setPlayerPosition' },

  // --- marking ---
  setIn: { impl: Impl.API, destructive: true, verify: 'api', stage: 2, api: 'Sequence.createSetInPointAction (transaction)' },
  setOut: { impl: Impl.API, destructive: true, verify: 'api', stage: 2, api: 'Sequence.createSetOutPointAction (transaction)' },
  addMarker: { impl: Impl.API, destructive: true, verify: 'api', stage: 2, api: 'Markers.getMarkers(sequence).createAddMarkerAction (transaction)' },

  // --- editing ---
  addEdit: {
    impl: Impl.KEYBOARD, shortcut: 'addEdit', requiresTimelineFocus: true, destructive: true, verify: 'trackItemCount', stage: 1,
    note: 'No razor/split API in the UXP DOM. Uses "Add Edit" shortcut; host verifies via clip-count diff from VideoTrack/AudioTrack.getTrackItems.',
  },
  selectClipAtPlayhead: {
    impl: Impl.KEYBOARD, shortcut: 'selectClipAtPlayhead', requiresTimelineFocus: true, destructive: false, verify: 'none', stage: 2,
  },
  deleteSelection: {
    impl: Impl.API, destructive: true, verify: 'api', stage: 2,
    api: 'Sequence.getSelection + SequenceEditor.createRemoveItemsAction(selection, ripple=false)',
    note: 'Lift: leaves a gap.',
  },
  rippleDeleteSelection: {
    impl: Impl.API, destructive: true, verify: 'api', stage: 2,
    api: 'Sequence.getSelection + SequenceEditor.createRemoveItemsAction(selection, ripple=true)',
    note: 'Closes the gap. Shown in a different colour and requires a confirm-hold on the phone.',
  },
  trimPrevToPlayhead: { impl: Impl.KEYBOARD, shortcut: 'rippleTrimPrevToPlayhead', requiresTimelineFocus: true, destructive: true, verify: 'none', stage: 2 },
  trimNextToPlayhead: { impl: Impl.KEYBOARD, shortcut: 'rippleTrimNextToPlayhead', requiresTimelineFocus: true, destructive: true, verify: 'none', stage: 2 },

  // --- view ---
  zoomIn: { impl: Impl.KEYBOARD, shortcut: 'zoomIn', requiresTimelineFocus: true, destructive: false, verify: 'none', stage: 2 },
  zoomOut: { impl: Impl.KEYBOARD, shortcut: 'zoomOut', requiresTimelineFocus: true, destructive: false, verify: 'none', stage: 2 },

  // --- history / file ---
  undo: {
    impl: Impl.KEYBOARD, shortcut: 'undo', destructive: true, verify: 'none', stage: 1,
    note: 'No documented undo API; executeTransaction only adds entries to the history.',
  },
  redo: { impl: Impl.KEYBOARD, shortcut: 'redo', destructive: true, verify: 'none', stage: 1 },
  save: { impl: Impl.API, destructive: false, verify: 'api', stage: 1, api: 'Project.save()' },

  // --- tracks ---
  trackMute: {
    impl: Impl.API, destructive: false, verify: 'api', stage: 2,
    api: 'AudioTrack.setMute / VideoTrack.setMute + isMuted',
    args: { kind: "'audio'|'video'", index: 'integer >= 0', mute: 'boolean' },
  },
  trackSolo: { impl: Impl.UNSUPPORTED, destructive: false, stage: 2, note: 'No solo API in the UXP DOM and no default Premiere shortcut.' },

  // --- info ---
  status: { impl: Impl.API, destructive: false, verify: 'api', stage: 1, api: 'Project.getActiveProject / getActiveSequence / getPlayerPosition' },
});

/**
 * Default shortcut profile = Premiere Pro factory defaults on Windows (US layout).
 * These are DATA, not code: users override them in %APPDATA%/PremiereRemote/shortcuts.json
 * or the companion UI. Key names follow keyboard.js VK table.
 */
export const DEFAULT_SHORTCUT_PROFILE = Object.freeze({
  id: 'premiere-default-win',
  name: 'Premiere Pro defaults (Windows)',
  shortcuts: {
    focusTimeline: 'Shift+3',
    playPause: 'Space',
    addEdit: 'Ctrl+K',
    selectClipAtPlayhead: 'D',
    rippleTrimPrevToPlayhead: 'Q',
    rippleTrimNextToPlayhead: 'W',
    zoomIn: '=',
    zoomOut: '-',
    undo: 'Ctrl+Z',
    redo: 'Ctrl+Shift+Z',
  },
});

export function validateCommandArgs(action, args = {}) {
  const def = COMMANDS[action];
  if (!def) return 'unknown action';
  if (action === 'stepFrames') {
    const f = args.frames;
    if (!Number.isInteger(f) || f === 0 || Math.abs(f) > 600) return 'frames must be a non-zero integer in -600..600';
  }
  if (action === 'trackMute') {
    if (args.kind !== 'audio' && args.kind !== 'video') return 'kind must be audio or video';
    if (!Number.isInteger(args.index) || args.index < 0 || args.index > 256) return 'index out of range';
    if (typeof args.mute !== 'boolean') return 'mute must be boolean';
  }
  return null;
}

/** Public, serialisable view of the catalogue sent to the phone after auth. */
export function capabilityList(profile = DEFAULT_SHORTCUT_PROFILE) {
  return Object.entries(COMMANDS).map(([action, d]) => ({
    action,
    impl: d.impl === Impl.KEYBOARD && !profile.shortcuts[d.shortcut] ? Impl.UNSUPPORTED : d.impl,
    destructive: !!d.destructive,
    verified: d.verify && d.verify !== 'none',
    shortcut: d.impl === Impl.KEYBOARD ? profile.shortcuts[d.shortcut] ?? null : null,
  }));
}
