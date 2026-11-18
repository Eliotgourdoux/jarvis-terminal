import AppKit
import WebKit

/// Pilote de développement, pour les tests d'intégration (agent F). INACTIF par défaut.
///
/// Il ne s'active que si l'app est lancée avec `BT_DEV_PILOTE=<dossier>` dans son environnement
/// (lancement du binaire depuis un shell ; ni le Finder, ni le Dock, ni un lien ne posent cette variable).
/// Le dossier doit exister, appartenir à l'utilisateur et n'être lisible que par lui (0700).
///
/// - `injecte.js` (s'il existe dans le dossier quand une fenêtre est créée) : script ajouté à la page,
///   en fin de document. Sert à taper un message avant même que claude soit lancé.
/// - `<nom>.cmd.json` déposés dans le dossier : exécutés un par un (ordre des noms), résultat écrit dans
///   `<nom>.res.json`. Actions : `fenetres`, `js` {fenetre, code}, `touche` {fenetre, touche, mods},
///   `recharger` {fenetre} (comme ⌘R), `capture` {chemin, cible} (PNG de la vue web réelle), `quitter` (⌘Q fabriqué). `fenetre` = index (0, 1…) ou début du sessionId ; absent = dernière fenêtre ouverte.
/// - Les touches sont des NSEvent fabriqués et remis à l'app elle-même (NSApp.sendEvent) : rien ne passe
///   par le système, rien ne peut atterrir dans une autre application.
/// - En mode pilote, aucune notification Mac n'est envoyée (journalisée à la place).
enum PiloteDev {
    static let dossier: String? = {
        guard let d = ProcessInfo.processInfo.environment["BT_DEV_PILOTE"], d.hasPrefix("/") else { return nil }
        var st = stat()
        guard lstat(d, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid(), (st.st_mode & 0o077) == 0 else {
            journal("pilote : BT_DEV_PILOTE refusé (dossier absent, pas à moi, ou pas en 0700)"); return nil
        }
        return d
    }()

    static var actif: Bool { dossier != nil }

    /// `BT_DEV_REGISTRE` : registre des projets de test (noms distincts pour des sessions de bac-a-sable/).
    static let registre: String? = {
        guard actif, let r = ProcessInfo.processInfo.environment["BT_DEV_REGISTRE"], r.hasPrefix("/") else { return nil }
        return r
    }()

    private static var minuteur: Timer?
    private static var occupe = false

    /// Script à injecter dans une nouvelle fenêtre (lu à la création de la fenêtre).
    static func scriptInjecte() -> String? {
        guard let d = dossier, let s = try? String(contentsOfFile: d + "/injecte.js", encoding: .utf8), !s.isEmpty else { return nil }
        journal("pilote : injecte.js ajouté à la page (\(s.utf8.count) o)")
        return s
    }

    static func demarrer() {
        guard let d = dossier, minuteur == nil else { return }
        journal("pilote : ACTIF sur \(d)")
        minuteur = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in relever() }
    }

    private static func relever() {
        guard !occupe, let d = dossier else { return }
        let fm = FileManager.default
        guard let noms = try? fm.contentsOfDirectory(atPath: d) else { return }
        guard let nom = noms.filter({ $0.hasSuffix(".cmd.json") }).sorted().first else { return }
        let chemin = d + "/" + nom
        let base = String(nom.dropLast(".cmd.json".count))
        let donnees = fm.contents(atPath: chemin)
        try? fm.removeItem(atPath: chemin)
        guard let donnees, let cmd = (try? JSONSerialization.jsonObject(with: donnees)) as? [String: Any] else {
            ecrire(base, ["erreur": "commande illisible"]); return
        }
        occupe = true
        executer(cmd) { r in
            ecrire(base, r)
            occupe = false
        }
    }

    private static func ecrire(_ base: String, _ r: [String: Any]) {
        guard let d = dossier else { return }
        let data = (try? JSONSerialization.data(withJSONObject: r, options: [.prettyPrinted, .sortedKeys])) ?? Data("{\"erreur\":\"résultat non sérialisable\"}".utf8)
        try? data.write(to: URL(fileURLWithPath: d + "/" + base + ".res.json"), options: .atomic)
    }

    private static func session(_ cmd: [String: Any]) -> Session? {
        let l = RegistreSessions.shared.sessions.filter { !$0.estFermee }
        if let i = cmd["fenetre"] as? Int { return i >= 0 && i < l.count ? l[i] : nil }
        if let s = cmd["fenetre"] as? String, !s.isEmpty { return l.first { $0.sessionId.hasPrefix(s.lowercased()) } }
        return l.last
    }

    private static func executer(_ cmd: [String: Any], _ fini: @escaping ([String: Any]) -> Void) {
        switch cmd["action"] as? String ?? "" {
        case "fenetres":
            let l = RegistreSessions.shared.sessions.enumerated().map { (i, s) -> [String: Any] in
                let w = s.vueDev.window
                return ["index": i, "sessionId": s.sessionId, "numero": w.windowNumber, "titre": w.title, "etat": s.etat,
                        "pid": s.pid.map { NSNumber(value: $0) } ?? NSNull(), "fermee": s.estFermee, "cle": w.isKeyWindow,
                        "visible": w.isVisible]
            }
            fini(["fenetres": l, "appActive": NSApp.isActive,
                  "panneau": ["numero": PanneauJarvis.shared.numeroFenetre, "visible": PanneauJarvis.shared.visible,
                              "page": PanneauJarvis.shared.cheminPage]])
        case "js":
            guard let s = session(cmd), let code = cmd["code"] as? String else { fini(["erreur": "fenêtre ou code absent"]); return }
            s.vueDev.evaluerDev(code) { ok, v in fini(ok ? ["ok": true, "valeur": v] : ["ok": false, "erreur": v]) }
        case "touche":
            guard let s = session(cmd), let t = cmd["touche"] as? String else { fini(["erreur": "fenêtre ou touche absente"]); return }
            FenetrePrincipale.shared.selectionner(s.vueDev)
            fini(touche(s.vueDev.window, t, cmd["mods"] as? [String] ?? []))
        // --- fenêtre unique + barre latérale ---
        case "ouvrir":
            guard let c = cmd["cwd"] as? String, let cwd = Validation.dossier(c) else { fini(["erreur": "cwd absent ou invalide"]); return }
            var d = DemandeSession(cwd: cwd)
            d.modele = cmd["modele"] as? String
            d.resume = cmd["resume"] as? String
            Entrees.ouvrir(d)
            fini(["ok": true])
        case "capture":
            // {chemin, cible: "barre" | absent (fenêtre de session)} : PNG de la vue web réelle.
            guard let c = cmd["chemin"] as? String, c.hasPrefix("/"), c.hasSuffix(".png") else { fini(["erreur": "chemin .png absolu attendu"]); return }
            let rendu: (Bool, Any) -> Void = { ok, v in fini(ok ? ["ok": true, "valeur": v] : ["ok": false, "erreur": v]) }
            if cmd["cible"] as? String == "barre" { FenetrePrincipale.shared.capturerDev(c, rendu) }
            else if let s = session(cmd) { s.vueDev.capturerDev(c, rendu) }
            else { fini(["erreur": "fenêtre absente"]) }
        case "barre":
            guard let code = cmd["code"] as? String else { fini(["erreur": "code absent"]); return }
            FenetrePrincipale.shared.evaluerBarreDev(code) { ok, v in fini(ok ? ["ok": true, "valeur": v] : ["ok": false, "erreur": v]) }
        case "principale":
            let p = FenetrePrincipale.shared
            fini(["selection": p.selection?.sessionLiee?.sessionId ?? NSNull(),
                  "ordre": p.vues.compactMap { $0.sessionLiee?.sessionId },
                  "titre": p.window.title, "visible": p.window.isVisible, "cadre": NSStringFromRect(p.window.frame)])
        case "choisir":
            if let n = cmd["numero"] as? Int { FenetrePrincipale.shared.choisir(numero: n) }
            else if let pas = cmd["decaler"] as? Int { FenetrePrincipale.shared.decaler(pas) }
            else if cmd["fermerSelection"] as? Bool == true { FenetrePrincipale.shared.fermerSelection() }
            fini(["ok": true, "selection": FenetrePrincipale.shared.selection?.sessionLiee?.sessionId ?? NSNull()])
        case "recharger":
            // Ce que fait ⌘R (menu Présentation) ; le menu vise NSApp.keyWindow, nil tant que l'app n'est pas active.
            guard let s = session(cmd) else { fini(["erreur": "fenêtre absente"]); return }
            s.vueDev.recharger()
            fini(["ok": true])
        case "quitter":
            // Un vrai ⌘Q fabriqué, depuis un minuteur. Surtout pas NSApp.terminate dans un bloc de la file
            // principale : pendant terminateLater, la boucle imbriquée ne pourrait plus vider cette file, et
            // les rappels de fin des processus n'arriveraient jamais (l'app resterait bloquée).
            fini(["ok": true])
            Timer.scheduledTimer(withTimeInterval: 0.2, repeats: false) { _ in
                if let w = RegistreSessions.shared.sessions.last?.vueDev.window { _ = touche(w, "q", ["cmd"]) } else { NSApp.terminate(nil) }
            }
        // --- mode vocal (tests) ---
        case "vocal":
            // les mêmes fonctions que le raccourci, le menu et le panneau ; rien ne passe par le système
            let v = MoteurVocal.shared
            if let f = cmd["fichier"] as? String { v.sourceSimulee = f.isEmpty ? nil : URL(fileURLWithPath: f) }
            switch cmd["faire"] as? String ?? "etat" {
            case "activer": v.activer(true, source: "pilote")
            case "desactiver": v.activer(false, source: "pilote")
            case "appui": v.appui(source: "pilote")
            case "relache": v.relache(source: "pilote")
            case "passer": v.passer()
            case "rejouer": v.rejouer()
            case "couper": v.couper()
            case "reprendre": v.reprendre()
            case "panneau": PanneauJarvis.shared.montrer()
            case "masquer": PanneauJarvis.shared.masquer()
            case "raccourci": if let c = cmd["cle"] as? String { v.changerRaccourci(c) }
            case "etat": break
            default: fini(["erreur": "faire inconnu"]); return
            }
            if let m = cmd["muet"] as? Bool { v.muet = m }
            if cmd.keys.contains("proxyEdge") { Synthese.shared.proxyEdge = cmd["proxyEdge"] as? String; Synthese.shared.reparerEdge() }
            fini(v.diagnostic())
        case "clicPanneau":
            // clic fabriqué remis à l'app (NSApp.sendEvent), jamais au système : vérifie qu'un clic agit
            // dans le panneau alors qu'il n'est jamais fenêtre clé. x, y en points depuis le coin haut gauche.
            guard let w = PanneauJarvis.shared.fenetreDev, let x = (cmd["x"] as? NSNumber)?.doubleValue,
                  let y = (cmd["y"] as? NSNumber)?.doubleValue else { fini(["erreur": "panneau absent ou x, y manquants"]); return }
            let p = NSPoint(x: x, y: w.frame.height - y)
            var n = 0
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                    NSApp.sendEvent(e); n += 1
                }
            }
            fini(["ok": n == 2, "cle": w.isKeyWindow, "appActive": NSApp.isActive])
        case "panneauJs":
            guard let code = cmd["code"] as? String else { fini(["erreur": "code absent"]); return }
            PanneauJarvis.shared.evaluerDev(code) { ok, r in fini(ok ? ["ok": true, "valeur": r] : ["ok": false, "erreur": r]) }
        case "routage":
            guard let t = cmd["texte"] as? String, let noms = cmd["noms"] as? [[String]] else { fini(["erreur": "texte ou noms absents"]); return }
            if let c = Routage.nomEnTete(t, candidats: noms) {
                fini(["index": c.index, "nom": c.nom, "mots": c.mots, "score": c.score, "reste": Routage.sansEnTete(t, mots: c.mots)])
            } else { fini(["index": -1]) }
        case "transcrire":
            guard let f = cmd["fichier"] as? String else { fini(["erreur": "fichier absent"]); return }
            let duree = (cmd["duree"] as? Double) ?? 5
            Environnement.charger { env in
                Transcription.transcrire(URL(fileURLWithPath: f), dureeAudio: duree, vocabulaire: cmd["vocabulaire"] as? [String] ?? [], env: env) { r in
                    switch r {
                    case .success(let t): fini(["texte": t.texte, "brut": t.brut, "duree": t.duree, "modele": t.modele])
                    case .failure(let e): fini(["erreur": e.description])
                    }
                }
            }
        case "tts":
            guard let t = cmd["texte"] as? String else { fini(["erreur": "texte absent"]); return }
            let t0 = Date()
            Environnement.charger { env in
                Synthese.shared.preparer(t, env: env) { a in
                    guard let a else { fini(["erreur": "aucune voix"]); return }
                    let taille = (try? FileManager.default.attributesOfItem(atPath: a.url.path)[.size] as? Int) ?? 0
                    fini(["moteur": a.moteur, "duree": Date().timeIntervalSince(t0), "taille": taille, "fichier": a.url.path, "texte": a.texte])
                }
            }
        default:
            fini(["erreur": "action inconnue"])
        }
    }

    /// Touche fabriquée et remise à l'app (comme si elle venait du clavier, mais sans passer par le système).
    private static func touche(_ w: NSWindow, _ t: String, _ mods: [String]) -> [String: Any] {
        var flags: NSEvent.ModifierFlags = []
        for m in mods {
            switch m {
            case "cmd": flags.insert(.command)
            case "shift": flags.insert(.shift)
            case "alt": flags.insert(.option)
            case "ctrl": flags.insert(.control)
            default: break
            }
        }
        let codes: [String: UInt16] = ["a": 0, "f": 3, "g": 5, "q": 12, "w": 13, "r": 15, "escape": 53, "return": 36,
                                       "haut": 126, "bas": 125]
        let car: String
        switch t {
        case "escape": car = "\u{1b}"
        case "return": car = "\r"
        case "haut": car = String(UnicodeScalar(UInt16(NSUpArrowFunctionKey))!)
        case "bas": car = String(UnicodeScalar(UInt16(NSDownArrowFunctionKey))!)
        default: car = t
        }
        let avant: [String: Any] = ["appActive": NSApp.isActive, "fenetreCle": w.isKeyWindow]
        if !w.isKeyWindow { w.makeKey() }
        var envoyes = 0
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: w.windowNumber, context: nil, characters: car,
                                        charactersIgnoringModifiers: car, isARepeat: false, keyCode: codes[t] ?? 0) {
                NSApp.sendEvent(e); envoyes += 1
            }
        }
        journal("pilote : touche \(mods.joined(separator: "+"))\(mods.isEmpty ? "" : "+")\(t) → fenêtre \(w.windowNumber)")
        return ["ok": envoyes == 2, "avant": avant, "apres": ["appActive": NSApp.isActive, "fenetreCle": w.isKeyWindow]]
    }
}
