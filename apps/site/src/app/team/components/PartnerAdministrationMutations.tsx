import { randomUUID } from "node:crypto";
import { SubmitButton } from "@/components/SubmitButton";
import {
  partnerAccountDomainCreateAction,
  partnerAccountDomainRevokeAction,
  partnerAccountDomainVerifyAction,
  partnerMembershipMigrationReviewAction,
  partnerMembershipRoleAction,
  partnerMembershipScopeAction,
} from "../actions/partner-administration";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";

export type PartnerDomainAccountOption = {
  id: string;
  name: string;
  version: string;
};

export type PartnerMembershipControlPermissions = {
  manage: boolean;
  reviewMigration: boolean;
  recoverAdministrator: boolean;
};

export type PartnerDomainControlPermissions = {
  manage: boolean;
  verify: boolean;
  revoke: boolean;
  override: boolean;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scopeValues(item: Record<string, unknown>, key: string): string {
  const scope = item["accessScope"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return "";
  const values = (scope as Record<string, unknown>)[key];
  return Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === "string")
        .join("\n")
    : "";
}

function MembershipIdentityFields({
  item,
  keyPrefix,
}: {
  item: Record<string, unknown>;
  keyPrefix: string;
}): React.ReactElement {
  return (
    <>
      <input type="hidden" name="membershipId" value={text(item["id"])} />
      <input
        type="hidden"
        name="accountId"
        value={text(item["partnerAccountId"])}
      />
      <input
        type="hidden"
        name="expectedVersion"
        value={text(item["updatedAt"])}
      />
      <input
        type="hidden"
        name="idempotencyKey"
        value={`${keyPrefix}:${text(item["id"]) || "unknown"}:${randomUUID()}`}
      />
    </>
  );
}

function ConfirmationField({
  phrase,
  id,
}: {
  phrase: string;
  id: string;
}): React.ReactElement {
  return (
    <label
      htmlFor={id}
      className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
    >
      Type {phrase}
      <input
        id={id}
        className={`${TEAM_INPUT_COMPACT} mt-1 font-mono`}
        name="confirmation"
        required
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
      />
    </label>
  );
}

export function PartnerMembershipMutationControls({
  item,
  permissions,
}: {
  item: Record<string, unknown>;
  permissions: PartnerMembershipControlPermissions;
}): React.ReactElement | null {
  const membershipId = text(item["id"]);
  const status = text(item["status"]);
  const roleKey = text(item["roleKey"]);
  const accessLevel = text(item["accessLevel"]);
  const migrationReviewStatus = text(item["migrationReviewStatus"]);
  const migrationLegacyRoleKey = text(item["migrationLegacyRoleKey"]);
  const editableLifecycle = status === "active" || status === "suspended";
  const migrationBlocksEditing =
    migrationReviewStatus === "pending" ||
    migrationReviewStatus === "quarantined";
  const canEdit =
    permissions.manage && editableLifecycle && !migrationBlocksEditing;
  const canReview =
    permissions.reviewMigration && migrationReviewStatus === "pending";
  if (!canEdit && !canReview) return null;

  const idPrefix = `partner-member-${membershipId}`;
  return (
    <div className="mt-4 space-y-3">
      {canReview ? (
        <details className="rounded-xl border border-amber-300 bg-amber-50 p-3">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-amber-950">
            Review migrated privileges
          </summary>
          <p className="mt-1 text-xs text-amber-900">
            Legacy role: {migrationLegacyRoleKey || "unknown"}. Approval removes
            only the launch migration&apos;s temporary capability protections.
            Quarantine suspends this company membership.
          </p>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {migrationLegacyRoleKey !== "owner" ||
            permissions.recoverAdministrator ? (
              <form
                action={partnerMembershipMigrationReviewAction}
                className="space-y-3 rounded-xl border border-emerald-200 bg-white p-3"
              >
                <MembershipIdentityFields
                  item={item}
                  keyPrefix="partner-migration-approve"
                />
                <input type="hidden" name="decision" value="approve" />
                <input
                  type="hidden"
                  name="ownerOverride"
                  value={migrationLegacyRoleKey === "owner" ? "true" : "false"}
                />
                <label
                  htmlFor={`${idPrefix}-approve-note`}
                  className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
                >
                  Approval evidence and reason
                  <textarea
                    id={`${idPrefix}-approve-note`}
                    className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                    name="note"
                    minLength={12}
                    maxLength={2000}
                    required
                  />
                </label>
                <ConfirmationField
                  id={`${idPrefix}-approve-confirmation`}
                  phrase={
                    migrationLegacyRoleKey === "owner"
                      ? "APPROVE MIGRATED OWNER"
                      : "APPROVE MIGRATED MEMBERSHIP"
                  }
                />
                <SubmitButton
                  className={teamButtonClass("primary", "sm")}
                  pendingLabel="Approving…"
                >
                  Approve migrated membership
                </SubmitButton>
              </form>
            ) : (
              <div className="rounded-xl border border-amber-300 bg-white p-3 text-sm text-amber-950">
                A Team Owner must approve a migrated account owner. You can
                still quarantine it when another active Administrator exists.
              </div>
            )}

            <form
              action={partnerMembershipMigrationReviewAction}
              className="space-y-3 rounded-xl border border-rose-200 bg-white p-3"
            >
              <MembershipIdentityFields
                item={item}
                keyPrefix="partner-migration-quarantine"
              />
              <input type="hidden" name="decision" value="quarantine" />
              <input type="hidden" name="ownerOverride" value="false" />
              <label
                htmlFor={`${idPrefix}-quarantine-note`}
                className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
              >
                Quarantine evidence and reason
                <textarea
                  id={`${idPrefix}-quarantine-note`}
                  className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                  name="note"
                  minLength={12}
                  maxLength={2000}
                  required
                />
              </label>
              <ConfirmationField
                id={`${idPrefix}-quarantine-confirmation`}
                phrase="QUARANTINE MIGRATED MEMBERSHIP"
              />
              <SubmitButton
                className={teamButtonClass("danger", "sm")}
                pendingLabel="Quarantining…"
              >
                Quarantine membership
              </SubmitButton>
            </form>
          </div>
        </details>
      ) : null}

      {canEdit ? (
        <details className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-3">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-[color:var(--team-text)]">
            Change role or account scope
          </summary>
          <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
            These changes affect only this company membership. A current version
            and a fresh sign-in within 15 minutes are required.
          </p>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <form
              action={partnerMembershipRoleAction}
              className="space-y-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3"
            >
              <MembershipIdentityFields item={item} keyPrefix="partner-role" />
              <label
                htmlFor={`${idPrefix}-role`}
                className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
              >
                Account role
                <select
                  id={`${idPrefix}-role`}
                  className={`${TEAM_INPUT_COMPACT} mt-1`}
                  name="roleKey"
                  defaultValue={roleKey}
                  required
                >
                  <option value="administrator">Administrator</option>
                  <option value="operations">Operations</option>
                  <option value="billing_approver">Billing / Approver</option>
                  <option value="viewer">Viewer</option>
                </select>
              </label>
              {accessLevel === "scoped" ? (
                <p className="text-xs text-amber-800">
                  Set account-wide scope before assigning Administrator.
                </p>
              ) : null}
              <ConfirmationField
                id={`${idPrefix}-role-confirmation`}
                phrase="UPDATE MEMBERSHIP ROLE"
              />
              <SubmitButton
                className={teamButtonClass("primary", "sm")}
                pendingLabel="Updating role…"
              >
                Update role
              </SubmitButton>
            </form>

            <form
              action={partnerMembershipScopeAction}
              className="space-y-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3"
            >
              <MembershipIdentityFields item={item} keyPrefix="partner-scope" />
              <label
                htmlFor={`${idPrefix}-access-level`}
                className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
              >
                Access level
                <select
                  id={`${idPrefix}-access-level`}
                  className={`${TEAM_INPUT_COMPACT} mt-1`}
                  name="accessLevel"
                  defaultValue={accessLevel || "account"}
                  required
                >
                  <option value="account">Entire company account</option>
                  {roleKey !== "administrator" ? (
                    <option value="scoped">
                      Selected locations or cost centers
                    </option>
                  ) : null}
                </select>
              </label>
              <p
                id={`${idPrefix}-scope-help`}
                className="text-xs text-[color:var(--team-text-muted)]"
              >
                Enter one account-owned UUID per line. For entire-account
                access, clear both lists. At least one value is required for
                scoped access.
              </p>
              <label
                htmlFor={`${idPrefix}-locations`}
                className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
              >
                Location IDs
                <textarea
                  id={`${idPrefix}-locations`}
                  className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y font-mono text-xs`}
                  name="locationIds"
                  defaultValue={scopeValues(item, "locationIds")}
                  aria-describedby={`${idPrefix}-scope-help`}
                  spellCheck={false}
                />
              </label>
              <label
                htmlFor={`${idPrefix}-cost-centers`}
                className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
              >
                Cost-center IDs
                <textarea
                  id={`${idPrefix}-cost-centers`}
                  className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y font-mono text-xs`}
                  name="costCenterIds"
                  defaultValue={scopeValues(item, "costCenterIds")}
                  aria-describedby={`${idPrefix}-scope-help`}
                  spellCheck={false}
                />
              </label>
              <ConfirmationField
                id={`${idPrefix}-scope-confirmation`}
                phrase="UPDATE MEMBERSHIP SCOPE"
              />
              <SubmitButton
                className={teamButtonClass("primary", "sm")}
                pendingLabel="Updating scope…"
              >
                Update scope
              </SubmitButton>
            </form>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function DomainIdentityFields({
  item,
  keyPrefix,
}: {
  item: Record<string, unknown>;
  keyPrefix: string;
}): React.ReactElement {
  return (
    <>
      <input type="hidden" name="domainId" value={text(item["id"])} />
      <input
        type="hidden"
        name="accountId"
        value={text(item["partnerAccountId"])}
      />
      <input
        type="hidden"
        name="expectedVersion"
        value={text(item["version"] || item["updatedAt"])}
      />
      <input
        type="hidden"
        name="idempotencyKey"
        value={`${keyPrefix}:${text(item["id"]) || "unknown"}:${randomUUID()}`}
      />
    </>
  );
}

function VerificationFields({
  idPrefix,
}: {
  idPrefix: string;
}): React.ReactElement {
  return (
    <>
      <label
        htmlFor={`${idPrefix}-method`}
        className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
      >
        Verification method
        <select
          id={`${idPrefix}-method`}
          className={`${TEAM_INPUT_COMPACT} mt-1`}
          name="verificationMethod"
          defaultValue="dns_txt"
          required
        >
          <option value="dns_txt">DNS TXT record</option>
          <option value="email_challenge">Verified email challenge</option>
          <option value="manual_document">Reviewed company document</option>
        </select>
      </label>
      <label
        htmlFor={`${idPrefix}-evidence`}
        className="block text-xs font-semibold text-[color:var(--team-text-muted)]"
      >
        Evidence reference
        <textarea
          id={`${idPrefix}-evidence`}
          className={`${TEAM_INPUT_COMPACT} mt-1 min-h-20 resize-y`}
          name="verificationEvidence"
          minLength={8}
          maxLength={2000}
          required
          aria-describedby={`${idPrefix}-evidence-help`}
        />
      </label>
      <p
        id={`${idPrefix}-evidence-help`}
        className="text-xs text-[color:var(--team-text-muted)]"
      >
        Record the DNS result, completed challenge reference, or reviewed
        document reference. This evidence is not shown in directory results.
      </p>
    </>
  );
}

export function PartnerDomainCreatePanel({
  accounts,
  accountsTruncated,
  unavailableReason,
}: {
  accounts: PartnerDomainAccountOption[];
  accountsTruncated: boolean;
  unavailableReason: string;
}): React.ReactElement {
  return (
    <details className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
      <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-sky-950">
        Add a company domain
      </summary>
      <p className="mt-1 text-xs text-sky-900">
        New domains remain pending until a separately authorized verification
        decision records provenance.
      </p>
      {unavailableReason ? (
        <p role="status" className="mt-3 text-sm text-amber-900">
          {unavailableReason}
        </p>
      ) : (
        <form
          action={partnerAccountDomainCreateAction}
          className="mt-4 grid gap-3 lg:grid-cols-2"
        >
          <input type="hidden" name="domainAction" value="create" />
          <input
            type="hidden"
            name="idempotencyKey"
            value={`partner-domain-create:${randomUUID()}`}
          />
          <label className="block text-xs font-semibold text-sky-950">
            Partner company
            <select
              className={`${TEAM_INPUT_COMPACT} mt-1`}
              name="accountTarget"
              defaultValue=""
              required
            >
              <option value="" disabled>
                Choose a company
              </option>
              {accounts.map((account) => (
                <option
                  key={account.id}
                  value={`${account.id}|${account.version}`}
                >
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold text-sky-950">
            Company-owned domain
            <input
              className={`${TEAM_INPUT_COMPACT} mt-1`}
              name="domain"
              placeholder="example.com"
              minLength={3}
              maxLength={253}
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <div className="lg:col-span-2">
            <ConfirmationField
              id="partner-domain-create-confirmation"
              phrase="ADD COMPANY DOMAIN"
            />
          </div>
          <div className="lg:col-span-2 flex flex-wrap items-center gap-3">
            <SubmitButton
              className={teamButtonClass("primary", "sm")}
              pendingLabel="Adding domain…"
            >
              Add pending domain
            </SubmitButton>
            {accountsTruncated ? (
              <p className="text-xs text-amber-900">
                Only the first 500 companies are shown. Use company search to
                find and manage domains for accounts outside this list.
              </p>
            ) : null}
          </div>
        </form>
      )}
    </details>
  );
}

export function PartnerDomainMutationControls({
  item,
  permissions,
}: {
  item: Record<string, unknown>;
  permissions: PartnerDomainControlPermissions;
}): React.ReactElement | null {
  const domainId = text(item["id"]);
  const status = text(item["status"]);
  const idPrefix = `partner-domain-${domainId}`;
  const canVerify = status === "pending" && permissions.verify;
  const canRevoke = status !== "revoked" && permissions.revoke;
  const canRestore =
    status === "revoked" && permissions.manage && permissions.override;
  if (!canVerify && !canRevoke && !canRestore) return null;

  return (
    <details className="mt-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-3">
      <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-[color:var(--team-text)]">
        Manage domain lifecycle
      </summary>
      <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
        A fresh sign-in within 15 minutes, the current version, and exact
        confirmation are required. Applicant websites never establish domain
        authority.
      </p>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {canVerify ? (
          <form
            action={partnerAccountDomainVerifyAction}
            className="space-y-3 rounded-xl border border-emerald-200 bg-[color:var(--team-surface)] p-3"
          >
            <DomainIdentityFields
              item={item}
              keyPrefix="partner-domain-verify"
            />
            <input
              type="hidden"
              name="overrideConflictingVerification"
              value="false"
            />
            <VerificationFields idPrefix={`${idPrefix}-verify`} />
            <ConfirmationField
              id={`${idPrefix}-verify-confirmation`}
              phrase="VERIFY COMPANY DOMAIN"
            />
            <SubmitButton
              className={teamButtonClass("primary", "sm")}
              pendingLabel="Verifying…"
            >
              Verify domain
            </SubmitButton>
          </form>
        ) : null}

        {canVerify && permissions.override ? (
          <form
            action={partnerAccountDomainVerifyAction}
            className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3"
          >
            <DomainIdentityFields
              item={item}
              keyPrefix="partner-domain-transfer"
            />
            <input
              type="hidden"
              name="overrideConflictingVerification"
              value="true"
            />
            <VerificationFields idPrefix={`${idPrefix}-transfer`} />
            <label className="block text-xs font-semibold text-amber-950">
              Transfer reason
              <textarea
                className={`${TEAM_INPUT_COMPACT} mt-1 min-h-20 resize-y`}
                name="overrideReason"
                minLength={12}
                maxLength={1000}
                required
              />
            </label>
            <p className="text-xs text-amber-900">
              Owner override revokes every conflicting verified record before
              assigning this tenant boundary.
            </p>
            <ConfirmationField
              id={`${idPrefix}-transfer-confirmation`}
              phrase="TRANSFER VERIFIED DOMAIN"
            />
            <SubmitButton
              className={teamButtonClass("danger", "sm")}
              pendingLabel="Transferring…"
            >
              Transfer and verify
            </SubmitButton>
          </form>
        ) : null}

        {canRevoke ? (
          <form
            action={partnerAccountDomainRevokeAction}
            className="space-y-3 rounded-xl border border-rose-200 bg-[color:var(--team-surface)] p-3"
          >
            <DomainIdentityFields
              item={item}
              keyPrefix="partner-domain-revoke"
            />
            <label className="block text-xs font-semibold text-[color:var(--team-text-muted)]">
              Revocation reason
              <textarea
                className={`${TEAM_INPUT_COMPACT} mt-1 min-h-20 resize-y`}
                name="reason"
                minLength={12}
                maxLength={1000}
                required
              />
            </label>
            <ConfirmationField
              id={`${idPrefix}-revoke-confirmation`}
              phrase="REVOKE COMPANY DOMAIN"
            />
            <SubmitButton
              className={teamButtonClass("danger", "sm")}
              pendingLabel="Revoking…"
            >
              Revoke domain
            </SubmitButton>
          </form>
        ) : null}

        {canRestore ? (
          <form
            action={partnerAccountDomainCreateAction}
            className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3"
          >
            <input type="hidden" name="domainAction" value="restore" />
            <input
              type="hidden"
              name="accountId"
              value={text(item["partnerAccountId"])}
            />
            <input
              type="hidden"
              name="expectedVersion"
              value={text(item["version"] || item["updatedAt"])}
            />
            <input
              type="hidden"
              name="domain"
              value={text(item["normalizedDomain"])}
            />
            <input
              type="hidden"
              name="idempotencyKey"
              value={`partner-domain-restore:${domainId}:${randomUUID()}`}
            />
            <label className="block text-xs font-semibold text-amber-950">
              Restore reason
              <textarea
                className={`${TEAM_INPUT_COMPACT} mt-1 min-h-20 resize-y`}
                name="reason"
                minLength={12}
                maxLength={1000}
                required
              />
            </label>
            <p className="text-xs text-amber-900">
              Restoring returns the domain to pending; it does not restore
              verification.
            </p>
            <ConfirmationField
              id={`${idPrefix}-restore-confirmation`}
              phrase="RESTORE REVOKED DOMAIN"
            />
            <SubmitButton
              className={teamButtonClass("danger", "sm")}
              pendingLabel="Restoring…"
            >
              Restore to pending
            </SubmitButton>
          </form>
        ) : null}
      </div>
    </details>
  );
}
