import * as vscode from "vscode";
import { XMLParser } from "fast-xml-parser";

/* ---------------------------------------------------------------- types */

type Source = "arxiv" | "crossref" | "dblp";

interface Paper {
  source: Source;
  title: string;
  authors: string[];
  year: string;
  id: string;        // arXiv ID, DOI, or URL
  journal?: string;
}

interface PaperPickItem extends vscode.QuickPickItem {
  paper: Paper;
}

/* -------------------------------------------------- helper functions */

const STOPWORDS = new Set(["a", "an", "the"]);
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const stripNumericSuffix = (s: string) => s.replace(/\s+\d{1,4}$/, "");

const surname = (input: unknown) => {
  const s = stripNumericSuffix(String(input).trim());
  if (s.includes(",")) return s.split(",")[0].trim();       // "Wang, Jianxin"
  const tokens = s.split(/\s+/);
  return tokens[tokens.length - 1];                         // "Jianxin Wang" -> "Wang"
};

const firstWord = (title: string) => {
  const words = title
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);
  for (const w of words) if (!STOPWORDS.has(w.toLowerCase())) return w;
  return words[0] ?? "paper";
};

const bibKey = (p: Paper) =>
  `${clean(surname(p.authors[0] ?? "anon"))}${p.year}${clean(firstWord(p.title))}`;

function bibtex(p: Paper): { key: string; text: string } {
  const key = bibKey(p);
  const authors = p.authors.join(" and ");
  const base = `@article{${key},
  title  = {${p.title}},
  author = {${authors}},
  year   = {${p.year}},`;

  if (p.source === "arxiv") {
    return {
      key,
      text: `${base}
  journal= {arXiv},
  eprint = {${p.id}}
}
`
    };
  }

  if (p.source === "crossref") {
    return {
      key,
      text: `${base}
  journal= {${p.journal ?? "journal"}},
  doi    = {${p.id}}
}
`
    };
  }

  /* DBLP */
  const idField = p.id.startsWith("10.") ? `doi    = {${p.id}}` : `url    = {${p.id}}`;
  return {
    key,
    text: `${base}
  journal= {${p.journal ?? "conference"}},
  ${idField}
}
`
  };
}

/* ------------------------------ author string sanitiser (all sources) */

const toAuthorStr = (a: any): string => {
  let raw =
    typeof a === "string"
      ? a
      : a?.text ?? a?.["#text"] ?? a?.name ?? `${a.family ?? ""} ${a.given ?? ""}`;
  raw = String(raw).trim();
  return stripNumericSuffix(raw);
};

/* ---------------------------------------------------- fetch helpers */

async function searchArxiv(q: string, max = 20): Promise<Paper[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
    q
  )}&start=0&max_results=${max}`;

  const xml = await (await fetch(url)).text();
  const feed = new XMLParser({ ignoreAttributes: false }).parse(xml);
  let entries: any[] = feed.feed?.entry ?? [];
  if (!Array.isArray(entries)) entries = [entries];

  return entries.map((e) => ({
    source: "arxiv",
    title: e.title.trim().replace(/\s+/g, " "),
    authors: (Array.isArray(e.author) ? e.author : [e.author]).map((a: any) =>
      toAuthorStr(a.name)
    ),
    year: e.published.slice(0, 4),
    id: e.id.split("/abs/")[1]
  }));
}

async function searchCrossref(q: string, max = 20): Promise<Paper[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=${max}`;
  const items: any[] = (await (await fetch(url)).json()).message?.items ?? [];

  return items.map((it) => ({
    source: "crossref",
    title: it.title?.[0] ?? "(untitled)",
    authors: (it.author ?? []).map(toAuthorStr),
    year:
      it.issued?.["date-parts"]?.[0]?.[0]?.toString() ??
      it.created?.["date-parts"]?.[0]?.[0]?.toString() ??
      "????",
    id: it.DOI ?? "",
    journal: it["container-title"]?.[0]
  }));
}

async function searchDblp(q: string, max = 20): Promise<Paper[]> {
  const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(
    q
  )}&h=${max}&format=json`;

  const hits: any[] = (await (await fetch(url)).json()).result?.hits?.hit ?? [];

  return hits.map((hit) => {
    const info = hit.info;
    const rawAuth = info.authors?.author ?? [];
    const authorsArr: string[] = Array.isArray(rawAuth)
      ? rawAuth.map(toAuthorStr)
      : [toAuthorStr(rawAuth)];
    return {
      source: "dblp",
      title: String(info.title ?? "(untitled)").replace(/\s+/g, " "),
      authors: authorsArr,
      year: String(info.year ?? "????"),
      id: info.doi ?? info.url ?? "",
      journal:
        info.venue ??
        info.journal ??
        info.booktitle ??
        info.type?.replace(/_/g, " ")
    } as Paper;
  });
}

/* ------------------------------------------------------- activate */

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "arxivBiblatex.addCitation",
      async () => {
        /* 1 ─ prompt */
        const query = await vscode.window.showInputBox({
          prompt:
            "Search arXiv, DBLP, and Crossref to get relevant citations",
          placeHolder: "e.g. Diffusion models, Wang 2025"
        });
        if (!query) return;

        /* 2 ─ QuickPick */
        const qp = vscode.window.createQuickPick<PaperPickItem>();
        qp.title = "Search results";
        qp.placeholder = "Searching arXiv, DBLP & Crossref…";
        qp.matchOnDetail = true;
        qp.busy = true;
        qp.show();

        const toItems = (papers: Paper[]): PaperPickItem[] =>
          papers.map((p) => ({
            label: p.title,
            detail: `${p.authors.join(", ")} (${p.year}) [${
              p.source === "arxiv" ? "arXiv" : p.source === "dblp" ? "DBLP" : "Crossref"
            }]`,
            paper: p
          }));

        /* pending counter (arXiv + DBLP + Crossref) */
        let pending = 3;
        const finish = () => {
          pending -= 1;
          if (pending === 0) {
            qp.busy = false;
            qp.placeholder = qp.items.length ? "Select a paper" : "No results found";
          }
        };

        /* 3 ─ arXiv */
        searchArxiv(query, 20)
          .then((ax) => {
            qp.items = [...qp.items, ...toItems(ax)];
          })
          .catch((err) =>
            vscode.window.showErrorMessage(
              `arXiv request failed: ${err instanceof Error ? err.message : String(err)}`
            )
          )
          .finally(finish);

        /* 4 ─ DBLP */
        searchDblp(query, 20)
          .then((dl) => (qp.items = [...qp.items, ...toItems(dl)]))
          .catch((err) =>
            vscode.window.showErrorMessage(
              `DBLP request failed: ${err instanceof Error ? err.message : String(err)}`
            )
          )
          .finally(finish);

        /* 5 ─ Crossref */
        searchCrossref(query, 20)
          .then((cr) => (qp.items = [...qp.items, ...toItems(cr)]))
          .catch((err) =>
            vscode.window.showErrorMessage(
              `Crossref request failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          )
          .finally(finish);

        /* 6 ─ accept */
        qp.onDidAccept(async () => {
          const sel = qp.selectedItems[0];
          if (!sel) return;
          qp.hide();

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

        qp.onDidHide(() => qp.dispose());
      }
    )
  );
}

export function deactivate() {}
