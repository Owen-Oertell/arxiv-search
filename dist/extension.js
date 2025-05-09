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
/* ---------- Helpers ------------------------------------------------------ */
function cleanKeyFragment(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ""); // drop punctuation/spaces
}
/**
 * Clean a string to be a valid BibTeX key fragment:
 *  - lowercase
 *  - remove non-alphanumeric characters
 */
function entryToBib(entry) {
    // 1) Authors → array of names
    const authorsArr = Array.isArray(entry.author)
        ? entry.author.map((a) => a.name)
        : [entry.author.name];
    // 2) Year from published date
    const year = entry.published.slice(0, 4);
    // 3) Surname of first author
    const surname = authorsArr[0].split(/\s+/).pop() || authorsArr[0];
    const cleanSurname = cleanKeyFragment(surname);
    // 4) First significant word of title
    const titleWords = entry.title
        .trim()
        .replace(/[\r\n]/g, " ")
        .split(/\s+/)
        .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
        .filter((w) => w.length > 0);
    const firstWord = titleWords.length > 0 ? titleWords[0] : "paper";
    const cleanFirst = cleanKeyFragment(firstWord);
    // 5) Compose key
    const bibKey = `${cleanSurname}${year}${cleanFirst}`;
    // 6) ArXiv ID
    const arxivId = entry.id.split("/abs/")[1];
    // 7) Build the BibTeX text
    const authorsBib = authorsArr.join(" and ");
    const text = `@article{${bibKey},
  title  = {${entry.title.trim().replace(/\s+/g, " ")}},
  author = {${authorsBib}},
  journal= {arXiv},
  eprint = {${arxivId}},
  year   = {${year}}
}
`;
    return { key: bibKey, text };
}
/* ---------- Extension entry points -------------------------------------- */
function activate(context) {
    const cmd = vscode.commands.registerCommand("arxivBiblatex.addCitation", async () => {
        /* 1 ─ ask for a search query */
        const query = await vscode.window.showInputBox({
            prompt: "Search arXiv (title / author / keywords)",
            placeHolder: "e.g. diffusion models, Smith transformer"
        });
        if (!query)
            return;
        /* 2 ─ fetch results from arXiv */
        const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=20`;
        let xml;
        try {
            const res = await fetch(url);
            xml = await res.text();
        }
        catch (err) {
            vscode.window.showErrorMessage(`arXiv request failed: ${err instanceof Error ? err.message : err}`);
            return;
        }
        /* 3 ─ parse Atom XML */
        const feed = new fast_xml_parser_1.XMLParser({ ignoreAttributes: false }).parse(xml);
        let entries = feed.feed.entry || [];
        if (!Array.isArray(entries))
            entries = [entries];
        if (entries.length === 0) {
            vscode.window.showInformationMessage("No results found.");
            return;
        }
        /* 4 ─ QuickPick UI */
        const pick = await vscode.window.showQuickPick(entries.map((e) => {
            const authorList = e.author instanceof Array
                ? e.author.map((a) => a.name).join(", ")
                : e.author.name;
            return {
                label: e.title.trim().replace(/\s+/g, " "),
                detail: `${authorList} (${e.published.slice(0, 4)})`,
                entry: e
            };
        }), { matchOnDetail: true, placeHolder: "Select a paper" });
        if (!pick)
            return;
        /* 5 ─ build BibTeX */
        const { key, text } = entryToBib(pick.entry);
        /* 6 ─ choose or create .bib file */
        const bibFiles = await vscode.workspace.findFiles("**/*.bib");
        let bibUri;
        if (bibFiles.length === 0) {
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
        /* 7 ─ append and save */
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
    context.subscriptions.push(cmd);
}
function deactivate() { }
