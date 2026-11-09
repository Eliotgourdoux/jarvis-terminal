import WebKit

/// Aperçus du fil (blocs html, svg, mermaid ; voir ui/js/apercu.js).
///
/// Le schéma `btapercu://app/<nom>` sert le cadre d'aperçu et ses bibliothèques, et RIEN d'autre :
/// liste fermée de fichiers, lus dans `<ui>/apercu/` (le même dossier ui/ que la page, voir Page.choisir).
/// Le cadre est chargé dans une iframe sandbox sans allow-same-origin (origine opaque) ; sa CSP est posée
/// ici en en-tête et répétée en <meta> dans apercu.html. Le pont `bt` refuse déjà tout message hors cadre principal
/// (FenetreSession.messageDeLaPage) : un aperçu ne peut ni écrire à claude, ni lire un fichier local.
final class Apercu: NSObject, WKURLSchemeHandler {
    static let schema = "btapercu"
    private static let partage = Apercu()

    static func installer(dans cfg: WKWebViewConfiguration) {
        cfg.setURLSchemeHandler(partage, forURLScheme: schema)
    }

    private static let fichiers: [String: String] = [
        "apercu.html": "text/html; charset=utf-8",
        "cadre.js": "text/javascript; charset=utf-8",
        "mermaid.js": "text/javascript; charset=utf-8",
        "chart.js": "text/javascript; charset=utf-8",
    ]

    static let csp = "default-src 'none'; script-src btapercu: 'unsafe-inline' 'unsafe-eval' https:; "
        + "style-src btapercu: 'unsafe-inline' https:; img-src btapercu: data: blob: https:; font-src btapercu: data: https:; "
        + "media-src data: blob: https:; connect-src https:; frame-src 'none'; form-action 'none'; object-src 'none'"

    private var cache: [String: Data] = [:]   // file principale seulement

    private func donnees(_ nom: String) -> Data? {
        if let d = cache[nom] { return d }
        let dossier = Page.choisir().lecture.appendingPathComponent("apercu", isDirectory: true)
        guard let d = try? Data(contentsOf: dossier.appendingPathComponent(nom)) else { return nil }
        cache[nom] = d
        return d
    }

    func webView(_ w: WKWebView, start t: WKURLSchemeTask) {
        guard let url = t.request.url else { return }
        let nom = url.lastPathComponent
        guard url.host == "app", url.path == "/" + nom, let type = Self.fichiers[nom], let d = donnees(nom) else {
            let rep = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"])!
            t.didReceive(rep); t.didReceive(Data()); t.didFinish()
            return
        }
        let rep = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": type,
            "Content-Length": String(d.count),
            "Content-Security-Policy": Self.csp,
            "Cache-Control": "max-age=3600",
        ])!
        t.didReceive(rep)
        t.didReceive(d)
        t.didFinish()
    }

    func webView(_ w: WKWebView, stop t: WKURLSchemeTask) {}
}
