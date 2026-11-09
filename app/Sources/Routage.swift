import Foundation

/// À qui va une phrase dictée (CONTRAT.md, « Mode vocal ») : un nom de projet en tête de phrase
/// désigne sa session ; sinon la session qui vient de parler ; sinon la fenêtre au premier plan.
/// Ici, uniquement la partie pure (comparaison de noms), testable sans fenêtre.
enum Routage {
    /// minuscules, sans accents, tout ce qui n'est pas lettre ou chiffre devient une espace
    static func normaliser(_ s: String) -> String {
        let plie = s.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: Locale(identifier: "fr_FR"))
        let u = plie.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
        return String(u).split(separator: " ").joined(separator: " ")
    }

    static func mots(_ s: String) -> [String] { normaliser(s).split(separator: " ").map(String.init) }

    static func distance(_ a: String, _ b: String) -> Int {
        let x = Array(a), y = Array(b)
        if x.isEmpty { return y.count }
        if y.isEmpty { return x.count }
        var prec = Array(0...y.count), cour = [Int](repeating: 0, count: y.count + 1)
        for i in 1...x.count {
            cour[0] = i
            for j in 1...y.count {
                cour[j] = min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1))
            }
            swap(&prec, &cour)
        }
        return prec[y.count]
    }

    static func similarite(_ a: String, _ b: String) -> Double {
        let m = max(a.count, b.count)
        return m == 0 ? 1 : 1 - Double(distance(a, b)) / Double(m)
    }

    struct Correspondance { let index: Int; let mots: Int; let score: Double; let nom: String }

    /// Cherche, parmi les candidats (une liste de noms par candidat), celui dont un nom ouvre la phrase.
    /// On compare sans espaces (« BT Terminal » ≈ « Better Terminal », « Cock pit » ≈ « Cockpit »),
    /// un nom pouvant être dit en entier ou par ses premiers mots (« Better Terminal » pour
    /// « Better Terminal For Claude »). Seuils : nom de 4 lettres ou moins → identique ; 5 à 6 → 0,8 ;
    /// 7 et plus → 0,7. Sans ponctuation après le nom dans la phrase (pas de pause), on exige 0,85.
    static func nomEnTete(_ phrase: String, candidats: [[String]]) -> Correspondance? {
        let jetons = Self.jetons(phrase)
        guard !jetons.isEmpty else { return nil }
        let dits = jetons.map { normaliser($0.texte) }
        var meilleur: Correspondance?
        for (i, noms) in candidats.enumerated() {
            for nom in noms {
                let nm = mots(nom)
                guard !nm.isEmpty else { continue }
                for j in 1...nm.count {
                    let cible = nm[0..<j].joined()
                    if j < nm.count && cible.count < 5 { continue }   // « Ping » seul ne désigne pas « Ping Pong Edit »
                    for k in 1...min(4, dits.count) {
                        let dit = dits[0..<k].joined()
                        if abs(dit.count - cible.count) > max(3, cible.count / 2) { continue }
                        let s = similarite(dit, cible)
                        var seuil = cible.count <= 4 ? 1.0 : cible.count <= 6 ? 0.8 : 0.7
                        if !jetons[k - 1].suiviDePonctuation && k < jetons.count { seuil = max(seuil, 0.85) }
                        guard s >= seuil else { continue }
                        // à score égal : le nom le plus long l'emporte (« Better Terminal For Claude » plutôt que « Better »)
                        if meilleur == nil || s > meilleur!.score + 1e-9 || (abs(s - meilleur!.score) < 1e-9 && k > meilleur!.mots) {
                            meilleur = Correspondance(index: i, mots: k, score: s, nom: nom)
                        }
                    }
                }
            }
        }
        return meilleur
    }

    /// La phrase sans ses `n` premiers mots ni la ponctuation qui les suit, avec une majuscule.
    static func sansEnTete(_ phrase: String, mots n: Int) -> String {
        let j = jetons(phrase)
        guard n > 0, n <= j.count else { return phrase }
        var reste = String(phrase[j[n - 1].fin...])
        while let c = reste.first, c.isWhitespace || ",.;:!?-–—".contains(c) { reste.removeFirst() }
        guard let p = reste.first else { return "" }
        return p.uppercased() + reste.dropFirst()
    }

    struct Jeton { let texte: String; let fin: String.Index; let suiviDePonctuation: Bool }

    static func jetons(_ s: String) -> [Jeton] {
        var l: [Jeton] = []
        var i = s.startIndex
        while i < s.endIndex {
            guard s[i].isLetter || s[i].isNumber else { i = s.index(after: i); continue }
            var f = i
            while f < s.endIndex, s[f].isLetter || s[f].isNumber { f = s.index(after: f) }
            var k = f, ponct = false
            while k < s.endIndex, !(s[k].isLetter || s[k].isNumber) {
                if ",.;:!?–—".contains(s[k]) { ponct = true }
                k = s.index(after: k)
            }
            l.append(Jeton(texte: String(s[i..<f]), fin: f, suiviDePonctuation: ponct))
            i = f
        }
        return l
    }

    /// Les projets du registre (~/.config/projets/registry.json) : noms et identifiants.
    static func projetsDuRegistre() -> [(nom: String, id: String)] {
        guard let d = FileManager.default.contents(atPath: RegistreProjets.chemin),
              let l = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return [] }
        return l.compactMap { o in
            guard let n = o["nom"] as? String, !n.isEmpty else { return nil }
            return (n, o["id"] as? String ?? "")
        }
    }
}

/// La phrase dictée a-t-elle l'air finie ? (fin d'énoncé intelligente du mode mains libres, 09/11/2026)
/// Lu sur le texte de whisper-server pendant un silence : inachevée → on attend plus longtemps la suite.
/// - inachevée : points de suspension, virgule ou deux-points en fin ; dernier mot de liaison (« et », « mais »,
///   « parce que », « de », « le », « pour », « avec », « euh »…) sauf question ; pas de ponctuation finale ;
///   très courte (deux mots ou moins), sauf réponse brève connue (« oui », « deux », « vas-y », « d'accord ») ;
/// - complète sinon (ponctuation finale sur une phrase entière).
/// Les accents comptent : « là » et « où » finissent une phrase, « la » et « ou » non.
enum FinPhrase {
    static let liaisons: Set<String> = [
        "et", "mais", "ou", "donc", "car", "ni", "or", "que", "qu", "puis", "ensuite", "enfin",
        "de", "d", "du", "des", "le", "la", "les", "l", "un", "une", "au", "aux", "à", "en",
        "pour", "avec", "sur", "sous", "dans", "par", "chez", "vers", "entre", "sans", "contre", "comme",
        "si", "quand", "lorsque", "puisque", "parce", "pendant", "depuis",
        "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "votre", "nos", "vos", "leur", "leurs",
        "ce", "cet", "cette", "ces", "je", "j", "tu", "il", "ils", "on", "me", "m", "te", "t", "se", "s", "ne", "n", "c",
        "euh", "heu", "hum", "hmm", "bah", "ben", "genre", "style"]
    static let reponsesBreves: Set<String> = [
        "oui", "non", "ok", "okay", "ouais", "d", "accord", "merci", "stop", "arrête", "arrete", "go", "vas", "y",
        "continue", "annule", "parfait", "super", "nickel", "exactement", "voilà", "carrément", "bien", "sûr",
        "un", "deux", "trois", "quatre", "cinq", "premier", "première", "deuxième", "troisième", "dernier", "dernière",
        "aucun", "aucune", "tous", "toutes", "le", "la", "l", "les", "approuve", "valide", "refuse", "autorise", "jamais", "toujours"]

    /// Mots en minuscules, accents gardés, coupés aux apostrophes et aux traits d'union.
    static func mots(_ s: String) -> [String] {
        s.lowercased().split { !($0.isLetter || $0.isNumber) }.map(String.init)
    }

    /// nil si la phrase a l'air finie, sinon la raison (pour le journal).
    static func inachevee(_ texte: String) -> String? {
        let t = texte.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let fin = t.last else { return "vide" }
        if t.hasSuffix("...") || t.hasSuffix("…") { return "points de suspension" }
        if ",;:-–—".contains(fin) { return "virgule en fin" }
        let m = mots(t)
        guard let dernier = m.last else { return "vide" }
        let dernierBrut = t.split(whereSeparator: { $0.isWhitespace }).last.map(String.init) ?? ""
        // « fais-le », « vas-y » : le trait d'union lie le mot au verbe d'avant, la phrase peut finir là
        if fin != "?", liaisons.contains(dernier), !dernierBrut.contains("-") { return "mot de liaison « \(dernier) »" }
        // « non », « d'accord » : réponse brève complète, même sans ponctuation
        if m.count <= 3, m.allSatisfy({ reponsesBreves.contains($0) }) { return nil }
        if !".!?".contains(fin) { return "pas de ponctuation finale" }
        if m.count <= 2, fin == "." { return "très courte" }   // whisper met un point aux bribes
        return nil
    }
}
