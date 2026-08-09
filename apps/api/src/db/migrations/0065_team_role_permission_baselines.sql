-- Materialize every built-in role's current permission baseline before the
-- application stops deriving authority from mutable role slugs at runtime.
-- Existing custom additions remain intact.
WITH default_role_permissions(slug, permissions) AS (
  VALUES
    ('owner', ARRAY['*']::text[]),
    (
      'office',
      ARRAY[
        'messages.send', 'messages.read', 'messages.write',
        'messages.upload', 'messages.delete', 'policy.read', 'policy.write',
        'bookings.manage', 'automation.read', 'automation.simulate',
        'automation.write', 'audit.read', 'appointments.read',
        'appointments.update', 'appointment_media.capture',
        'appointment_media.manage', 'payments.read', 'payments.collect',
        'quotes.read', 'quotes.write', 'quotes.send', 'quotes.update',
        'quotes.delete', 'expenses.read', 'expenses.write', 'contacts.read',
        'contacts.write', 'contacts.delete', 'properties.read',
        'properties.write', 'properties.delete', 'pipeline.read',
        'pipeline.write', 'sales.read', 'sales.write', 'outbound.read',
        'outbound.write', 'outbound.import'
      ]::text[]
    ),
    (
      'sales',
      ARRAY[
        'messages.read', 'messages.write', 'messages.upload',
        'messages.delete', 'messages.send', 'appointments.read',
        'appointments.update', 'appointment_media.capture',
        'appointment_media.manage', 'payments.read', 'payments.collect',
        'bookings.manage', 'quotes.read', 'quotes.write', 'quotes.send',
        'quotes.update', 'contacts.read', 'contacts.write', 'properties.read',
        'properties.write', 'pipeline.read', 'pipeline.write', 'sales.read',
        'sales.write', 'outbound.read', 'outbound.write', 'outbound.import',
        'automation.simulate'
      ]::text[]
    ),
    (
      'crew',
      ARRAY[
        'messages.read', 'appointments.read', 'appointments.update',
        'appointment_media.capture', 'payments.read', 'payments.collect',
        'expenses.read', 'expenses.write'
      ]::text[]
    ),
    (
      'read_only',
      ARRAY[
        'appointments.read', 'audit.read', 'automation.read',
        'contacts.read', 'expenses.read', 'properties.read', 'pipeline.read',
        'messages.read', 'policy.read', 'quotes.read', 'sales.read',
        'outbound.read', 'partners.read', 'finance.read',
        'commissions.read', 'marketing.read'
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
FROM default_role_permissions AS defaults
WHERE lower(trim(role.slug)) = defaults.slug;

-- Expand the legacy generic `read` capability everywhere it can be stored.
-- This preserves its historical scope (which intentionally excluded payment
-- details) while allowing the runtime matcher to remove wildcard semantics.
WITH explicit_read_permissions AS (
  SELECT ARRAY[
    'appointments.read', 'audit.read', 'automation.read', 'contacts.read',
    'expenses.read', 'properties.read', 'pipeline.read', 'messages.read',
    'policy.read', 'quotes.read', 'sales.read', 'outbound.read',
    'partners.read', 'finance.read', 'commissions.read', 'marketing.read'
  ]::text[] AS permissions
)
UPDATE team_roles AS role
SET permissions = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          array_remove(role.permissions, 'read') || reads.permissions
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
FROM explicit_read_permissions AS reads
WHERE 'read' = ANY(role.permissions);

WITH explicit_read_permissions AS (
  SELECT ARRAY[
    'appointments.read', 'audit.read', 'automation.read', 'contacts.read',
    'expenses.read', 'properties.read', 'pipeline.read', 'messages.read',
    'policy.read', 'quotes.read', 'sales.read', 'outbound.read',
    'partners.read', 'finance.read', 'commissions.read', 'marketing.read'
  ]::text[] AS permissions
)
UPDATE team_members AS member
SET permissions_grant = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          array_remove(member.permissions_grant, 'read') || reads.permissions
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
FROM explicit_read_permissions AS reads
WHERE 'read' = ANY(member.permissions_grant);

WITH explicit_read_permissions AS (
  SELECT ARRAY[
    'appointments.read', 'audit.read', 'automation.read', 'contacts.read',
    'expenses.read', 'properties.read', 'pipeline.read', 'messages.read',
    'policy.read', 'quotes.read', 'sales.read', 'outbound.read',
    'partners.read', 'finance.read', 'commissions.read', 'marketing.read'
  ]::text[] AS permissions
)
UPDATE team_members AS member
SET permissions_deny = (
      SELECT ARRAY(
        SELECT DISTINCT permission
        FROM unnest(
          array_remove(member.permissions_deny, 'read') || reads.permissions
        ) AS permission
        ORDER BY permission
      )
    ),
    updated_at = now()
FROM explicit_read_permissions AS reads
WHERE 'read' = ANY(member.permissions_deny);
