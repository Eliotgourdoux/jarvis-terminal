import AppKit
import WebKit

/// Panneau de diagnostic du mode vocal (depuis le 08/11/2026, il ne s'ouvre que par le menu Vocal → Afficher
/// le panneau Jarvis ; jamais seul à l'activation du mode) : petit NSPanel flottant, non activant (il ne vole jamais le focus,
/// ne devient jamais fenêtre clé), visible sur tous les bureaux, avec une vue web transparente.
/// Page : `ui/jarvis.html` (agent V2) si elle existe, sinon la page de test `app/page-test/jarvis-test.html`.
/// Swift → page : `jarvis.maj(etat)` ; page → Swift : `{type: pret|passer|rejouer|couper|reprendre|modeVocal|fermer|taille}`.
final class PanneauJarvis: NSObject, WKNavigationDelegate, WKUIDelegate {
    static let shared = PanneauJarvis()
    static let hauteurBande: CGFloat = 16   // bande du haut : déplace le panneau (rien de cliquable dedans)

    private var panneau: Panneau?
    private var web: VueWebPanneau?
    private var page = URL(fileURLWithPath: "/")
    private var pret = false
    private var dernier: [String: Any]?
    private var envoiPrevu = false

    var visible: Bool { panneau?.isVisible ?? false }
    var numeroFenetre: Int { panneau?.windowNumber ?? 0 }
    /// Pilote de développement uniquement.
    var fenetreDev: NSWindow? { PiloteDev.actif ? panneau : nil }
    var cheminPage: String { page.path }

    func basculer() { visible ? masquer() : montrer() }

    func montrer() {
        creerSiBesoin()
        guard let p = panneau else { return }
        // Tests (BT_DEV_PILOTE) : le panneau reste derrière les fenêtres d'Eliot, au niveau normal.
        if PiloteDev.actif { p.orderBack(nil) } else { p.orderFrontRegardless() }
        journal("panneau : affiché (fenêtre \(p.windowNumber))")
        envoyerBientot()
        NotificationCenter.default.post(name: MoteurVocal.changement, object: self)
    }

    func masquer() {
        panneau?.orderOut(nil)
        journal("panneau : masqué")
        NotificationCenter.default.post(name: MoteurVocal.changement, object: self)
    }

    /// Dernier état connu ; envoyé au plus ~30 fois par seconde (le niveau du micro change souvent).
    func maj(_ e: [String: Any]) {
        dernier = e
        envoyerBientot()
    }

    private func envoyerBientot() {
        guard !envoiPrevu else { return }
        envoiPrevu = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.033) { [weak self] in
            guard let self else { return }
            self.envoiPrevu = false
            guard self.pret, self.visible, let e = self.dernier, let w = self.web else { return }
            w.callAsyncJavaScript("if (window.jarvis && typeof window.jarvis.maj === 'function') { window.jarvis.maj(e); return true; } return false;",
                                  arguments: ["e": e], in: nil, in: .page) { r in
                if case .failure(let err) = r { journal("panneau : jarvis.maj en échec — \(err.localizedDescription)") }
            }
        }
    }

    // MARK: - Construction

    static func choisirPage() -> (page: URL, lecture: URL) {
        let fm = FileManager.default
        let env = ProcessInfo.processInfo.environment
        let projet = Bundle.main.object(forInfoDictionaryKey: "BTDossierProjet") as? String
        let ressources = Bundle.main.resourcePath
        if env["BT_PANNEAU"] != "test" && UserDefaults.standard.string(forKey: "BTPanneau") != "test" {
            for d in [env["BT_UI_DIR"], projet.map { $0 + "/ui" }, ressources.map { $0 + "/ui" }].compactMap({ $0 })
            where fm.fileExists(atPath: d + "/jarvis.html") {
                return (URL(fileURLWithPath: d + "/jarvis.html"), URL(fileURLWithPath: d, isDirectory: true))
            }
        }
        for d in [projet.map { $0 + "/app/page-test" }, ressources.map { $0 + "/page-test" }].compactMap({ $0 })
        where fm.fileExists(atPath: d + "/jarvis-test.html") {
            return (URL(fileURLWithPath: d + "/jarvis-test.html"), URL(fileURLWithPath: d, isDirectory: true))
        }
        let d = (ressources ?? "/") + "/page-test"
        return (URL(fileURLWithPath: d + "/jarvis-test.html"), URL(fileURLWithPath: d, isDirectory: true))
    }

    private func creerSiBesoin() {
        guard panneau == nil else { return }
        let (pg, lecture) = Self.choisirPage()
        page = pg
        let taille = NSSize(width: 380, height: 230)
        let p = Panneau(contentRect: NSRect(origin: .zero, size: taille), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isFloatingPanel = !PiloteDev.actif
        p.level = PiloteDev.actif ? .normal : .floating
        p.hidesOnDeactivate = false
        p.becomesKeyOnlyIfNeeded = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isExcludedFromWindowsMenu = true
        p.isReleasedWhenClosed = false
        p.appearance = NSAppearance(named: .darkAqua)
        p.title = "Jarvis"

        let racine = NSView(frame: NSRect(origin: .zero, size: taille))
        racine.wantsLayer = true
        racine.layer?.cornerRadius = 22
        racine.layer?.masksToBounds = true
        racine.layer?.backgroundColor = NSColor.clear.cgColor

        // même voile que les fenêtres de session (skill neon-glass-ui)
        let verre = NSVisualEffectView(frame: racine.bounds)
        verre.autoresizingMask = [.width, .height]
        verre.material = .hudWindow
        verre.blendingMode = .behindWindow
        verre.state = .active
        verre.appearance = NSAppearance(named: .darkAqua)
        verre.alphaValue = 0.55
        racine.addSubview(verre)

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(RelaisPanneau(self), name: "bt")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        cfg.preferences.isElementFullscreenEnabled = false
        let w = VueWebPanneau(frame: racine.bounds, configuration: cfg)
        w.autoresizingMask = [.width, .height]
        w.setValue(false, forKey: "drawsBackground")
        w.navigationDelegate = self
        w.uiDelegate = self
        w.allowsBackForwardNavigationGestures = false
        w.allowsLinkPreview = false
        if #available(macOS 13.3, *) { w.isInspectable = true }
        if PiloteDev.actif, w.responds(to: Selector(("_setWindowOcclusionDetectionEnabled:"))) {
            w.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        racine.addSubview(w)

        let bande = BandePanneau(frame: NSRect(x: 0, y: taille.height - Self.hauteurBande, width: taille.width, height: Self.hauteurBande))
        bande.autoresizingMask = [.width, .minYMargin]
        racine.addSubview(bande)

        p.contentView = racine
        if !PiloteDev.actif { p.setFrameAutosaveName("BTPanneauJarvis") }
        if PiloteDev.actif || !p.setFrameUsingName("BTPanneauJarvis") {
            let ecran = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            p.setFrameOrigin(NSPoint(x: ecran.maxX - taille.width - 18, y: ecran.maxY - taille.height - 18))
        }
        panneau = p
        web = w
        journal("panneau : page \(pg.path)")
        w.loadFileURL(pg, allowingReadAccessTo: lecture)
    }

    // MARK: - Page → Swift

    fileprivate func message(_ m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, let u = m.frameInfo.request.url, u.isFileURL,
              u.standardizedFileURL.path == page.standardizedFileURL.path else {
            journal("panneau : message refusé (cadre \(m.frameInfo.request.url?.absoluteString ?? "?"))"); return
        }
        guard let o = m.body as? [String: Any], let type = o["type"] as? String else { journal("panneau : message sans type"); return }
        let v = MoteurVocal.shared
        switch type {
        case "pret": pret = true; dernier = v.etatPanneau(); envoyerBientot()
        case "passer": v.passer()
        case "rejouer": v.rejouer()
        case "couper": v.couper()
        case "reprendre": v.reprendre()
        case "modeVocal":
            guard let a = o["actif"] as? Bool else { journal("panneau : modeVocal sans actif"); return }
            v.activer(a, source: "panneau")
        case "fermer": masquer()
        case "taille":
            guard let l = (o["largeur"] as? NSNumber)?.doubleValue, let h = (o["hauteur"] as? NSNumber)?.doubleValue,
                  (200...900).contains(l), (60...900).contains(h), let p = panneau else { journal("panneau : taille invalide"); return }
            var f = p.frame
            f.origin.y += f.height - h   // le haut reste en place
            f.size = NSSize(width: l, height: h)
            p.setFrame(f, display: true, animate: false)
        default: journal("panneau : type inconnu « \(extrait(type, 40)) »")
        }
    }

    // MARK: - Navigation : la vue ne quitte jamais sa page

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, u.isFileURL, u.standardizedFileURL.path == page.standardizedFileURL.path { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, let u = action.request.url, ["http", "https"].contains(u.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(u)
        } else { journal("panneau : navigation bloquée \(action.request.url?.absoluteString.prefix(200) ?? "?")") }
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) { pret = false }

    func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
        // une page qui n'envoie pas « pret » reçoit quand même l'état
        pret = true
        dernier = MoteurVocal.shared.etatPanneau()
        envoyerBientot()
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        journal("panneau : processus WebKit terminé, rechargement")
        pret = false
        w.reload()
    }

    /// Pilote de développement uniquement.
    func evaluerDev(_ code: String, _ fini: @escaping (Bool, Any) -> Void) {
        guard PiloteDev.actif, let w = web else { fini(false, "panneau absent ou pilote inactif"); return }
        w.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): fini(true, JSONSerialization.isValidJSONObject([v]) ? v : String(describing: v))
            case .failure(let e): fini(false, e.localizedDescription)
            }
        }
    }
}

/// Ne devient jamais fenêtre clé ni principale : le focus reste dans l'app où Eliot travaille.
private final class Panneau: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Un clic agit du premier coup, alors que le panneau n'est jamais fenêtre clé.
private final class VueWebPanneau: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private final class BandePanneau: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { window?.performDrag(with: e) }
}

private final class RelaisPanneau: NSObject, WKScriptMessageHandler {
    weak var p: PanneauJarvis?
    init(_ p: PanneauJarvis) { self.p = p }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { p?.message(m) }
}
