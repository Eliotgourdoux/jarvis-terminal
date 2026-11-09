import Foundation

/// Réglages de l'écoute mains libres du mode Jarvis (08/11/2026). Valeurs par défaut mesurées sur des
/// enregistrements fabriqués (voix de `say` ramenée à un niveau de micro réel, bruit de fond, frappes de clavier).
/// Chacune se change sans recompiler : `defaults write local.eliot.betterterminal <clé> <valeur>`.
///
/// Fin d'énoncé intelligente (09/11/2026, Eliot : « je prends souvent des blancs de deux secondes pour réfléchir
/// entre mes mots, et il estime que j'ai fini alors que non ») : après `silencePause` de silence, le découpeur
/// signale une pause ; `MoteurVocal` fait lire le texte entendu (whisper-server) et rend un verdict. Phrase qui a
/// l'air finie : coupure à `silenceComplet` de silence ; inachevée (mot de liaison en fin, pas de ponctuation
/// finale, très courte) : `silenceInacheve`. Sans verdict à temps (serveur absent ou lent) : `silenceFin`.
struct ParametresEcoute {
    /// En dessous, jamais de la voix, quel que soit le bruit de fond (dB pleine échelle, trames de 20 ms).
    var seuilAbsoluDb: Float = -48                 // BTEcouteSeuilDb
    /// Une trame est « voix » si elle dépasse le bruit de fond mesuré d'au moins cette marge.
    var margeBruitDb: Float = 9                   // BTEcouteMargeDb
    /// Parole continue qu'il faut entendre pour ouvrir un énoncé (dans une fenêtre glissante un peu plus large).
    /// 0,2 s : un « oui » ou un « deux » dit vite dure à peine plus (mesuré sur la voix Thomas).
    var voixMinimum: Double = 0.20                 // BTEcouteVoixMin (s)
    var fenetreDebut: Double = 0.40
    /// Silence qui ouvre une pause : le texte entendu est lu pour savoir si la phrase a l'air finie.
    var silencePause: Double = 1.2                 // BTEcoutePause (s)
    /// Fin de l'énoncé après ce silence quand la phrase a l'air finie (ponctuation finale, phrase entière).
    var silenceComplet: Double = 2.0               // BTEcouteSilenceComplet (s)
    /// Fin de l'énoncé après ce silence quand la phrase a l'air inachevée (« … parce que », « et », pas de point).
    var silenceInacheve: Double = 4.0              // BTEcouteSilenceInacheve (s)
    /// Repli quand le texte n'a pas pu être lu à temps (serveur de transcription absent ou lent). Ramené entre
    /// `silenceComplet` et `silenceInacheve` : l'ancien réglage d'Eliot (2,5 s) garde donc un sens.
    var silenceFin: Double = 2.5                   // BTEcouteSilenceFin (s)
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

    // Couper la parole à Jarvis (09/11/2026). Pendant que sa voix sort des haut-parleurs du Mac, le micro l'entend :
    // une trame n'est « voix » que si elle dépasse l'écho attendu (niveau joué + couplage appris) de `margeEchoDb`,
    // et il faut `voixCoupure` de cette voix nette pour ouvrir un énoncé (qui coupe Jarvis).
    var margeEchoDb: Float = 8                     // BTEcouteMargeEcho (dB)
    var voixCoupure: Double = 0.35                 // BTEcouteVoixCoupure (s)
    /// L'écho arrive un peu après le niveau mesuré à la lecture, et traîne (réverbération) : on prend le niveau joué
    /// le plus fort sur cette fenêtre.
    var fenetreEcho: Double = 0.30

    static let trame = 320            // 20 ms à 16 kHz
    static let frequence = 16_000.0

    /// Réglages d'Eliot (UserDefaults) par-dessus les valeurs par défaut.
    static func depuis(_ d: UserDefaults) -> ParametresEcoute {
        var p = ParametresEcoute()
        func lire(_ k: String) -> Double? { d.object(forKey: k) == nil ? nil : d.double(forKey: k) }
        if let v = lire("BTEcouteSeuilDb") { p.seuilAbsoluDb = Float(v) }
        if let v = lire("BTEcouteMargeDb") { p.margeBruitDb = Float(v) }
        if let v = lire("BTEcouteVoixMin"), v > 0.05 { p.voixMinimum = v; p.fenetreDebut = max(p.fenetreDebut, v + 0.1) }
        if let v = lire("BTEcoutePause"), v > 0.3 { p.silencePause = v }
        if let v = lire("BTEcouteSilenceComplet"), v > 0.3 { p.silenceComplet = v }
        if let v = lire("BTEcouteSilenceInacheve"), v > 0.3 { p.silenceInacheve = v }
        if let v = lire("BTEcouteSilenceFin"), v > 0.2 { p.silenceFin = v }
        if let v = lire("BTEcouteMargeEcho") { p.margeEchoDb = Float(v) }
        if let v = lire("BTEcouteVoixCoupure"), v > 0.05 { p.voixCoupure = v }
        return p.coherent()
    }

    /// pause ≤ complet ≤ inachevé, repli entre les deux.
    func coherent() -> ParametresEcoute {
        var p = self
        p.silenceComplet = max(p.silenceComplet, p.silencePause)
        p.silenceInacheve = max(p.silenceInacheve, p.silenceComplet)
        p.silenceFin = min(max(p.silenceFin, p.silenceComplet), p.silenceInacheve)
        return p
    }
}

/// Découpe un flux continu (16 kHz mono, Int16) en énoncés, d'après le niveau sonore. Sans état partagé ni
/// fil : on lui pousse l'audio, il rend les événements. Utilisé par `EcouteContinue` et par les tests hors de l'app.
///
/// - trames de 20 ms ; une trame est « voix » si son niveau dépasse max(seuil absolu, bruit de fond + marge,
///   écho attendu + marge d'écho) et si ce n'est pas un clic (rapport pic / moyenne) ;
/// - début : au moins `voixMinimum` de voix dans les `fenetreDebut` dernières secondes (des frappes de clavier,
///   espacées, n'y arrivent pas ; pendant la voix de Jarvis, `voixCoupure`) ; l'énoncé démarre `avantDebut`
///   avant la première trame de voix ;
/// - pause : `silencePause` sans activité (activité = au moins 4 trames de voix sur les 10 dernières : un clic
///   isolé ne prolonge pas l'énoncé) ; `verdict` fixe alors le silence qui clôt l'énoncé ; une reprise de la
///   parole annule la pause (même énoncé) ;
/// - fin : on garde `apresFin` après la dernière activité ;
/// - le bruit de fond suit le niveau des trames calmes (descend vite, monte lentement), sauf pendant l'écho.
final class DecoupeurEnonces {
    struct Enonce {
        let echantillons: [Int16]
        var duree: Double { Double(echantillons.count) / ParametresEcoute.frequence }
        let voix: Double          // secondes de trames « voix »
        let niveauMaxDb: Float
        let bruitDb: Float
        let coupe: Bool           // durée maximale atteinte
        let pauses: Int           // pauses reprises en cours de route
        let silence: Double       // silence qui l'a clos (s)
    }
    struct Pause {
        let numero: Int
        /// Taille de l'audio de l'énoncé à la fin de la parole (+ `apresFin`) : un texte lu sur au moins autant
        /// d'audio contient toute la phrase.
        let echantillonsParole: Int
    }
    enum Evenement { case debut, pause(Pause), reprise, fin(Enonce) }

    let p: ParametresEcoute
    private let nDebut: Int, nVoixMin: Int, nAvant: Int, nApres: Int, nMax: Int, nEcart: Int, nRetour: Int
    private let nPause: Int, nComplet: Int, nInacheve: Int, nRepli: Int, nCoupure: Int, nDebutCoupure: Int, nEcho: Int
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
    // pause en cours : son numéro, et le silence (en trames) qui clora l'énoncé
    private(set) var enPause = false
    private var numeroPause = 0
    private var pausesReprises = 0
    private var cible = 0
    // écho : niveau joué (dBFS) des dernières trames, et couplage appris (niveau micro − niveau joué)
    private var refHisto: [Float?] = []
    private(set) var couplageDb: Float?
    private var echoActif = false

    init(_ p: ParametresEcoute = ParametresEcoute()) {
        let p = p.coherent()
        self.p = p
        func n(_ s: Double) -> Int { max(1, Int((s * ParametresEcoute.frequence / Double(ParametresEcoute.trame)).rounded())) }
        nDebut = n(p.fenetreDebut); nVoixMin = n(p.voixMinimum)
        nAvant = n(p.avantDebut); nApres = n(p.apresFin); nMax = n(p.dureeMax)
        nEcart = n(p.ecartRetour); nRetour = n(p.retourMax)
        nPause = n(p.silencePause); nComplet = n(p.silenceComplet); nInacheve = n(p.silenceInacheve); nRepli = n(p.silenceFin)
        nCoupure = n(p.voixCoupure); nDebutCoupure = max(n(p.fenetreDebut), n(p.voixCoupure + 0.15)); nEcho = n(p.fenetreEcho)
        cible = nRepli
    }

    /// Audio de l'énoncé en cours (vide hors énoncé) : la transcription en direct le relit pendant qu'Eliot parle.
    var enonceEnCours: [Int16] { enEnonce ? enonce : [] }

    /// Oublie tout l'audio en cours (écoute suspendue) ; garde le bruit de fond et le couplage d'écho appris.
    func reinitialiser() {
        reste = []
        refHisto = []; echoActif = false
        oublierEnonce()
    }

    private func oublierEnonce() {
        historique = []; voixHisto = []
        enEnonce = false; enonce = []; activite = []
        trames = 0; voixTrames = 0; silence = 0; finActivite = 0; maxDb = -120
        enPause = false; pausesReprises = 0; cible = nRepli
    }

    /// Verdict sur la pause `numero` (texte lu pendant le silence) : fixe le silence qui clôt l'énoncé. Sans effet si
    /// Eliot a repris entre-temps (autre pause, ou plus de pause). Si ce silence est déjà atteint, l'énoncé se clôt
    /// à la trame suivante.
    @discardableResult
    func verdict(pause numero: Int, inacheve: Bool) -> Bool {
        guard enEnonce, enPause, numero == numeroPause else { return false }
        cible = inacheve ? nInacheve : nComplet
        return true
    }

    /// Silence écoulé dans la pause en cours (s), pour le journal.
    var silenceEcoule: Double { Double(silence) * Double(ParametresEcoute.trame) / ParametresEcoute.frequence }

    /// `sortieDb` : niveau (dBFS) de ce que Jarvis joue en ce moment sur des haut-parleurs que le micro entend ;
    /// nil si rien ne joue ou si la sortie est un casque (pas d'écho).
    func pousser(_ e: [Int16], sortieDb: Float? = nil) -> [Evenement] {
        var ev: [Evenement] = []
        reste.append(contentsOf: e)
        let t = ParametresEcoute.trame
        var i = 0
        while reste.count - i >= t {
            if let x = trame(Array(reste[i..<(i + t)]), sortieDb: sortieDb) { ev.append(x) }
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

    private func trame(_ f: [Int16], sortieDb: Float?) -> Evenement? {
        let m = Self.mesurer(f)
        // écho : niveau joué le plus fort sur la fenêtre (retard du haut-parleur au micro, réverbération)
        refHisto.append(sortieDb.flatMap { $0 > -70 ? $0 : nil })
        if refHisto.count > nEcho { refHisto.removeFirst() }
        let refMax = refHisto.compactMap { $0 }.max()
        if refMax != nil && !echoActif {
            // Jarvis commence à parler : ce qui a été pris pour de la voix juste avant était sans doute son début
            voixHisto = voixHisto.map { _ in false }
        }
        echoActif = refMax != nil

        if amorce.count < Self.nAmorce {
            amorce.append(m.db)
            if amorce.count == Self.nAmorce { bruitDb = min(-20, max(-90, amorce.sorted()[Self.nAmorce / 3])) }
            return nil
        }
        var seuil = max(p.seuilAbsoluDb, bruitDb + p.margeBruitDb)
        if let r = refMax {
            if let c = couplageDb { seuil = max(seuil, r + c + p.margeEchoDb) }
            else { seuil = max(seuil, r + p.margeEchoDb) }   // rien d'appris : prudence (écho supposé au niveau joué)
        }
        let voix = m.db > seuil && m.crete < p.crete
        if let r = refMax {
            // couplage : enveloppe haute de (micro − joué) sur les trames d'écho (pas pendant qu'Eliot parle)
            let x = m.db - r
            if !enEnonce, m.db > bruitDb + 3 {
                if let c = couplageDb {
                    if x < c + p.margeEchoDb { couplageDb = c + (x > c ? 0.1 : 0.005) * (x - c) }
                } else {
                    couplageDb = x
                }
            }
        } else {
            // bruit de fond : descend vite, monte lentement ; très lentement pendant la voix (bruit fort et durable).
            // Figé pendant l'écho : la voix de Jarvis n'est pas le bruit de la pièce.
            let a: Float = m.db < bruitDb ? 0.2 : (voix ? 0.0005 : 0.01)
            bruitDb = min(-20, max(-90, bruitDb + a * (m.db - bruitDb)))
        }

        if !enEnonce {
            historique.append(f); voixHisto.append(voix)
            if historique.count > nDebutCoupure + nRetour + nAvant { historique.removeFirst(); voixHisto.removeFirst() }
            let fen = voixHisto.suffix(echoActif ? nDebutCoupure : nDebut)
            guard fen.filter({ $0 }).count >= (echoActif ? nCoupure : nVoixMin) else { return nil }
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
            enPause = false; pausesReprises = 0; cible = nRepli
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
        if activite.filter({ $0 }).count >= Self.voixActivite {
            silence = 0; finActivite = trames
            if enPause {   // Eliot reprend : même énoncé
                enPause = false; pausesReprises += 1; cible = nRepli
                return .reprise
            }
        } else {
            silence += 1
        }
        let coupe = trames >= nMax
        if !coupe, !enPause, silence >= nPause {
            enPause = true
            numeroPause += 1
            cible = nRepli
            return .pause(Pause(numero: numeroPause, echantillonsParole: min(enonce.count, (finActivite + nApres) * ParametresEcoute.trame)))
        }
        guard (enPause && silence >= cible) || coupe else { return nil }
        let garder = min(trames, coupe ? trames : finActivite + nApres) * ParametresEcoute.trame
        let e = Enonce(echantillons: Array(enonce.prefix(garder)), voix: Double(voixTrames) * Double(ParametresEcoute.trame) / ParametresEcoute.frequence,
                       niveauMaxDb: maxDb, bruitDb: bruitDb, coupe: coupe, pauses: pausesReprises, silence: silenceEcoule)
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
