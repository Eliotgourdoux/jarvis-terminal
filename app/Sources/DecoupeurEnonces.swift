import Foundation

/// Réglages de l'écoute mains libres du mode Jarvis (08/11/2026). Valeurs par défaut mesurées sur des
/// enregistrements fabriqués (voix de `say` ramenée à un niveau de micro réel, bruit de fond, frappes de clavier).
/// Chacune se change sans recompiler : `defaults write local.eliot.betterterminal <clé> <valeur>`.
struct ParametresEcoute {
    /// En dessous, jamais de la voix, quel que soit le bruit de fond (dB pleine échelle, trames de 20 ms).
    var seuilAbsoluDb: Float = -48                 // BTEcouteSeuilDb
    /// Une trame est « voix » si elle dépasse le bruit de fond mesuré d'au moins cette marge.
    var margeBruitDb: Float = 9                   // BTEcouteMargeDb
    /// Parole continue qu'il faut entendre pour ouvrir un énoncé (dans une fenêtre glissante un peu plus large).
    /// 0,2 s : un « oui » ou un « deux » dit vite dure à peine plus (mesuré sur la voix Thomas).
    var voixMinimum: Double = 0.20                 // BTEcouteVoixMin (s)
    var fenetreDebut: Double = 0.40
    /// Fin de l'énoncé après ce silence.
    var silenceFin: Double = 1.0                   // BTEcouteSilenceFin (s)
    /// Avant la parole qui a déclenché l'énoncé, on remonte les bribes de voix séparées de moins de `ecartRetour`
    /// (« Cockpit, … » : le nom, puis une pause) sur `retourMax` au plus, puis on garde encore `avantDebut`.
    var ecartRetour: Double = 0.60
    var retourMax: Double = 2.0
    /// Audio gardé avant le début détecté (pour ne pas couper le premier mot) et après la dernière parole.
    var avantDebut: Double = 0.30
    var apresFin: Double = 0.30
    /// Au-delà, l'énoncé est coupé et transcrit tel quel.
    var dureeMax: Double = 60
    /// Une trame de clic (frappe de clavier) a un pic très au-dessus de sa moyenne ; la voix, non.
    var crete: Float = 7

    static let trame = 320            // 20 ms à 16 kHz
    static let frequence = 16_000.0

    /// Réglages d'Eliot (UserDefaults) par-dessus les valeurs par défaut.
    static func depuis(_ d: UserDefaults) -> ParametresEcoute {
        var p = ParametresEcoute()
        func lire(_ k: String) -> Double? { d.object(forKey: k) == nil ? nil : d.double(forKey: k) }
        if let v = lire("BTEcouteSeuilDb") { p.seuilAbsoluDb = Float(v) }
        if let v = lire("BTEcouteMargeDb") { p.margeBruitDb = Float(v) }
        if let v = lire("BTEcouteVoixMin"), v > 0.05 { p.voixMinimum = v; p.fenetreDebut = max(p.fenetreDebut, v + 0.1) }
        if let v = lire("BTEcouteSilenceFin"), v > 0.2 { p.silenceFin = v }
        return p
    }
}

/// Découpe un flux continu (16 kHz mono, Int16) en énoncés, d'après le niveau sonore. Sans état partagé ni
/// fil : on lui pousse l'audio, il rend les événements. Utilisé par `EcouteContinue` et par les tests hors de l'app.
///
/// - trames de 20 ms ; une trame est « voix » si son niveau dépasse max(seuil absolu, bruit de fond + marge)
///   et si ce n'est pas un clic (rapport pic / moyenne) ;
/// - début : au moins `voixMinimum` de voix dans les `fenetreDebut` dernières secondes (des frappes de clavier,
///   espacées, n'y arrivent pas) ; l'énoncé démarre `avantDebut` avant la première trame de voix ;
/// - fin : `silenceFin` sans activité (activité = au moins 4 trames de voix sur les 10 dernières : un clic isolé
///   ne prolonge pas l'énoncé) ; on garde `apresFin` après la dernière activité ;
/// - le bruit de fond suit le niveau des trames calmes (descend vite, monte lentement).
final class DecoupeurEnonces {
    struct Enonce {
        let echantillons: [Int16]
        var duree: Double { Double(echantillons.count) / ParametresEcoute.frequence }
        let voix: Double          // secondes de trames « voix »
        let niveauMaxDb: Float
        let bruitDb: Float
        let coupe: Bool           // durée maximale atteinte
    }
    enum Evenement { case debut, fin(Enonce) }

    let p: ParametresEcoute
    private let nDebut: Int, nVoixMin: Int, nSilence: Int, nAvant: Int, nApres: Int, nMax: Int, nEcart: Int, nRetour: Int
    private static let nActivite = 10, voixActivite = 4

    private var reste: [Int16] = []
    private(set) var bruitDb: Float = -60
    /// Les premières trames après l'ouverture du micro mesurent le bruit de fond (aucune détection pendant ce temps).
    private var amorce: [Float] = []
    private static let nAmorce = 10
    // hors énoncé : les dernières trames (pour la fenêtre de début et l'audio d'avant)
    private var historique: [[Int16]] = []
    private var voixHisto: [Bool] = []
    // pendant un énoncé
    private(set) var enEnonce = false
    private var enonce: [Int16] = []
    private var trames = 0, voixTrames = 0, silence = 0, finActivite = 0
    private var activite: [Bool] = []
    private var maxDb: Float = -120

    init(_ p: ParametresEcoute = ParametresEcoute()) {
        self.p = p
        func n(_ s: Double) -> Int { max(1, Int((s * ParametresEcoute.frequence / Double(ParametresEcoute.trame)).rounded())) }
        nDebut = n(p.fenetreDebut); nVoixMin = n(p.voixMinimum); nSilence = n(p.silenceFin)
        nAvant = n(p.avantDebut); nApres = n(p.apresFin); nMax = n(p.dureeMax)
        nEcart = n(p.ecartRetour); nRetour = n(p.retourMax)
    }

    /// Audio de l'énoncé en cours (vide hors énoncé) : la transcription en direct le relit pendant qu'Eliot parle.
    var enonceEnCours: [Int16] { enEnonce ? enonce : [] }

    /// Oublie tout l'audio en cours (écoute suspendue) ; garde le bruit de fond appris.
    func reinitialiser() {
        reste = []
        oublierEnonce()
    }

    private func oublierEnonce() {
        historique = []; voixHisto = []
        enEnonce = false; enonce = []; activite = []
        trames = 0; voixTrames = 0; silence = 0; finActivite = 0; maxDb = -120
    }

    func pousser(_ e: [Int16]) -> [Evenement] {
        var ev: [Evenement] = []
        reste.append(contentsOf: e)
        let t = ParametresEcoute.trame
        var i = 0
        while reste.count - i >= t {
            if let x = trame(Array(reste[i..<(i + t)])) { ev.append(x) }
            i += t
        }
        if i > 0 { reste.removeFirst(i) }
        return ev
    }

    /// Niveau (dB pleine échelle) et rapport pic / moyenne d'une trame.
    static func mesurer(_ f: [Int16]) -> (db: Float, crete: Float) {
        var somme: Double = 0, pic: Int32 = 0
        for s in f { let v = Int32(s); somme += Double(v) * Double(v); pic = max(pic, abs(v)) }
        let rms = (somme / Double(max(1, f.count))).squareRoot()
        let db = Float(20 * log10(max(rms, 1e-3) / 32768))
        return (db, rms < 1 ? 0 : Float(Double(pic) / rms))
    }

    private func trame(_ f: [Int16]) -> Evenement? {
        let m = Self.mesurer(f)
        if amorce.count < Self.nAmorce {
            amorce.append(m.db)
            if amorce.count == Self.nAmorce { bruitDb = min(-20, max(-90, amorce.sorted()[Self.nAmorce / 3])) }
            return nil
        }
        let seuil = max(p.seuilAbsoluDb, bruitDb + p.margeBruitDb)
        let voix = m.db > seuil && m.crete < p.crete
        // bruit de fond : descend vite, monte lentement ; très lentement pendant la voix (bruit fort et durable)
        let a: Float = m.db < bruitDb ? 0.2 : (voix ? 0.0005 : 0.01)
        bruitDb = min(-20, max(-90, bruitDb + a * (m.db - bruitDb)))

        if !enEnonce {
            historique.append(f); voixHisto.append(voix)
            if historique.count > nDebut + nRetour + nAvant { historique.removeFirst(); voixHisto.removeFirst() }
            let fen = voixHisto.suffix(nDebut)
            guard fen.filter({ $0 }).count >= nVoixMin else { return nil }
            var premiere = fen.firstIndex(of: true) ?? fen.startIndex   // indices de voixHisto
            // bribes de voix juste avant (le nom dit en tête, suivi d'une virgule) : elles font partie de l'énoncé
            var j = premiere - 1
            while j >= 0, premiere - j <= nEcart {
                if voixHisto[j] { premiere = j }
                j -= 1
            }
            let debut = max(0, premiere - nAvant)
            enEnonce = true
            enonce = historique[debut...].flatMap { $0 }
            trames = historique.count - debut
            voixTrames = voixHisto[debut...].filter { $0 }.count
            activite = Array(voixHisto.suffix(Self.nActivite))
            silence = 0; finActivite = trames
            maxDb = -120
            for h in historique[debut...] { maxDb = max(maxDb, Self.mesurer(h).db) }
            historique = []; voixHisto = []
            return .debut
        }

        enonce.append(contentsOf: f)
        trames += 1
        if voix { voixTrames += 1 }
        maxDb = max(maxDb, m.db)
        activite.append(voix)
        if activite.count > Self.nActivite { activite.removeFirst() }
        if activite.filter({ $0 }).count >= Self.voixActivite { silence = 0; finActivite = trames } else { silence += 1 }
        let coupe = trames >= nMax
        guard silence >= nSilence || coupe else { return nil }
        let garder = min(trames, coupe ? trames : finActivite + nApres) * ParametresEcoute.trame
        let e = Enonce(echantillons: Array(enonce.prefix(garder)), voix: Double(voixTrames) * Double(ParametresEcoute.trame) / ParametresEcoute.frequence,
                       niveauMaxDb: maxDb, bruitDb: bruitDb, coupe: coupe)
        oublierEnonce()
        return .fin(e)
    }

    /// WAV 16 kHz mono 16 bits (ce qu'attend whisper.cpp).
    static func ecrireWAV(_ s: [Int16], vers u: URL) throws {
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        let octets = UInt32(s.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + octets); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16_000); u32(32_000); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(octets)
        s.withUnsafeBytes { d.append(contentsOf: $0) }   // arm64 : déjà en petit-boutiste
        try d.write(to: u, options: .atomic)
    }
}
