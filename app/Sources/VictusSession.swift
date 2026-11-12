import AppKit

/// Une session du Victus affichée dans l'app Mac (victus/CONTRAT-VICTUS.md, 12/11/2026).
/// Joue pour FenetreSession le rôle de Session.swift, mais ne lance rien : la session vit dans le démon
/// `ultron-moteur` du Victus. Les messages de la page partent en `op page` sur le canal de la session, les appels
/// `ev page` reviennent en `bt.<fonction>(argument)`. Les actions locales restent sur le Mac : copier, ouvrir un lien,
/// terminal et shell (par ssh), fichiers joints (copiés sur le Victus avant d'être cités).
final class VictusSession: VictusCanal {
    private static var ouvertes: [String: VictusSession] = [:]
    static func existante(_ id: String) -> VictusSession? { ouvertes[id.lowercased()] }

    let sessionId: String
    private var cwdConnu: String
    private(set) var fenetre: FenetreSession!
    private var canal: String?
    private var pagePrete = false
    /// La page a dit `pret` alors que le lien était coupé : on le relaiera dès qu'un canal existe.
    private var pretEnAttente = false
    private var file: [[Any]] = []
    private var vidagePrevu = false
    private(set) var fermee = false
    /// La session a figuré dans une liste du démon : si elle en disparaît, elle a été fermée ailleurs.
    private var vueDansListe = false
    private var avertiCoupure = false
    /// Textes à envoyer (Jarvis, `betterterminal://envoyer`) quand la page sera prête.
    private var envoisEnAttente: [(texte: String, source: String)] = []
    private var etatPrecedent: String?

    var apercu: [String: Any]? { VictusLien.shared.session(sessionId) }
    var cwd: String { apercu?["cwd"] as? String ?? cwdConnu }
    var projet: String { apercu?["projet"] as? String ?? ((cwd as NSString).lastPathComponent.isEmpty ? "Victus" : (cwd as NSString).lastPathComponent) }
    var emoji: String { apercu?["emoji"] as? String ?? "🖥️" }
    var dansTerminal: Bool { apercu?["dansTerminal"] as? Bool ?? false }

    // MARK: - Ouverture

    /// Montre la vue d'une session du démon (créée au besoin).
    @discardableResult
    static func montrer(_ id: String, cwd: String? = nil, devant: Bool = true) -> VictusSession? {
        guard VictusLien.idValide(id) else { return nil }
        let i = id.lowercased()
        if let s = ouvertes[i] { if devant { s.fenetre.mettreDevant() }; return s }
        let c = cwd ?? VictusLien.shared.session(i)?["cwd"] as? String ?? VictusLien.shared.home
        let s = VictusSession(id: i, cwd: c)
        s.fenetre.montrer()
        return s
    }

    /// Nouvelle session sur le Victus (`op ouvrir`), puis sa vue. `fini(nil)` si tout va bien, sinon le message d'erreur.
    static func nouvelle(cwd: String, resume: String? = nil, prompt: String? = nil, modele: String? = nil, effort: String? = nil,
                         fini: ((String?) -> Void)? = nil) {
        let o: [String: Any] = ["op": "ouvrir", "cwd": cwd, "resume": resume ?? NSNull(), "prompt": prompt ?? NSNull(),
                                "modele": modele ?? NSNull(), "effort": effort ?? NSNull()]
        VictusLien.shared.requete(o, delai: 40) { r in
            if r["ev"] as? String == "ouverte", let id = r["sessionId"] as? String, VictusLien.idValide(id) {
                journal("victus : session \(id) ouverte dans \(cwd)")
                montrer(id, cwd: cwd)
                fini?(nil)
            } else {
                let m = extrait(r["message"] as? String ?? "réponse inattendue", 300)
                journal("victus : ouverture refusée dans \(cwd) — \(m)")
                fini?(m)
            }
        }
    }

    private init(id: String, cwd: String) {
        sessionId = id
        cwdConnu = cwd
        Self.ouvertes[id] = self
        fenetre = FenetreSession(distante: self)
        NotificationCenter.default.addObserver(self, selector: #selector(lienChange(_:)), name: VictusLien.changement, object: nil)
        vueDansListe = apercu != nil
        etatPrecedent = apercu?["etat"] as? String
        canal = VictusLien.shared.attacher(self, sessionId: sessionId)
        journal("victus \(sessionId) : vue ouverte (\(canal ?? "en attente du lien"))")
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: - Lien → page

    func lienAppels(_ appels: [[Any]]) {
        for a in appels {
            guard a.count >= 1, let f = a[0] as? String else { continue }
            var arg: Any = a.count > 1 ? a[1] : NSNull()
            if f == "info", var i = arg as? [String: Any] {
                // la page se cale sur la barre de titre du Mac, pas sur celle de la fenêtre GTK
                i["barreTitre"] = ["hauteur": FenetreSession.hauteurBarre, "gauche": FenetreSession.largeurFeux]
                i["machine"] = "victus"
                if let c = i["cwd"] as? String, c.hasPrefix("/") { cwdConnu = c }
                arg = i
            }
            pousser(f, arg)
        }
    }

    func lienCoupe() {
        canal = nil
        if pagePrete, !avertiCoupure {
            avertiCoupure = true
            pousser("stderr", "Connexion au Victus perdue. Nouvel essai automatique ; la session continue sur le Victus.\n")
        }
        _ = VictusLien.shared.attacher(self, sessionId: sessionId)   // rattachée au retour du lien
        FenetrePrincipale.shared.planifierMaj()
    }

    func lienRecharger() {
        guard !fermee, pagePrete else { return }
        journal("victus \(sessionId) : reprise ici, page rechargée")
        fenetre.recharger()
    }

    func lienRetabli() {
        guard !fermee else { return }
        canal = VictusLien.shared.attacher(self, sessionId: sessionId)
        guard canal != nil else { return }
        avertiCoupure = false
        journal("victus \(sessionId) : rattachée (\(canal!))")
        if pagePrete {
            // la page a déjà un fil : elle repart de zéro et son `pret` redemande info + historique au démon
            fenetre.recharger()
        } else if pretEnAttente {
            pretEnAttente = false
            relayer(["type": "pret"])
        }
    }

    @objc private func lienChange(_ n: Notification) {
        guard !fermee else { return }
        let l = VictusLien.shared
        if let a = apercu {
            vueDansListe = true
            let e = a["etat"] as? String
            // fin de tour pendant qu'Eliot regarde ailleurs : « Réponse prête » dans la barre
            if etatPrecedent == "travaille", e == "pret" || e == "attend" { FenetrePrincipale.shared.marquerNonLu(sessionId, vue: fenetre) }
            etatPrecedent = e
        } else if l.connecte, vueDansListe {
            journal("victus \(sessionId) : fermée sur le Victus, vue retirée")
            liberer()
        }
    }

    // MARK: - Page → lien

    func recevoir(_ corps: Any) {
        guard let o = corps as? [String: Any], let type = o["type"] as? String else { return }
        switch type {
        case "pret":
            pagePrete = true
            file.removeAll()
            if canal != nil { relayer(o) } else {
                pretEnAttente = true
                pousser("stderr", VictusLien.shared.etat == .connexion
                        ? "Connexion au Victus…\n"
                        : "Victus injoignable : la session s'affichera dès le retour de la connexion.\n")
            }
            if !envoisEnAttente.isEmpty, canal != nil {
                let e = envoisEnAttente; envoisEnAttente.removeAll()
                // laisser à la page le temps de recevoir info + historique
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in e.forEach { _ = self?.envoyerTexte($0.texte, source: $0.source) } }
            }
        case "copier":
            guard let t = o["texte"] as? String, t.utf8.count <= 20_000_000 else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(t, forType: .string)
        case "ouvrirLien":
            guard let s = o["url"] as? String, let u = URL(string: s), let sc = u.scheme?.lowercased(),
                  sc == "http" || sc == "https", u.host?.isEmpty == false else { return }
            NSWorkspace.shared.open(u)
        case "ouvrirShell": ouvrirShell()
        case "ouvrirTerminal": ceder()
        case "fermer": fermer()
        case "choisirFichiers":
            fenetre.choisirFichiers { [weak self] u in self?.fichiersRecus(u, origine: "bouton") }
        case "collerFichiers":
            fichiersRecus(VueWebSession.urls(NSPasteboard.general), origine: "collage")
        case "enregistrerPiece":
            guard let nom = o["nom"] as? String, let b64 = o["donnees"] as? String, b64.utf8.count <= 60_000_000,
                  let data = Data(base64Encoded: b64) else { return }
            var propre = (nom as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "-")
            if propre.isEmpty || propre.hasPrefix(".") || propre.utf8.count > 200 { propre = "fichier" }
            let dossier = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("local.eliot.betterterminal/pieces/\(UUID().uuidString.prefix(8).lowercased())")
            do {
                try FileManager.default.createDirectory(at: dossier, withIntermediateDirectories: true)
                let u = dossier.appendingPathComponent(propre)
                try data.write(to: u)
                fichiersRecus([u], origine: "copie")
            } catch { journal("victus \(sessionId) : pièce non écrite — \(error.localizedDescription)") }
        case "montrerFichier", "dictee", "vocal", "vocalPret", "vocalAnnule", "modeVocal":
            // fichier du Victus (pas de Finder ici), vocal et dictée : pas sur le Victus dans cette version
            journal("victus \(sessionId) : « \(type) » ignoré (session du Victus)")
        default:
            relayer(o)
        }
    }

    private func relayer(_ message: [String: Any]) {
        guard let c = canal, VictusLien.shared.envoyer(["op": "page", "canal": c, "message": message]) else {
            if message["type"] as? String == "versClaude" {
                pousser("stderr", "Victus injoignable : message non envoyé.\n")
            }
            return
        }
    }

    // MARK: - File vers la page (même principe que Session : lots, ordre conservé)

    private func pousser(_ fonction: String, _ argument: Any) {
        guard pagePrete else { return }
        file.append([fonction, argument])
        if !vidagePrevu {
            vidagePrevu = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.008) { [weak self] in self?.vider() }
        }
    }

    private func vider() {
        vidagePrevu = false
        guard pagePrete, !file.isEmpty else { return }
        let lot = file
        file = []
        fenetre.executer(lot)
    }

    /// ⌘R, processus WebKit mort : on attend le prochain `pret` (le démon traite un second `pret` comme un rechargement).
    func pageDechargee() {
        pagePrete = false
        file.removeAll()
    }

    // MARK: - Envoi d'un texte (Jarvis, betterterminal://envoyer)

    @discardableResult
    func envoyerTexte(_ texte: String, source: String) -> Bool {
        guard !fermee else { return false }
        guard pagePrete, canal != nil else { envoisEnAttente.append((texte, source)); return true }
        vider()
        fenetre.appelerEnvoyerTexte(texte, source: source) { [weak self] ok in
            if !ok, let self, let l = ClaudeArgs.messageUtilisateur(texte) { self.relayer(["type": "versClaude", "ligne": l]) }
        }
        return true
    }

    // MARK: - Fichiers joints : copiés sur le Victus, cités par leur chemin là-bas

    func fichiersRecus(_ urls: [URL], origine: String) {
        let locaux = Array(urls.prefix(40).filter(\.isFileURL))
        guard !locaux.isEmpty else { pousser("fichiers", ["origine": origine, "liste": []]); return }
        guard VictusLien.shared.connecte else { pousser("stderr", "Victus injoignable : fichiers non envoyés.\n"); return }
        let dossier = VictusLien.shared.home + "/.cache/jarvis-terminal-mac/pieces/" + UUID().uuidString.prefix(8).lowercased()
        let id = sessionId
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let images: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]
            var liste: [[String: Any]] = []
            var echecs: [String] = []
            _ = VictusSsh.executer("mkdir -p -- \(shq(dossier))", delai: 20)
            for u in locaux {
                let v = try? u.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentTypeKey])
                let estDossier = v?.isDirectory ?? false
                let nom = u.lastPathComponent
                let distant = dossier + "/" + nom
                let ok: Bool
                if estDossier {
                    // tar du Mac vers tar du Victus : un dossier entier en un aller-retour
                    let tar = Process()
                    tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
                    tar.arguments = ["-C", u.deletingLastPathComponent().path, "-cf", "-", nom]
                    tar.environment = ["COPYFILE_DISABLE": "1"]
                    let tuyau = Pipe(); tar.standardOutput = tuyau; tar.standardError = FileHandle.nullDevice
                    if (try? tar.run()) == nil { ok = false } else {
                        let r = VictusSsh.executer("tar -xf - -C \(shq(dossier)) 2>/dev/null", entree: tuyau.fileHandleForReading, delai: 600)
                        tar.waitUntilExit()
                        ok = r.code == 0 && tar.terminationStatus == 0
                    }
                } else if let h = FileHandle(forReadingAtPath: u.path) {
                    ok = VictusSsh.executer("cat > \(shq(distant))", entree: h, delai: 600).code == 0
                    try? h.close()
                } else { ok = false }
                guard ok else { echecs.append(nom); continue }
                let mime = v?.contentType?.preferredMIMEType ?? ""
                var d: [String: Any] = ["chemin": distant, "nom": nom, "dossier": estDossier, "mime": mime]
                if let t = v?.fileSize { d["taille"] = t }
                if !estDossier, images.contains(mime), (v?.fileSize ?? .max) <= 25_000_000, let data = try? Data(contentsOf: u) {
                    d["donnees"] = data.base64EncodedString()
                }
                liste.append(d)
            }
            DispatchQueue.main.async {
                guard let self else { return }
                journal("victus \(id) : \(liste.count) fichier(s) copié(s) sur le Victus (\(origine))\(echecs.isEmpty ? "" : ", échecs : \(echecs.joined(separator: ", "))")")
                if !echecs.isEmpty { self.pousser("stderr", "Copie sur le Victus impossible : \(echecs.joined(separator: ", "))\n") }
                self.pousser("fichiers", ["origine": origine, "liste": liste])
            }
        }
    }

    // MARK: - Terminal et shell par ssh

    private func ouvrirShell() {
        let hote = VictusSsh.hote
        let cmd = "ssh -t " + shq(hote) + " " + shq("cd " + shq(cwd) + " && exec \"${SHELL:-/bin/bash}\" -l")
        ouvrirDansTerminal(cmd, quoi: "shell")
    }

    /// « Continuer dans le terminal » : le démon arrête claude (`ceder`), puis Terminal.app reprend la conversation par ssh.
    /// « Continuer dans le terminal » : le démon arrête claude (op `ceder`), puis répond `cede` ;
    /// alors seulement Terminal.app reprend la même conversation par ssh (jamais deux claude dessus).
    private func ceder() {
        guard !fermee else { return }
        guard VictusLien.shared.connecte else {
            pousser("stderr", "Victus injoignable : impossible de passer dans le terminal.\n"); return
        }
        VictusLien.shared.requete(["op": "ceder", "sessionId": sessionId], delai: 15) { [weak self] r in
            guard let self else { return }
            guard r["ev"] as? String == "cede" else {
                self.pousser("stderr", "Passage dans le terminal refusé : \(r["message"] as? String ?? "réponse inattendue").\n"); return
            }
            let dossier = (r["cwd"] as? String).flatMap { $0.hasPrefix("/") ? $0 : nil } ?? self.cwd
            var claude = "~/.local/bin/claude"
            if let c = r["claude"] as? String, c.hasPrefix("/"), !c.contains("\0"), !c.contains("\n") { claude = shq(c) }
            // pas encore de transcript (session jamais lancée) : on crée la conversation sous le même identifiant
            let reprise = r["reprise"] as? Bool ?? true
            var cmd = "cd " + shq(dossier) + " && exec " + claude + " --dangerously-skip-permissions "
                + (reprise ? "--resume " : "--session-id ") + shq(self.sessionId)
            if let m = (r["modele"] as? String) ?? (self.apercu?["modele"] as? String), Validation.modele(m) { cmd += " --model " + shq(m) }
            self.ouvrirDansTerminal("ssh -t " + shq(VictusSsh.hote) + " " + shq(cmd), quoi: "terminal")
        }
    }

    private func ouvrirDansTerminal(_ cmd: String, quoi: String) {
        let id = sessionId
        DispatchQueue.global(qos: .userInitiated).async {
            let (ok, detail) = Terminal.ouvrir(cmd)
            DispatchQueue.main.async { [weak self] in
                journal("victus \(id) : \(quoi) → \(ok ? "ok" : "échec") \(detail) : \(cmd)")
                if !ok { self?.pousser("stderr", "Terminal n'a pas pu être ouvert (\(detail)).\n") }
            }
        }
    }

    // MARK: - Fin

    /// Croix, ⌘W : la session est arrêtée sur le Victus (`op fermer`), et la vue part.
    func fermer() {
        guard !fermee else { return }
        if !VictusLien.shared.envoyer(["op": "fermer", "sessionId": sessionId]) {
            journal("victus \(sessionId) : fermée hors connexion (la session continue sur le Victus)")
        }
        liberer()
    }

    /// Retire la vue sans toucher à la session du démon (fermée ailleurs, fin de l'app).
    func liberer() {
        guard !fermee else { return }
        fermee = true
        if let c = canal { VictusLien.shared.detacher(c) }
        canal = nil
        VictusLien.shared.oublier(self)
        Self.ouvertes.removeValue(forKey: sessionId)
        fenetre.liberer()
        FenetrePrincipale.shared.planifierMaj()
    }
}
