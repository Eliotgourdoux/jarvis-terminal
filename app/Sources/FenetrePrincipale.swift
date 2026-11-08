import AppKit
import WebKit

/// Relais faible pour la page de la barre latérale.
private final class RelaisBarre: NSObject, WKScriptMessageHandler {
    weak var cible: FenetrePrincipale?
    init(_ c: FenetrePrincipale) { cible = c }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { cible?.messageBarre(m) }
}

/// Bande de 28 px en haut de la fenêtre : déplace la fenêtre (une vue web ne le fait pas).
final class BandeDeplacement: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with e: NSEvent) {
        if e.clickCount == 2 {
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" { window?.performMiniaturize(nil) } else if action != "None" { window?.performZoom(nil) }
        } else { window?.performDrag(with: e) }
    }
}

/// Une seule fenêtre pour toutes les sessions (demande d'Eliot, 07/11/2026) : la liste des sessions
/// à gauche (page ui/sessions.html), la session choisie à droite. Les autres vues restent vivantes
/// derrière (empilées, pas cachées : WebKit continue de les faire tourner normalement).
final class FenetrePrincipale: NSObject, NSWindowDelegate, WKNavigationDelegate {
    static let shared = FenetrePrincipale()
    static let largeurBarre: CGFloat = 248
    private static func couleur(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    let window: NSWindow
    private var barre: WKWebView?
    private var pageBarre: URL?
    private let zone = NSView()
    private let vide = NSTextField(labelWithString: "Aucune session ouverte.\n⌘N pour en ouvrir une.")
    private(set) var vues: [FenetreSession] = []
    private(set) weak var selection: FenetreSession?
    /// Sessions qui ont fini un tour pendant qu'Eliot regardait ailleurs.
    private var nonLues: Set<String> = []
    private var barrePrete = false
    private var majPrevue = false
    private var dejaMontree = false
    /// La conversation Telegram avec Jarvis est affichée (alors `selection` vaut nil).
    private(set) var jarvisDevant = false

    private override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1220, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        super.init()
        window.title = "Jarvis Terminal"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isOpaque = true
        window.backgroundColor = Self.couleur(0x111216)
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 760, height: 420)
        window.tabbingMode = .disallowed
        window.delegate = self
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.center()
        window.setFrameAutosaveName("JarvisTerminalPrincipale")

        let racine = NSView(frame: window.contentLayoutRect)
        racine.wantsLayer = true
        racine.layer?.backgroundColor = Self.couleur(0x111216).cgColor
        let h = racine.bounds.height, l = Self.largeurBarre

        // Barre latérale
        let (_, lecture) = Page.choisir()
        let chemin = lecture.appendingPathComponent("sessions.html")
        let largeur: CGFloat = FileManager.default.fileExists(atPath: chemin.path) ? l : 0
        if largeur > 0 {
            pageBarre = chemin
            let cfg = WKWebViewConfiguration()
            cfg.userContentController.add(RelaisBarre(self), name: "barre")
            cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
            let w = WKWebView(frame: NSRect(x: 0, y: 0, width: largeur, height: h), configuration: cfg)
            w.autoresizingMask = [.height]
            w.navigationDelegate = self
            w.allowsBackForwardNavigationGestures = false
            w.allowsLinkPreview = false
            if #available(macOS 13.3, *) { w.isInspectable = true }
            if PiloteDev.actif, w.responds(to: Selector(("_setWindowOcclusionDetectionEnabled:"))) {
                w.setValue(false, forKey: "windowOcclusionDetectionEnabled")
            }
            racine.addSubview(w)
            barre = w
            let trait = NSView(frame: NSRect(x: largeur, y: 0, width: 1, height: h))
            trait.wantsLayer = true
            trait.layer?.backgroundColor = Self.couleur(0x2A2C36).cgColor
            trait.autoresizingMask = [.height]
            racine.addSubview(trait)
        }

        // Zone de la session choisie
        let x = largeur > 0 ? largeur + 1 : 0
        zone.frame = NSRect(x: x, y: 0, width: racine.bounds.width - x, height: h)
        zone.autoresizingMask = [.width, .height]
        zone.wantsLayer = true
        zone.layer?.backgroundColor = Self.couleur(0x111216).cgColor
        racine.addSubview(zone)

        vide.alignment = .center
        vide.textColor = Self.couleur(0x868A99)
        vide.font = .systemFont(ofSize: 14)
        vide.sizeToFit()
        vide.frame = NSRect(x: (zone.bounds.width - 320) / 2, y: (zone.bounds.height - 44) / 2, width: 320, height: 44)
        vide.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        zone.addSubview(vide)

        let bande = BandeDeplacement(frame: NSRect(x: 0, y: h - FenetreSession.hauteurBarre,
                                                    width: racine.bounds.width, height: FenetreSession.hauteurBarre))
        bande.autoresizingMask = [.width, .minYMargin]
        racine.addSubview(bande)

        window.contentView = racine
        if let p = pageBarre { barre?.loadFileURL(p, allowingReadAccessTo: lecture) }

        // Après l'init : demarrer() relit FenetrePrincipale.shared, ce qui bloquerait le dispatch_once du singleton.
        DispatchQueue.main.async { ConversationJarvis.shared.demarrer() }
        NotificationCenter.default.addObserver(self, selector: #selector(registreChange(_:)), name: RegistreSessions.changement, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(tourTermine(_:)), name: RegistreSessions.tourTermine, object: nil)
    }

    // MARK: - Sessions

    func ajouter(_ v: FenetreSession) {
        guard !vues.contains(where: { $0 === v }) else { return }
        vues.append(v)
        v.vue.frame = zone.bounds
        v.vue.autoresizingMask = [.width, .height]
        zone.addSubview(v.vue, positioned: .below, relativeTo: jarvisDevant ? ConversationJarvis.shared.vue : selection?.vue)
        if selection == nil && !jarvisDevant { selectionner(v) }
        vide.isHidden = true
        planifierMaj()
    }

    func retirer(_ v: FenetreSession) {
        guard let i = vues.firstIndex(where: { $0 === v }) else { return }
        vues.remove(at: i)
        v.vue.removeFromSuperview()
        if let id = v.sessionLiee?.sessionId { nonLues.remove(id) }
        if selection === v || (selection == nil && !jarvisDevant) {
            selection = nil
            if !vues.isEmpty { selectionner(vues[min(i, vues.count - 1)]) }
        }
        vide.isHidden = !vues.isEmpty
        if vues.isEmpty && !jarvisDevant { window.title = "Jarvis Terminal"; window.makeFirstResponder(barre) }
        planifierMaj()
    }

    func selectionner(_ v: FenetreSession) {
        guard vues.contains(where: { $0 === v }) else { return }
        selection = v
        if jarvisDevant { jarvisDevant = false; ConversationJarvis.shared.vue.isHidden = true }
        mettreAuDessus(v.vue)
        majTitre()
        if let s = v.sessionLiee {
            nonLues.remove(s.sessionId)
            s.marquerActivee()
        }
        window.makeFirstResponder(v.web)
        planifierMaj()
    }

    /// La conversation Telegram avec Jarvis prend la place de la session affichée.
    func selectionnerJarvis() {
        let c = ConversationJarvis.shared
        guard c.disponible else { return }
        c.preparerVue()
        if c.vue.superview !== zone {
            c.vue.frame = zone.bounds
            c.vue.autoresizingMask = [.width, .height]
            zone.addSubview(c.vue)
        }
        c.vue.isHidden = false
        selection = nil
        jarvisDevant = true
        mettreAuDessus(c.vue)
        majTitre()
        if let w = c.web { window.makeFirstResponder(w) }
        c.marquerAffichee()
        planifierMaj()
    }

    /// Réordonne sans retirer : aucune vue ne quitte la fenêtre (WebKit continue de les faire tourner).
    private func mettreAuDessus(_ vue: NSView) {
        let ctx = Unmanaged.passUnretained(vue).toOpaque()
        zone.sortSubviews({ a, b, c in
            guard let c else { return .orderedSame }
            let choisie = Unmanaged<NSView>.fromOpaque(c).takeUnretainedValue()
            if a === choisie { return .orderedDescending }
            if b === choisie { return .orderedAscending }
            return .orderedSame
        }, context: ctx)
    }

    func montrer() {
        if !dejaMontree { dejaMontree = true; window.setFrameUsingName("JarvisTerminalPrincipale") }
        // Tests d'intégration (BT_DEV_PILOTE) : la fenêtre s'ouvre derrière les autres, sans voler le focus à Eliot.
        if PiloteDev.actif { window.orderBack(nil); return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func estChoisie(_ v: FenetreSession) -> Bool { selection === v }

    /// ⌘W : ferme la session affichée (la fenêtre reste, avec les autres sessions).
    func fermerSelection() { selection?.sessionLiee?.fermer() }

    /// ⌘1…⌘9.
    func choisir(numero n: Int) {
        guard n >= 1, n <= vues.count else { return }
        selectionner(vues[n - 1]); montrer()
    }

    /// Session suivante (+1) ou précédente (-1), en boucle.
    func decaler(_ pas: Int) {
        guard !vues.isEmpty else { return }
        if jarvisDevant { selectionner(vues[pas > 0 ? 0 : vues.count - 1]); return }
        let i = vues.firstIndex { $0 === selection } ?? 0
        selectionner(vues[(i + pas + vues.count) % vues.count])
    }

    // MARK: - Barre latérale

    @objc private func registreChange(_ n: Notification) { planifierMaj() }

    @objc private func tourTermine(_ n: Notification) {
        guard let id = n.userInfo?["sessionId"] as? String,
              let v = vues.first(where: { $0.sessionLiee?.sessionId == id }) else { return }
        if !(selection === v && window.isKeyWindow && NSApp.isActive) { nonLues.insert(id) }
        planifierMaj()
    }

    func planifierMaj() {
        guard !majPrevue else { return }
        majPrevue = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            guard let self else { return }
            self.majPrevue = false
            self.envoyerListe()
        }
    }

    private func majTitre() {
        if jarvisDevant { window.title = "🤖 Jarvis — Telegram"; return }
        guard let s = selection?.sessionLiee else { window.title = "Jarvis Terminal"; return }
        window.title = s.projet.emoji + " " + s.projet.nom + (s.apercu.dansTerminal ? " — dans le Terminal" : "")
    }

    private func envoyerListe() {
        majTitre()
        guard barrePrete, let barre else { return }
        let liste: [[String: Any]] = vues.enumerated().compactMap { i, v in
            guard let s = v.sessionLiee, !s.estFermee else { return nil }
            let a = s.apercu
            return ["id": a.sessionId, "numero": i + 1, "projet": a.projet, "emoji": a.emoji, "cwd": a.cwd,
                    "etat": a.etat, "resume": a.resume ?? NSNull(), "dernierMessage": a.dernierMessage ?? NSNull(),
                    "modele": a.modele ?? NSNull(), "dansTerminal": a.dansTerminal,
                    "maj": a.maj.timeIntervalSince1970 * 1000, "actif": selection === v, "nonLu": nonLues.contains(a.sessionId)]
        }
        let ouvertes = Set(liste.compactMap { $0["id"] as? String })
        let fermetures: [[String: Any]] = RegistreSessions.shared.enFermeture.filter { !ouvertes.contains($0.sessionId) }.map { f in
            ["id": f.sessionId, "numero": 99, "projet": f.projet, "emoji": f.emoji, "cwd": f.cwd, "etat": "fermeture",
             "fermeture": true, "maj": f.debut.timeIntervalSince1970 * 1000, "actif": false, "nonLu": false, "dansTerminal": false]
        }
        let c = ConversationJarvis.shared
        let jarvis: Any = c.disponible
            ? ["apercu": c.apercu, "maj": (c.dateDernier?.timeIntervalSince1970 ?? 0) * 1000, "actif": jarvisDevant,
               "nonLu": c.nonLu, "occupe": c.occupe] as [String: Any]
            : NSNull()
        barre.callAsyncJavaScript("if (window.barreSessions) window.barreSessions.maj(liste, jarvis);",
                                  arguments: ["liste": liste + fermetures, "jarvis": jarvis], in: nil, in: .page) { r in
            if case .failure(let e) = r { journal("barre : mise à jour en échec — \(e.localizedDescription)") }
        }
    }

    func messageBarre(_ m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, let u = m.frameInfo.request.url, u.isFileURL, let p = pageBarre,
              u.standardizedFileURL.path == p.standardizedFileURL.path,
              let o = m.body as? [String: Any], let type = o["type"] as? String else {
            journal("barre : message refusé"); return
        }
        func cible() -> FenetreSession? {
            guard let id = o["id"] as? String, Validation.sessionId(id) else { return nil }
            return vues.first { $0.sessionLiee?.sessionId == id.lowercased() }
        }
        switch type {
        case "pret": barrePrete = true; envoyerListe()
        case "choisir": if let v = cible() { selectionner(v) }
        case "jarvis": selectionnerJarvis()
        case "fermer": cible()?.sessionLiee?.fermer()
        case "nouvelle": Entrees.choisirDossier()
        default: journal("barre : type inconnu « \(type.prefix(30)) »")
        }
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, u.isFileURL, let p = pageBarre, u.standardizedFileURL.path == p.standardizedFileURL.path {
            decisionHandler(.allow); return
        }
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) { barrePrete = false }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { barrePrete = false; w.reload() }

    /// Pilote de développement uniquement (BT_DEV_PILOTE).
    func evaluerBarreDev(_ code: String, _ fini: @escaping (Bool, Any) -> Void) {
        guard PiloteDev.actif, let barre else { fini(false, "pilote inactif ou pas de barre"); return }
        barre.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): fini(true, JSONSerialization.isValidJSONObject([v]) ? v : String(describing: v))
            case .failure(let e): fini(false, e.localizedDescription)
            }
        }
    }

    // MARK: - Fenêtre

    func windowDidBecomeKey(_ n: Notification) {
        if jarvisDevant { ConversationJarvis.shared.marquerAffichee() }
        if let s = selection?.sessionLiee { s.marquerActivee(); if nonLues.remove(s.sessionId) != nil { planifierMaj() } }
    }

    /// Le bouton rouge cache la fenêtre sans tuer les sessions (⌘W ferme une session, ⌘Q quitte tout).
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        return false
    }
}
