import AppKit
import WebKit
import UniformTypeIdentifiers

/// Quelle page charger : BT_UI_DIR, puis <projet>/ui (développement), puis ui/ du bundle ;
/// la page de test si ui/ n'existe pas encore ou si BT_PAGE=test (ou `-BTPage test`).
enum Page {
    static func choisir() -> (page: URL, lecture: URL) {
        let fm = FileManager.default
        let env = ProcessInfo.processInfo.environment
        let projet = Bundle.main.object(forInfoDictionaryKey: "BTDossierProjet") as? String
        let ressources = Bundle.main.resourcePath
        let test = env["BT_PAGE"] == "test" || UserDefaults.standard.string(forKey: "BTPage") == "test"
        if !test {
            let dossiers = [env["BT_UI_DIR"], projet.map { $0 + "/ui" }, ressources.map { $0 + "/ui" }].compactMap { $0 }
            for d in dossiers where fm.fileExists(atPath: d + "/index.html") {
                return (URL(fileURLWithPath: d + "/index.html"), URL(fileURLWithPath: d, isDirectory: true))
            }
        }
        for d in [projet.map { $0 + "/app/page-test" }, ressources.map { $0 + "/page-test" }].compactMap({ $0 })
        where fm.fileExists(atPath: d + "/page-test.html") {
            return (URL(fileURLWithPath: d + "/page-test.html"), URL(fileURLWithPath: d, isDirectory: true))
        }
        let d = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
        return (URL(fileURLWithPath: d + "/page-test/page-test.html"), URL(fileURLWithPath: d, isDirectory: true))
    }
}

/// Relais faible : WKUserContentController retient son gestionnaire, la session ne doit pas l'être.
private final class RelaisMessages: NSObject, WKScriptMessageHandler {
    weak var fenetre: FenetreSession?
    init(_ f: FenetreSession) { fenetre = f }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { fenetre?.messageDeLaPage(m) }
}

/// La vue d'une session, hébergée dans la fenêtre principale (FenetrePrincipale) : fond opaque, page web.
/// Garde son ancien nom : le reste de la coque l'appelle encore « fenêtre ».
/// Vue web de session : un dépôt de fichiers venant du Finder est pris ici (chemins réels, tout type),
/// au lieu de passer à la page en objets File sans chemin. Le reste (texte, image d'un navigateur) va à WebKit.
final class VueWebSession: WKWebView {
    var surFichiers: (([URL]) -> Void)?

    static func urls(_ p: NSPasteboard) -> [URL] {
        (p.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation {
        let op = super.draggingUpdated(s)
        return surFichiers != nil && !Self.urls(s.draggingPasteboard).isEmpty ? .copy : op
    }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        let u = Self.urls(s.draggingPasteboard)
        if let f = surFichiers, !u.isEmpty { f(u); return true }
        return super.performDragOperation(s)
    }
}

final class FenetreSession: NSObject, WKNavigationDelegate, WKUIDelegate {
    static let hauteurBarre: CGFloat = 28
    /// Marge gauche du titre dans la page : les feux macOS sont au-dessus de la barre latérale.
    static let largeurFeux: CGFloat = 16

    private weak var session: Session?
    /// Session du Victus (VictusSession.swift) : la page parle au démon par le lien ssh, pas à un processus local.
    private(set) weak var distante: VictusSession?
    let vue: NSView
    private(set) var web: WKWebView!
    private let page: URL
    private let lecture: URL
    private var libere = false

    var sessionLiee: Session? { session }
    /// Identifiant de la session affichée, du Mac ou du Victus.
    var idSession: String? { session?.sessionId ?? distante?.sessionId }
    var estVictus: Bool { distante != nil }
    var window: NSWindow { FenetrePrincipale.shared.window }
    var estDevant: Bool {
        let w = FenetrePrincipale.shared.window
        return w.isKeyWindow && w.isVisible && FenetrePrincipale.shared.estChoisie(self)
    }

    convenience init(session s: Session) { self.init(session: s, distante: nil) }
    convenience init(distante d: VictusSession) { self.init(session: nil, distante: d) }

    private init(session s: Session?, distante d: VictusSession?) {
        session = s
        distante = d
        (page, lecture) = Page.choisir()
        vue = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 780))
        super.init()
        vue.wantsLayer = true
        vue.layer?.backgroundColor = NSColor(srgbRed: 0x11/255.0, green: 0x12/255.0, blue: 0x16/255.0, alpha: 1).cgColor

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(RelaisMessages(self), name: "bt")
        // images, vidéos et sons cités dans le fil (btmedia://, Medias.swift) ; du Victus : copiés par ssh (VictusMedias.swift)
        Medias.installer(dans: cfg, gestionnaire: d != nil ? VictusMedias.gestionnaire : nil)
        Apercu.installer(dans: cfg)   // aperçus html / svg / mermaid du fil (btapercu://, Apercu.swift)
        // Tests d'intégration seulement (BT_DEV_PILOTE posé au lancement) : voir PiloteDev.swift.
        if let js = PiloteDev.scriptInjecte() {
            cfg.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        cfg.preferences.isElementFullscreenEnabled = false
        let vw = VueWebSession(frame: vue.bounds, configuration: cfg)
        vw.surFichiers = { [weak self] urls in
            if let d = self?.distante { d.fichiersRecus(urls, origine: "depot") } else { self?.session?.fichiersRecus(urls, origine: "depot") }
        }
        web = vw
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.allowsLinkPreview = false
        if #available(macOS 13.3, *) { web.isInspectable = true }   // clic droit → Inspecter l'élément
        // Tests (BT_DEV_PILOTE) : la fenêtre reste derrière celles d'Eliot ; sans ceci WebKit la croit cachée
        // (document.hidden) et suspend rendu, animations et défilement doux.
        if PiloteDev.actif, web.responds(to: Selector(("_setWindowOcclusionDetectionEnabled:"))) {
            web.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        vue.addSubview(web)
        journal("session : page \(page.path)")
        web.loadFileURL(page, allowingReadAccessTo: lecture)
    }

    /// Nouvelle session : elle entre dans la barre latérale et devient la session affichée.
    func montrer() {
        FenetrePrincipale.shared.ajouter(self)
        if FenetrePrincipale.shared.doitPasserDevant(self) { mettreDevant() } else { FenetrePrincipale.shared.montrer() }
    }

    func mettreDevant() {
        FenetrePrincipale.shared.selectionner(self)
        FenetrePrincipale.shared.montrer()
    }

    func recharger() {
        pageDechargee()
        web.reloadFromOrigin()
    }

    func fermerFenetre() { if let d = distante { d.fermer() } else { session?.fermer() } }

    private func pageDechargee() { if let d = distante { d.pageDechargee() } else { session?.pageDechargee() } }

    func marquerDansTerminal() { FenetrePrincipale.shared.planifierMaj() }

    /// Fin de vie : coupe le pont et la page (après l'arrêt du processus), puis quitte la fenêtre.
    func liberer() {
        guard !libere else { return }
        libere = true
        web.configuration.userContentController.removeScriptMessageHandler(forName: "bt")
        web.navigationDelegate = nil
        web.uiDelegate = nil
        web.stopLoading()
        FenetrePrincipale.shared.retirer(self)
    }

    // MARK: - Swift → page

    /// Un lot d'appels `bt.<fonction>(argument)`, passés en arguments (aucune chaîne JavaScript fabriquée).
    func executer(_ lot: [[Any]]) {
        guard !libere else { return }
        let corps = """
        const bt = window.bt;
        if (!bt) { console.warn('window.bt absent'); return 0; }
        let n = 0;
        for (const [f, a] of lot) {
          try { if (typeof bt[f] === 'function') { bt[f](a); n++; } else console.warn('bt.' + f + ' absent'); }
          catch (e) { console.error('bt.' + f, e); }
        }
        return n;
        """
        web.callAsyncJavaScript(corps, arguments: ["lot": lot], in: nil, in: .page) { r in
            if case .failure(let e) = r { journal("page : lot de \(lot.count) appels en échec — \(e.localizedDescription)") }
        }
    }

    /// `bt.envoyerTexte(texte, {source})` si la page la définit ; `fini(false)` sinon (la session écrit alors elle-même).
    func appelerEnvoyerTexte(_ texte: String, source: String, _ fini: @escaping (Bool) -> Void) {
        guard !libere else { fini(false); return }
        let corps = """
        if (window.bt && typeof window.bt.envoyerTexte === 'function') { await window.bt.envoyerTexte(texte, { source }); return true; }
        return false;
        """
        web.callAsyncJavaScript(corps, arguments: ["texte": texte, "source": source], in: nil, in: .page) { r in
            switch r {
            case .success(let v): fini((v as? Bool) ?? ((v as? NSNumber)?.boolValue ?? false))
            case .failure(let e): journal("page : envoyerTexte en échec — \(e.localizedDescription)"); fini(false)
            }
        }
    }

    /// `bt.<nom>(argument)` si la page définit cette fonction (attendue si elle renvoie une promesse) ;
    /// `fini(false)` sinon, pour que la session prenne le relais.
    func appelerFonction(_ nom: String, _ argument: [String: Any], _ fini: @escaping (Bool) -> Void) {
        guard !libere else { fini(false); return }
        let corps = """
        if (window.bt && typeof window.bt[nom] === 'function') { await window.bt[nom](arg); return true; }
        return false;
        """
        web.callAsyncJavaScript(corps, arguments: ["nom": nom, "arg": argument], in: nil, in: .page) { r in
            switch r {
            case .success(let v): fini((v as? Bool) ?? ((v as? NSNumber)?.boolValue ?? false))
            case .failure(let e): journal("page : bt.\(nom) en échec — \(e.localizedDescription)"); fini(false)
            }
        }
    }

    /// Pilote de développement uniquement (PiloteDev, actif seulement avec BT_DEV_PILOTE).

    /// Pilote : image PNG de la vue web telle qu'elle est rendue dans la fenêtre (taille réelle), pour vérifier
    /// un changement visible sans capture d'écran du système.
    func capturerDev(_ chemin: String, _ fini: @escaping (Bool, Any) -> Void) {
        guard PiloteDev.actif, !libere else { fini(false, "pilote inactif ou vue absente"); return }
        web.takeSnapshot(with: nil) { image, erreur in
            guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { fini(false, erreur?.localizedDescription ?? "capture impossible"); return }
            do { try png.write(to: URL(fileURLWithPath: chemin)); fini(true, ["largeur": rep.pixelsWide, "hauteur": rep.pixelsHigh]) }
            catch { fini(false, error.localizedDescription) }
        }
    }

    func evaluerDev(_ code: String, _ fini: @escaping (Bool, Any) -> Void) {
        guard PiloteDev.actif, !libere else { fini(false, "pilote inactif ou fenêtre libérée"); return }
        web.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): fini(true, JSONSerialization.isValidJSONObject([v]) ? v : String(describing: v))
            case .failure(let e): fini(false, e.localizedDescription)
            }
        }
    }

    // MARK: - Page → Swift

    func messageDeLaPage(_ m: WKScriptMessage) {
        // seulement le cadre principal, seulement notre page
        guard m.frameInfo.isMainFrame, let u = m.frameInfo.request.url, u.isFileURL,
              u.standardizedFileURL.path == page.standardizedFileURL.path else {
            journal("pont : message refusé (cadre \(m.frameInfo.request.url?.absoluteString ?? "?"))"); return
        }
        if let d = distante { d.recevoir(m.body) } else { session?.recevoir(m.body) }
    }

    // MARK: - Navigation : la vue ne quitte jamais sa page

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let u = action.request.url
        let principal = action.targetFrame?.isMainFrame ?? true
        if let u, u.isFileURL, u.standardizedFileURL.path == page.standardizedFileURL.path { decisionHandler(.allow); return }
        if !principal, let u, u.scheme == "about" { decisionHandler(.allow); return }
        if !principal, let u, u.scheme == Apercu.schema, u.host == "app", u.path == "/apercu.html" { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, let u, ["http", "https"].contains(u.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(u)   // un lien cliqué s'ouvre dans le navigateur, jamais dans la vue
        } else {
            journal("navigation bloquée : \(u?.absoluteString.prefix(200) ?? "?")")
        }
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url, ["http", "https"].contains(u.scheme?.lowercased() ?? ""), action.navigationType == .linkActivated {
            NSWorkspace.shared.open(u)
        }
        return nil
    }

    func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) { pageDechargee() }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
        journal("page : processus WebKit terminé, rechargement")
        pageDechargee()
        w.reload()
    }

    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { journal("page : échec — \(e.localizedDescription)") }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { journal("page : échec de chargement — \(e.localizedDescription)") }

    /// Bouton « joindre une image » : <input type=file> n'ouvre rien sans ce délégué. Images seulement.
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let o = NSOpenPanel()
        o.canChooseFiles = true
        o.canChooseDirectories = false
        o.allowsMultipleSelection = p.allowsMultipleSelection
        o.message = "Choisis les fichiers à envoyer à Claude"
        o.beginSheetModal(for: window) { r in completionHandler(r == .OK ? o.urls : nil) }
    }

    /// Bouton « joindre » de la page : panneau natif, tout type de fichier et dossiers, chemins réels.
    func choisirFichiers(_ fini: @escaping ([URL]) -> Void) {
        let o = NSOpenPanel()
        o.canChooseFiles = true
        o.canChooseDirectories = true
        o.allowsMultipleSelection = true
        o.message = "Choisis les fichiers ou dossiers à envoyer à Claude"
        o.prompt = "Joindre"
        o.beginSheetModal(for: window) { r in if r == .OK { fini(o.urls) } }
    }

    // Les alert()/confirm() de la page ne bloquent pas la fenêtre en silence.
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = msg; a.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = msg; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Annuler")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

}
