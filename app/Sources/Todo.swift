import Foundation

/// Panneau « To-do » de la page (ui/js/todo.js) : la to-do Apple Rappels du projet de la session,
/// lue et modifiée par le CLI d'Eliot `~/.claude/bin/todo` (jamais par un shell, arguments séparés).
///
/// Page → Swift : { type: "todo", action: "lister" | "cocher" | "ajouter", titre?, demande? }
///   - le projet n'est jamais choisi par la page : il vient du cwd de la session (registre des projets) ;
///   - `demande` (entier) est renvoyé tel quel pour que la page associe la réponse.
/// Swift → page (window.bt.todo) :
///   lister  → { action, demande, projet: { id, nom, emoji } | null, taches: [{ titre, notes, echeance, priorite, cree, id }], erreur? }
///   cocher / ajouter → { action, demande, titre, ok, message?, erreur? }
enum TodoProjet {
    /// `BT_TODO_BIN` : faux binaire pour les tests (ne touche pas aux vrais Rappels).
    static let binaire: String = {
        if let b = ProcessInfo.processInfo.environment["BT_TODO_BIN"], b.hasPrefix("/") { return b }
        return HOME + "/.claude/bin/todo"
    }()

    /// Un seul appel à la fois pour toute l'app : pas d'écritures concurrentes dans Rappels.
    private static let file = DispatchQueue(label: "bt.todo", qos: .userInitiated)

    private static let titreMax = 300
    private static let delaiLecture: TimeInterval = 45      // todo-ek < 0,1 s ; le repli osascript peut lancer Rappels
    private static let delaiEcriture: TimeInterval = 130    // au-delà des délais propres de todo (90 s / 120 s)

    static func traiter(_ o: [String: Any], cwd: String, repondre: @escaping (Any) -> Void) {
        var base: [String: Any] = [:]
        if let d = o["demande"] as? Int, d >= 0, d < 1_000_000_000 { base["demande"] = d }
        func rendre(_ r: [String: Any]) {
            let tout = base.merging(r) { _, n in n }
            DispatchQueue.main.async { repondre(tout) }
        }

        guard let action = o["action"] as? String, ["lister", "cocher", "ajouter", "supprimer"].contains(action) else {
            journal("todo : action refusée")
            rendre(["action": "inconnue", "ok": false, "erreur": "Action inconnue."])
            return
        }
        base["action"] = action

        var titre = ""
        if action != "lister" {
            guard let t = o["titre"] as? String else { rendre(["ok": false, "erreur": "Titre manquant."]); return }
            titre = t.trimmingCharacters(in: .whitespaces)
            base["titre"] = titre
            if let e = erreurTitre(titre) { rendre(["ok": false, "erreur": e]); return }
        }

        file.async {
            guard let projet = projet(cwd: cheminReel(cwd)) else {
                rendre(action == "lister" ? ["projet": NSNull(), "taches": []]
                                         : ["ok": false, "erreur": "Aucun projet du registre ne correspond à ce dossier."])
                return
            }
            let infoProjet: [String: Any] = ["id": projet.id, "nom": projet.nom, "emoji": projet.emoji]

            switch action {
            case "lister":
                let r = lancer(["list", projet.id, "--json"], delai: delaiLecture)
                guard r.code == 0, !r.delaiDepasse else {
                    rendre(["projet": infoProjet, "taches": [], "erreur": messageErreur(r, defaut: "Lecture de la to-do impossible.")])
                    return
                }
                guard let d = r.sortie.data(using: .utf8),
                      let liste = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] else {
                    journal("todo : réponse illisible de list : \(extrait(r.sortie))")
                    rendre(["projet": infoProjet, "taches": [], "erreur": "Réponse illisible de todo."])
                    return
                }
                let cles = ["titre", "notes", "echeance", "priorite", "cree", "id"]
                let taches: [[String: Any]] = liste.prefix(500).map { t in
                    var x: [String: Any] = [:]
                    for k in cles { if let v = t[k] as? String { x[k] = v } }
                    return x
                }
                rendre(["projet": infoProjet, "taches": taches])

            default:
                var args: [String]
                switch action {
                case "cocher": args = ["done", projet.id, titre]
                case "supprimer":
                    // Bouton poubelle (09/11/2026) : id exact de Rappels quand la page le donne, sinon titre exact.
                    args = ["suppr", projet.id, titre]
                    if let id = o["id"] as? String, id.hasPrefix("x-apple-reminder://"), id.count < 200,
                       !id.contains(where: { $0.isNewline }) { args += ["--id", id] }
                default: args = ["add", projet.id, titre]
                }
                journal("todo : \(args[0]) \(projet.id) « \(extrait(titre, 80)) »")
                let r = lancer(args, delai: delaiEcriture)
                if r.code == 0 && !r.delaiDepasse {
                    rendre(["ok": true, "message": r.sortie.trimmingCharacters(in: .whitespacesAndNewlines)])
                } else {
                    let defaut = action == "cocher" ? "Impossible de cocher la tâche."
                        : action == "supprimer" ? "Impossible de supprimer la tâche." : "Impossible d'ajouter la tâche."
                    rendre(["ok": false, "erreur": messageErreur(r, defaut: defaut)])
                }
            }
        }
    }

    // MARK: - Projet de la session (registre ~/.config/projets/registry.json)

    struct Projet { let id: String; let nom: String; let emoji: String; let chemin: String }

    /// Même règle que RegistreProjets.info (et Cockpit) : chemin exact d'abord, sinon le plus long chemin
    /// parent ; les dossiers « parents » d'autres projets (home, ~/Desktop) ne captent que leur propre chemin.
    static func projet(cwd: String) -> Projet? {
        guard let d = FileManager.default.contents(atPath: RegistreProjets.chemin),
              let liste = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] else { return nil }
        let projets: [Projet] = liste.compactMap {
            guard let id = $0["id"] as? String, !id.isEmpty, !id.hasPrefix("-"),
                  let c = $0["chemin"] as? String, !c.isEmpty else { return nil }
            return Projet(id: id, nom: $0["nom"] as? String ?? id, emoji: $0["emoji"] as? String ?? "",
                          chemin: cheminReel((c as NSString).expandingTildeInPath))
        }
        if let p = projets.first(where: { $0.chemin == cwd }) { return p }
        let parents = Set(projets.map(\.chemin).filter { c in projets.contains { $0.chemin.hasPrefix(c + "/") } })
        return projets.filter { !parents.contains($0.chemin) && cwd.hasPrefix($0.chemin + "/") }
            .max { $0.chemin.count < $1.chemin.count }
    }

    // MARK: - Lancement de todo (hors fil principal, délai max, stdout et stderr séparés)

    struct Resultat { let code: Int32; let sortie: String; let erreur: String; let delaiDepasse: Bool }

    /// posix_spawn plutôt que Process : Process passe les arguments en forme décomposée (NFD,
    /// « â » → « a » + accent), et `todo add` enregistrerait le titre ainsi dans Rappels.
    static func lancer(_ args: [String], delai: TimeInterval) -> Resultat {
        var env = Environnement.propre(ProcessInfo.processInfo.environment)
        env["LANG"] = env["LANG"] ?? "fr_FR.UTF-8"

        var tOut: [Int32] = [-1, -1], tErr: [Int32] = [-1, -1]
        guard pipe(&tOut) == 0 else { return Resultat(code: -1, sortie: "", erreur: "pipe impossible", delaiDepasse: false) }
        guard pipe(&tErr) == 0 else {
            close(tOut[0]); close(tOut[1])
            return Resultat(code: -1, sortie: "", erreur: "pipe impossible", delaiDepasse: false)
        }
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, tOut[1], 1)
        posix_spawn_file_actions_adddup2(&actions, tErr[1], 2)
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Aucun autre descripteur de l'app n'est hérité ; groupe à part pour tout arrêter au délai (todo-ek, osascript).
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attr, 0)

        let argv: [UnsafeMutablePointer<CChar>?] = ([binaire] + args).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup($0.key + "=" + $0.value) } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, binaire, &actions, &attr, argv, envp)
        close(tOut[1]); close(tErr[1])
        if rc != 0 {
            close(tOut[0]); close(tErr[0])
            journal("todo : lancement impossible (\(binaire)) : \(String(cString: strerror(rc)))")
            return Resultat(code: -1, sortie: "", erreur: "todo introuvable (\(binaire))", delaiDepasse: false)
        }

        var dOut = Data(), dErr = Data()
        let lu = DispatchGroup()
        let hOut = FileHandle(fileDescriptor: tOut[0], closeOnDealloc: true)
        let hErr = FileHandle(fileDescriptor: tErr[0], closeOnDealloc: true)
        lu.enter(); DispatchQueue.global().async { dOut = hOut.readDataToEndOfFile(); lu.leave() }
        lu.enter(); DispatchQueue.global().async { dErr = hErr.readDataToEndOfFile(); lu.leave() }

        let verrou = NSLock()
        var fini = false, depasse = false
        let garde = DispatchWorkItem {
            verrou.lock(); defer { verrou.unlock() }
            if !fini { depasse = true; kill(-pid, SIGTERM) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + delai, execute: garde)
        var statut: Int32 = 0
        while waitpid(pid, &statut, 0) == -1 && errno == EINTR {}
        verrou.lock(); fini = true; verrou.unlock()
        garde.cancel()
        _ = lu.wait(timeout: .now() + 2)

        // WIFEXITED / WEXITSTATUS (macros C absentes de Swift)
        let code: Int32 = (statut & 0x7f) == 0 ? (statut >> 8) & 0xff : 128 + (statut & 0x7f)
        let r = Resultat(code: code, sortie: String(decoding: dOut, as: UTF8.self),
                         erreur: String(decoding: dErr, as: UTF8.self), delaiDepasse: depasse)
        if r.code != 0 || depasse { journal("todo \(args.first ?? "") : code \(r.code)\(depasse ? " (délai dépassé)" : "") \(extrait(r.erreur, 200))") }
        return r
    }

    /// Message lisible pour la page : la première ligne d'erreur de todo, sans le préfixe « todo : ».
    private static func messageErreur(_ r: Resultat, defaut: String) -> String {
        if r.delaiDepasse { return "Rappels ne répond pas. Vérifie dans Rappels avant de réessayer." }
        let lignes = r.erreur.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.contains("repli sur osascript") }
        guard var m = lignes.first else { return defaut }
        if m.hasPrefix("todo : ") { m = String(m.dropFirst(7)) }
        if let premiere = m.first { m = premiere.uppercased() + m.dropFirst() }
        return m.count > 240 ? String(m.prefix(240)) + "…" : m
    }

    /// Une ligne, 300 caractères au plus, pas de caractère de contrôle (les emoji composés restent permis).
    static func erreurTitre(_ t: String) -> String? {
        if t.isEmpty { return "Titre vide." }
        if t.count > titreMax { return "Titre trop long (\(titreMax) caractères au plus)." }
        if t.unicodeScalars.contains(where: { $0.properties.generalCategory == .control
            || $0.properties.generalCategory == .lineSeparator || $0.properties.generalCategory == .paragraphSeparator }) {
            return "Le titre doit tenir sur une ligne."
        }
        // todo lirait « --xxx » comme une option.
        if t.hasPrefix("--") { return "Le titre ne peut pas commencer par « -- »." }
        return nil
    }
}
