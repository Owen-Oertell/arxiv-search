"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fast_xml_parser_1 = require("fast-xml-parser");
/* -------------------------------------------------------- key helpers */
const STOPWORDS = new Set(["a", "an", "the"]);
function clean(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function surname(str) {
    return str.includes(",")
        ? str.split(",")[0].trim()
        : str.split(/\s+/)[0].trim();
}
function firstWord(title) {
    const words = title
        .split(/\s+/)
        .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
        .filter(Boolean);
    for (const w of words) {
        if (!STOPWORDS.has(w.toLowerCase()))
            return w;
    }
    return words[0] ?? "paper";
}
function bibKey(p) {
    return `${clean(surname(p.authors[0] ?? "anon"))}${p.year}${clean(firstWord(p.title))}`;
}
function bibtex(p) {
    const key = bibKey(p);
    const authors = p.authors.join(" and ");
    const common = `@article{${key},
  title  = {${p.title}},
  author = {${authors}},
  year   = {${p.year}},`;
    if (p.source === "arxiv") {
        return {
            key,
            text: `${common}
  journal= {arXiv},
  eprint = {${p.id}}
}
`
        };
    }
    return {
        key,
        text: `${common}
  journal= {${p.journal ?? "journal"}},
  doi    = {${p.id}}
}
`
    };
}
/* ---------------------------------------------------- fetch helpers */
async function searchArxiv(query, max = 20) {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${max}`;
    const xml = await (await fetch(url)).text();
    const feed = new fast_xml_parser_1.XMLParser({ ignoreAttributes: false }).parse(xml);
    let entries = feed.feed?.entry ?? [];
    if (!Array.isArray(entries))
        entries = [entries];
    return entries.map((e) => ({
        source: "arxiv",
        title: e.title.trim().replace(/\s+/g, " "),
        authors: Array.isArray(e.author)
            ? e.author.map((a) => a.name)
            : [e.author.name],
        year: e.published.slice(0, 4),
        id: e.id.split("/abs/")[1]
    }));
}
async function searchCrossref(query, max = 20) {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${max}`;
    const json = await (await fetch(url)).json();
    const items = json.message?.items ?? [];
    return items.map((it) => ({
        source: "crossref",
        title: it.title?.[0] ?? "(untitled)",
        authors: (it.author ?? []).map((a) => `${a.family ?? ""}, ${a.given ?? ""}`.trim()),
        year: it.issued?.["date-parts"]?.[0]?.[0]?.toString() ??
            it.created?.["date-parts"]?.[0]?.[0]?.toString() ??
            "????",
        id: it.DOI ?? "",
        journal: it["container-title"]?.[0]
    }));
}
/* ------------------------------------------------------- activate */
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand("arxivBiblatex.addCitation", async () => {
        /* 1 ─ user query */
        const query = await vscode.window.showInputBox({
            prompt: "Search arXiv or Crossref",
            placeHolder: "e.g. Diffusion models, Tong 2024"
        });
        if (!query)
            return;
        /* 2 ─ QuickPick setup */
        const qp = vscode.window.createQuickPick();
        qp.title = "Search results";
        qp.placeholder = "Select a paper";
        qp.matchOnDetail = true;
        qp.busy = true;
        qp.show();
        /* helper to convert papers → items */
        const toItems = (list) => list.map((p) => ({
            label: p.title,
            detail: `${p.authors.join(", ")} (${p.year}) [${p.source === "arxiv" ? "arXiv" : "Crossref"}]`,
            paper: p
        }));
        /* 3 ─ fetch arXiv immediately */
        searchArxiv(query, 20)
            .then((ax) => {
            qp.items = toItems(ax);
        })
            .catch((e) => console.error(e))
            .finally(() => {
            /* we leave qp.busy true until Crossref also finishes */
        });
        /* 4 ─ fetch Crossref in parallel */
        searchCrossref(query, 20)
            .then((cr) => {
            qp.items = [...qp.items, ...toItems(cr)];
        })
            .catch((e) => console.error(e))
            .finally(() => {
            qp.busy = false; // both tasks done
        });
        /* 5 ─ when user picks */
        qp.onDidAccept(async () => {
            const sel = qp.selectedItems[0];
            if (!sel)
                return;
            qp.hide();
            /* 5a ─ build BibTeX */
            const { key, text } = bibtex(sel.paper);
            /* 5b ─ choose/create .bib */
            const bibFiles = await vscode.workspace.findFiles("**/*.bib");
            let bibUri;
            if (!bibFiles.length) {
                const root = vscode.workspace.workspaceFolders?.[0];
                if (!root) {
                    vscode.window.showErrorMessage("No workspace open.");
                    return;
                }
                bibUri = vscode.Uri.joinPath(root.uri, "references.bib");
                await vscode.workspace.fs.writeFile(bibUri, Buffer.from(""));
            }
            else if (bibFiles.length === 1) {
                bibUri = bibFiles[0];
            }
            else {
                const pickFile = await vscode.window.showQuickPick(bibFiles.map((f) => ({
                    label: vscode.workspace.asRelativePath(f),
                    uri: f
                })), { placeHolder: "Select the .bib file to append" });
                if (!pickFile)
                    return;
                bibUri = pickFile.uri;
            }
            /* 5c ─ append & save */
            const edit = new vscode.WorkspaceEdit();
            edit.insert(bibUri, new vscode.Position(Number.MAX_VALUE, 0), "\n" + text);
            const ok = await vscode.workspace.applyEdit(edit);
            if (ok) {
                await (await vscode.workspace.openTextDocument(bibUri)).save();
                vscode.window.showInformationMessage(`Added ${key} to ${vscode.workspace.asRelativePath(bibUri)}`);
            }
            else {
                vscode.window.showErrorMessage("Failed to update .bib file.");
            }
        });
        /* dispose on hide */
        qp.onDidHide(() => qp.dispose());
    }));
}
function deactivate() { }
