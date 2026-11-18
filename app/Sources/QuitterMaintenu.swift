import AppKit
import Carbon.HIToolbox

/// ⌘Q à maintenir pour quitter, comme Chrome (demande d'Eliot, 08/11/2026).
/// Un appui bref affiche « Maintiens ⌘Q pour quitter » ; il faut garder la touche ~1 s, barre pleine, pour que l'app quitte.
/// Seul le raccourci clavier est concerné : le menu, le Dock et `osascript … quit` (app/relancer.sh) quittent directement.
enum QuitterMaintenu {
    private static let duree: TimeInterval = 1.0
    private static var debut: Date?
    private static var touche: UInt16 = 12
    private static var minuteur: Timer?
    private static var masquage: DispatchWorkItem?
    private static var panneau: NSPanel?
    private static var barre: CALayer?
    private static var sousTitre: NSTextField?

    static func installer() {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            let m = e.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.function, .numericPad, .capsLock])
            guard m == .command, e.charactersIgnoringModifiers?.lowercased() == "q", !PiloteDev.actif else { return e }
            if !e.isARepeat && debut == nil { commencer(e.keyCode) }
            return nil   // avalé : le menu « Quitter » ne le voit pas
        }
    }

    private static func commencer(_ code: UInt16) {
        touche = code
        debut = Date()
        masquage?.cancel()
        afficher()
        // Suivi par l'état réel du clavier : un ⌘ relâché n'envoie pas toujours de keyUp à l'app.
        minuteur = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in avancer() }
    }

    private static func avancer() {
        guard let d = debut else { return }
        let tenue = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(touche))
            && NSEvent.modifierFlags.contains(.command)
        let p = min(1, Date().timeIntervalSince(d) / duree)
        if !tenue { arreter(quitter: false); return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        if let b = barre, let l = b.superlayer { b.frame.size.width = l.bounds.width * p }
        CATransaction.commit()
        if p >= 1 { arreter(quitter: true) }
    }

    private static func arreter(quitter: Bool) {
        minuteur?.invalidate(); minuteur = nil
        debut = nil
        if quitter {
            panneau?.orderOut(nil)
            // Directement, depuis le rappel du minuteur. Surtout pas dans un bloc DispatchQueue.main : pendant
            // terminateLater, la file principale resterait occupée par ce bloc, aucun rappel d'arrêt (fin des
            // processus, SIGTERM, repli de 7 s) ne pourrait passer, et l'app se figeait (bug du 08/11/2026).
            NSApp.terminate(nil)
            return
        }
        // relâché trop tôt : la barre se vide, le message reste un instant (comme Chrome)
        CATransaction.begin(); CATransaction.setAnimationDuration(0.15)
        barre?.frame.size.width = 0
        CATransaction.commit()
        let w = DispatchWorkItem { panneau?.orderOut(nil) }
        masquage = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4, execute: w)
    }

    // MARK: Bulle

    private static func couleur(_ hex: UInt32) -> CGColor {
        CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    private static func afficher() {
        let p = panneau ?? construire()
        let enCours = RegistreSessions.shared.sessions.filter { $0.etat == "travaille" }.count
        let enFond = Reglages.d.bool(forKey: "BTGarderEnFond")
        sousTitre?.stringValue = enFond ? (enCours == 0 ? "Tes sessions restent en fond et reviendront au prochain lancement."
                                           : enCours == 1 ? "1 session travaille : elle continue en fond."
                                           : "\(enCours) sessions travaillent : elles continuent en fond.")
            : enCours == 0 ? "Tes sessions se rouvriront au prochain lancement."
            : enCours == 1 ? "1 session travaille : elle sera interrompue."
            : "\(enCours) sessions travaillent : elles seront interrompues."
        sousTitre?.textColor = enCours == 0 || enFond ? NSColor(cgColor: couleur(0xB9B1A3)) : NSColor(cgColor: couleur(0xE8B04B))
        CATransaction.begin(); CATransaction.setDisableActions(true)
        barre?.frame.size.width = 0
        CATransaction.commit()
        // centrée sur la fenêtre active, sinon sur l'écran
        let ref = (NSApp.keyWindow ?? NSApp.mainWindow)?.frame ?? NSScreen.main?.visibleFrame ?? .zero
        p.setFrameOrigin(NSPoint(x: ref.midX - p.frame.width / 2, y: ref.midY - p.frame.height / 2))
        p.orderFrontRegardless()
    }

    private static func construire() -> NSPanel {
        let taille = NSSize(width: 340, height: 104)
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: taille), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .floating
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.ignoresMouseEvents = true
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

        let fond = NSView(frame: NSRect(origin: .zero, size: taille))
        fond.wantsLayer = true
        fond.layer?.backgroundColor = couleur(0x141216)   // charte marbre : --surface
        fond.layer?.cornerRadius = 14
        fond.layer?.borderWidth = 1
        fond.layer?.borderColor = CGColor(srgbRed: 201 / 255, green: 164 / 255, blue: 92 / 255, alpha: 0.4)   // --bord-fort (filet or)
        p.contentView = fond

        let titre = NSTextField(labelWithString: "Maintiens ⌘Q pour quitter")
        // titres en serif (New York), comme la page
        let base = NSFont.systemFont(ofSize: 17, weight: .semibold)
        titre.font = base.fontDescriptor.withDesign(.serif).flatMap { NSFont(descriptor: $0, size: 17) } ?? base
        titre.textColor = NSColor(cgColor: couleur(0xFAF5EA))
        titre.alignment = .center
        titre.frame = NSRect(x: 16, y: 62, width: taille.width - 32, height: 22)
        fond.addSubview(titre)

        let sous = NSTextField(labelWithString: "")
        sous.font = .systemFont(ofSize: 12.5)
        sous.alignment = .center
        sous.lineBreakMode = .byTruncatingTail
        sous.frame = NSRect(x: 16, y: 38, width: taille.width - 32, height: 18)
        fond.addSubview(sous)
        sousTitre = sous

        let rail = CALayer()
        rail.frame = CGRect(x: 24, y: 18, width: taille.width - 48, height: 4)
        rail.cornerRadius = 2
        rail.backgroundColor = couleur(0x262126)   // --surface-3
        rail.masksToBounds = true
        fond.layer?.addSublayer(rail)
        // barre en dégradé or (--or-clair → --accent-plein), à la place de l'ancien violet néon
        let plein = CAGradientLayer()
        plein.anchorPoint = .zero
        plein.frame = CGRect(x: 0, y: 0, width: 0, height: 4)
        plein.colors = [couleur(0xE3C887), couleur(0xB8914A)]
        plein.startPoint = CGPoint(x: 0, y: 0.5)
        plein.endPoint = CGPoint(x: 1, y: 0.5)
        rail.addSublayer(plein)
        barre = plein

        panneau = p
        return p
    }
}
