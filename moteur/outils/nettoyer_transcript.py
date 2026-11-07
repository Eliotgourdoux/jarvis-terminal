#!/usr/bin/env python3
"""Copie un transcript ~/.claude/projects/<dossier>/<id>.jsonl en retirant le
contenu lourd ou personnel (prompt système, CLAUDE.md, e-mail, identifiants de
compte), en gardant la structure (type, uuid, parentUuid, timestamp) de chaque ligne.
Usage : python3 -I nettoyer_transcript.py <source.jsonl> <destination.jsonl>"""
import json, sys

GARDER_ATTACHEMENT = {"date", "model", "total_tokens_reminder", "queued_command",
                      "edited_text_file", "hook_success", "hook_additional_context"}
SUPPRIMER = {"api-request-blob", "api-request", "api-request-shape"}

src, dst = sys.argv[1], sys.argv[2]
n_in = n_out = 0
with open(src) as f, open(dst, "w") as out:
    for l in f:
        n_in += 1
        o = json.loads(l)
        t = o.get("type")
        if t in SUPPRIMER:
            continue
        if t == "session-owner":
            o["accountUuid"] = "00000000-0000-0000-0000-000000000000"
            o["organizationUuid"] = "00000000-0000-0000-0000-000000000000"
        if t == "attachment":
            a = o.get("attachment", {})
            if a.get("type") not in GARDER_ATTACHEMENT:
                o["attachment"] = {"type": a.get("type"), "_contenu_retire_par_agent_B": True}
                o.pop("rendered", None)
        out.write(json.dumps(o, ensure_ascii=False) + "\n")
        n_out += 1
print(f"{n_in} lignes lues, {n_out} écrites")
