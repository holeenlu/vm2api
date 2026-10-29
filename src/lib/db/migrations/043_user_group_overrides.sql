-- Pricing and RPM overrides are independent of access grants.
CREATE TABLE user_group_overrides (
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  rate_multiplier REAL CHECK(rate_multiplier IS NULL OR rate_multiplier >= 0),
  rpm_limit INTEGER CHECK(rpm_limit IS NULL OR rpm_limit >= 0),
  PRIMARY KEY(user_id, group_id)
);
INSERT INTO user_group_overrides(user_id,group_id,rate_multiplier)
  SELECT user_id,group_id,rate_multiplier FROM user_groups WHERE rate_multiplier IS NOT NULL;
ALTER TABLE user_groups DROP COLUMN rate_multiplier;
CREATE INDEX user_group_overrides_group ON user_group_overrides(group_id);
