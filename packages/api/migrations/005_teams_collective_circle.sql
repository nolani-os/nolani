-- Store Collective's auto-generated Circle-ID so the
-- sync-daemon + add_member/remove_member can keep Collective membership in sync
-- with the team's Authentik group.

ALTER TABLE claraos_teams
  ADD COLUMN IF NOT EXISTS nc_collective_circle_id TEXT;
