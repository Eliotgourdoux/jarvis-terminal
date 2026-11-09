import AppKit

/// Dictée en direct (08/11/2026, demande d'Eliot : « dans le terminal ça s'affiche en live, c'est hyper beau »).
/// Pendant qu'Eliot tient Espace, l'audio déjà capté est retranscrit en boucle par `whisper-server`
/// (modèle small gardé en mémoire : ~0,45 s par passe sur ce Mac) et le texte partiel s'affiche dans la saisie
/// (`bt.dictee({etat: "partiel", texte})`). Au relâchement, le texte final reste celui de whisper-cli
/// large-v3-turbo (plus juste), qui remplace le partiel.
/// Même mécanisme pour le mode vocal (09/11/2026, « pour l'apparition des mots, je veux quelque chose de plus
/// smooth ») : un énoncé mains libres ou ⌥Espace envoie ses partiels à `MoteurVocal`, qui les pousse à la page
/// (`bt.vocalDirect`). Une seule transcription en direct à la fois (le micro n'est qu'à un seul des trois).
/// Le serveur démarre à la première dictée, s'arrête après 5 min sans dictée et à la sortie de l'app ; il reste
/// chargé tant que le mode vocal mains libres est actif (`garder`), pour que le premier mot arrive vite.
/// Tout se passe sur le fil principal, sauf la requête HTTP.
final class DicteeDirecte {
    static let shared = DicteeDirecte()
    static let port = 18741
    static let inactiviteMax: TimeInterval = 300

    private var serveur: Process?
    private var pret = false
    private var demarrage = false
    private var surPartiel: ((String) -> Void)?
    private var audio: (() -> [Int16])?
    private var actif = false
    private var garde = false
    private var requete = false
    private var generation = 0
    private var tramesEnvoyees = 0
    private var dernierTexte = ""
    /// Dernier texte rendu par le serveur et la taille de l'audio qu'il couvre (même vide, même inchangé).
    private var dernierResultat: (texte: String, echantillons: Int)?
    /// Demandes de texte « frais » (fin d'énoncé intelligente) : rendu dès qu'un texte couvre `min` échantillons.
    private var frais: [(min: Int, gen: Int, rappel: (String?) -> Void)] = []
    private var minuteur: Timer?
    private var arretDiffere: DispatchWorkItem?
    private let url = URL(string: "http://127.0.0.1:\(DicteeDirecte.port)/inference")!

    private init() {
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
            DicteeDirecte.shared.arreterServeur()
        }
    }

    /// Dictée de la saisie : les partiels vont à `bt.dictee`.
    func commencer(pour s: Session, audio: @escaping () -> [Int16]) {
        commencer(audio: audio) { [weak s] t in s?.pousserDictee(["etat": "partiel", "texte": t]) }
    }

    /// `audio` rend tout l'audio capté depuis le début (16 kHz mono) ; `partiel` reçoit chaque nouveau texte.
    func commencer(audio: @escaping () -> [Int16], partiel: @escaping (String) -> Void) {
        generation += 1
        actif = true
        surPartiel = partiel
        self.audio = audio
        tramesEnvoyees = 0
        dernierTexte = ""
        dernierResultat = nil
        echouerFrais()
        arretDiffere?.cancel(); arretDiffere = nil
        demarrerServeur()
        minuteur?.invalidate()
        minuteur = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in DicteeDirecte.shared.tic() }
    }

    func arreter() {
        guard actif else { return }
        actif = false
        generation += 1
        echouerFrais()
        minuteur?.invalidate(); minuteur = nil
        surPartiel = nil; audio = nil
        planifierArret()
    }

    /// Mode vocal mains libres actif : serveur chargé d'avance et gardé (pas d'arrêt après 5 min).
    func garder(_ g: Bool) {
        guard g != garde else { return }
        garde = g
        if g { arretDiffere?.cancel(); arretDiffere = nil; demarrerServeur() }
        else if !actif { planifierArret() }
    }

    private func planifierArret() {
        arretDiffere?.cancel(); arretDiffere = nil
        guard !garde else { return }
        let w = DispatchWorkItem {
            let d = DicteeDirecte.shared
            if !d.garde && !d.actif { d.arreterServeur() }
        }
        arretDiffere = w
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.inactiviteMax, execute: w)
    }

    // MARK: - Transcriptions partielles

    /// Texte de l'énoncé en cours lu sur au moins `min` échantillons (toute la parole jusqu'à une pause) :
    /// tout de suite si le dernier texte suffit, sinon après la prochaine passe (lancée sans attendre).
    /// nil si le serveur n'est pas prêt, si la dictée s'arrête, ou après `delai`. Fil principal.
    func texteFrais(min: Int, delai: TimeInterval, _ rappel: @escaping (String?) -> Void) {
        guard actif, pret else { rappel(nil); return }
        if let r = dernierResultat, r.echantillons >= min { rappel(r.texte); return }
        let gen = generation
        frais.append((min, gen, rappel))
        tic(force: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + delai) {
            let d = DicteeDirecte.shared
            guard let i = d.frais.firstIndex(where: { $0.gen == gen && $0.min == min }) else { return }
            let r = d.frais.remove(at: i).rappel
            r(nil)
        }
    }

    private func echouerFrais() {
        let l = frais; frais = []
        l.forEach { $0.rappel(nil) }
    }

    private func rendreFrais(_ texte: String, echantillons n: Int) {
        let prets = frais.filter { $0.gen == generation && $0.min <= n }
        frais.removeAll { $0.gen == generation && $0.min <= n }
        prets.forEach { $0.rappel(texte) }
    }

    private func tic(force: Bool = false) {
        guard actif, pret, !requete, let audio else { return }
        let pcm = audio()
        // au moins 0,6 s d'audio, et 0,3 s de nouveau depuis la dernière passe (forcé : du nouveau suffit)
        guard pcm.count >= 9_600, pcm.count - tramesEnvoyees >= (force ? 1 : 4_800) else { return }
        tramesEnvoyees = pcm.count
        let nEnvoyes = pcm.count
        requete = true
        let gen = generation
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        let frontiere = "bt" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        req.setValue("multipart/form-data; boundary=\(frontiere)", forHTTPHeaderField: "Content-Type")
        req.httpBody = Self.corps(wav: Self.wav(pcm), frontiere: frontiere)
        URLSession.shared.dataTask(with: req) { data, _, err in
            let brut = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["text"] as? String
            DispatchQueue.main.async {
                let d = DicteeDirecte.shared
                d.requete = false
                guard d.actif, gen == d.generation else { return }
                if let err { journal("dictée en direct : \(err.localizedDescription)"); return }
                let t = Transcription.nettoyer((brut ?? "").replacingOccurrences(of: "\n", with: " "), invite: "")
                d.dernierResultat = (t, nEnvoyes)
                d.rendreFrais(t, echantillons: nEnvoyes)
                if !d.frais.isEmpty { d.tic(force: true) }   // une demande attend plus d'audio que cette passe
                guard !t.isEmpty, t != d.dernierTexte else { return }
                d.dernierTexte = t
                d.surPartiel?(t)
            }
        }.resume()
    }

    private static func wav(_ pcm: [Int16]) -> Data {
        var d = Data(capacity: 44 + pcm.count * 2)
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        let octets = UInt32(pcm.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + octets); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16_000); u32(32_000); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(octets)
        pcm.withUnsafeBufferPointer { d.append(UnsafeRawBufferPointer($0).bindMemory(to: UInt8.self)) }
        return d
    }

    private static func corps(wav: Data, frontiere: String) -> Data {
        var d = Data()
        func champ(_ nom: String, _ valeur: String) {
            d.append("--\(frontiere)\r\nContent-Disposition: form-data; name=\"\(nom)\"\r\n\r\n\(valeur)\r\n".data(using: .utf8)!)
        }
        champ("temperature", "0")
        champ("response_format", "json")
        d.append("--\(frontiere)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictee.wav\"\r\nContent-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        d.append(wav)
        d.append("\r\n--\(frontiere)--\r\n".data(using: .utf8)!)
        return d
    }

    // MARK: - whisper-server

    private static var modele: String? {
        let m = Transcription.modeles
        return [m + "/ggml-small.bin", m + "/ggml-large-v3-turbo.bin"].first { FileManager.default.fileExists(atPath: $0) }
    }

    private func demarrerServeur() {
        if pret || demarrage { return }
        demarrage = true
        Environnement.charger { env in
            let d = DicteeDirecte.shared
            guard let exe = Environnement.trouver("whisper-server", env, connus: ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"]),
                  let modele = Self.modele else {
                journal("dictée en direct : whisper-server ou modèle introuvable, pas d'affichage en direct")
                d.demarrage = false
                return
            }
            // Un serveur resté d'un lancement précédent (app plantée) répond déjà : on le reprend.
            d.attendre(essais: 1) { dejaLa in
                if dejaLa { d.pret = true; d.demarrage = false; journal("dictée en direct : serveur déjà en place"); return }
                let p = Process()
                p.executableURL = URL(fileURLWithPath: exe)
                p.arguments = ["-m", modele, "-l", "fr", "--host", "127.0.0.1", "--port", String(Self.port), "-nt", "-t", "4"]
                p.environment = env
                p.standardInput = FileHandle.nullDevice
                p.standardOutput = FileHandle.nullDevice
                p.standardError = FileHandle.nullDevice
                p.terminationHandler = { _ in DispatchQueue.main.async {
                    let d = DicteeDirecte.shared
                    if d.serveur === p { d.serveur = nil; d.pret = false; d.demarrage = false }
                } }
                do { try p.run() } catch {
                    journal("dictée en direct : lancement impossible — \(error.localizedDescription)")
                    d.demarrage = false; return
                }
                d.serveur = p
                let debut = Date()
                d.attendre(essais: 75) { ok in
                    d.demarrage = false
                    d.pret = ok
                    journal(ok ? "dictée en direct : serveur prêt en \(String(format: "%.2f", Date().timeIntervalSince(debut))) s (\((modele as NSString).lastPathComponent))"
                               : "dictée en direct : le serveur ne répond pas")
                    if !ok { d.arreterServeur() }
                }
            }
        }
    }

    /// Interroge le serveur toutes les 0,2 s, `essais` fois au plus.
    private func attendre(essais: Int, _ fini: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(Self.port)/")!, timeoutInterval: 0.5)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { _, rep, _ in
            let ok = (rep as? HTTPURLResponse).map { $0.statusCode < 500 } ?? false
            DispatchQueue.main.async {
                if ok || essais <= 1 { fini(ok); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { DicteeDirecte.shared.attendre(essais: essais - 1, fini) }
            }
        }.resume()
    }

    func arreterServeur() {
        arretDiffere?.cancel(); arretDiffere = nil
        if let p = serveur, p.isRunning { p.terminate(); journal("dictée en direct : serveur arrêté") }
        serveur = nil
        pret = false
    }
}
