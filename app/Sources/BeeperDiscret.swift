import AppKit

/// L'envoi vers Jarvis passe par l'API locale de Beeper Desktop (localhost:23373), qui n'existe que si Beeper
/// tourne. Quand il est fermé, on le lance sans fenêtre ni focus (`open -g -j`), on attend que l'API réponde,
/// et on le recache si Electron affiche quand même sa fenêtre ou prend le premier plan (demande d'Eliot,
/// 08/11/2026). Si l'API ne répond pas à temps, l'appelant affiche l'échec : jamais de repli par le bot.
enum BeeperDiscret {
    static let bundle = "com.automattic.beeper.desktop"
    /// Sonde sans jeton : n'importe quelle réponse HTTP (401 compris) veut dire que l'API écoute.
    private static let sonde = URL(string: "http://localhost:23373/v1/accounts")!

    static func tourne() -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty
    }

    /// Lance Beeper en arrière-plan, caché, puis appelle `fini(true)` dès que l'API répond, `fini(false)` après `delai`.
    /// Toujours rappelé sur la file principale.
    static func lancer(delai: TimeInterval = 30, fini: @escaping (Bool) -> Void) {
        // Beeper déjà ouvert (par Eliot) : on n'y touche jamais, ni `open -j` qui le cacherait, ni surveillance
        // (bug du 12/11/2026 : un délai de l'API cachait Beeper pendant qu'Eliot l'utilisait). On attend juste l'API.
        if tourne() {
            journal("beeper : déjà ouvert, API injoignable — attente sans toucher à la fenêtre")
            attendreAPI(delai: delai, arreter: { _ in }, fini: fini)
            return
        }
        let devant = NSWorkspace.shared.frontmostApplication
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-g", "-j", "-b", bundle]   // -g : pas de premier plan ; -j : lancé caché
        do { try p.run() } catch {
            journal("beeper : lancement impossible — \(error.localizedDescription)")
            DispatchQueue.main.async { fini(false) }
            return
        }
        // Electron ignore parfois -g / -j et se met devant avec sa fenêtre : on réagit à l'événement même
        // (activation, lancement) et, en filet, toutes les 0,2 s, jusqu'à 6 s après que l'API est prête.
        let centre = NSWorkspace.shared.notificationCenter
        var jetons: [NSObjectProtocol] = []
        for nom in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didLaunchApplicationNotification] {
            jetons.append(centre.addObserver(forName: nom, object: nil, queue: .main) { n in
                let a = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                if a?.bundleIdentifier == bundle { garderDerriere(devant) }
            })
        }
        let filet = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in garderDerriere(devant) }
        func arreterSurveillance(apres d: TimeInterval) {
            DispatchQueue.main.asyncAfter(deadline: .now() + d) {
                filet.invalidate()
                jetons.forEach { centre.removeObserver($0) }
                jetons.removeAll()
            }
        }
        // Surveillance courte : 3 s après que l'API répond, puis plus jamais. Beeper redevient l'affaire d'Eliot.
        attendreAPI(delai: delai, arreter: { ok in arreterSurveillance(apres: ok ? 3 : 0) }, fini: fini)
    }

    /// Sonde l'API toutes les 0,5 s jusqu'à `delai` ; `arreter(ok)` puis `fini(ok)` sur la file principale.
    private static func attendreAPI(delai: TimeInterval, arreter: @escaping (Bool) -> Void, fini: @escaping (Bool) -> Void) {
        let debut = Date(), limite = debut.addingTimeInterval(delai)
        func tic() {
            sonder { ok in
                DispatchQueue.main.async {
                    if ok {
                        journal("beeper : API prête en \(Int(Date().timeIntervalSince(debut))) s")
                        arreter(true)
                        fini(true)
                    } else if Date() < limite {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: tic)
                    } else {
                        journal("beeper : API toujours muette après \(Int(delai)) s")
                        arreter(false)
                        fini(false)
                    }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: tic)
    }

    private static func sonder(_ r: @escaping (Bool) -> Void) {
        let req = URLRequest(url: sonde, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        URLSession.shared.dataTask(with: req) { _, rep, _ in r(rep is HTTPURLResponse) }.resume()
    }

    /// Cache Beeper, et rend le premier plan à l'app qui l'avait si Beeper l'a pris.
    static func garderDerriere(_ devant: NSRunningApplication?) {
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundle) {
            if app.isActive, let d = devant, d.bundleIdentifier != bundle, !d.isTerminated {
                d.activate(options: [])
            }
            if !app.isHidden { app.hide() }
        }
    }

    // MARK: - Beeper vraiment prêt, et envoi confirmé (bug du 17/11/2026)
    //
    // Juste après son lancement, l'API de Beeper répond avant que Beeper soit connecté : un envoi renvoie 500
    // (« Failed to execute tool: sendMessage ») ou ne répond pas avant le délai, mais Beeper GARDE le message et
    // l'envoie quand il est connecté. L'app affichait un échec, Eliot renvoyait, et Jarvis recevait le même
    // message trois fois d'un coup. Donc : on attend que les comptes soient connectés avant d'envoyer, et après
    // une réponse douteuse, on ne renvoie jamais : on vérifie dans le chat que le message est bien parti.

    private static let api = "http://localhost:23373/v1"

    static func jeton() -> String {
        ((try? String(contentsOfFile: NSHomeDirectory() + "/.config/beeper/token", encoding: .utf8)) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func lire(_ chemin: String, jeton: String, _ r: @escaping (Any?) -> Void) {
        guard let url = URL(string: api + chemin) else { r(nil); return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        req.setValue("Bearer " + jeton, forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: req) { data, rep, _ in
            guard (rep as? HTTPURLResponse)?.statusCode == 200, let data else { r(nil); return }
            r(try? JSONSerialization.jsonObject(with: data))
        }.resume()
    }

    /// Attend que le compte Beeper (Matrix) et le compte Telegram soient « connected », `delai` au plus.
    /// `fini(true)` s'ils le sont, `fini(false)` sinon (l'appelant envoie quand même, puis vérifie). File principale.
    static func attendrePret(delai: TimeInterval = 60, fini: @escaping (Bool) -> Void) {
        let j = jeton(), debut = Date(), limite = debut.addingTimeInterval(delai)
        func tic() {
            lire("/accounts", jeton: j) { o in
                let comptes = (o as? [[String: Any]]) ?? ((o as? [String: Any])?["items"] as? [[String: Any]]) ?? []
                func connecte(_ f: ([String: Any]) -> Bool) -> Bool {
                    comptes.contains { f($0) && ($0["status"] as? String) == "connected" }
                }
                let pret = connecte { ($0["accountID"] as? String) == "matrix" } && connecte { ($0["network"] as? String) == "Telegram" }
                DispatchQueue.main.async {
                    if pret {
                        journal("beeper : comptes connectés en \(Int(Date().timeIntervalSince(debut))) s")
                        // un court répit : « connected » arrive un peu avant que l'envoi passe vraiment
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { fini(true) }
                    } else if Date() < limite {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: tic)
                    } else {
                        journal("beeper : comptes toujours pas connectés après \(Int(delai)) s")
                        fini(false)
                    }
                }
            }
        }
        tic()
    }

    /// Après une réponse douteuse (500, délai dépassé) : cherche dans le chat, `delai` au plus, un message envoyé
    /// par Eliot depuis `depuis` qui vérifie `correspond`. `fini(true)` s'il est parti. File principale.
    static func confirmerEnvoi(chat: String, depuis: Date, delai: TimeInterval = 120,
                               correspond: @escaping ([String: Any]) -> Bool, fini: @escaping (Bool) -> Void) {
        let j = jeton(), limite = Date().addingTimeInterval(delai)
        let permis = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard let c = chat.addingPercentEncoding(withAllowedCharacters: permis) else { fini(false); return }
        let dates = ISO8601DateFormatter()
        dates.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let datesSimples = ISO8601DateFormatter()
        func tic() {
            lire("/chats/\(c)/messages?limit=20", jeton: j) { o in
                let items = ((o as? [String: Any])?["items"] as? [[String: Any]]) ?? []
                let trouve = items.contains { m in
                    guard m["isSender"] as? Bool == true, let t = m["timestamp"] as? String,
                          let d = dates.date(from: t) ?? datesSimples.date(from: t) else { return false }
                    return d >= depuis.addingTimeInterval(-5) && correspond(m)
                }
                DispatchQueue.main.async {
                    if trouve { fini(true) }
                    else if Date() < limite { DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: tic) }
                    else { fini(false) }
                }
            }
        }
        tic()
    }
}
