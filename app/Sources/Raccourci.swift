import AppKit
import Carbon

/// Raccourci clavier global par Carbon (`RegisterEventHotKey`) : il reçoit l'appui ET le relâchement,
/// sans autorisation d'accessibilité ni de surveillance du clavier (comme ⌃⌥⌘C de Cockpit).
/// Enregistrement exclusif : si une autre app tient déjà la combinaison, l'enregistrement échoue
/// (`eventHotKeyExistsErr`) au lieu de se partager la touche en silence.
/// Tout se passe sur le fil principal (les événements Carbon y arrivent).
final class RaccourciGlobal {
    struct Combinaison: Equatable {
        let code: UInt32   // kVK_* (position physique, clavier U.S.)
        let mods: UInt32   // cmdKey | optionKey | controlKey | shiftKey
        let cle: String    // forme réglable : « alt+space »
        let texte: String  // forme affichée : « ⌥Espace »
    }

    private static let signature: OSType = 0x4254_766B   // 'BTvk'
    private static var suivant: UInt32 = 1
    private static var actifs: [UInt32: RaccourciGlobal] = [:]
    private static var gestionnaire: EventHandlerRef?

    let combinaison: Combinaison
    private let id: UInt32
    private var ref: EventHotKeyRef?
    private var enfonce = false
    private let rappel: (Bool) -> Void   // true : appui, false : relâchement
    private(set) var statut: OSStatus = noErr

    var enregistre: Bool { ref != nil }

    init(_ c: Combinaison, rappel: @escaping (Bool) -> Void) {
        combinaison = c
        self.rappel = rappel
        id = Self.suivant
        Self.suivant += 1
    }

    @discardableResult
    func enregistrer() -> Bool {
        guard ref == nil else { return true }
        Self.installer()
        let hk = EventHotKeyID(signature: Self.signature, id: id)
        var r: EventHotKeyRef?
        statut = RegisterEventHotKey(combinaison.code, combinaison.mods, hk, GetApplicationEventTarget(),
                                     OptionBits(kEventHotKeyExclusive), &r)
        if statut == noErr, let r {
            ref = r
            Self.actifs[id] = self
            journal("raccourci \(combinaison.texte) : enregistré")
            return true
        }
        journal("raccourci \(combinaison.texte) : échec \(statut)\(statut == OSStatus(eventHotKeyExistsErr) ? " (déjà pris par une autre app)" : "")")
        return false
    }

    func retirer() {
        guard let r = ref else { return }
        UnregisterEventHotKey(r)
        ref = nil
        Self.actifs[id] = nil
        if enfonce { enfonce = false; rappel(false) }
        journal("raccourci \(combinaison.texte) : retiré")
    }

    private func recu(_ appui: Bool) {
        // la répétition automatique ou un relâchement orphelin ne doivent rien déclencher
        if appui == enfonce { return }
        enfonce = appui
        rappel(appui)
    }

    private static func installer() {
        guard gestionnaire == nil else { return }
        var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                     EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        let st = InstallEventHandler(GetApplicationEventTarget(), { _, evt, _ -> OSStatus in
            guard let evt else { return OSStatus(eventNotHandledErr) }
            var hk = EventHotKeyID()
            let st = GetEventParameter(evt, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                       nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            guard st == noErr, hk.signature == RaccourciGlobal.signature, let r = RaccourciGlobal.actifs[hk.id] else {
                return OSStatus(eventNotHandledErr)
            }
            r.recu(GetEventKind(evt) == UInt32(kEventHotKeyPressed))
            return noErr
        }, 2, &types, nil, &gestionnaire)
        if st != noErr { journal("raccourcis : InstallEventHandler en échec \(st)") }
    }

    // MARK: - Forme texte (réglage)

    private static let touches: [String: (UInt32, String)] = {
        var t: [String: (UInt32, String)] = [
            "space": (UInt32(kVK_Space), "Espace"), "espace": (UInt32(kVK_Space), "Espace"),
            "escape": (UInt32(kVK_Escape), "Échap"), "esc": (UInt32(kVK_Escape), "Échap"),
            "return": (UInt32(kVK_Return), "Retour"), "tab": (UInt32(kVK_Tab), "Tab"),
        ]
        let f: [Int] = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                        kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
        for (i, c) in f.enumerated() { t["f\(i + 1)"] = (UInt32(c), "F\(i + 1)") }
        let lettres: [(String, Int)] = [
            ("a", kVK_ANSI_A), ("b", kVK_ANSI_B), ("c", kVK_ANSI_C), ("d", kVK_ANSI_D), ("e", kVK_ANSI_E), ("f", kVK_ANSI_F),
            ("g", kVK_ANSI_G), ("h", kVK_ANSI_H), ("i", kVK_ANSI_I), ("j", kVK_ANSI_J), ("k", kVK_ANSI_K), ("l", kVK_ANSI_L),
            ("m", kVK_ANSI_M), ("n", kVK_ANSI_N), ("o", kVK_ANSI_O), ("p", kVK_ANSI_P), ("q", kVK_ANSI_Q), ("r", kVK_ANSI_R),
            ("s", kVK_ANSI_S), ("t", kVK_ANSI_T), ("u", kVK_ANSI_U), ("v", kVK_ANSI_V), ("w", kVK_ANSI_W), ("x", kVK_ANSI_X),
            ("y", kVK_ANSI_Y), ("z", kVK_ANSI_Z), ("0", kVK_ANSI_0), ("1", kVK_ANSI_1), ("2", kVK_ANSI_2), ("3", kVK_ANSI_3),
            ("4", kVK_ANSI_4), ("5", kVK_ANSI_5), ("6", kVK_ANSI_6), ("7", kVK_ANSI_7), ("8", kVK_ANSI_8), ("9", kVK_ANSI_9),
        ]
        for (l, c) in lettres { t[l] = (UInt32(c), l.uppercased()) }
        return t
    }()

    /// « alt+space », « ctrl+alt+j », « f13 », « cmd+shift+;»… ; nil si la forme est inconnue.
    static func analyser(_ s: String) -> Combinaison? {
        let morceaux = s.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+").map(String.init)
        guard let derniere = morceaux.last, let (code, nom) = touches[derniere] else { return nil }
        var mods: UInt32 = 0
        for m in morceaux.dropLast() {
            switch m {
            case "cmd", "command", "⌘": mods |= UInt32(cmdKey)
            case "alt", "option", "opt", "⌥": mods |= UInt32(optionKey)
            case "ctrl", "control", "⌃": mods |= UInt32(controlKey)
            case "shift", "maj", "⇧": mods |= UInt32(shiftKey)
            default: return nil
            }
        }
        // une lettre ou un chiffre seuls captureraient la frappe normale partout
        if mods == 0 && !nom.hasPrefix("F") { return nil }
        var texte = ""
        if mods & UInt32(controlKey) != 0 { texte += "⌃" }
        if mods & UInt32(optionKey) != 0 { texte += "⌥" }
        if mods & UInt32(shiftKey) != 0 { texte += "⇧" }
        if mods & UInt32(cmdKey) != 0 { texte += "⌘" }
        var cle: [String] = []
        if mods & UInt32(controlKey) != 0 { cle.append("ctrl") }
        if mods & UInt32(optionKey) != 0 { cle.append("alt") }
        if mods & UInt32(shiftKey) != 0 { cle.append("shift") }
        if mods & UInt32(cmdKey) != 0 { cle.append("cmd") }
        cle.append(derniere == "espace" ? "space" : derniere == "esc" ? "escape" : derniere)
        return Combinaison(code: code, mods: mods, cle: cle.joined(separator: "+"), texte: texte + nom)
    }
}
