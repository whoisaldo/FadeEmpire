import CoreImage.CIFilterBuiltins
import SwiftUI

struct LinksView: View {
    @Environment(AppModel.self) private var app
    @State private var chairId: UUID?
    @State private var links: [BookingLink] = []
    @State private var error: String?
    @State private var adding = false
    @State private var qr: QRItem?
    @State private var copied: String?

    private var chairs: [Chair] { app.manageableChairs }
    private var chair: Chair? { chairs.first { $0.id == chairId } ?? chairs.first { $0.id == app.selectedChairId } ?? chairs.first }

    var body: some View {
        NavigationStack {
            List {
                if chairs.count > 1 {
                    Picker("Chair", selection: Binding(get: { chair?.id }, set: { chairId = $0 })) {
                        ForEach(chairs) { Text($0.displayName).tag(UUID?.some($0.id)) }
                    }
                    .frame(minHeight: 44)
                    .listRowBackground(Color.ink2)
                    .accessibilityIdentifier("links-chair")
                }
                if let chair {
                    Section {
                        LinkCard(label: "\(chair.displayName)'s booking page", detail: "Opens the booking form with \(chair.displayName) picked",
                                 url: BookingLinks.plain(slug: chair.slug), copied: $copied, qr: $qr)
                    } header: {
                        Text("Plain link")
                    }
                    .listRowBackground(Color.ink2)

                    Section {
                        if links.isEmpty {
                            Text("None yet. A custom link can open on one service.").foregroundStyle(Color.boneSoft)
                        }
                        ForEach(links) { link in
                            LinkCard(label: link.label, detail: Catalog.serviceName(link.serviceSlug),
                                     url: BookingLinks.url(for: link, slug: chair.slug), copied: $copied, qr: $qr,
                                     onDelete: { delete(link) })
                        }
                        Button { adding = true } label: { Label("Add custom link", systemImage: "plus") }
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("add-link")
                    } header: {
                        Text("Custom links")
                    }
                    .listRowBackground(Color.ink2)
                } else {
                    Text("You have no chair to share links for.").foregroundStyle(Color.boneSoft).listRowBackground(Color.ink2)
                }
                if let error { ErrorText(message: error).listRowBackground(Color.ink2) }
            }
            .listStyle(.insetGrouped)
            .inkBackground()
            .navigationTitle("Links")
            .autoRefresh { await load() }
            .onChange(of: chairId) { _, _ in Task { await load() } }
            .sheet(isPresented: $adding) {
                if let chair { AddLinkView(chair: chair) { links.append($0) } }
            }
            .sheet(item: $qr) { QRSheet(item: $0) }
            .overlay(alignment: .bottom) {
                if let copied {
                    Text(copied)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(Color.ink3, in: Capsule())
                        .foregroundStyle(Color.bone)
                        .padding(.bottom, 12)
                        .transition(.opacity)
                        .accessibilityIdentifier("copied-toast")
                        .task {
                            UIAccessibility.post(notification: .announcement, argument: copied)
                            try? await Task.sleep(for: .seconds(2))
                            self.copied = nil
                        }
                }
            }
        }
    }

    private func load() async {
        guard let chair else { return }
        do { links = try await app.backend.links(barberId: chair.id); error = nil } catch { self.error = app.handle(error) }
    }

    private func delete(_ link: BookingLink) {
        Task {
            do {
                try await app.backend.deleteLink(id: link.id)
                links.removeAll { $0.id == link.id }
            } catch {
                self.error = app.handle(error)
            }
        }
    }
}

struct QRItem: Identifiable {
    let label: String
    let url: URL
    var id: String { url.absoluteString + label }
}

private struct LinkCard: View {
    let label: String
    let detail: String
    let url: URL
    @Binding var copied: String?
    @Binding var qr: QRItem?
    var onDelete: (() -> Void)?
    @State private var confirmingDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.headline).foregroundStyle(Color.bone)
                    Text(detail).font(.subheadline).foregroundStyle(Color.boneSoft)
                }
                Spacer()
                if onDelete != nil {
                    Button(role: .destructive) { confirmingDelete = true } label: {
                        Image(systemName: "trash").frame(width: 44, height: 44)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Delete link \(label)")
                }
            }
            Text(url.absoluteString)
                .font(.footnote.monospaced())
                .foregroundStyle(Color.goldPale)
                .textSelection(.enabled)
                .accessibilityIdentifier("link-url-\(label)")
            HStack(spacing: 8) {
                Button {
                    UIPasteboard.general.string = url.absoluteString
                    copied = "Copied \(label)"
                } label: { Label("Copy", systemImage: "doc.on.doc") }
                    .buttonStyle(OutlineButtonStyle())
                    .accessibilityLabel("Copy link \(label)")
                ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") }
                    .buttonStyle(OutlineButtonStyle())
                    .accessibilityLabel("Share link \(label)")
                Button { qr = QRItem(label: label, url: url) } label: { Label("QR", systemImage: "qrcode") }
                    .buttonStyle(OutlineButtonStyle())
                    .accessibilityLabel("QR code for \(label)")
            }
        }
        .padding(.vertical, 6)
        .confirmationDialog("Delete \(label)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete link", role: .destructive) { onDelete?() }
        } message: {
            Text("Anyone who already has it still reaches the booking page.")
        }
    }
}

private struct AddLinkView: View {
    let chair: Chair
    let onAdded: (BookingLink) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var service: String?
    @State private var error: String?
    @State private var busy = false

    private var preview: URL {
        service.map { BookingLinks.withService(slug: chair.slug, service: $0) } ?? BookingLinks.plain(slug: chair.slug)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, e.g. Instagram bio", text: $label)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("link-label")
                    Picker("Opens on", selection: $service) {
                        Text("Any service").tag(String?.none)
                        ForEach(Catalog.services) { Text($0.name).tag(String?.some($0.slug)) }
                    }
                    .pickerStyle(.navigationLink)
                    .accessibilityIdentifier("link-service")
                } footer: {
                    Text(preview.absoluteString).font(.footnote.monospaced()).foregroundStyle(Color.goldPale)
                        .accessibilityIdentifier("link-preview")
                }
                .listRowBackground(Color.ink2)
                Section {
                    ErrorText(message: error)
                    Button("Save link", action: save)
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty || label.count > 60 || busy)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .accessibilityIdentifier("link-save")
                }
                .listRowBackground(Color.ink2)
            }
            .inkBackground()
            .navigationTitle("New link · \(chair.displayName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    private func save() {
        busy = true
        Task {
            do {
                onAdded(try await app.backend.addLink(barberId: chair.id, label: label, serviceSlug: service))
                dismiss()
            } catch {
                self.error = app.handle(error)
            }
            busy = false
        }
    }
}

enum QRCode {
    /// A crisp QR code: CoreImage's generator scaled up without smoothing.
    static func image(for text: String, scale: CGFloat = 12) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

private struct QRSheet: View {
    let item: QRItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let img = QRCode.image(for: item.url.absoluteString) {
                    Image(uiImage: img)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .padding(16)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                        .frame(maxWidth: 300)
                        .accessibilityLabel("QR code for \(item.url.absoluteString)")
                        .accessibilityIdentifier("qr-image")
                    Text(item.url.absoluteString)
                        .font(.footnote.monospaced())
                        .foregroundStyle(Color.goldPale)
                        .multilineTextAlignment(.center)
                    ShareLink(item: Image(uiImage: img), preview: SharePreview(item.label, image: Image(uiImage: img))) {
                        Label("Share QR image", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.ink.ignoresSafeArea())
            .navigationTitle(item.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
