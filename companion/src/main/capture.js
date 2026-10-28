// Capture-source plumbing. The engine renderer calls navigator.mediaDevices.getDisplayMedia();
// Electron routes that to setDisplayMediaRequestHandler, where we hand back exactly the source
// HostCore selected (Premiere's window by HWND, or a display) plus system audio loopback.
// No picker is shown and no other window can be captured.

export class CaptureSources {
  constructor({ desktopCapturer, screen, log }) {
    this.desktopCapturer = desktopCapturer;
    this.screen = screen;
    this.log = log;
    this.pending = null;
  }

  setPending(capture) {
    this.pending = capture;
  }

  install(session) {
    session.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const want = this.pending;
        if (!want) return callback({});
        const sources = await this.desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
        let src;
        if (want.mode === 'window') src = sources.find((s) => s.id.startsWith(`window:${want.hwnd}:`));
        else src = sources.find((s) => s.id.startsWith('screen:') && String(s.display_id) === String(want.displayId));
        if (!src) {
          this.log.warn('capture source not found', { mode: want.mode });
          return callback({});
        }
        return callback(request.audioRequested ? { video: src, audio: 'loopback' } : { video: src });
      } catch (e) {
        this.log.error('display media handler failed', { err: e.message });
        return callback({});
      }
    }, { useSystemPicker: false });
  }

  displays() {
    return this.screen.getAllDisplays().map((d) => this.describe(d));
  }

  describe(d) {
    const r = this.screen.dipToScreenRect(null, d.bounds);
    return { id: d.id, label: d.label || `Display ${d.id}`, physicalRect: { x: r.x, y: r.y, width: r.width, height: r.height }, scaleFactor: d.scaleFactor };
  }

  displayFor(id) {
    const all = this.screen.getAllDisplays();
    const d = all.find((x) => String(x.id) === String(id)) ?? this.screen.getPrimaryDisplay();
    return this.describe(d);
  }

  displayIdForPhysicalRect(rect) {
    const dip = this.screen.screenToDipPoint({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    return this.screen.getDisplayNearestPoint(dip).id;
  }
}
