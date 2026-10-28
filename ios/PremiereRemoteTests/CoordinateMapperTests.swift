import XCTest
@testable import PremiereRemote

/// Same cases as shared/test/mapping.test.js and the Kotlin CoordinateMapperTest.
final class CoordinateMapperTests: XCTestCase {
    private let eps: CGFloat = 1e-4

    func testLetterboxPortrait() {
        let r = CoordinateMapper.fitRect(viewW: 1080, viewH: 2340, frameW: 1280, frameH: 720)!
        XCTAssertEqual(r.width, 1080, accuracy: eps)
        XCTAssertEqual(r.height, 607.5, accuracy: eps)
        XCTAssertEqual(r.minY, (2340 - 607.5) / 2, accuracy: eps)
    }

    func testCentreAndCorners() {
        let v = ViewState(viewW: 1080, viewH: 2340, frameW: 1280, frameH: 720)
        let c = CoordinateMapper.viewToNormalized(CGPoint(x: 540, y: 1170), v)!
        XCTAssertEqual(c.x, 0.5, accuracy: eps); XCTAssertEqual(c.y, 0.5, accuracy: eps)
        let top = (2340 - 607.5) / 2
        let br = CoordinateMapper.viewToNormalized(CGPoint(x: 1080, y: top + 607.5), v)!
        XCTAssertEqual(br.x, 1, accuracy: eps); XCTAssertEqual(br.y, 1, accuracy: eps)
    }

    func testLetterboxTapsAreIgnored() {
        XCTAssertNil(CoordinateMapper.viewToNormalized(CGPoint(x: 540, y: 10), ViewState(viewW: 1080, viewH: 2340, frameW: 1280, frameH: 720)))
    }

    func testZoomAndPan() {
        let v = ViewState(viewW: 1600, viewH: 900, frameW: 1280, frameH: 720, scale: 2, panX: -1600, panY: -900)
        let p = CoordinateMapper.viewToNormalized(.zero, v)!
        XCTAssertEqual(p.x, 0.5, accuracy: eps); XCTAssertEqual(p.y, 0.5, accuracy: eps)
    }

    func testRotationInvariance() {
        let pr = CoordinateMapper.fitRect(viewW: 1080, viewH: 2340, frameW: 1920, frameH: 1080)!
        let lr = CoordinateMapper.fitRect(viewW: 2340, viewH: 1080, frameW: 1920, frameH: 1080)!
        let a = CoordinateMapper.viewToNormalized(CGPoint(x: pr.minX + pr.width * 0.25, y: pr.minY + pr.height * 0.75), ViewState(viewW: 1080, viewH: 2340, frameW: 1920, frameH: 1080))!
        let b = CoordinateMapper.viewToNormalized(CGPoint(x: lr.minX + lr.width * 0.25, y: lr.minY + lr.height * 0.75), ViewState(viewW: 2340, viewH: 1080, frameW: 1920, frameH: 1080))!
        XCTAssertEqual(a.x, b.x, accuracy: eps); XCTAssertEqual(a.y, b.y, accuracy: eps)
    }

    func testClampPanKeepsViewDimensions() {
        let c = CoordinateMapper.clampPan(ViewState(viewW: 1600, viewH: 900, frameW: 1280, frameH: 720, scale: 2, panX: 500, panY: -5000))
        XCTAssertEqual(c.panX, 0, accuracy: eps)
        XCTAssertEqual(c.panY, -900, accuracy: eps)
        XCTAssertEqual(c.viewW, 1600) // the web client bug this guards against: clamping must keep dimensions
        XCTAssertEqual(CoordinateMapper.clampPan(ViewState(viewW: 1600, viewH: 900, frameW: 1280, frameH: 720, scale: 50)).scale, 8)
    }
}
