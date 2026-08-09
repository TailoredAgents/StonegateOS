import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ACTION_FILES = [
  join(process.cwd(), "../site/src/app/team/actions.ts"),
  join(process.cwd(), "../site/src/app/team/actions/tasks.ts"),
];

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function assignedIdentifier(call: ts.CallExpression): ts.Identifier | null {
  let current: ts.Node = call;
  while (
    current.parent &&
    (ts.isAwaitExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent))
  ) {
    current = current.parent;
  }

  const declaration = current.parent;
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name)
    ? declaration.name
    : null;
}

function isResolvedByFeedbackHelper(call: ts.CallExpression): boolean {
  const parent = call.parent;
  return (
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "resolveTeamMutationFeedback"
  );
}

function isPassedToPolicyReceiptHelper(call: ts.CallExpression): boolean {
  const responseIdentifier = assignedIdentifier(call);
  const fn = enclosingFunction(call);
  if (!responseIdentifier || !fn) return false;

  let passed = false;
  visit(fn, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "finishPolicyMutation" &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === responseIdentifier.text
    ) {
      passed = true;
    }
  });
  return passed;
}

function callResultIsChecked(call: ts.CallExpression): boolean {
  if (isResolvedByFeedbackHelper(call) || isPassedToPolicyReceiptHelper(call)) {
    return true;
  }

  const responseIdentifier = assignedIdentifier(call);
  const fn = enclosingFunction(call);
  if (!responseIdentifier || !fn) return false;

  let checked = false;
  visit(fn, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === responseIdentifier.text &&
      node.name.text === "ok"
    ) {
      checked = true;
    }
  });
  return checked;
}

function functionSource(
  sourceFile: ts.SourceFile,
  name: string,
): string | null {
  let result: string | null = null;
  visit(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      result = node.getText(sourceFile);
    }
  });
  return result;
}

describe("Site Team server action response safety", () => {
  const sourceFiles = ACTION_FILES.map((path) =>
    ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  );

  it("does not ignore any admin API response in the audited action files", () => {
    const violations: string[] = [];

    for (const sourceFile of sourceFiles) {
      visit(sourceFile, (node) => {
        if (
          !ts.isCallExpression(node) ||
          node.expression.getText(sourceFile) !== "callAdminApiAs"
        ) {
          return;
        }
        if (callResultIsChecked(node)) return;

        const position = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push(`${sourceFile.fileName}:${position.line + 1}`);
      });
    }

    expect(violations).toEqual([]);
  });

  it.each(["updateApptStatus", "addApptNote", "quoteDecisionAction"])(
    "routes %s through the no-false-success helper",
    (name) => {
      const source = functionSource(sourceFiles[0]!, name);
      expect(source).not.toBeNull();
      expect(source).toContain("resolveTeamMutationFeedback(");
      expect(source).toContain("setMutationFlash(feedback)");
    },
  );

  it.each(["addApptTaskAction", "updateApptTaskStatusAction"])(
    "routes %s through actionable task feedback",
    (name) => {
      const source = functionSource(sourceFiles[1]!, name);
      expect(source).not.toBeNull();
      expect(source).toContain("resolveTeamMutationFeedback(");
      expect(source).toContain(
        "setTaskFeedback(feedback.message, feedback.ok)",
      );
      expect(source).not.toMatch(/HTTP \$\{response\.status\}/u);
    },
  );

  it("keeps the recognized Policy helper strict about HTTP and receipt success", () => {
    const source = functionSource(sourceFiles[0]!, "finishPolicyMutation");
    expect(source).not.toBeNull();
    expect(source).toContain("if (!response.ok)");
    expect(source).toContain("isConfirmedPolicyMutation(result, expectedKey)");
  });
});
