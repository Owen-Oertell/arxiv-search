import * as vscode from "vscode";
import { XMLParser } from "fast-xml-parser";

/* ---------------------------------------------------------------- types */

type Source = "arxiv" | "crossref";

interface Paper {
  source: Source;
  title: string;
  authors: string[];
  year: string;
  id: string;       // arXiv ID or DOI
  journal?: string;
}

interface PaperPickItem extends vscode.QuickPickItem {
  paper: Paper;
}

/* -------------------------------------------------------- key helpers */

const STOPWORDS = new Set(["a", "an", "the"]);

function clean(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function surname(str: string) {
  return str.includes(",")
    ? str.split(",")[0].trim()
    : str.split(/\s+/)[0].trim();
}
function firstWord(title: string) {
  const words = title
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);
  for (const w of words) {
    if (!STOPWORDS.has(w.toLowerCase())) return w;
  }
  return words[0] ?? "paper";
}

function bibKey(p: Paper) {
  return `${clean(surname(p.authors[0] ?? "anon"))}${p.year}${clean(
    firstWord(p.title)
  )}`;
}
function bibtex(p: Paper): { key: string; text: string } {
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

async function searchArxiv(query: string, max = 20): Promise<Paper[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
    query
  )}&start=0&max_results=${max}`;

  const xml = await (await fetch(url)).text();
  const feed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  let entries: any[] = feed.feed?.entry ?? [];
  if (!Array.isArray(entries)) entries = [entries];

  return entries.map((e) => ({
    source: "arxiv",
    title: e.title.trim().replace(/\s+/g, " "),
    authors: Array.isArray(e.author)
      ? e.author.map((a: any) => a.name)
      : [e.author.name],
    year: e.published.slice(0, 4),
    id: e.id.split("/abs/")[1]
  }));
}

async function searchCrossref(query: string, max = 20): Promise<Paper[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(
    query
  )}&rows=${max}`;

  const json = await (await fetch(url)).json();
  const items: any[] = json.message?.items ?? [];

  return items.map((it) => ({
    source: "crossref",
    title: it.title?.[0] ?? "(untitled)",
    authors: (it.author ?? []).map(
      (a: any) => `${a.family ?? ""}, ${a.given ?? ""}`.trim()
    ),
    year:
      it.issued?.["date-parts"]?.[0]?.[0]?.toString() ??
      it.created?.["date-parts"]?.[0]?.[0]?.toString() ??
      "????",
    id: it.DOI ?? "",
    journal: it["container-title"]?.[0]
  }));
}

/* ------------------------------------------------------- activate */

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "arxivBiblatex.addCitation",
      async () => {
        /* 1 ─ user query */
        const query = await vscode.window.showInputBox({
          prompt: "Search arXiv (fast) and Crossref (added when ready)",
          placeHolder: "e.g. Diffusion models, Tong 2024"
        });
        if (!query) return;

        /* 2 ─ QuickPick */
        const qp = vscode.window.createQuickPick<PaperPickItem>();
        qp.title = "Search results";
        qp.placeholder = "Loading arXiv…";
        qp.matchOnDetail = true;
        qp.busy = true;
        qp.show();

        const toItems = (list: Paper[]): PaperPickItem[] =>
          list.map((p) => ({
            label: p.title,
            detail: `${p.authors.join(", ")} (${p.year}) [${
              p.source === "arxiv" ? "arXiv" : "Crossref"
            }]`,
            paper: p
          }));

        /* 3 ─ fetch arXiv first */
        searchArxiv(query, 20)
          .then((ax) => {
            qp.items = toItems(ax);
            qp.placeholder = "Loading Crossref…";
          })
          .catch((err) => {
            vscode.window.showErrorMessage(
              `arXiv request failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
            qp.placeholder = "arXiv failed; loading Crossref…";
          });

        /* 4 ─ fetch Crossref */
        searchCrossref(query, 20)
          .then((cr) => {
            qp.items = [...qp.items, ...toItems(cr)];
          })
          .catch((err) => console.error(err))
          .finally(() => {
            qp.busy = false;
            qp.placeholder = qp.items.length
              ? "Select a paper"
              : "No results found";
          });

        /* 5 ─ accept selection */
        qp.onDidAccept(async () => {
          const sel = qp.selectedItems[0];
          if (!sel) return;
          qp.hide();

          /* build BibTeX */
          const { key, text } = bibtex(sel.paper);

          /* choose/create .bib */
          const bibFiles = await vscode.workspace.findFiles("**/*.bib");
          let bibUri: vscode.Uri;
          if (!bibFiles.length) {
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
              bibFiles.map((f) => ({
                label: vscode.workspace.asRelativePath(f),
                uri: f
              })),
              { placeHolder: "Select the .bib file to append" }
            );
            if (!pickFile) return;
            bibUri = pickFile.uri;
          }

          /* append & save */
          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            bibUri,
            new vscode.Position(Number.MAX_VALUE, 0),
            "\n" + text
          );
          const ok = await vscode.workspace.applyEdit(edit);
          if (ok) {
            await (await vscode.workspace.openTextDocument(bibUri)).save();
            vscode.window.showInformationMessage(
              `Added ${key} to ${vscode.workspace.asRelativePath(bibUri)}`
            );
          } else {
            vscode.window.showErrorMessage("Failed to update .bib file.");
          }
        });

        /* dispose on hide */
        qp.onDidHide(() => qp.dispose());
      }
    )
  );
}

export function deactivate() {}
