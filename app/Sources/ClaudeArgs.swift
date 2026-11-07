import Foundation

// Le SEUL endroit où sont définis les arguments de lancement de claude et les deux messages que la
// coque écrit elle-même (repli d'envoi, interruption avant arrêt). Source : moteur/PROTOCOLE.md §1, §2, §5, §6.

enum ClaudeArgs {
    /// Options communes à toutes les sessions de l'app.
    /// Pas de `-p` : stdin n'est pas un terminal, claude passe seul en mode non interactif
    /// (comme le SDK officiel et moteur/essai.py).
    static let base: [String] = [
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool=stdio",
        "--dangerously-skip-permissions",
        "--thinking-display", "summarized",   // sinon les blocs thinking arrivent vides (PROTOCOLE §1)
    ]

    /// Arguments complets (sans le binaire).
    /// - reprise : `--resume <id>` (le session_id reste le même, vérifié par l'agent B), sinon `--session-id <id>`.
    static func arguments(sessionId: String, reprise: Bool, modele: String?, effort: String?) -> [String] {
        var a = base
        if let m = modele, Validation.modele(m) { a += ["--model", m] }
        if let e = effort, Validation.effort(e) { a += ["--effort", e] }
        a += reprise ? ["--resume", sessionId] : ["--session-id", sessionId]
        return a
    }

    /// Commande tapée dans Terminal.app par « ouvrir dans le terminal » (le filet de sécurité).
    /// Chaque morceau variable passe par shq ; le script AppleScript la reçoit en argv (aucune interpolation).
    /// Sans transcript (aucun message encore envoyé), `--resume` échouerait : on garde l'id avec `--session-id`.
    static func commandeTerminal(claude: String, cwd: String, sessionId: String, reprise: Bool, modele: String?) -> String {
        var c = "cd " + shq(cwd) + " && " + shq(claude) + " --dangerously-skip-permissions "
            + (reprise ? "--resume " : "--session-id ") + shq(sessionId)
        if let m = modele, Validation.modele(m) { c += " --model " + shq(m) }
        return c
    }

    /// Message utilisateur stream-json (format de moteur/essai.py et fixtures/*.entree.jsonl).
    /// Utilisé seulement en repli, quand la page ne sait pas construire le message elle-même
    /// (bt.envoyerTexte absent) : en temps normal c'est la page qui construit tout.
    static func messageUtilisateur(_ texte: String) -> String? {
        let o: [String: Any] = [
            "type": "user",
            "session_id": "",
            "message": ["role": "user", "content": [["type": "text", "text": texte]]],
            "parent_tool_use_id": NSNull(),
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.withoutEscapingSlashes]) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    /// Interruption du tour en cours (PROTOCOLE §5-6) : envoyée juste avant de fermer stdin, sinon claude
    /// termine d'abord le tour (qui peut durer des minutes) et l'arrêt finirait toujours en SIGTERM.
    static func interruption() -> String {
        "{\"type\":\"control_request\",\"request_id\":\"bt-arret-\(UUID().uuidString.prefix(8).lowercased())\",\"request\":{\"subtype\":\"interrupt\"}}"
    }
}

/// Effort appliqué quand la session n'en choisit pas : `effortLevel` des réglages Claude Code,
/// du plus précis au plus général (projet local, projet, utilisateur). Nil si aucun réglage.
enum EffortReglages {
    static func valeur(cwd: String) -> String? {
        let maison = FileManager.default.homeDirectoryForCurrentUser.path
        for f in [cwd + "/.claude/settings.local.json", cwd + "/.claude/settings.json", maison + "/.claude/settings.json"] {
            guard let d = FileManager.default.contents(atPath: f),
                  let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                  let e = o["effortLevel"] as? String, Validation.effort(e) else { continue }
            return e
        }
        return nil
    }
}

/// Validation stricte de tout ce qui vient de l'extérieur (page, URL, ligne de commande).
enum Validation {
    static let efforts: Set<String> = ["low", "medium", "high", "xhigh", "max"]
    static let etats: Set<String> = ["travaille", "attend", "pret", "termine"]
    static let typesQuestion: Set<String> = ["permission", "choix", "multi", "texte"]

    static func correspond(_ s: String, _ motif: String) -> Bool {
        s.range(of: motif, options: .regularExpression) != nil
    }
    /// « haiku », « sonnet », « claude-opus-5-5 », « claude-sonnet-4-6[1m] »…
    static func modele(_ s: String) -> Bool { correspond(s, "^[A-Za-z0-9][A-Za-z0-9._\\[\\]-]{0,63}$") }
    static func effort(_ s: String) -> Bool { efforts.contains(s) }
    static func sessionId(_ s: String) -> Bool {
        correspond(s, "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    }
    /// Identifiant de question : court (callback_data Telegram ≤ 64 octets), sûr comme nom de fichier.
    static func idQuestion(_ s: String) -> Bool { correspond(s, "^[A-Za-z0-9_-]{1,32}$") }

    /// Dossier de travail : chemin absolu (~ accepté) d'un dossier existant, rendu canonique.
    static func dossier(_ brut: String) -> String? {
        let p = (brut as NSString).expandingTildeInPath
        guard p.hasPrefix("/") else { return nil }
        var estDossier: ObjCBool = false
        guard FileManager.default.fileExists(atPath: p, isDirectory: &estDossier), estDossier.boolValue else { return nil }
        return cheminReel(p)
    }
}
