import AppKit

/// Ce qu'on demande à l'ouverture d'une session (URL, ligne de commande, ⌘N).
struct DemandeSession {
    var cwd: String
    var resume: String?
    var prompt: String?
    var modele: String?
    var effort: String?
}

/// Une session = une fenêtre + un processus claude + le pont avec la page.
/// La coque reste un tuyau : elle relaie les lignes et n'exécute que les actions prédéfinies du contrat.
/// Tout se passe sur le fil principal (les rappels du processus y sont ramenés).
final class Session {
    private(set) var sessionId: String
    let cwd: String
    let projet: InfoProjet
    private(set) var modele: String?
    private(set) var effort: String?
    private(set) var etat = "pret"
    private(set) var resume: String?
    private(set) var dernierMessage: String?
    private(set) var dansTerminal = false
    private(set) var maj = Date()
    private let repriseDemandee: Bool
    private var promptInitial: String?

    private var processus: ProcessusClaude?
    private var fenetre: FenetreSession!
    private var pagePrete = false
    private var dejaPrete = false
    private var demarre = false
    private var fermee = false
    /// Arrêt voulu par l'app ("relance", "terminal", "fermer") : le `bt.fin` habituel n'est pas envoyé.
    private var arretVoulu: String?
    private var attenteNotifiee = false
    private var questionsOuvertes: Set<String> = []
    /// Lignes `versClaude` reçues avant le lancement du processus (ou pendant une relance).
    private var avantLancement: [String] = []
    /// Fermeture avec bilan : nombre de fins de tour (`result`) encore attendues avant d'arrêter le processus.
    private var toursAvantArret: Int? = nil

    /// File d'appels vers la page, vidée par lots (un aller-retour WebKit par lot, ordre conservé).
    private var file: [[Any]] = []
    private var vidagePrevu = false
    /// Dernier `bt.vocalEtat` envoyé (on n'envoie que les changements).
    private var dernierVocalEtat: String?
    /// Dernière fois que la fenêtre est passée au premier plan (routage vocal « fenêtre au premier plan »).
    private(set) var derniereActivation = Date()

    var pid: Int32? { processus.flatMap { $0.fini ? nil : $0.pid } }

    var apercu: RegistreSessions.Apercu {
        .init(sessionId: sessionId, cwd: cwd, projet: projet.nom, emoji: projet.emoji, etat: etat, resume: resume,
              dernierMessage: dernierMessage, modele: modele, effort: effort, pid: pid, dansTerminal: dansTerminal, maj: maj)
    }

    init(_ d: DemandeSession) {
        cwd = d.cwd
        projet = RegistreProjets.info(cwd: d.cwd)
        if let r = d.resume { sessionId = r.lowercased(); repriseDemandee = true }
        else { sessionId = UUID().uuidString.lowercased(); repriseDemandee = false }
        modele = d.modele
        effort = d.effort
        promptInitial = d.prompt
        fenetre = FenetreSession(session: self)
        RegistreSessions.shared.ajouter(self)
        journal("session \(sessionId) : ouverte dans \(cwd) (\(projet.emoji) \(projet.nom))\(repriseDemandee ? " [reprise]" : "")")
        fenetre.montrer()
    }

    func mettreDevant() { fenetre.mettreDevant() }

    /// Pour le pilote de développement (PiloteDev) uniquement.
    var vueDev: FenetreSession { fenetre }

    // MARK: - Page → Swift

    /// Point d'entrée unique des messages de la page. Tout est validé ; rien d'autre n'est exécuté.
    func recevoir(_ corps: Any) {
        guard let o = corps as? [String: Any], let type = o["type"] as? String else { refuser("message sans type"); return }
        switch type {
        case "pret": surPret()
        case "versClaude":
            guard let l = o["ligne"] as? String, l.utf8.count <= 20_000_000, !l.contains("\n"), !l.contains("\r"),
                  let d = l.data(using: .utf8), (try? JSONSerialization.jsonObject(with: d)) is [String: Any]
            else { refuser("versClaude : ligne invalide"); return }
            if let p = processus, !p.fini, arretVoulu == nil {
                p.ecrire(l)
                journal("session \(sessionId) : → stdin \(l.utf8.count) o \(typeDe(l))")
            } else if !fermee, !dansTerminal, processus == nil || arretVoulu == "relance" {
                // claude pas encore lancé (environnement, lecture du transcript) ou en cours de relance :
                // la ligne est gardée et écrite dès que le processus est lancé (rien n'est perdu).
                avantLancement.append(l)
                journal("session \(sessionId) : en attente du lancement \(l.utf8.count) o \(typeDe(l))")
            } else {
                journal("session \(sessionId) : refusé — versClaude alors que le processus est arrêté")
                pousser("stderr", "Le processus claude est arrêté : message non envoyé.\n")
            }
        case "relancer":
            var m = modele, e = effort
            if let v = o["modele"] { if v is NSNull { m = nil } else if let s = v as? String, Validation.modele(s) { m = s } else { refuser("relancer : modele invalide"); return } }
            if let v = o["effort"] { if v is NSNull { e = nil } else if let s = v as? String, Validation.effort(s) { e = s } else { refuser("relancer : effort invalide"); return } }
            relancer(modele: m, effort: e)
        case "ouvrirTerminal": ouvrirTerminal()
        case "fermer": fenetre.fermerFenetre()
        case "copier":
            guard let t = o["texte"] as? String, t.utf8.count <= 20_000_000 else { refuser("copier : texte invalide"); return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(t, forType: .string)
        case "ouvrirLien":
            guard let s = o["url"] as? String, let u = URL(string: s), let sc = u.scheme?.lowercased(),
                  sc == "http" || sc == "https", u.host?.isEmpty == false else { refuser("ouvrirLien : seulement http(s)"); return }
            NSWorkspace.shared.open(u)
        case "etat": changerEtat(o)
        case "question": question(o)
        case "questionClose": questionClose(o)
        case "vocal":
            guard let t = o["texte"] as? String, t.utf8.count <= 20_000,
                  let p = (o["priorite"] as? String).flatMap(MoteurVocal.Priorite.init(rawValue:)) else { refuser("vocal : texte ou priorite invalide"); return }
            var qid: String?
            if let q = o["questionId"], !(q is NSNull) {
                guard let qs = q as? String, Validation.idQuestion(qs) else { refuser("vocal : questionId invalide"); return }
                qid = qs
            }
            MoteurVocal.shared.ajouter(de: self, texte: t, priorite: p, questionId: qid)
        case "vocalAnnule":
            guard let q = o["questionId"] as? String, Validation.idQuestion(q) else { refuser("vocalAnnule : questionId invalide"); return }
            MoteurVocal.shared.annuler(questionId: q, session: self)
        case "choisirFichiers":
            fenetre.choisirFichiers { [weak self] u in self?.fichiersRecus(u, origine: "bouton") }
        case "collerFichiers":
            // ⌘V dans la saisie : fichiers copiés dans le Finder (liste vide sinon : la page garde ce qu'elle a)
            fichiersRecus(VueWebSession.urls(NSPasteboard.general), origine: "collage")
        case "enregistrerPiece":
            guard let nom = o["nom"] as? String, let b64 = o["donnees"] as? String, b64.utf8.count <= 60_000_000,
                  let data = Data(base64Encoded: b64) else { refuser("enregistrerPiece : invalide"); return }
            var propre = (nom as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "-")
            if propre.isEmpty || propre.hasPrefix(".") || propre.utf8.count > 200 { propre = "fichier" }
            let dossier = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("local.eliot.betterterminal/pieces/\(UUID().uuidString.prefix(8).lowercased())")
            do {
                try FileManager.default.createDirectory(at: dossier, withIntermediateDirectories: true)
                let u = dossier.appendingPathComponent(propre)
                try data.write(to: u)
                fichiersRecus([u], origine: "copie")
            } catch { journal("session \(sessionId) : pièce non écrite — \(error.localizedDescription)") }
        case "montrerFichier":
            guard let c = o["chemin"] as? String, c.hasPrefix("/"), c.utf8.count <= 4096,
                  FileManager.default.fileExists(atPath: c) else { refuser("montrerFichier : chemin invalide"); return }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: c)])
        case "dictee":
            switch o["action"] as? String {
            case "debut": MoteurVocal.shared.dicteeDebut(self)
            case "fin": MoteurVocal.shared.dicteeFin(self, annuler: false)
            case "annuler": MoteurVocal.shared.dicteeFin(self, annuler: true)
            default: refuser("dictee : action invalide")
            }
        case "todo":
            TodoProjet.traiter(o, cwd: cwd) { [weak self] r in self?.pousser("todo", r) }
        case "agents":   // sous-agents en cours : suivi en direct de leurs transcripts (SuiviAgents.swift)
            let ids = (o["ids"] as? [String] ?? []).filter { !$0.isEmpty }
            SuiviAgents.suivre(ids, session: self, cwd: cwd, sessionId: sessionId) { [weak self] r in self?.pousser("agents", r) }
        case "modeVocal":
            guard let a = o["actif"] as? Bool else { refuser("modeVocal : actif invalide"); return }
            MoteurVocal.shared.activer(a, source: "page")
        default: refuser("type inconnu « \(extrait(type, 40)) »")
        }
    }

    /// Fichiers joints (dépôt du Finder, bouton, collage, copie) → la page : chemin, nom, taille, type ;
    /// pour une image raisonnable, ses octets aussi (Claude la voit directement au lieu de la lire).
    func fichiersRecus(_ urls: [URL], origine: String) {
        let images: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]
        let liste: [[String: Any]] = urls.prefix(40).compactMap { u in
            guard u.isFileURL else { return nil }
            let v = try? u.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentTypeKey])
            let dossier = v?.isDirectory ?? false
            let mime = v?.contentType?.preferredMIMEType ?? ""
            var d: [String: Any] = ["chemin": u.path, "nom": u.lastPathComponent, "dossier": dossier, "mime": mime]
            if let t = v?.fileSize { d["taille"] = t }
            if !dossier, images.contains(mime), (v?.fileSize ?? .max) <= 25_000_000, let data = try? Data(contentsOf: u) {
                d["donnees"] = data.base64EncodedString()
            }
            return d
        }
        journal("session \(sessionId) : \(liste.count) fichier(s) joint(s) (\(origine))")
        pousser("fichiers", ["origine": origine, "liste": liste])
    }

    private func refuser(_ pourquoi: String) { journal("session \(sessionId) : refusé — \(pourquoi)") }

    private func typeDe(_ ligne: String) -> String {
        guard let r = ligne.range(of: "\"type\":\"") else { return "" }
        return String(ligne[r.upperBound...].prefix { $0 != "\"" }.prefix(30))
    }

    // MARK: - Démarrage

    private func surPret() {
        journal("session \(sessionId) : page prête\(dejaPrete ? " (rechargement)" : "")")
        pagePrete = true
        file.removeAll()
        pousser("info", info())
        dernierVocalEtat = nil
        envoyerVocalEtat(MoteurVocal.shared.etatPage(pour: self))
        if !dejaPrete {
            dejaPrete = true
            if repriseDemandee { envoyerHistorique { [weak self] in self?.demarrer() } } else { demarrer() }
        } else {
            // ⌘R ou page rechargée : la conversation est reconstruite depuis le transcript (écrit au fil de l'eau).
            envoyerHistorique { [weak self] in
                guard let self else { return }
                if self.dansTerminal { self.pousser("fin", ["code": 0, "raison": "terminal"]) }
                else if self.demarre, self.processus == nil || self.processus!.fini { self.pousser("fin", ["code": 0]) }
            }
        }
    }

    private func info() -> [String: Any] {
        ["cwd": cwd, "projet": projet.nom, "emoji": projet.emoji, "sessionId": sessionId,
         "modele": modele ?? NSNull(), "effort": effort ?? NSNull(),
         "effortDefaut": EffortReglages.valeur(cwd: cwd) ?? NSNull(),
         "reprise": repriseDemandee, "dansTerminal": dansTerminal,
         "barreTitre": ["hauteur": FenetreSession.hauteurBarre, "gauche": FenetreSession.largeurFeux],
         "app": "better-terminal", "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"]
    }

    /// Lit le transcript hors du fil principal et l'envoie (sans les lignes techniques volumineuses).
    private func envoyerHistorique(_ ensuite: @escaping () -> Void) {
        let (c, id) = (cwd, sessionId)
        DispatchQueue.global(qos: .userInitiated).async {
            let lignes = Transcript.lignes(cwd: c, sessionId: id).filter { !$0.hasPrefix("{\"type\":\"api-request") }
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.fermee else { return }
                journal("session \(id) : historique \(lignes.count) lignes")
                self.pousser("historique", lignes)
                ensuite()
            }
        }
    }

    private func demarrer() {
        guard !demarre, !fermee else { return }
        demarre = true
        lancer(reprise: repriseDemandee) { [weak self] in
            guard let self, let p = self.promptInitial else { return }
            self.promptInitial = nil
            self.envoyerTexte(p, source: "lancement")
        }
    }

    /// Lance claude (environnement du shell de connexion + BT_APP=1). `lance` est appelé si le lancement réussit.
    private func lancer(reprise: Bool, lance: (() -> Void)? = nil) {
        Environnement.charger { [weak self] env in
            guard let self, !self.fermee else { return }
            guard let exe = BinaireClaude.chemin(env) else {
                self.pousser("stderr", "Binaire claude introuvable (~/.local/bin/claude, whence -p claude).\n")
                self.pousser("fin", ["code": -1]); return
            }
            var e = env
            e["BT_APP"] = "1"
            e["PWD"] = self.cwd
            let args = ClaudeArgs.arguments(sessionId: self.sessionId, reprise: reprise, modele: self.modele, effort: self.effort)
            let p: ProcessusClaude
            do { p = try ProcessusClaude(exe: exe, args: args, env: e, cwd: self.cwd) }
            catch {
                journal("session \(self.sessionId) : lancement impossible — \(error)")
                self.pousser("stderr", "Lancement de claude impossible : \(error)\n")
                self.pousser("fin", ["code": -1]); return
            }
            p.surLigne = { [weak self, weak p] l in
                let a = Session.analyser(l)
                DispatchQueue.main.async { if let p { self?.ligneClaude(l, a, de: p) } }
            }
            p.surStderr = { [weak self] l in
                DispatchQueue.main.async { self?.journalStderr(l); self?.pousser("stderr", l + "\n") }
            }
            p.surFin = { [weak self, weak p] code in
                DispatchQueue.main.async { if let p { self?.finProcessus(p, code) } }
            }
            self.processus = p
            self.arretVoulu = nil
            p.ecouter()
            journal("session \(self.sessionId) : pid \(p.pid) : \(exe) \(args.joined(separator: " "))")
            let enAttente = self.avantLancement
            self.avantLancement = []
            enAttente.forEach { p.ecrire($0) }
            if !enAttente.isEmpty { journal("session \(self.sessionId) : \(enAttente.count) ligne(s) gardée(s) avant le lancement → stdin") }
            self.ecrireEtat()
            RegistreSessions.shared.signaler(self)
            lance?()
        }
    }

    private func journalStderr(_ l: String) { journal("session \(sessionId) : stderr \(extrait(l, 300))") }

    // MARK: - stdout → page

    /// Le strict nécessaire pour le registre (dernier message, fin de tour, id réel) ; tout le reste est pour la page.
    struct Analyse { var idInit: String?; var texte: String?; var finTour = false; var resultat: String? }

    static func analyser(_ l: String) -> Analyse? {
        if l.hasPrefix("{\"type\":\"stream_event\"") { return nil }
        guard let o = (try? JSONSerialization.jsonObject(with: Data(l.utf8))) as? [String: Any],
              let t = o["type"] as? String else { return nil }
        var a = Analyse()
        switch t {
        case "system":
            guard o["subtype"] as? String == "init" else { return nil }
            a.idInit = o["session_id"] as? String
        case "assistant":
            guard o["parent_tool_use_id"] == nil || o["parent_tool_use_id"] is NSNull,
                  let m = o["message"] as? [String: Any], let c = m["content"] as? [[String: Any]] else { return nil }
            let textes = c.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            guard !textes.isEmpty else { return nil }
            a.texte = sansANSI(textes.joined(separator: "\n"))
        case "result":
            a.finTour = true
            if let r = o["result"] as? String { a.resultat = sansANSI(r) }
        default: return nil
        }
        return a
    }

    /// Le hook MessageDisplay d'Eliot colore le texte (PROTOCOLE §3.3) : le registre garde la version propre.
    static func sansANSI(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{1b}\\[[0-9;]*m", with: "", options: .regularExpression)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.hasPrefix("━━━ Claude") && !($0.hasPrefix("────") && $0.allSatisfy { $0 == "─" }) }
            .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func ligneClaude(_ l: String, _ a: Analyse?, de p: ProcessusClaude) {
        pousser("depuisClaude", l)
        guard let a else { return }
        if let id = a.idInit, Validation.sessionId(id), id.lowercased() != sessionId {
            journal("session \(sessionId) : init annonce l'id \(id), adopté")
            supprimerEtat()
            sessionId = id.lowercased()
            ecrireEtat()
        }
        if let t = a.texte, !t.isEmpty { dernierMessage = t; maj = Date(); RegistreSessions.shared.signaler(self) }
        if a.finTour {
            if let r = a.resultat, !r.isEmpty { dernierMessage = r }
            maj = Date()
            RegistreSessions.shared.signaler(self)
            RegistreSessions.shared.signalerTour(self, texte: dernierMessage ?? "")
            if let n = toursAvantArret { toursAvantArret = max(0, n - 1) }
        }
    }

    private func finProcessus(_ p: ProcessusClaude, _ code: Int32) {
        journal("session \(sessionId) : pid \(p.pid) terminé, code \(code)\(arretVoulu.map { " (\($0))" } ?? "")")
        guard p === processus else { return }
        if arretVoulu != nil { return }   // relance / terminal / fermeture : géré par l'action elle-même
        pousser("fin", ["code": code])
        etat = "termine"; maj = Date()
        ecrireEtat()
        RegistreSessions.shared.signaler(self)
    }

    // MARK: - Envoi d'un message (registre, prompt de lancement)

    /// Par la page si elle expose `bt.envoyerTexte(texte, {source})` (elle construit et affiche le message),
    /// sinon écriture directe du message stream-json standard.
    @discardableResult
    func envoyerTexte(_ texte: String, source: String) -> Bool {
        guard !fermee, !dansTerminal else { return false }
        guard let p = processus, !p.fini else {
            if !demarre { promptInitial = [promptInitial, texte].compactMap { $0 }.joined(separator: "\n\n"); return true }
            return false
        }
        let direct = { [weak self] in
            guard let self, let l = ClaudeArgs.messageUtilisateur(texte) else { return }
            p.ecrire(l)
            journal("session \(self.sessionId) : → stdin (direct, \(source)) \(extrait(texte, 60))")
        }
        guard pagePrete else { direct(); return true }
        vider()   // garder l'ordre avec les appels déjà en file
        fenetre.appelerEnvoyerTexte(texte, source: source) { ok in if !ok { direct() } }
        return true
    }

    // MARK: - File vers la page

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

    /// La page se recharge (⌘R) ou son processus WebKit est mort : on attendra son prochain `pret`.
    func pageDechargee() { pagePrete = false; file.removeAll() }

    // MARK: - Relancer, terminal, fermer

    private func relancer(modele m: String?, effort e: String?) {
        guard !fermee, !dansTerminal else { return }
        modele = m; effort = e
        journal("session \(sessionId) : relance (modele \(m ?? "défaut"), effort \(e ?? "défaut"))")
        let suite = { [weak self] in
            guard let self, !self.fermee else { return }
            let reprise = Transcript.chemin(cwd: self.cwd, sessionId: self.sessionId) != nil
            self.demarre = true
            self.lancer(reprise: reprise) { [weak self] in
                guard let self else { return }
                self.pousser("info", self.info())
            }
        }
        if let p = processus, !p.fini {
            arretVoulu = "relance"
            arreterProcessus(p) { DispatchQueue.main.async(execute: suite) }
        } else { suite() }
    }

    private func ouvrirTerminal() {
        guard !fermee, !dansTerminal, Validation.sessionId(sessionId) else { return }
        let codeAvant: Int32 = 0
        let suite = { [weak self] in
            guard let self, !self.fermee else { return }
            Environnement.charger { [weak self] env in
                guard let self, let exe = BinaireClaude.chemin(env) else { return }
                let reprise = Transcript.chemin(cwd: self.cwd, sessionId: self.sessionId) != nil
                let cmd = ClaudeArgs.commandeTerminal(claude: exe, cwd: self.cwd, sessionId: self.sessionId, reprise: reprise, modele: self.modele)
                DispatchQueue.global(qos: .userInitiated).async {
                    let (ok, detail) = Terminal.ouvrir(cmd)
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        journal("session \(self.sessionId) : terminal → \(ok ? "ok" : "échec") \(detail) : \(cmd)")
                        if ok {
                            self.dansTerminal = true
                            self.etat = "termine"; self.maj = Date()
                            self.supprimerEtat()   // la session n'est plus pilotée par l'app
                            self.fenetre.marquerDansTerminal()
                            self.pousser("info", self.info())
                            self.pousser("fin", ["code": codeAvant, "raison": "terminal"])
                            RegistreSessions.shared.signaler(self)
                        } else {
                            self.pousser("stderr", "Terminal n'a pas pu être ouvert (\(detail)). La session reprend dans l'app.\n")
                            self.lancer(reprise: Transcript.chemin(cwd: self.cwd, sessionId: self.sessionId) != nil)
                        }
                    }
                }
            }
        }
        // jamais deux processus sur la même session : celui de l'app s'arrête d'abord
        if let p = processus, !p.fini {
            arretVoulu = "terminal"
            arreterProcessus(p) { DispatchQueue.main.async(execute: suite) }
        } else { suite() }
    }

    /// Interruption du tour en cours, fin de stdin, puis SIGTERM (2 s) et SIGKILL (5 s) au besoin.
    private func arreterProcessus(_ p: ProcessusClaude, _ fini: @escaping () -> Void) {
        p.ecrire(ClaudeArgs.interruption())
        p.arreter(fini)
    }

    /// Fermeture de la fenêtre (bouton, ⌘W, action `fermer`) : la fenêtre part tout de suite,
    /// le processus s'arrête en arrière-plan, puis la session quitte le registre.
    func fermer() { fermerPuis(nil) }

    func arreterPourQuitter(_ fini: @escaping () -> Void) { fermerPuis(fini) }

    var estFermee: Bool { fermee }

    private func fermerPuis(_ fini: (() -> Void)?) {
        if fermee {   // déjà fermée (fenêtre partie) : on attend quand même la fin du processus
            if let p = processus, !p.fini, let fini { p.arreter { DispatchQueue.main.async(execute: fini) } } else { fini?() }
            return
        }
        // Fermer (pas Quitter) une session d'un projet du registre : la fenêtre part tout de suite, et Claude fait
        // sa fin de session (to-do, fiche d'état) en arrière-plan avant d'être arrêté. Même consigne que la croix du Cockpit.
        if fini == nil, !dansTerminal, let id = projet.id, let p = processus, !p.fini, demarre {
            fermerAvecBilan(p, projet: id); return
        }
        fermee = true
        arretVoulu = "fermer"
        avantLancement.removeAll()
        journal("session \(sessionId) : fermeture")
        for id in questionsOuvertes { BoiteQuestions.shared.oublier(id); Questions.clore(id, texte: "session fermée") }
        questionsOuvertes.removeAll()
        MoteurVocal.shared.sessionFermee(self)
        let finir = { [weak self] in
            guard let self else { fini?(); return }
            self.supprimerEtat()
            self.fenetre.liberer()
            RegistreSessions.shared.retirer(self)
            fini?()
        }
        if let p = processus, !p.fini { arreterProcessus(p) { DispatchQueue.main.async(execute: finir) } }
        else { finir() }
    }

    /// Fermeture avec bilan : disparition immédiate (fenêtre, registre, état), consigne de fin envoyée sur stdin
    /// (`~/.claude/bin/consigne-fin <projet> <flag>`), arrêt du processus quand le drapeau apparaît, quand les tours
    /// attendus sont finis (2 si un tour était en cours, sinon 1), ou après 5 min.
    private func fermerAvecBilan(_ p: ProcessusClaude, projet id: String) {
        fermee = true
        arretVoulu = "fermer"
        avantLancement.removeAll()
        for q in questionsOuvertes { BoiteQuestions.shared.oublier(q); Questions.clore(q, texte: "session fermée") }
        questionsOuvertes.removeAll()
        MoteurVocal.shared.sessionFermee(self)
        supprimerEtat()
        pagePrete = false; file.removeAll()
        fenetre.liberer()
        RegistreSessions.shared.debutFermeture(self)
        RegistreSessions.shared.retirer(self)
        let sid = sessionId
        let termine = { DispatchQueue.main.async { RegistreSessions.shared.finFermeture(sid) } }
        let dossier = HOME + "/.config/projets/fin"
        try? FileManager.default.createDirectory(atPath: dossier, withIntermediateDirectories: true)
        let uid = String(UUID().uuidString.prefix(8)).lowercased()
        let flag = dossier + "/bt-" + uid
        let fichier = dossier + "/consigne-bt-" + uid + ".md"
        let (st, texte) = executer(HOME + "/.claude/bin/consigne-fin", [id, flag], delai: 10)
        guard st == 0, !texte.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              (try? texte.write(toFile: fichier, atomically: true, encoding: .utf8)) != nil,
              let ligne = ClaudeArgs.messageUtilisateur("Fin de session : lis et exécute " + fichier) else {
            journal("session \(sessionId) : fermeture, consigne-fin indisponible (\(st)) → arrêt direct")
            arreterProcessus(p, termine)
            return
        }
        toursAvantArret = etat == "travaille" ? 2 : 1
        journal("session \(sessionId) : fermeture avec bilan (\(id)), tour en cours : \(etat == "travaille"), fenêtre libérée")
        p.ecrire(ligne)
        let t0 = Date()
        func verifier() {
            if p.fini { journal("session \(self.sessionId) : bilan, processus déjà terminé"); termine(); return }
            let drapeau = FileManager.default.fileExists(atPath: flag)
            let tours = self.toursAvantArret ?? 0
            let age = Date().timeIntervalSince(t0)
            if drapeau || tours <= 0 || age > 300 {
                journal("session \(self.sessionId) : bilan \(drapeau ? "fini (drapeau)" : tours <= 0 ? "fini (tour)" : "abandonné (5 min)") après \(Int(age)) s → arrêt")
                self.toursAvantArret = nil
                try? FileManager.default.removeItem(atPath: flag)
                p.arreter(termine)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { verifier() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { verifier() }
    }

    // MARK: - État (~/.config/better-terminal/sessions/<id>.json) et notification

    private func changerEtat(_ o: [String: Any]) {
        guard let e = o["etat"] as? String, Validation.etats.contains(e) else { refuser("etat invalide"); return }
        if let r = o["resume"] { resume = (r as? String).map { String($0.prefix(500)) } }
        etat = e; maj = Date()
        ecrireEtat()
        if e == "attend" {
            if !attenteNotifiee { attenteNotifiee = true; notifierAttente() }
        } else { attenteNotifiee = false }
        RegistreSessions.shared.signaler(self)
    }

    private var cheminEtat: String { DOSSIER_SESSIONS + "/" + sessionId + ".json" }

    private func ecrireEtat() {
        guard !fermee, !dansTerminal, Validation.sessionId(sessionId) else { return }
        let o: [String: Any] = ["sessionId": sessionId, "cwd": cwd, "projet": projet.nom, "emoji": projet.emoji,
                                "pid": pid.map { NSNumber(value: $0) } ?? NSNull(), "etat": etat,
                                "resume": resume ?? NSNull(), "maj": iso8601.string(from: maj)]
        if let d = json(o) { ecrireAtomique(d, cheminEtat) }
    }

    private func supprimerEtat() {
        guard Validation.sessionId(sessionId) else { return }
        try? FileManager.default.removeItem(atPath: cheminEtat)
    }

    /// Une seule notification par attente. Pas de notification si Eliot regarde déjà cette fenêtre.
    private func notifierAttente() {
        if NSApp.isActive && fenetre.estDevant { journal("session \(sessionId) : attend (fenêtre au premier plan, pas de notification)"); return }
        if PiloteDev.actif { journal("session \(sessionId) : attend (mode pilote : notification non envoyée)"); return }
        let titre = projet.emoji + " " + projet.nom
        var message = resume?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if message.isEmpty { message = "Claude attend votre réponse." }
        while message.hasPrefix("-") || message.hasPrefix("[") { message.removeFirst() }   // lu comme option sinon
        let id = sessionId
        Environnement.charger { env in
            guard let tn = Environnement.trouver("terminal-notifier", env, connus: ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"])
            else { journal("terminal-notifier introuvable"); return }
            DispatchQueue.global().async {
                let (code, _) = executer(tn, ["-title", titre, "-subtitle", "Claude attend votre réponse", "-message", message,
                                              "-group", "bt-" + id, "-sound", "default",
                                              "-open", "betterterminal://focus?session=" + id], env: env, delai: 10)
                journal("session \(id) : notification d'attente (code \(code))")
            }
        }
    }

    // MARK: - Questions (Telegram)

    /// `type` sert déjà à nommer le message : le type de question arrive dans `typeQuestion`
    /// (ou sous forme imbriquée `{type: "question", question: {id, type, texte, options}}`).
    private func question(_ message: [String: Any]) {
        var o = message
        if let q = message["question"] as? [String: Any] {
            o = q; o["typeQuestion"] = q["type"]
        }
        guard let id = o["id"] as? String, Validation.idQuestion(id),
              let type = o["typeQuestion"] as? String, Validation.typesQuestion.contains(type),
              let texte = o["texte"] as? String, texte.utf8.count <= 50_000 else { refuser("question invalide"); return }
        var options: [[String: Any]] = []
        if let brut = o["options"] {
            guard let liste = brut as? [Any], liste.count <= 40 else { refuser("question : options invalides"); return }
            for x in liste {
                guard let d = x as? [String: Any], let label = d["label"] as? String, label.utf8.count <= 1000 else { refuser("question : option invalide"); return }
                var opt: [String: Any] = ["label": label]
                if let desc = d["description"] as? String { opt["description"] = String(desc.prefix(4000)) }
                options.append(opt)
            }
        }
        questionsOuvertes.insert(id)
        var q: [String: Any] = ["id": id, "sessionId": sessionId, "projet": projet.nom, "emoji": projet.emoji, "type": type, "texte": texte,
                                "options": options, "cree": iso8601.string(from: Date())]
        // champ facultatif du contrat (titre court de la question AskUserQuestion), affiché par tg-question.sh
        if let h = o["header"] as? String, !h.isEmpty { q["header"] = String(h.prefix(200)) }
        Questions.envoyer(q, session: self)
    }

    private func questionClose(_ o: [String: Any]) {
        guard let id = o["id"] as? String, Validation.idQuestion(id) else { refuser("questionClose : id invalide"); return }
        let reponse: Any
        if let s = o["reponse"] as? String { reponse = String(s.prefix(20_000)) }
        else if let a = o["reponse"] as? [Any], a.allSatisfy({ $0 is String }) { reponse = a as! [String] }
        else { refuser("questionClose : reponse invalide"); return }
        questionsOuvertes.remove(id)
        Questions.fermerDepuisMac(id, reponse: reponse)
        MoteurVocal.shared.annuler(questionId: id, session: self)   // répondue : plus rien à dire
    }

    /// Réponse arrivée de Telegram (BoiteQuestions).
    func reponseExterne(id: String, reponse: Any, source: String) {
        guard questionsOuvertes.remove(id) != nil else { return }
        journal("session \(sessionId) : réponse externe \(id) (\(source))")
        pousser("reponseExterne", ["id": id, "reponse": reponse, "source": source])
        MoteurVocal.shared.annuler(questionId: id, session: self)   // répondue sur Telegram : plus rien à dire
    }

    // MARK: - Mode vocal

    var fenetreDevant: Bool { fenetre.estDevant }

    func marquerActivee() { derniereActivation = Date() }

    /// `bt.vocalEtat` : seulement quand quelque chose change pour cette page.
    func envoyerVocalEtat(_ e: [String: Any]) {
        let cle = "\(e["actif"] ?? "")|\(e["etat"] ?? "")|\(e["enLigne"] ?? "")"
        guard pagePrete, cle != dernierVocalEtat else { return }
        dernierVocalEtat = cle
        pousser("vocalEtat", e)
    }

    /// Dictée dans la saisie (Espace maintenu) : état et texte pour la page.
    func pousserDictee(_ d: [String: Any]) { pousser("dictee", d) }

    /// Texte dicté pour cette session : `bt.transcription({texte, questionId?})` ; une page qui ne connaît pas
    /// encore cette fonction reçoit le texte comme un message ordinaire (`envoyerTexte`, source « vocal »).
    func livrerTranscription(_ texte: String, questionId: String?) {
        guard !fermee, !dansTerminal else { return }
        var arg: [String: Any] = ["texte": texte]
        if let q = questionId { arg["questionId"] = q }
        guard pagePrete else { envoyerTexte(texte, source: "vocal"); return }
        vider()   // garder l'ordre avec les appels déjà en file
        fenetre.appelerFonction("transcription", arg) { [weak self] ok in
            guard let self else { return }
            if ok { journal("session \(self.sessionId) : bt.transcription\(questionId.map { " (question \($0))" } ?? "")") }
            else { journal("session \(self.sessionId) : bt.transcription absente, envoi direct"); self.envoyerTexte(texte, source: "vocal") }
        }
    }
}
