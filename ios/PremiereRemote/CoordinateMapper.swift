import CoreGraphics

/// Same math as shared/src/mapping.js (the tested reference) and CoordinateMapper.kt.
/// Display transform: screen = base * scale + pan, applied about the container origin.
struct ViewState: Equatable {
    var viewW: CGFloat, viewH: CGFloat
    var frameW: CGFloat, frameH: CGFloat
    var scale: CGFloat = 1, panX: CGFloat = 0, panY: CGFloat = 0
}

enum CoordinateMapper {
    static func fitRect(viewW: CGFloat, viewH: CGFloat, frameW: CGFloat, frameH: CGFloat) -> CGRect? {
        guard viewW > 0, viewH > 0, frameW > 0, frameH > 0 else { return nil }
        let s = min(viewW / frameW, viewH / frameH)
        let w = frameW * s, h = frameH * s
        return CGRect(x: (viewW - w) / 2, y: (viewH - h) / 2, width: w, height: h)
    }

    /// Touch point in container coordinates -> normalized frame coordinates, or nil in the letterbox.
    static func viewToNormalized(_ p: CGPoint, _ v: ViewState) -> CGPoint? {
        guard let base = fitRect(viewW: v.viewW, viewH: v.viewH, frameW: v.frameW, frameH: v.frameH) else { return nil }
        let qx = (p.x - v.panX) / v.scale
        let qy = (p.y - v.panY) / v.scale
        let nx = (qx - base.minX) / base.width
        let ny = (qy - base.minY) / base.height
        guard (0...1).contains(nx), (0...1).contains(ny) else { return nil }
        return CGPoint(x: nx, y: ny)
    }

    static func clampPan(_ v: ViewState) -> ViewState {
        var out = v
        out.scale = max(1, min(v.scale, 8))
        guard let base = fitRect(viewW: v.viewW, viewH: v.viewH, frameW: v.frameW, frameH: v.frameH) else {
            out.panX = 0; out.panY = 0; return out
        }
        func axis(_ pan: CGFloat, _ viewLen: CGFloat, _ start: CGFloat, _ len: CGFloat) -> CGFloat {
            let cs = start * out.scale, cl = len * out.scale
            if cl <= viewLen { return (viewLen - cl) / 2 - cs }
            return min(-cs, max(viewLen - (cs + cl), pan))
        }
        out.panX = axis(v.panX, v.viewW, base.minX, base.width) + 0
        out.panY = axis(v.panY, v.viewH, base.minY, base.height) + 0
        return out
    }
}
