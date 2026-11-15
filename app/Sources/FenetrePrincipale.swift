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
    /// Relevé CPU / RAM / disque du pied de la barre (Systeme.swift), toutes les 3 s quand la fenêtre est visible.
    private var minuterieSysteme: Timer?
    private let fileSysteme = DispatchQueue(label: "local.eliot.betterterminal.systeme", qos: .utility)
    private var majPrevue = false
    private var dejaMontree = false
    /// La conversation Telegram avec Jarvis est affichée (alors `selection` vaut nil).
    private(set) var jarvisDevant = false

    // MARK: Page affichée gardée d'un lancement à l'autre (demande d'Eliot, 09/11/2026)
    // « BTPageAffichee » = id de la session affichée, ou « jarvis ». Pendant la réouverture des sessions,
    // les sessions qui arrivent ne passent plus devant : seule la page mémorisée reprend sa place.
    private static let clePage = "BTPageAffichee"
    private var pageAReprendre: String?
    private var restauration = false

    /// Appelé par RegistreSessions.rouvrirDernieres() avant d'ouvrir les sessions.
    func debuterRestauration() {
        pageAReprendre = Reglages.texte(Self.clePage)
        restauration = true
        // Filet : si la page mémorisée n'existe plus, on garde ce qui est affiché et on reprend la mémoire normale.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [self] in
            guard restauration else { return }
            restauration = false; pageAReprendre = nil; memoriserPage()
        }
        if pageAReprendre == "jarvis" { reprendreJarvis(essai: 0) }
    }

    private func reprendreJarvis(essai: Int) {
        guard restauration, pageAReprendre == "jarvis" else { return }
        if ConversationJarvis.shared.disponible { selectionnerJarvis(); finirRestauration(); return }
        if essai < 16 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in reprendreJarvis(essai: essai + 1) } }
    }

    private func finirRestauration() {
        // Les autres sessions rouvertes juste après ne doivent pas voler la place : on garde la fenêtre de 10 s,
        // mais la page est trouvée, donc plus rien à attendre.
        pageAReprendre = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [self] in restauration = false; memoriserPage() }
    }

    /// Une session qui vient de s'ouvrir passe-t-elle devant ? Oui, sauf pendant la réouverture au lancement
    /// (alors seule la session mémorisée passe devant).
    func doitPasserDevant(_ v: FenetreSession) -> Bool {
        guard restauration else { return true }
        if let id = v.idSession, id == pageAReprendre { return true }
        return false
    }

    private func memoriserPage() {
        guard !restauration, !RegistreSessions.shared.quitte, !PiloteDev.actif else { return }
        if jarvisDevant { Reglages.mettre("jarvis", Self.clePage) }
        else if let id = selection?.idSession { Reglages.mettre(id, Self.clePage) }
    }

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
        NotificationCenter.default.addObserver(self, selector: #selector(registreChange(_:)), name: VictusLien.changement, object: nil)
    }

    // MARK: - Sessions

    func ajouter(_ v: FenetreSession) {
        guard !vues.contains(where: { $0 === v }) else { return }
        // sessions du Mac d'abord, puis celles du Victus (même ordre que la barre)
        if !v.estVictus, let i = vues.firstIndex(where: { $0.estVictus }) { vues.insert(v, at: i) } else { vues.append(v) }
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
        if let id = v.idSession { nonLues.remove(id) }
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
        if let id = v.idSession { nonLues.remove(id) }
        v.sessionLiee?.marquerActivee()
        window.makeFirstResponder(v.web)
        planifierMaj()
        if restauration, let id = v.idSession, id == pageAReprendre { finirRestauration() }
        memoriserPage()
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
        memoriserPage()
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
    func fermerSelection() { selection?.fermerFenetre() }

    /// ⌘1…⌘9, dans l'ordre de la barre (sessions du Mac, puis du Victus, ouvertes ou non dans l'app).
    func choisir(numero n: Int) {
        let o = ordre()
        guard n >= 1, n <= o.count else { return }
        switch o[n - 1] {
        case .vue(let v): selectionner(v)
        case .victus(let id): VictusSession.montrer(id)
        }
        montrer()
    }

    /// Une session du Victus vient de finir un tour : « Réponse prête » si Eliot ne la regarde pas.
    func marquerNonLu(_ id: String, vue: FenetreSession) {
        guard !(selection === vue && window.isKeyWindow && NSApp.isActive) else { return }
        nonLues.insert(id)
        planifierMaj()
    }

    // MARK: - Ordre de la barre : Mac, puis Victus

    private enum Entree { case vue(FenetreSession), victus(String) }

    private func ordre() -> [Entree] {
        let mac = vues.filter { !$0.estVictus && !($0.sessionLiee?.estFermee ?? true) }
        let distantes = vues.filter(\.estVictus)
        var o: [Entree] = mac.map { .vue($0) }
        var vus = Set<String>()
        for s in VictusLien.shared.sessions {
            guard let id = (s["id"] as? String)?.lowercased(), vus.insert(id).inserted else { continue }
            if let v = distantes.first(where: { $0.idSession == id }) { o.append(.vue(v)) } else { o.append(.victus(id)) }
        }
        // vues ouvertes dont le démon n'a pas (encore) parlé : à la fin
        for v in distantes where !vus.contains(v.idSession ?? "") { o.append(.vue(v)) }
        return o
    }

    /// Session suivante (+1) ou précédente (-1), en boucle.
    func decaler(_ pas: Int) {
        guard !vues.isEmpty else { return }
        let liste: [FenetreSession] = ordre().compactMap { if case .vue(let v) = $0 { return v }; return nil }
        guard !liste.isEmpty else { return }
        if jarvisDevant { selectionner(liste[pas > 0 ? 0 : liste.count - 1]); return }
        let i = liste.firstIndex { $0 === selection } ?? 0
        selectionner(liste[(i + pas + liste.count) % liste.count])
    }

    // MARK: - Barre latérale

    @objc private func registreChange(_ n: Notification) { planifierMaj() }

    @objc private func tourTermine(_ n: Notification) {
        guard let id = n.userInfo?["sessionId"] as? String,
              let v = vues.first(where: { $0.idSession == id }) else { return }
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
        if let d = selection?.distante {
            window.title = d.emoji + " " + d.projet + " — Victus" + (d.dansTerminal ? " (dans le terminal)" : "")
            return
        }
        guard let s = selection?.sessionLiee else { window.title = "Jarvis Terminal"; return }
        window.title = s.projet.emoji + " " + s.projet.nom + (s.apercu.dansTerminal ? " — dans le Terminal" : "")
    }

    private func envoyerListe() {
        majTitre()
        guard barrePrete, let barre else { return }
        let lien = VictusLien.shared
        let liste: [[String: Any]] = ordre().enumerated().compactMap { i, e in
            switch e {
            case .vue(let v):
                if let s = v.sessionLiee {
                    guard !s.estFermee else { return nil }
                    let a = s.apercu
                    return ["id": a.sessionId, "numero": i + 1, "projet": a.projet, "emoji": a.emoji, "cwd": a.cwd,
                            "etat": a.etat, "resume": a.resume ?? NSNull(), "dernierMessage": a.dernierMessage ?? NSNull(),
                            "modele": a.modele ?? NSNull(), "dansTerminal": a.dansTerminal,
                            "maj": a.maj.timeIntervalSince1970 * 1000, "actif": selection === v, "nonLu": nonLues.contains(a.sessionId),
                            "machine": "mac"]
                }
                guard let d = v.distante else { return nil }
                return entreeVictus(d.apercu ?? ["id": d.sessionId, "projet": d.projet, "emoji": d.emoji, "cwd": d.cwd, "etat": "pret"],
                                    numero: i + 1, actif: selection === v, ouverte: true, connecte: lien.connecte)
            case .victus(let id):
                guard let a = lien.session(id) else { return nil }
                return entreeVictus(a, numero: i + 1, actif: false, ouverte: false, connecte: lien.connecte)
            }
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
        let machines: [String: Any] = ["victus": [
            "configure": VictusSsh.configure, "etat": lien.etat.rawValue, "erreur": lien.derniereErreur ?? NSNull()
        ] as [String: Any]]
        barre.callAsyncJavaScript("if (window.barreSessions) window.barreSessions.maj(liste, jarvis, machines);",
                                  arguments: ["liste": liste + fermetures, "jarvis": jarvis, "machines": machines], in: nil, in: .page) { r in
            if case .failure(let e) = r { journal("barre : mise à jour en échec — \(e.localizedDescription)") }
        }
    }

    /// Une session du Victus dans la barre : les champs du démon, plus l'encadré « Ultron » et l'état du lien.
    private func entreeVictus(_ a: [String: Any], numero: Int, actif: Bool, ouverte: Bool, connecte: Bool) -> [String: Any] {
        var e: [String: Any] = ["numero": numero, "actif": actif, "machine": "victus", "ouverte": ouverte, "indisponible": !connecte]
        for k in ["id", "projet", "emoji", "cwd", "etat", "resume", "dernierMessage", "modele", "effort", "dansTerminal", "maj"] {
            e[k] = a[k] ?? NSNull()
        }
        if let id = a["id"] as? String { e["id"] = id.lowercased(); e["nonLu"] = nonLues.contains(id.lowercased()) }
        if !(a["maj"] is NSNumber) { e["maj"] = NSNull() }
        if !(a["dansTerminal"] is Bool) { e["dansTerminal"] = false }
        return e
    }

    /// `window.barreSessions.<fonction>(argument)` si la barre la définit.
    private func appelerBarre(_ fonction: String, _ argument: Any) {
        guard barrePrete, let barre else { return }
        barre.callAsyncJavaScript("const b = window.barreSessions; if (b && typeof b[f] === 'function') b[f](a);",
                                  arguments: ["f": fonction, "a": argument], in: nil, in: .page) { r in
            if case .failure(let e) = r { journal("barre : \(fonction) en échec — \(e.localizedDescription)") }
        }
    }

    func messageBarre(_ m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, let u = m.frameInfo.request.url, u.isFileURL, let p = pageBarre,
              u.standardizedFileURL.path == p.standardizedFileURL.path,
              let o = m.body as? [String: Any], let type = o["type"] as? String else {
            journal("barre : message refusé"); return
        }
        let idDemande = (o["id"] as? String).flatMap { Validation.sessionId($0) ? $0.lowercased() : nil }
        func cible() -> FenetreSession? {
            guard let id = idDemande else { return nil }
            return vues.first { $0.idSession == id }
        }
        let victus = o["machine"] as? String == "victus"
        switch type {
        case "pret": barrePrete = true; envoyerListe(); demarrerSysteme()
        case "choisir":
            if let v = cible() { selectionner(v) }
            else if let id = idDemande, VictusLien.shared.session(id) != nil { VictusSession.montrer(id) }
        case "jarvis": selectionnerJarvis()
        case "fermer":
            if let v = cible() { v.fermerFenetre() }
            else if let id = idDemande, VictusLien.shared.session(id) != nil {
                // session du Victus jamais ouverte dans l'app : le démon l'arrête directement
                VictusLien.shared.envoyer(["op": "fermer", "sessionId": id])
            }
        case "nouvelle" where victus:
            guard let cwd = o["cwd"] as? String else { journal("barre : nouvelle session Victus sans dossier"); return }
            let home = VictusLien.shared.home
            let c = cwd.hasPrefix("~/") ? home + cwd.dropFirst(1) : (cwd == "~" ? home : cwd)
            guard c.hasPrefix("/"), c == home || c.hasPrefix(home + "/"), !c.contains("\0"), c.utf8.count <= 4096,
                  !c.split(separator: "/").contains("..") else {
                appelerBarre("erreur", "Le dossier doit être sous \(home)."); return
            }
            VictusSession.nouvelle(cwd: c) { [weak self] err in
                if let err { self?.appelerBarre("erreur", "Victus : \(err)") } else { self?.appelerBarre("ouverte", c) }
            }
        case "nouvelle": Entrees.choisirDossier()
        case "dossiers":
            VictusLien.shared.requete(["op": "dossiers"], delai: 20) { [weak self] r in
                if r["ev"] as? String == "dossiers", let l = r["liste"] as? [[String: Any]] {
                    let propres: [[String: Any]] = l.prefix(200).compactMap { d in
                        guard let c = d["cwd"] as? String, c.hasPrefix("/") else { return nil }
                        return ["cwd": c, "nom": d["nom"] as? String ?? (c as NSString).lastPathComponent, "maj": d["maj"] ?? NSNull()]
                    }
                    self?.appelerBarre("dossiers", ["liste": propres, "home": VictusLien.shared.home])
                } else {
                    self?.appelerBarre("dossiers", ["liste": [], "home": VictusLien.shared.home,
                                                    "erreur": r["message"] as? String ?? "Le Victus ne répond pas."])
                }
            }
        case "discussion": Entrees.nouvelleDiscussion()
        default: journal("barre : type inconnu « \(type.prefix(30)) »")
        }
    }

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, u.isFileURL, let p = pageBarre, u.standardizedFileURL.path == p.standardizedFileURL.path {
            decisionHandler(.allow); return
        }
        decisionHandler(.cancel)
    }

    // MARK: - Machine (pied de la barre)
    private func demarrerSysteme() {
        envoyerSysteme()
        guard minuterieSysteme == nil else { return }
        let t = Timer(timeInterval: 3, repeats: true) { [weak self] _ in self?.envoyerSysteme() }
        t.tolerance = 1
        RunLoop.main.add(t, forMode: .common)
        minuterieSysteme = t
    }

    private func envoyerSysteme() {
        guard barrePrete, window.isVisible, window.occlusionState.contains(.visible) || PiloteDev.actif else { return }
        fileSysteme.async {
            let r = Systeme.shared.releve()
            DispatchQueue.main.async { [weak self] in
                guard let self, self.barrePrete, let barre = self.barre else { return }
                barre.callAsyncJavaScript("if (window.systemeBarre) window.systemeBarre.maj(r);", arguments: ["r": r], in: nil, in: .page) { _ in }
            }
        }
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
        selection?.sessionLiee?.marquerActivee()
        if let id = selection?.idSession, nonLues.remove(id) != nil { planifierMaj() }
    }

    /// Le bouton rouge cache la fenêtre sans tuer les sessions (⌘W ferme une session, ⌘Q quitte tout).
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        window.orderOut(nil)
        return false
    }
}
