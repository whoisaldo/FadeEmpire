// Builds the 1024 px app icon from the site's knight cut-out (assets/brand/logo-mark.png):
// the mark's visible pixels, tinted brass, centred on the ink background.
//
//   DEVELOPER_DIR=/Applications/Xcode-26.3.0.app/Contents/Developer \
//     xcrun swift ios/scripts/make-icon.swift assets/brand/logo-mark.png \
//     ios/FadeEmpire/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
import AppKit
import CoreGraphics

let args = CommandLine.arguments
guard args.count == 3,
      let source = NSImage(contentsOfFile: args[1]),
      let mark = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("usage: make-icon.swift <logo-mark.png> <out.png>\n".data(using: .utf8)!)
    exit(1)
}

// Bounding box of the opaque pixels, so the knight is centred on what you see.
let w = mark.width, h = mark.height
var rgba = [UInt8](repeating: 0, count: w * h * 4)
let probe = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
probe.draw(mark, in: CGRect(x: 0, y: 0, width: w, height: h))
var minX = w, minY = h, maxX = 0, maxY = 0
for y in 0..<h { for x in 0..<w where rgba[(y * w + x) * 4 + 3] > 24 {
    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
} }
// Bitmap rows run top-down; CoreGraphics crop rects do too.
let crop = mark.cropping(to: CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))!

let size = 1024
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(CGColor(srgbRed: 0x0A / 255, green: 0x09 / 255, blue: 0x08 / 255, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

let target = 640.0
let scale = target / Double(max(crop.width, crop.height))
let dw = Double(crop.width) * scale, dh = Double(crop.height) * scale
let rect = CGRect(x: (Double(size) - dw) / 2, y: (Double(size) - dh) / 2, width: dw, height: dh)
// Tint: draw the mark into a clear layer, then paint brass only where it is opaque.
let layer = CGContext(data: nil, width: Int(dw), height: Int(dh), bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let layerRect = CGRect(x: 0, y: 0, width: Int(dw), height: Int(dh))
layer.draw(crop, in: layerRect)
layer.setBlendMode(.sourceIn)
layer.setFillColor(CGColor(srgbRed: 0xC8 / 255, green: 0xA2 / 255, blue: 0x4A / 255, alpha: 1))
layer.fill(layerRect)
ctx.draw(layer.makeImage()!, in: rect)

let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
