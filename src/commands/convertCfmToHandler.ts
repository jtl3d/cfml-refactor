import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import {
  buildHandlerFile,
  convertCfmToHandler,
  mergeIntoExistingHandler,
  type ConvertCfmOptions,
  type RescopedVar
} from "../transform/convertCfmToHandler";

export function registerConvertCfmToHandler(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const channel = vscode.window.createOutputChannel(
    "CFML Refactor: cfm → Handler"
  );
  context.subscriptions.push(channel);

  const cmd = vscode.commands.registerCommand(
    "cfml-refactor.convertCfmToHandler",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          "CFML Refactor: open a .cfm file before running Convert CFM to Handler."
        );
        return;
      }

      const sourcePath = editor.document.uri.fsPath;
      if (!sourcePath.toLowerCase().endsWith(".cfm")) {
        vscode.window.showWarningMessage(
          "CFML Refactor: active file must be a .cfm page template."
        );
        return;
      }

      const baseName = path.basename(sourcePath, path.extname(sourcePath));
      const actionName = await vscode.window.showInputBox({
        prompt: "Action name for the new handler function",
        value: deriveActionName(baseName)
      });
      if (!actionName) return;

      const handlerName = await vscode.window.showInputBox({
        prompt: "Handler component name (used for view path)",
        value: deriveHandlerName(sourcePath)
      });
      if (!handlerName) return;

      const defaultHandlerPath = deriveHandlerFilePath(sourcePath, handlerName);
      const handlerPath = await vscode.window.showInputBox({
        prompt: "Target handler file path (.cfc)",
        value: defaultHandlerPath
      });
      if (!handlerPath) return;

      const defaultViewPath = deriveViewFilePath(
        sourcePath,
        handlerName,
        actionName
      );
      const viewPath = await vscode.window.showInputBox({
        prompt: "Target view file path (.cfm) — leave blank to skip",
        value: defaultViewPath
      });

      const scopeStyle = await pickScopeStyle();
      if (!scopeStyle) return;

      const cfg = vscode.workspace.getConfiguration("cfml-refactor");
      const defaultDatasourcePatterns = cfg.get<string[]>(
        "defaultDatasourcePatterns",
        []
      );
      const extraSafeBuiltInFunctions = cfg.get<string[]>(
        "safeBuiltInFunctions",
        []
      );
      const tabUnit = computeTabUnit(editor);

      const source = editor.document.getText();
      const opts: ConvertCfmOptions = {
        actionName,
        viewPath: `${handlerName}/${actionName}`,
        scopeStyle,
        tabUnit,
        defaultDatasourcePatterns,
        extraSafeBuiltInFunctions
      };

      const result = convertCfmToHandler(source, opts);

      let handlerWritten = false;
      let mergeConflict: string | undefined;
      const handlerExists = fs.existsSync(handlerPath);
      if (handlerExists) {
        const existing = fs.readFileSync(handlerPath, "utf8");
        const merge = mergeIntoExistingHandler(
          existing,
          result.handlerBody,
          result.setViewCall,
          actionName,
          tabUnit
        );
        if (merge.conflict) {
          mergeConflict = merge.conflict;
        } else {
          fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
          fs.writeFileSync(handlerPath, merge.output, "utf8");
          handlerWritten = true;
        }
      } else {
        const fileText = buildHandlerFile(
          result.handlerBody,
          result.setViewCall,
          actionName,
          tabUnit
        );
        fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
        fs.writeFileSync(handlerPath, fileText, "utf8");
        handlerWritten = true;
      }

      let viewWritten = false;
      if (result.hasView && viewPath && viewPath.length > 0) {
        fs.mkdirSync(path.dirname(viewPath), { recursive: true });
        fs.writeFileSync(viewPath, result.viewBody, "utf8");
        viewWritten = true;
      }

      writeReport(channel, {
        sourcePath,
        handlerPath,
        viewPath: viewWritten ? viewPath : undefined,
        handlerWritten,
        mergeConflict,
        result
      });
      channel.show(true);

      if (mergeConflict) {
        vscode.window.showWarningMessage(
          `CFML Refactor: handler not updated — ${mergeConflict}`
        );
        return;
      }
      vscode.window.showInformationMessage(
        `CFML Refactor: wrote handler ${path.basename(handlerPath)}` +
          (viewWritten ? ` and view ${path.basename(viewPath!)}.` : ".")
      );
    }
  );

  context.subscriptions.push(cmd);
  return cmd;
}

interface ReportInput {
  sourcePath: string;
  handlerPath: string;
  viewPath?: string;
  handlerWritten: boolean;
  mergeConflict?: string;
  result: ReturnType<typeof convertCfmToHandler>;
}

function writeReport(
  channel: vscode.OutputChannel,
  r: ReportInput
): void {
  channel.clear();
  channel.appendLine(`=== ${path.basename(r.sourcePath)} → handler ===`);
  channel.appendLine(`Source: ${r.sourcePath}`);
  channel.appendLine(
    `Handler: ${r.handlerPath} ${r.handlerWritten ? "(written)" : "(not written)"}`
  );
  if (r.mergeConflict) {
    channel.appendLine(`Merge conflict: ${r.mergeConflict}`);
  }
  if (r.viewPath) {
    channel.appendLine(`View: ${r.viewPath} (written)`);
  } else if (r.result.hasView) {
    channel.appendLine(`View: skipped (no view path provided)`);
  } else {
    channel.appendLine(`View: none (handler is pure logic)`);
  }
  channel.appendLine(`Tags converted: ${r.result.tagsConverted}`);
  if (r.result.todos.length > 0) {
    channel.appendLine(`Tags flagged as TODO:`);
    for (const t of r.result.todos) {
      channel.appendLine(`  - <${t.tag}>: ${t.raw}`);
    }
  }
  if (r.result.querySkipped.length > 0) {
    channel.appendLine(`Queries skipped:`);
    for (const q of r.result.querySkipped) {
      channel.appendLine(`  - ${q.name}: ${q.reason}`);
    }
  }
  channel.appendLine(
    `Variables rescoped: ${r.result.rescoped.length} (${countModes(r.result.rescoped)})`
  );
  for (const v of r.result.rescoped) {
    channel.appendLine(`  - ${v.name} → ${v.mode}`);
  }
}

function countModes(rescoped: RescopedVar[]): string {
  let prc = 0;
  let v = 0;
  let local = 0;
  for (const r of rescoped) {
    if (r.mode === "prc") prc++;
    else if (r.mode === "local") local++;
    else v++;
  }
  return `${prc} prc, ${v} var, ${local} local`;
}

async function pickScopeStyle(): Promise<"var" | "local" | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "var (recommended)",
        description: "var x = ... on first write, bare x afterward",
        value: "var" as const
      },
      {
        label: "local",
        description: "local.x = ...",
        value: "local" as const
      }
    ],
    { placeHolder: "Scope style for non-prc variables" }
  );
  return pick?.value;
}

function deriveActionName(baseName: string): string {
  return baseName;
}

function deriveHandlerName(sourcePath: string): string {
  const dir = path.basename(path.dirname(sourcePath));
  if (dir && dir !== "." && dir !== "/") return dir.toLowerCase();
  return "main";
}

function deriveHandlerFilePath(
  sourcePath: string,
  handlerName: string
): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const root = ws?.uri.fsPath ?? path.dirname(sourcePath);
  return path.join(root, "handlers", `${handlerName}.cfc`);
}

function deriveViewFilePath(
  sourcePath: string,
  handlerName: string,
  actionName: string
): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const root = ws?.uri.fsPath ?? path.dirname(sourcePath);
  return path.join(root, "views", handlerName, `${actionName}.cfm`);
}

function computeTabUnit(editor: vscode.TextEditor): string {
  const opts = editor.options;
  if (opts.insertSpaces === false) return "\t";
  const size = typeof opts.tabSize === "number" ? opts.tabSize : 4;
  return " ".repeat(size);
}
