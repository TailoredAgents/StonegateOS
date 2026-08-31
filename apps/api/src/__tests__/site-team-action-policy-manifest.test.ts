import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isTeamPermission, type ActionRisk } from "@myst-os/sdk";
import {
  TEAM_SERVER_ACTION_MANIFEST_EXCLUSIONS,
  TEAM_SERVER_ACTION_MANIFEST_RUNTIME_STATUS,
  TEAM_SERVER_ACTION_MANIFEST_SCOPE,
  TEAM_SERVER_ACTION_POLICIES,
} from "../../../site/src/app/team/action-policy-manifest";
import ts from "typescript";

const SITE_TEAM_ROOT = join(process.cwd(), "../site/src/app/team");
const ACTION_DIRECTORY = join(SITE_TEAM_ROOT, "actions");
const LOGIN_ACTION_FILE = join(SITE_TEAM_ROOT, "login/actions.ts");

const ACTION_FILES = [
  join(SITE_TEAM_ROOT, "actions.ts"),
  ...readdirSync(ACTION_DIRECTORY)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .sort()
    .map((name) => join(ACTION_DIRECTORY, name)),
];

type ExportedAction = {
  file: string;
  name: string;
};

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function isFunctionInitializer(
  initializer: ts.Expression | undefined,
): boolean {
  return Boolean(
    initializer &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)),
  );
}

function exportedActions(file: string): ExportedAction[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const actions: ExportedAction[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
      if (!statement.name) {
        throw new Error(`${file} has an unnamed exported function`);
      }
      actions.push({ file, name: statement.name.text });
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          isFunctionInitializer(declaration.initializer)
        ) {
          actions.push({ file, name: declaration.name.text });
        }
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        actions.push({ file, name: element.name.text });
      }
    }
  }

  return actions;
}

const DISCOVERED_ACTIONS = ACTION_FILES.flatMap(exportedActions);
const DISCOVERED_ACTION_NAMES = DISCOVERED_ACTIONS.map(({ name }) => name);

const DESTRUCTIVE_ACTIONS = new Set([
  "approveMergeSuggestionAction",
  "deleteCallCoachingAction",
  "deleteContactAction",
  "deleteContactNoteAction",
  "deleteInstantQuoteAction",
  "deleteMessageAction",
  "deletePropertyAction",
  "deleteQuoteAction",
  "deleteTaskAction",
  "deleteTeamMemberAction",
  "manualMergeContactsAction",
  "partnerAccessApplicationDecisionAction",
  "resetSalesHqAction",
  "updateTeamMemberAction",
  "partnerPortalSetUserActiveAction",
]);

const EXTERNAL_ACTIONS = new Set([
  "applyGoogleAdsAnalystRecommendationAction",
  "bookAppointmentAction",
  "bookInboxAppointmentAction",
  "bulkApplyGoogleAdsAnalystRecommendationsAction",
  "createQuoteAction",
  "createCanvassFollowupAction",
  "draftOutboundFirstTouchAction",
  "draftOutboundFollowupAction",
  "partnerPortalInviteUserAction",
  "rescheduleAppointmentAction",
  "rescheduleInboxAppointmentAction",
  "retryFailedMessageAction",
  "runGoogleAdsAnalystAction",
  "runGoogleAdsSyncAction",
  "publishSeoPostAction",
  "runSeoDraftAction",
  "saveGoogleAdsAnalystSettingsAction",
  "scheduleQuoteFollowupAction",
  "sendDraftMessageAction",
  "sendEtaDraftAction",
  "sendQuoteAction",
  "sendThreadMessageAction",
  "startContactCallAction",
  "suggestThreadReplyAction",
  "updateAutomationModeAction",
  "updateLeadAutomationAction",
  "updateSalesAutopilotPolicyAction",
]);

const FINANCIAL_ACTIONS = new Set([
  "attachPaymentAction",
  "convertAppointmentToJobAction",
  "detachPaymentAction",
  "partnerPortalSaveRatesAction",
  "paymentReconciliationAction",
  "updateAppointmentBookingDetailsAction",
  "updateAppointmentSoldByAction",
  "updateApptStatus",
]);

function expectedRisk(name: string): ActionRisk {
  if (DESTRUCTIVE_ACTIONS.has(name)) return "destructive";
  if (EXTERNAL_ACTIONS.has(name)) return "external";
  if (FINANCIAL_ACTIONS.has(name)) return "financial";
  return "normal";
}

describe("Site Team server action policy manifest", () => {
  it("inventories every exported function in actions.ts and actions/*.ts", () => {
    const duplicateExports = DISCOVERED_ACTION_NAMES.filter(
      (name, index, names) => names.indexOf(name) !== index,
    );
    expect(duplicateExports).toEqual([]);
    expect(Object.keys(TEAM_SERVER_ACTION_POLICIES).sort()).toEqual(
      [...DISCOVERED_ACTION_NAMES].sort(),
    );
  });

  it("keeps authentication actions separate and marks runtime adoption incomplete", () => {
    expect(TEAM_SERVER_ACTION_MANIFEST_RUNTIME_STATUS).toBe("metadata_only");
    expect(TEAM_SERVER_ACTION_MANIFEST_SCOPE).toEqual([
      "team/actions.ts",
      "team/actions/*.ts",
    ]);
    expect(TEAM_SERVER_ACTION_MANIFEST_EXCLUSIONS).toEqual([
      "team/login/actions.ts",
      "team/auth/route.ts",
    ]);

    const loginActionNames = exportedActions(LOGIN_ACTION_FILE).map(
      ({ name }) => name,
    );
    expect(loginActionNames.length).toBeGreaterThan(0);
    for (const loginActionName of loginActionNames) {
      expect(TEAM_SERVER_ACTION_POLICIES).not.toHaveProperty(loginActionName);
    }

    for (const file of ACTION_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("TEAM_SERVER_ACTION_POLICIES");
      expect(source).not.toContain("action-policy-manifest");
    }
  });

  it("uses only known, non-empty permissions and human principals", () => {
    for (const policy of Object.values(TEAM_SERVER_ACTION_POLICIES)) {
      expect(policy.principalTypes).toEqual(["human"]);
      expect(policy.requiredPermissions.length).toBeGreaterThan(0);
      for (const permission of policy.requiredPermissions) {
        expect(isTeamPermission(permission)).toBe(true);
      }
    }
  });

  it("gives every mutation a unique, action-bound audit name", () => {
    const auditActions = Object.values(TEAM_SERVER_ACTION_POLICIES).map(
      ({ auditAction }) => auditAction,
    );
    expect(new Set(auditActions).size).toBe(auditActions.length);

    for (const [name, policy] of Object.entries(TEAM_SERVER_ACTION_POLICIES)) {
      expect(policy.auditAction).toBe(`team_action.${name}`);
    }
  });

  it("does not classify an exported mutation as read-only", () => {
    for (const policy of Object.values(TEAM_SERVER_ACTION_POLICIES)) {
      expect(policy.risk).not.toBe("read");
    }
  });

  it("locks the reviewed destructive, external, and financial classifications", () => {
    const reviewedHighRiskNames = [
      ...DESTRUCTIVE_ACTIONS,
      ...EXTERNAL_ACTIONS,
      ...FINANCIAL_ACTIONS,
    ];
    expect(new Set(reviewedHighRiskNames).size).toBe(
      reviewedHighRiskNames.length,
    );
    for (const name of reviewedHighRiskNames) {
      expect(DISCOVERED_ACTION_NAMES).toContain(name);
    }

    for (const [name, policy] of Object.entries(TEAM_SERVER_ACTION_POLICIES)) {
      expect(policy.risk).toBe(expectedRisk(name));
    }
  });

  it("requires idempotency for every high-risk action", () => {
    for (const policy of Object.values(TEAM_SERVER_ACTION_POLICIES)) {
      if (
        policy.risk === "destructive" ||
        policy.risk === "external" ||
        policy.risk === "financial"
      ) {
        expect(policy.requiresIdempotency).toBe(true);
      }
    }
  });

  it("declares the appointment-status action's maximum conditional capability", () => {
    expect(TEAM_SERVER_ACTION_POLICIES.updateApptStatus).toEqual(
      expect.objectContaining({
        requiredPermissions: [
          "appointments.update",
          "payments.collect",
          "payments.manage",
          "commissions.manage",
          "messages.send",
        ],
        risk: "financial",
        requiresIdempotency: true,
      }),
    );
  });
});
