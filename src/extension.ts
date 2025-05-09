import * as vscode from "vscode";
import { XMLParser } from "fast-xml-parser";

/* ---------- Helpers ------------------------------------------------------ */


function cleanKeyFragment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ""); // drop punctuation/spaces
}

/**
 * Clean a string to be a valid BibTeX key fragment:
 *  - lowercase
 *  - remove non-alphanumeric characters
 */
function entryToBib(entry: any): { key: string; text: string } {
  // 1) Authors → array of names
  const authorsArr =
    Array.isArray(entry.author) 
      ? entry.author.map((a: any) => a.name) 
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
    .map((w: string) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter((w: string) => w.length > 0);
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

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand(
    "arxivBiblatex.addCitation",
    async () => {
      /* 1 ─ ask for a search query */
      const query = await vscode.window.showInputBox({
        prompt: "Search arXiv (title / author / keywords)",
        placeHolder: "e.g. diffusion models, Smith transformer"
      });
      if (!query) return;

      /* 2 ─ fetch results from arXiv */
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
        query
      )}&start=0&max_results=20`;

      let xml: string;
      try {
        const res = await fetch(url);
        xml = await res.text();
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `arXiv request failed: ${err instanceof Error ? err.message : err}`
        );
        return;
      }

      /* 3 ─ parse Atom XML */
      const feed = new XMLParser({ ignoreAttributes: false }).parse(xml);
      let entries: any[] = feed.feed.entry || [];
      if (!Array.isArray(entries)) entries = [entries];
      if (entries.length === 0) {
        vscode.window.showInformationMessage("No results found.");
        return;
      }

      /* 4 ─ QuickPick UI */
      const pick = await vscode.window.showQuickPick(
        entries.map((e) => {
          const authorList =
            e.author instanceof Array
              ? e.author.map((a: any) => a.name).join(", ")
              : e.author.name;
          return {
            label: e.title.trim().replace(/\s+/g, " "),
            detail: `${authorList} (${e.published.slice(0, 4)})`,
            entry: e
          };
        }),
        { matchOnDetail: true, placeHolder: "Select a paper" }
      );
      if (!pick) return;

      /* 5 ─ build BibTeX */
      const { key, text } = entryToBib(pick.entry);

      /* 6 ─ choose or create .bib file */
      const bibFiles = await vscode.workspace.findFiles("**/*.bib");
      let bibUri: vscode.Uri;

      if (bibFiles.length === 0) {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) {
          vscode.window.showErrorMessage("No workspace open.");
          return;
        }
        bibUri = vscode.Uri.joinPath(root.uri, "references.bib");
        await vscode.workspace.fs.writeFile(bibUri, Buffer.from(""));
      } else if (bibFiles.length === 1) {
        bibUri = bibFiles[0];
      } else {
        const pickFile = await vscode.window.showQuickPick(
          bibFiles.map((f: vscode.Uri) => ({
            label: vscode.workspace.asRelativePath(f),
            uri: f
          })),
          { placeHolder: "Select the .bib file to append" }
        );
        if (!pickFile) return;
        bibUri = pickFile.uri;
      }

      /* 7 ─ append and save */
      const edit = new vscode.WorkspaceEdit();
      edit.insert(bibUri, new vscode.Position(Number.MAX_VALUE, 0), "\n" + text);
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        await (await vscode.workspace.openTextDocument(bibUri)).save();
        vscode.window.showInformationMessage(
          `Added ${key} to ${vscode.workspace.asRelativePath(bibUri)}`
        );
      } else {
        vscode.window.showErrorMessage("Failed to update .bib file.");
      }
    }
  );

  context.subscriptions.push(cmd);
}

export function deactivate() {}
