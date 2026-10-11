-- Materialize the account-centred Partner Administration permissions added
-- after the original stored-role baseline. Runtime authorization is sourced
-- from these stored arrays, so built-in roles must not depend on mutable role
-- slugs or a bare wildcard to acquire later capabilities.
WITH partner_role_permissions(slug, permissions) AS (
  VALUES
    (
      'owner',
      ARRAY[
        'partners.identities.disable',
        'partners.memberships.recover_admin',
        'partners.domains.override',
        'partners.accounts.merge',
        'partners.accounts.close',
        'partners.quarantine.release'
      ]::text[]
    ),
    (
      'read_only',
      ARRAY[
        'partners.accounts.read',
        'partners.applications.read',
        'partners.joins.read',
        'partners.people.read',
        'partners.memberships.read',
        'partners.invitations.read',
        'partners.domains.read',
        'partners.security.read',
        'partners.quarantine.read',
        'partners.preview.read',
        'partners.commercial.read',
        'partners.billing_disputes.read',
        'partners.cancellation_requests.read',
        'partners.change_requests.read'
      ]::text[]
    )
)
UPDATE team_roles AS role
SET permissions = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          coalesce(role.permissions, ARRAY[]::text[]) || defaults.permissions
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
FROM partner_role_permissions AS defaults
WHERE lower(trim(role.slug)) = defaults.slug;
