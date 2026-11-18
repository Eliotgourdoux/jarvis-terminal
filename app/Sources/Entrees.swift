import AppKit

/// Les trois portes d'entrée : schéma d'URL, ligne de commande, ⌘N.
///
/// betterterminal://session?cwd=<chemin>&resume=<id>&prompt=<texte>&modele=<m>&effort=<e>&jeton=<jeton>
/// betterterminal://focus?session=<id>                       (met la fenêtre de la session devant)
/// betterterminal://envoyer?session=<id>&texte=<t>&jeton=<j> (registre : message à une session ouverte)
/// betterterminal://session?machine=victus&cwd=/home/eliotgrx/…  (session lancée sur le Victus, par le lien ssh)
///   `focus` et `envoyer` reconnaissent aussi les sessions du Victus (VictusSession.swift).
///
/// Le jeton (~/.config/better-terminal/jeton) distingue les appelants locaux d'un lien cliqué sur le web :
/// sans lui, un `prompt` demande confirmation et `envoyer` est refusé.
enum Entrees {
    static let schema = "betterterminal"

    // MARK: URL

    static func traiter(_ url: URL) {
        guard url.scheme?.lowercased() == schema, let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            journal("URL ignorée : \(url.absoluteString.prefix(200))"); return
        }
        var q: [String: String] = [:]
        for i in c.queryItems ?? [] where q[i.name] == nil { q[i.name] = i.value ?? "" }
        let fiable = Jeton.valide(q["jeton"])
        let action = (url.host ?? c.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))).lowercased()
        journal("URL \(action)\(fiable ? " (jeton valide)" : "")")
        switch action {
        case "session" where q["machine"]?.lowercased() == "victus":
            sessionVictus(q, fiable: fiable)
        case "session":
            guard let brut = q["cwd"], let cwd = Validation.dossier(brut) else {
                alerte("Dossier introuvable", "Le lien demande un dossier qui n'existe pas : \(q["cwd"] ?? "(vide)")."); return
            }
            guard let d = demande(cwd: cwd, resume: q["resume"], prompt: q["prompt"], modele: q["modele"] ?? q["model"], effort: q["effort"]) else { return }
            if let p = d.prompt, !fiable, !confirmer(d, prompt: p) { journal("URL session : refusée par Eliot"); return }
            ouvrir(d)
        case "recharger":
            // Seule l'interface (ui/) a changé : les pages se rechargent, les processus claude ne s'arrêtent pas
            // (app/relancer.sh, 18/11/2026 : ne plus attendre ni couper les sessions pour un changement d'interface).
            FenetrePrincipale.shared.toutRecharger()
        case "focus":
            if let id = q["session"], let s = RegistreSessions.shared.session(id) { s.mettreDevant() }
            else if let id = q["session"], VictusSession.existante(id) != nil || VictusLien.shared.session(id) != nil {
                VictusSession.montrer(id); FenetrePrincipale.shared.montrer()
            }
            else { NSApp.activate(ignoringOtherApps: true) }
        case "envoyer":
            guard fiable else { journal("URL envoyer refusée : jeton absent ou faux"); return }
            guard let id = q["session"], let t = q["texte"], !t.isEmpty else { return }
            if RegistreSessions.shared.session(id) == nil, VictusSession.existante(id) != nil || VictusLien.shared.session(id) != nil {
                // session du Victus : la vue ouverte écrit le message ; sinon le démon le passe directement (op envoyer)
                if let v = VictusSession.existante(id) { _ = v.envoyerTexte(t, source: "url"); return }
                VictusLien.shared.requete(["op": "envoyer", "sessionId": id, "texte": t, "source": "jarvis"]) { r in
                    journal("URL envoyer → Victus \(id) : \(r["ev"] as? String == "envoye" && r["ok"] as? Bool == true ? "ok" : "échec \(r["message"] as? String ?? "")")")
                }
                return
            }
            RegistreSessions.shared.envoyer(t, a: id, source: "url")
        default:
            journal("URL : action inconnue « \(action.prefix(40)) »")
        }
    }

    /// Valide les champs ; nil (avec un message) si quelque chose ne va pas.
    static func demande(cwd: String, resume: String?, prompt: String?, modele: String?, effort: String?) -> DemandeSession? {
        func vide(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }
        if let r = vide(resume), !Validation.sessionId(r) { alerte("Session invalide", "« \(r.prefix(60)) » n'est pas un identifiant de session."); return nil }
        if let m = vide(modele), !Validation.modele(m) { alerte("Modèle invalide", "« \(m.prefix(60)) » n'est pas un nom de modèle."); return nil }
        if let e = vide(effort), !Validation.effort(e) { alerte("Effort invalide", "« \(e.prefix(20)) » : low, medium, high, xhigh ou max."); return nil }
        if let p = prompt, p.utf8.count > 200_000 { alerte("Message trop long", "Le message de lancement dépasse 200 Ko."); return nil }
        return DemandeSession(cwd: cwd, resume: vide(resume), prompt: vide(prompt), modele: vide(modele), effort: vide(effort))
    }

    /// Une session déjà ouverte n'est jamais lancée deux fois : on montre sa fenêtre.
    static func ouvrir(_ d: DemandeSession) {
        if let r = d.resume, let s = RegistreSessions.shared.session(r) {
            s.mettreDevant()
            if let p = d.prompt { s.envoyerTexte(p, source: "lien") }
            return
        }
        _ = Session(d)
    }

    /// `session?machine=victus` : le dossier est celui du Victus (vérifié par le démon), pas du Mac.
    private static func sessionVictus(_ q: [String: String], fiable: Bool) {
        let lien = VictusLien.shared
        let home = lien.home
        var cwd = q["cwd"] ?? home
        if cwd == "~" { cwd = home } else if cwd.hasPrefix("~/") { cwd = home + cwd.dropFirst(1) }
        guard cwd.hasPrefix(home), cwd == home || cwd.hasPrefix(home + "/"), !cwd.split(separator: "/").contains(".."),
              !cwd.contains("\0"), cwd.utf8.count <= 4096 else {
            alerte("Dossier refusé", "Une session du Victus s'ouvre dans un dossier sous \(home) : \(cwd.prefix(200))."); return
        }
        guard let d = demande(cwd: cwd, resume: q["resume"], prompt: q["prompt"], modele: q["modele"] ?? q["model"], effort: q["effort"]) else { return }
        if let p = d.prompt, !fiable, !confirmer(d, prompt: p) { journal("URL session Victus : refusée par Eliot"); return }
        if let r = d.resume, let s = VictusSession.existante(r) {
            s.fenetre.mettreDevant()
            if let p = d.prompt { s.envoyerTexte(p, source: "lien") }
            return
        }
        // juste après le lancement de l'app, le lien est encore en train de s'établir : on l'attend 20 s au plus
        func lancer(essai: Int) {
            if lien.etat == .connexion, essai < 40 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { lancer(essai: essai + 1) }; return
            }
            guard lien.connecte else {
                alerte("Victus injoignable", lien.etat == .inactif ? "ssh victus n'est pas configuré sur ce Mac." : "La connexion au Victus n'est pas établie (\(lien.derniereErreur ?? "nouvel essai en cours")).")
                return
            }
            VictusSession.nouvelle(cwd: d.cwd, resume: d.resume, prompt: d.prompt, modele: d.modele, effort: d.effort) { err in
                if let err { alerte("Session du Victus non ouverte", err) }
            }
        }
        lancer(essai: 0)
    }

    // MARK: Ligne de commande

    /// `--cwd <dossier> [--resume <id>] [--prompt <texte>] [--modele <m>] [--effort <e>]`,
    /// ou un dossier seul, ou une URL betterterminal://.
    enum Commande { case session(DemandeSession), url(URL), rien, erreur(String) }

    static func depuisArguments(_ args: [String]) -> Commande {
        var cwd: String?, resume: String?, prompt: String?, modele: String?, effort: String?
        var i = 0
        func valeur() -> String? { i += 1; return i < args.count ? args[i] : nil }
        while i < args.count {
            let a = args[i]
            switch a {
            case "--cwd": cwd = valeur()
            case "--resume": resume = valeur()
            case "--prompt": prompt = valeur()
            case "--modele", "--model": modele = valeur()
            case "--effort": effort = valeur()
            default:
                if a.hasPrefix("-psn_") { break }
                if a.hasPrefix("-") { i += 1; break }   // -NSDocumentRevisionsDebugMode YES, -BTPage test…
                if a.lowercased().hasPrefix(schema + "://"), let u = URL(string: a) { return .url(u) }
                if cwd == nil { cwd = a }
            }
            i += 1
        }
        guard let brut = cwd else { return .rien }
        guard let c = Validation.dossier(brut) else { return .erreur("dossier introuvable : \(brut)") }
        guard let d = demande(cwd: c, resume: resume, prompt: prompt, modele: modele, effort: effort) else { return .erreur("arguments invalides") }
        return .session(d)
    }

    /// Même demande sous forme d'URL (avec jeton) : pour la transmettre à l'instance déjà lancée.
    static func url(_ d: DemandeSession) -> URL? {
        var c = URLComponents(); c.scheme = schema; c.host = "session"
        var q = [URLQueryItem(name: "cwd", value: d.cwd)]
        if let v = d.resume { q.append(.init(name: "resume", value: v)) }
        if let v = d.prompt { q.append(.init(name: "prompt", value: v)) }
        if let v = d.modele { q.append(.init(name: "modele", value: v)) }
        if let v = d.effort { q.append(.init(name: "effort", value: v)) }
        q.append(.init(name: "jeton", value: Jeton.valeur))
        c.queryItems = q
        // URLComponents laisse « + » et « & » tels quels dans les valeurs : on les encode nous-mêmes
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return c.url
    }

    // MARK: ⌘N

    static func choisirDossier() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        p.prompt = "Ouvrir la session"
        let dernier = Reglages.texte("BTDernierDossier").map { ($0 as NSString).deletingLastPathComponent }
        p.directoryURL = URL(fileURLWithPath: dernier ?? (HOME + "/Desktop/Projets"))
        p.message = "Dossier de la nouvelle session Claude"
        p.directoryURL = URL(fileURLWithPath: HOME + "/Desktop/Projets")
        NSApp.activate(ignoringOtherApps: true)
        guard p.runModal() == .OK, let u = p.url, let c = Validation.dossier(u.path) else { return }
        ouvrir(DemandeSession(cwd: c))
    }

    // MARK: Discussion libre (09/11/2026)

    /// Dossier des discussions sans projet : pas de CLAUDE.md de projet ni de to-do, juste les réglages globaux.
    static let dossierDiscussions = HOME + "/Claude-Discussions"

    /// Bouton « Discussion » (⇧⌘N) : un chat normal avec Claude, sans choisir de dossier.
    static func nouvelleDiscussion() {
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: dossierDiscussions, withIntermediateDirectories: true)
            let consigne = dossierDiscussions + "/CLAUDE.md"
            if !fm.fileExists(atPath: consigne) {
                try "# Discussions libres\n\nCe dossier n'est pas un projet : ce sont des conversations libres avec Eliot (questions, idées, recherche). Pas de to-do de projet ici. Ne crée pas de fichiers dans ce dossier sauf si Eliot le demande.\n"
                    .write(toFile: consigne, atomically: true, encoding: .utf8)
            }
        } catch {
            alerte("Discussion impossible", "Le dossier \(dossierDiscussions) ne peut pas être créé : \(error.localizedDescription)")
            return
        }
        ouvrir(DemandeSession(cwd: cheminReel(dossierDiscussions)))
    }

    // MARK: Dialogues

    private static func confirmer(_ d: DemandeSession, prompt: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "Ouvrir une session Claude avec ce message ?"
        a.informativeText = "Un lien demande d'ouvrir une session dans\n\(d.cwd)\net d'y envoyer :\n\n« \(prompt.prefix(600))\(prompt.count > 600 ? "…" : "") »\n\nLa session tourne sans demande de permission. N'acceptez que si vous êtes à l'origine du lien."
        a.addButton(withTitle: "Ouvrir et envoyer")
        a.addButton(withTitle: "Annuler")
        return a.runModal() == .alertFirstButtonReturn
    }

    static func alerte(_ titre: String, _ texte: String) {
        journal("alerte : \(titre) — \(texte)")
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert(); a.messageText = titre; a.informativeText = texte; a.runModal()
    }
}
