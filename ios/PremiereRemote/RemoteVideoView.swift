import UIKit
import SwiftUI
import WebRTC

/// Letterboxed WebRTC video with pinch-zoom/pan and touch → remote input.
/// A full-size "canvas" (anchor 0,0) holds the video at its fit rect; the canvas transform is
/// translate(pan)·scale, i.e. screen = base * scale + pan — the transform CoordinateMapper inverts.
///   Touch:    tap = click · long-press = right-click · drag = mouse drag · two fingers = zoom/pan view
///   Trackpad: drag = relative cursor · tap = click · two-finger tap = right-click ·
///             two-finger drag = scroll · long-press then drag = drag · pinch = zoom view
final class RemoteVideoUIView: UIView, RTCVideoViewDelegate, UIGestureRecognizerDelegate {
    let video = RTCMTLVideoView(frame: .zero)
    private let canvas = UIView()
    private var view = ViewState(viewW: 1, viewH: 1, frameW: 16, frameH: 9)

    var trackpad = false
    var controlEnabled = false
    var onMove: ((CGPoint) -> Void)?
    var onRel: ((CGFloat, CGFloat) -> Void)?
    var onPointer: ((String, CGPoint?, String, Int) -> Void)?

    private var dragging = false
    private var scrollAcc: CGFloat = 0
    private var lastPan: CGPoint = .zero
    private var lastTwo: CGPoint = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
        canvas.layer.anchorPoint = .zero
        addSubview(canvas)
        video.videoContentMode = .scaleAspectFit
        video.delegate = self
        canvas.addSubview(video)

        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
        let twoTap = UITapGestureRecognizer(target: self, action: #selector(onTwoTap(_:)))
        twoTap.numberOfTouchesRequired = 2
        let long = UILongPressGestureRecognizer(target: self, action: #selector(onLong(_:)))
        long.minimumPressDuration = 0.5
        let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
        pan.maximumNumberOfTouches = 1
        let twoPan = UIPanGestureRecognizer(target: self, action: #selector(onTwoPan(_:)))
        twoPan.minimumNumberOfTouches = 2
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
        for g in [tap, twoTap, long, pan, twoPan, pinch] as [UIGestureRecognizer] { g.delegate = self; addGestureRecognizer(g) }
        tap.require(toFail: twoTap)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // pinch + two-finger pan together = zoom about the fingers while panning
        (g is UIPinchGestureRecognizer && other is UIPanGestureRecognizer) || (g is UIPanGestureRecognizer && other is UIPinchGestureRecognizer)
            || (g is UILongPressGestureRecognizer && other is UIPanGestureRecognizer) || (g is UIPanGestureRecognizer && other is UILongPressGestureRecognizer)
    }

    func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
        DispatchQueue.main.async {
            self.view.frameW = size.width
            self.view.frameH = size.height
            self.relayout()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        relayout() // rotation: normalized coordinates are unaffected; only the fit rect changes
    }

    private func relayout() {
        view.viewW = bounds.width
        view.viewH = bounds.height
        view = CoordinateMapper.clampPan(view)
        canvas.bounds = CGRect(origin: .zero, size: bounds.size)
        if let base = CoordinateMapper.fitRect(viewW: view.viewW, viewH: view.viewH, frameW: view.frameW, frameH: view.frameH) {
            video.frame = base
        }
        apply()
    }

    private func apply() {
        canvas.transform = .identity
        canvas.layer.position = .zero
        canvas.transform = CGAffineTransform(translationX: view.panX, y: view.panY).scaledBy(x: view.scale, y: view.scale)
    }

    func resetZoom() {
        view.scale = 1; view.panX = 0; view.panY = 0
        view = CoordinateMapper.clampPan(view)
        apply()
    }

    private func map(_ p: CGPoint) -> CGPoint? { CoordinateMapper.viewToNormalized(p, view) }

    // MARK: gestures
    @objc private func onTap(_ g: UITapGestureRecognizer) {
        guard controlEnabled else { return }
        // two quick taps arrive as two clicks; Windows turns them into a double-click
        if trackpad { onPointer?("click", nil, "left", 0) } else if let p = map(g.location(in: self)) { onPointer?("click", p, "left", 0) }
    }

    @objc private func onTwoTap(_ g: UITapGestureRecognizer) {
        guard controlEnabled, trackpad else { return }
        onPointer?("click", nil, "right", 0)
    }

    @objc private func onLong(_ g: UILongPressGestureRecognizer) {
        guard controlEnabled, g.state == .began else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if trackpad {
            dragging = true
            onPointer?("down", nil, "left", 0)
        } else if let p = map(g.location(in: self)) {
            onPointer?("click", p, "right", 0)
        }
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) {
        guard controlEnabled else { return }
        let p = g.location(in: self)
        switch g.state {
        case .began:
            lastPan = p
            if !trackpad, !dragging {
                let start = CGPoint(x: p.x - g.translation(in: self).x, y: p.y - g.translation(in: self).y)
                if let s = map(start) { dragging = true; onPointer?("down", s, "left", 0) }
            }
        case .changed:
            if trackpad {
                let dx = p.x - lastPan.x, dy = p.y - lastPan.y
                let sp = hypot(dx, dy)
                let acc: CGFloat = (sp < 3 ? 0.6 : sp < 12 ? 1.2 : 2.2) / view.scale
                onRel?(dx / view.viewW * acc, dy / view.viewH * acc)
            } else if dragging, let n = map(p) {
                onMove?(n)
            }
            lastPan = p
        case .ended, .cancelled, .failed:
            if dragging {
                onPointer?("up", trackpad ? nil : map(p), "left", 0)
                dragging = false
            }
        default: break
        }
    }

    @objc private func onTwoPan(_ g: UIPanGestureRecognizer) {
        let c = g.location(in: self)
        if g.state == .began { lastTwo = c; scrollAcc = 0; return }
        guard g.state == .changed else { return }
        let dx = c.x - lastTwo.x, dy = c.y - lastTwo.y
        lastTwo = c
        if trackpad && controlEnabled {
            scrollAcc += dy
            if abs(scrollAcc) > 24 { onPointer?("scroll", nil, "left", Int(scrollAcc * -5)); scrollAcc = 0 }
        } else {
            view.panX += dx; view.panY += dy
            view = CoordinateMapper.clampPan(view)
            apply()
        }
    }

    @objc private func onPinch(_ g: UIPinchGestureRecognizer) {
        guard g.state == .changed else { return }
        let f = g.location(in: self)
        let s = max(1, min(8, view.scale * g.scale))
        let k = s / view.scale
        view.panX = f.x - (f.x - view.panX) * k
        view.panY = f.y - (f.y - view.panY) * k
        view.scale = s
        view = CoordinateMapper.clampPan(view)
        apply()
        g.scale = 1
    }
}

/// SwiftUI bridge. The UIView is created once and owned by the session screen.
struct RemoteVideoView: UIViewRepresentable {
    let uiView: RemoteVideoUIView
    func makeUIView(context: Context) -> RemoteVideoUIView { uiView }
    func updateUIView(_ uiView: RemoteVideoUIView, context: Context) {}
}
